import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../payments-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../payments-client')>()
  return { ...actual, createPayment: vi.fn(), getPayment: vi.fn() }
})
vi.mock('../payment-capabilities', () => ({
  resolvePisAvailability: vi.fn(),
  getAspspPaymentTypes: vi.fn(),
  pisFlagEnabled: vi.fn(() => true),
}))

import {
  createAndSendOrder,
  mapPaymentStatus,
  paymentCallbackUrl,
  resolveOrderBankIdentity,
} from '../payment-orders'
import { createPayment, PaymentInitiationError } from '../payments-client'
import { getAspspPaymentTypes, resolvePisAvailability } from '../payment-capabilities'
import type { PisPaymentInstruction } from '@/lib/payments/pis-request'
import type { ResponsePaymentType } from '@/lib/payments/pis-types'

const GIRO: ResponsePaymentType = {
  payment_type: 'DOMESTIC_SE_GIRO',
  psu_type: 'business',
  currencies: ['SEK'],
  creditor_account_schemas: ['BGNR'],
}

const INSTRUCTION: PisPaymentInstruction = {
  payee: { type: 'bankgiro', bankgiro: '50501055' },
  payeeName: 'Leverantör AB',
  amount: 100,
  paymentDate: '2026-09-12',
  reference: { type: 'invoice_number', value: 'F-1' },
  supplierInvoiceId: '22222222-2222-4222-8222-222222222222',
}

/**
 * Minimal Supabase stub covering exactly the two shapes the service uses: the
 * creation RPC and a guarded update that reads the row back.
 */
