import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, requireCapability: vi.fn() }
})
vi.mock('@/lib/auth/rate-limit-http', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('../lib/payment-capabilities', () => ({
  resolvePisAvailability: vi.fn(),
  getAspspPaymentTypes: vi.fn(),
  pisFlagEnabled: vi.fn(() => true),
}))
vi.mock('../lib/payment-orders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/payment-orders')>()
  return {
    ...actual,
    createAndSendOrder: vi.fn(),
    refreshOrderStatus: vi.fn(),
    resolveOrderBankIdentity: vi.fn(),
  }
})
vi.mock('../lib/payment-sources', () => ({
  loadSupplierBatchSource: vi.fn(),
  loadTaxPaymentSource: vi.fn(),
  loadSalaryRunSource: vi.fn(),
}))

import { enableBankingExtension } from '../index'
import { requireCapability, capabilityBlockedResponse } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import {
  getAspspPaymentTypes,
  resolvePisAvailability,
} from '../lib/payment-capabilities'
import { createAndSendOrder, resolveOrderBankIdentity } from '../lib/payment-orders'
import {
  loadSalaryRunSource,
  loadSupplierBatchSource,
  loadTaxPaymentSource,
} from '../lib/payment-sources'
import type { ExtensionContext } from '@/lib/extensions/types'

const BATCH_ID = '11111111-1111-4111-8111-111111111111'

function makeContext(role: string | null = 'owner'): ExtensionContext {
  const roleQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: role ? { role } : null, error: null }),
  }
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'enable-banking',
    requestId: 'req_test',
    supabase: {
      from: vi.fn(() => roleQuery),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    emit: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
    settings: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function route(method: string, path: string) {
  const found = enableBankingExtension.apiRoutes?.find(
    (r) => r.method === method && r.path === path,
  )
  expect(found, `${method} ${path} must be registered`).toBeDefined()
  return found!
}

function postOrders(body: unknown) {
  return new Request('https://test.local/api/extensions/ext/enable-banking/payments/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('GET /payments/capabilities', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = 'https://accounted.test'
  })

  it('reports the reason when payment initiation is switched off', async () => {
    vi.mocked(resolvePisAvailability).mockResolvedValue({ enabled: false, reason: 'flag_off' })

    const response = await route('GET', '/payments/capabilities').handler(
      new Request('https://test.local/x'),
      makeContext(),
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ enabled: false, reason: 'flag_off' })
    // The gate must be answered without touching the bank.
    expect(getAspspPaymentTypes).not.toHaveBeenCalled()
  })

  it('reports no_bank_connection when the company has never connected a bank', async () => {
    vi.mocked(resolvePisAvailability).mockResolvedValue({ enabled: true, services: ['AIS', 'PIS'] })
    vi.mocked(resolveOrderBankIdentity).mockResolvedValue(null)

    const response = await route('GET', '/payments/capabilities').handler(
      new Request('https://test.local/x'),
      makeContext(),
    )
    await expect(response.json()).resolves.toMatchObject({
      enabled: false,
      reason: 'no_bank_connection',
    })
  })

  it('reports enabled:false when the bank offers no payment types', async () => {
    vi.mocked(resolvePisAvailability).mockResolvedValue({ enabled: true, services: ['AIS', 'PIS'] })
    vi.mocked(resolveOrderBankIdentity).mockResolvedValue({
      connectionId: 'conn-1',
      aspspName: 'Länsförsäkringar',
      aspspCountry: 'SE',
      psuType: 'business',
    })
    vi.mocked(getAspspPaymentTypes).mockResolvedValue([])

    const response = await route('GET', '/payments/capabilities').handler(
      new Request('https://test.local/x'),
      makeContext(),
    )
    await expect(response.json()).resolves.toMatchObject({
      enabled: false,
      reason: 'aspsp_has_no_payments',
    })
  })

  it('reports the supported payment types when everything is in place', async () => {
    vi.mocked(resolvePisAvailability).mockResolvedValue({
      enabled: true,
      services: ['AIS', 'PIS'],
      environment: 'PRODUCTION',
    })
    vi.mocked(resolveOrderBankIdentity).mockResolvedValue({
      connectionId: 'conn-1',
      aspspName: 'Länsförsäkringar',
      aspspCountry: 'SE',
      psuType: 'business',
    })
    vi.mocked(getAspspPaymentTypes).mockResolvedValue([
      { payment_type: 'DOMESTIC_SE_GIRO', psu_type: 'business' },
      { payment_type: 'BULK_DOMESTIC_SE_GIRO', psu_type: 'business' },
    ])

    const response = await route('GET', '/payments/capabilities').handler(
      new Request('https://test.local/x'),
      makeContext(),
    )
    await expect(response.json()).resolves.toMatchObject({
      enabled: true,
      bank_name: 'Länsförsäkringar',
      payment_types: ['DOMESTIC_SE_GIRO', 'BULK_DOMESTIC_SE_GIRO'],
    })
  })
})