function makeSupabase(options: {
  rpcResult?: { data: unknown; error: { message: string } | null }
  connections?: unknown[]
} = {}) {
  const updates: Record<string, unknown>[] = []

  const updateChain = (payload: Record<string, unknown>) => {
    updates.push(payload)
    const chain: Record<string, unknown> = {}
    chain.eq = vi.fn(() => chain)
    chain.select = vi.fn(() => chain)
    chain.single = vi.fn().mockResolvedValue({ data: { id: 'order-1', ...payload }, error: null })
    return chain
  }

  const connectionsChain = () => {
    const chain: Record<string, unknown> = {}
    chain.select = vi.fn(() => chain)
    chain.eq = vi.fn(() => chain)
    chain.is = vi.fn(() => chain)
    chain.in = vi.fn(() => chain)
    chain.order = vi.fn().mockResolvedValue({ data: options.connections ?? [], error: null })
    return chain
  }

  return {
    updates,
    client: {
      rpc: vi.fn().mockResolvedValue(
        options.rpcResult ?? {
          data: { ok: true, order: { id: 'order-1', status: 'draft' } },
          error: null,
        },
      ),
      from: vi.fn((table: string) => {
        if (table === 'bank_connections') return connectionsChain()
        return { update: vi.fn(updateChain) }
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  }
}

function sendInput(supabase: ReturnType<typeof makeSupabase>) {
  return {
    supabase: supabase.client,
    companyId: 'company-1',
    userId: 'user-1',
    sourceType: 'supplier_batch' as const,
    sourceId: 'batch-1',
    family: 'giro' as const,
    instructions: [INSTRUCTION],
    debtor: { name: 'Testbolaget AB' },
    origin: 'https://accounted.test',
    returnPath: '/supplier-invoices/payment-files',
  }
}

describe('paymentCallbackUrl', () => {
  it('builds the URL that must be whitelisted at Enable Banking', () => {
    expect(paymentCallbackUrl('https://accounted.test')).toBe(
      'https://accounted.test/api/extensions/enable-banking/payments/callback',
    )
  })

  it('tolerates a trailing slash on the configured origin', () => {
    expect(paymentCallbackUrl('https://accounted.test/')).toBe(
      'https://accounted.test/api/extensions/enable-banking/payments/callback',
    )
  })
})

describe('mapPaymentStatus', () => {
  it('trusts the bank about what counts as a successful final status', () => {
    const capability = { ...GIRO, final_successful_statuses: ['ACCP'] }
    expect(mapPaymentStatus('ACCP', true, capability)).toBe('accepted')
    // Same code, a bank that did not list it: not our call to make.
    expect(mapPaymentStatus('ACCP', false, GIRO)).toBe('submitted')
  })

  it('maps the terminal failures', () => {
    expect(mapPaymentStatus('RJCT', true, GIRO)).toBe('rejected')
    expect(mapPaymentStatus('CANC', true, GIRO)).toBe('cancelled')
  })

  it('keeps a received payment waiting for its signature', () => {
    expect(mapPaymentStatus('RCVD', false, GIRO)).toBe('awaiting_authorization')
  })

  it('parks a final-but-unrecognised code as unknown rather than guessing', () => {
    expect(mapPaymentStatus('PATC', true, GIRO)).toBe('unknown')
  })
})

describe('resolveOrderBankIdentity', () => {
  it('prefers an active connection and derives the country from the provider slug', async () => {
    const supabase = makeSupabase({
      connections: [
        { id: 'c-old', bank_name: 'SEB', provider: 'seb-se', psu_type: 'business', status: 'expired' },
        {
          id: 'c-new',
          bank_name: 'Länsförsäkringar',
          provider: 'lansforsakringar-se',
          psu_type: 'personal',
          status: 'active',
        },
      ],
    })

    const identity = await resolveOrderBankIdentity(supabase.client, 'company-1')
    expect(identity).toEqual({
      connectionId: 'c-new',
      aspspName: 'Länsförsäkringar',
      aspspCountry: 'SE',
      psuType: 'personal',
    })
  })

  it('accepts a lapsed connection: it still names the right bank', async () => {
    const supabase = makeSupabase({
      connections: [
        { id: 'c-1', bank_name: 'SEB', provider: 'seb-se', psu_type: null, status: 'expired' },
      ],
    })
    const identity = await resolveOrderBankIdentity(supabase.client, 'company-1')
    expect(identity).toMatchObject({ aspspName: 'SEB', psuType: 'business' })
  })

  it('returns null when no bank has ever been connected', async () => {
    const supabase = makeSupabase({ connections: [] })
    expect(await resolveOrderBankIdentity(supabase.client, 'company-1')).toBeNull()
  })
})

describe('createAndSendOrder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolvePisAvailability).mockResolvedValue({ enabled: true, services: ['AIS', 'PIS'] })
    vi.mocked(getAspspPaymentTypes).mockResolvedValue([GIRO])
  })

  function connectedSupabase(rpcResult?: { data: unknown; error: { message: string } | null }) {
    return makeSupabase({
      rpcResult,
      connections: [
        {
          id: 'c-1',
          bank_name: 'Länsförsäkringar',
          provider: 'lansforsakringar-se',
          psu_type: 'business',
          status: 'active',
        },
      ],
    })
  }

  it('refuses before touching the bank when PIS is switched off', async () => {
    vi.mocked(resolvePisAvailability).mockResolvedValue({ enabled: false, reason: 'flag_off' })
    const supabase = connectedSupabase()

    const result = await createAndSendOrder(sendInput(supabase))
    expect(result).toMatchObject({ ok: false, reason: 'pis_unavailable', code: 'flag_off' })
    expect(supabase.client.rpc).not.toHaveBeenCalled()
    expect(createPayment).not.toHaveBeenCalled()
  })

  it('refuses when the bank offers no payment types, before writing anything', async () => {
    vi.mocked(getAspspPaymentTypes).mockResolvedValue([])
    const supabase = connectedSupabase()

    const result = await createAndSendOrder(sendInput(supabase))
    expect(result).toMatchObject({ ok: false, reason: 'aspsp_has_no_payments' })
    expect(supabase.client.rpc).not.toHaveBeenCalled()
  })

  it('surfaces the RPC already_sent refusal instead of sending a second payment', async () => {
    const supabase = connectedSupabase({
      data: { ok: false, code: 'already_sent', details: { order_id: 'order-9', status: 'submitted' } },
      error: null,
    })

    const result = await createAndSendOrder(sendInput(supabase))
    expect(result).toMatchObject({ ok: false, reason: 'already_sent', orderId: 'order-9' })
    expect(createPayment).not.toHaveBeenCalled()
  })

  it('records the payment id and hands back the authorisation URL', async () => {
    vi.mocked(createPayment).mockResolvedValue({
      payment_id: 'pay-1',
      status: 'RCVD',
      url: 'https://auth.enablebanking.com/pis/start?payment_id=pay-1',
      psu_id_hash: 'hash',
    })
    const supabase = connectedSupabase()

    const result = await createAndSendOrder(sendInput(supabase))
    expect(result).toMatchObject({ ok: true, authUrl: expect.stringContaining('pis/start') })

    const rpcArgs = supabase.client.rpc.mock.calls[0][1]
    expect(rpcArgs.p_payment_type).toBe('DOMESTIC_SE_GIRO')
    expect(rpcArgs.p_items[0]).toMatchObject({
      payee_type: 'bankgiro',
      payee_bankgiro: '50501055',
      supplier_invoice_id: INSTRUCTION.supplierInvoiceId,
      reference_type: 'invoice_number',
    })
    expect(rpcArgs.p_request_snapshot.redirect_url).toBe(
      'https://accounted.test/api/extensions/enable-banking/payments/callback',
    )
    expect(supabase.updates[0]).toMatchObject({
      eb_payment_id: 'pay-1',
      status: 'awaiting_authorization',
    })
  })

  it('fails the order on a 4xx: the bank refused, so nothing exists and a retry is safe', async () => {
    vi.mocked(createPayment).mockRejectedValue(new PaymentInitiationError(400, 'BAD_REQUEST'))
    const supabase = connectedSupabase()

    const result = await createAndSendOrder(sendInput(supabase))
    expect(result).toMatchObject({ ok: false, reason: 'send_rejected' })
    expect(supabase.updates[0]).toMatchObject({ status: 'failed' })
  })

  it('parks the order as unknown on a 5xx: we cannot tell whether money moved', async () => {
    vi.mocked(createPayment).mockRejectedValue(new PaymentInitiationError(502, 'upstream'))
    const supabase = connectedSupabase()

    const result = await createAndSendOrder(sendInput(supabase))
    expect(result).toMatchObject({ ok: false, reason: 'send_indeterminate' })
    expect(supabase.updates[0]).toMatchObject({ status: 'unknown' })
  })

  it('parks the order as unknown on a network failure, for the same reason', async () => {
    vi.mocked(createPayment).mockRejectedValue(new Error('fetch failed'))
    const supabase = connectedSupabase()

    const result = await createAndSendOrder(sendInput(supabase))
    expect(result).toMatchObject({ ok: false, reason: 'send_indeterminate' })
    expect(supabase.updates[0]).toMatchObject({ status: 'unknown' })
  })

  it('parks a timeout as unknown rather than claiming failure', async () => {
    vi.mocked(createPayment).mockRejectedValue(new PaymentInitiationError(408, 'timeout'))
    const supabase = connectedSupabase()

    const result = await createAndSendOrder(sendInput(supabase))
    expect(result).toMatchObject({ ok: false, reason: 'send_indeterminate' })
  })
})