describe('POST /payments/orders', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = 'https://accounted.test'
    vi.mocked(requireCapability).mockResolvedValue(null)
  })

  it('refuses a viewer: viewers may look at orders, never create one', async () => {
    const response = await route('POST', '/payments/orders').handler(
      postOrders({ source_type: 'supplier_batch', source_id: BATCH_ID }),
      makeContext('viewer'),
    )
    expect(response.status).toBe(403)
    expect(createAndSendOrder).not.toHaveBeenCalled()
  })

  it('refuses when the company is not entitled to bank sync', async () => {
    vi.mocked(requireCapability).mockResolvedValue(capabilityBlockedResponse(CAPABILITY.bank_sync))

    const response = await route('POST', '/payments/orders').handler(
      postOrders({ source_type: 'supplier_batch', source_id: BATCH_ID }),
      makeContext(),
    )
    expect(response.status).toBe(403)
    expect(createAndSendOrder).not.toHaveBeenCalled()
  })

  it('rejects an unsupported source type', async () => {
    const response = await route('POST', '/payments/orders').handler(
      postOrders({ source_type: 'invented', source_id: BATCH_ID }),
      makeContext(),
    )
    expect(response.status).toBe(400)
    expect(createAndSendOrder).not.toHaveBeenCalled()
  })

  it('rejects a request with no source id', async () => {
    const response = await route('POST', '/payments/orders').handler(
      postOrders({ source_type: 'supplier_batch' }),
      makeContext(),
    )
    expect(response.status).toBe(400)
    expect(createAndSendOrder).not.toHaveBeenCalled()
  })

  it('routes a tax payment through the giro family', async () => {
    vi.mocked(loadTaxPaymentSource).mockResolvedValue({
      ok: true,
      source: {
        instructions: [
          {
            payee: { type: 'bankgiro', bankgiro: '50501055' },
            payeeName: 'Skatteverket',
            amount: 21426,
            paymentDate: '2026-09-12',
            reference: { type: 'ocr', value: '1234567890123' },
          },
        ],
        debtor: { name: 'Testbolaget AB' },
        label: 'Skatt och avgifter 2026-08',
      },
    })
    vi.mocked(createAndSendOrder).mockResolvedValue({
      ok: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      order: { id: 'order-1' } as any,
      authUrl: 'https://auth.enablebanking.com/pis/start',
    })

    const response = await route('POST', '/payments/orders').handler(
      postOrders({ source_type: 'tax_payment', source_id: '2026-08' }),
      makeContext(),
    )
    expect(response.status).toBe(200)

    const args = vi.mocked(createAndSendOrder).mock.calls[0][0]
    expect(args).toMatchObject({
      sourceType: 'tax_payment',
      sourceId: '2026-08',
      family: 'giro',
      // No return_path in the body: the per-source-type fallback applies.
      returnPath: '/salary',
    })
    expect(loadSupplierBatchSource).not.toHaveBeenCalled()
  })

  it('carries the client return path, but only when it is a plain local path', async () => {
    vi.mocked(loadSupplierBatchSource).mockResolvedValue({
      ok: true,
      source: {
        instructions: [
          {
            payee: { type: 'bankgiro', bankgiro: '50501055' },
            payeeName: 'Leverantör AB',
            amount: 100,
            paymentDate: '2026-09-12',
          },
        ],
        debtor: { name: 'Testbolaget AB' },
        label: 'Betalfil',
      },
    })
    vi.mocked(createAndSendOrder).mockResolvedValue({
      ok: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      order: { id: 'order-1' } as any,
      authUrl: 'https://auth.enablebanking.com/pis/start',
    })

    await route('POST', '/payments/orders').handler(
      postOrders({
        source_type: 'supplier_batch',
        source_id: BATCH_ID,
        return_path: '/salary/runs/run-1',
      }),
      makeContext(),
    )
    expect(vi.mocked(createAndSendOrder).mock.calls[0][0].returnPath).toBe('/salary/runs/run-1')

    vi.mocked(createAndSendOrder).mockClear()
    await route('POST', '/payments/orders').handler(
      postOrders({
        source_type: 'supplier_batch',
        source_id: BATCH_ID,
        return_path: '//evil.example/pwn',
      }),
      makeContext(),
    )
    expect(vi.mocked(createAndSendOrder).mock.calls[0][0].returnPath).toBe(
      '/supplier-invoices/payment-files',
    )
  })

  it('routes a salary run through the domestic family: employees are paid on accounts, not giro', async () => {
    vi.mocked(loadSalaryRunSource).mockResolvedValue({
      ok: true,
      source: {
        instructions: [
          {
            payee: { type: 'bank_account', clearing: '8327', account: '123456789' },
            payeeName: 'Anna Andersson',
            amount: 24000,
            paymentDate: '2026-09-25',
          },
        ],
        debtor: { name: 'Testbolaget AB' },
        label: 'Löner 2026-09',
      },
    })
    vi.mocked(createAndSendOrder).mockResolvedValue({
      ok: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      order: { id: 'order-1' } as any,
      authUrl: 'https://auth.enablebanking.com/pis/start',
    })

    const response = await route('POST', '/payments/orders').handler(
      postOrders({ source_type: 'salary_run', source_id: BATCH_ID }),
      makeContext(),
    )
    expect(response.status).toBe(200)

    const args = vi.mocked(createAndSendOrder).mock.calls[0][0]
    expect(args).toMatchObject({ sourceType: 'salary_run', family: 'domestic', returnPath: '/salary' })
  })

  it('surfaces an unapproved salary run as a 400 with its own code', async () => {
    vi.mocked(loadSalaryRunSource).mockResolvedValue({ ok: false, reason: 'not_approved' })

    const response = await route('POST', '/payments/orders').handler(
      postOrders({ source_type: 'salary_run', source_id: BATCH_ID }),
      makeContext(),
    )
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'not_approved' })
    expect(createAndSendOrder).not.toHaveBeenCalled()
  })

  it('returns 404 for a batch that does not exist', async () => {
    vi.mocked(loadSupplierBatchSource).mockResolvedValue({ ok: false, reason: 'not_found' })

    const response = await route('POST', '/payments/orders').handler(
      postOrders({ source_type: 'supplier_batch', source_id: BATCH_ID }),
      makeContext(),
    )
    expect(response.status).toBe(404)
  })

  it('refuses a cancelled batch with 400: cancelling means the instruction is void', async () => {
    vi.mocked(loadSupplierBatchSource).mockResolvedValue({ ok: false, reason: 'cancelled' })

    const response = await route('POST', '/payments/orders').handler(
      postOrders({ source_type: 'supplier_batch', source_id: BATCH_ID }),
      makeContext(),
    )
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'cancelled' })
  })

  it('returns the authorisation URL on success', async () => {
    vi.mocked(loadSupplierBatchSource).mockResolvedValue({
      ok: true,
      source: {
        instructions: [
          {
            payee: { type: 'bankgiro', bankgiro: '50501055' },
            payeeName: 'Leverantör AB',
            amount: 100,
            paymentDate: '2026-09-12',
            reference: { type: 'invoice_number', value: 'F-1' },
          },
        ],
        debtor: { name: 'Testbolaget AB' },
        label: 'Betalfil 2026-09-05',
      },
    })
    vi.mocked(createAndSendOrder).mockResolvedValue({
      ok: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      order: { id: 'order-1', status: 'awaiting_authorization' } as any,
      authUrl: 'https://auth.enablebanking.com/pis/start?payment_id=pay-1',
    })

    const response = await route('POST', '/payments/orders').handler(
      postOrders({ source_type: 'supplier_batch', source_id: BATCH_ID }),
      makeContext(),
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      auth_url: 'https://auth.enablebanking.com/pis/start?payment_id=pay-1',
    })

    const args = vi.mocked(createAndSendOrder).mock.calls[0][0]
    expect(args.sourceType).toBe('supplier_batch')
    expect(args.family).toBe('giro')
    expect(args.origin).toBe('https://accounted.test')
  })

  it('answers 409 when an order for this batch already exists', async () => {
    vi.mocked(loadSupplierBatchSource).mockResolvedValue({
      ok: true,
      source: {
        instructions: [
          {
            payee: { type: 'bankgiro', bankgiro: '50501055' },
            payeeName: 'Leverantör AB',
            amount: 100,
            paymentDate: '2026-09-12',
          },
        ],
        debtor: { name: 'Testbolaget AB' },
        label: 'Betalfil',
      },
    })
    vi.mocked(createAndSendOrder).mockResolvedValue({
      ok: false,
      reason: 'already_sent',
      orderId: 'order-1',
      status: 'submitted',
    })

    const response = await route('POST', '/payments/orders').handler(
      postOrders({ source_type: 'supplier_batch', source_id: BATCH_ID }),
      makeContext(),
    )
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ reason: 'already_sent' })
  })

  it('answers 502 when the create outcome is indeterminate, not 400', async () => {
    // The caller cannot fix this by changing the request, and must NOT be
    // invited to retry: the payment may exist at the bank.
    vi.mocked(loadSupplierBatchSource).mockResolvedValue({
      ok: true,
      source: {
        instructions: [
          {
            payee: { type: 'bankgiro', bankgiro: '50501055' },
            payeeName: 'Leverantör AB',
            amount: 100,
            paymentDate: '2026-09-12',
          },
        ],
        debtor: { name: 'Testbolaget AB' },
        label: 'Betalfil',
      },
    })
    vi.mocked(createAndSendOrder).mockResolvedValue({
      ok: false,
      reason: 'send_indeterminate',
      orderId: 'order-1',
    })

    const response = await route('POST', '/payments/orders').handler(
      postOrders({ source_type: 'supplier_batch', source_id: BATCH_ID }),
      makeContext(),
    )
    expect(response.status).toBe(502)
  })

  it('fails loudly when the instance address is unconfigured', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL

    const response = await route('POST', '/payments/orders').handler(
      postOrders({ source_type: 'supplier_batch', source_id: BATCH_ID }),
      makeContext(),
    )
    expect(response.status).toBe(500)
    expect(createAndSendOrder).not.toHaveBeenCalled()
  })
})
