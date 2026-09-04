import { describe, it, expect } from 'vitest'
import {
  buildPaymentRequest,
  canSendStructuredOcr,
  creditorAccountFor,
  formatWireAmount,
  isFailedStatus,
  isSuccessfulStatus,
  payeeFromSnapshot,
  selectPaymentCapability,
  type PisPaymentInstruction,
} from '../pis-request'
import type { ResponsePaymentType } from '../pis-types'

const GIRO_SINGLE: ResponsePaymentType = {
  payment_type: 'DOMESTIC_SE_GIRO',
  psu_type: 'business',
  currencies: ['SEK'],
  creditor_account_schemas: ['BGNR', 'PGNR', 'BBAN'],
  reference_number_supported: true,
  reference_number_schemas: ['SEBG'],
  requested_execution_date_supported: true,
}

const GIRO_BULK: ResponsePaymentType = {
  ...GIRO_SINGLE,
  payment_type: 'BULK_DOMESTIC_SE_GIRO',
  max_transactions: 10,
}

function instruction(overrides: Partial<PisPaymentInstruction> = {}): PisPaymentInstruction {
  return {
    payee: { type: 'bankgiro', bankgiro: '50501055' },
    payeeName: 'Skatteverket',
    amount: 1234.5,
    paymentDate: '2026-09-12',
    reference: { type: 'ocr', value: '1234567890123' },
    ...overrides,
  }
}

function build(
  instructions: PisPaymentInstruction[],
  paymentTypes: ResponsePaymentType[] = [GIRO_SINGLE, GIRO_BULK],
) {
  return buildPaymentRequest({
    family: 'giro',
    instructions,
    debtor: { name: 'Testbolaget AB', iban: 'SE45 5000 0000 0583 9825 7466' },
    aspsp: { name: 'Länsförsäkringar', country: 'SE' },
    psuType: 'business',
    availablePaymentTypes: paymentTypes,
    redirectUrl: 'https://example.test/api/extensions/enable-banking/payments/callback',
    state: 'state-1',
  })
}

describe('formatWireAmount', () => {
  it('rounds to öre before rendering, never twice', () => {
    expect(formatWireAmount(1234.5)).toBe('1234.50')
    expect(formatWireAmount(0.005)).toBe('0.01')
    expect(formatWireAmount(1.005)).toBe('1.01')
    // The classic float case: 0.1 + 0.2 must not render as 0.30000000000000004
    expect(formatWireAmount(0.1 + 0.2)).toBe('0.30')
  })
})

describe('creditorAccountFor', () => {
  it('maps bankgiro to BGNR with bare digits', () => {
    expect(creditorAccountFor({ type: 'bankgiro', bankgiro: '5050-1055' })).toEqual({
      identification: '50501055',
      scheme_name: 'BGNR',
    })
  })

  it('maps plusgiro to PGNR', () => {
    expect(creditorAccountFor({ type: 'plusgiro', plusgiro: '4321-0' })).toEqual({
      identification: '43210',
      scheme_name: 'PGNR',
    })
  })

  it('concatenates clearing and account into a Swedish BBAN', () => {
    expect(
      creditorAccountFor({ type: 'bank_account', clearing: '8327-9', account: '123 456 789' }),
    ).toEqual({ identification: '83279123456789', scheme_name: 'BBAN' })
  })
})

describe('payeeFromSnapshot', () => {
  it('rebuilds each payee shape from stored columns', () => {
    expect(payeeFromSnapshot({ payee_type: 'bankgiro', payee_bankgiro: '50501055' })).toEqual({
      type: 'bankgiro',
      bankgiro: '50501055',
    })
    expect(
      payeeFromSnapshot({ payee_type: 'bank_account', payee_clearing: '8327', payee_account: '12345' }),
    ).toEqual({ type: 'bank_account', clearing: '8327', account: '12345' })
  })

  it('throws rather than paying an empty account number', () => {
    expect(() => payeeFromSnapshot({ payee_type: 'bankgiro', payee_bankgiro: null })).toThrow()
    expect(() =>
      payeeFromSnapshot({ payee_type: 'bank_account', payee_clearing: '8327', payee_account: null }),
    ).toThrow()
  })
})

describe('selectPaymentCapability', () => {
  it('prefers the bulk type for several instructions: one signature, not five', () => {
    const picked = selectPaymentCapability([GIRO_SINGLE, GIRO_BULK], 'giro', 'business', 5)
    expect(picked?.payment_type).toBe('BULK_DOMESTIC_SE_GIRO')
  })

  it('uses the single type for one instruction', () => {
    const picked = selectPaymentCapability([GIRO_SINGLE, GIRO_BULK], 'giro', 'business', 1)
    expect(picked?.payment_type).toBe('DOMESTIC_SE_GIRO')
  })

  it('falls back to the single type when the bulk type cannot hold the batch', () => {
    const picked = selectPaymentCapability(
      [GIRO_SINGLE, { ...GIRO_BULK, max_transactions: 2 }],
      'giro',
      'business',
      5,
    )
    expect(picked?.payment_type).toBe('DOMESTIC_SE_GIRO')
  })

  it('ignores payment types scoped to another PSU type', () => {
    const picked = selectPaymentCapability(
      [{ ...GIRO_SINGLE, psu_type: 'personal' }],
      'giro',
      'business',
      1,
    )
    expect(picked).toBeUndefined()
  })

  it('does not use a giro type for the domestic family', () => {
    const picked = selectPaymentCapability([GIRO_SINGLE, GIRO_BULK], 'domestic', 'business', 1)
    expect(picked).toBeUndefined()
  })
})

describe('buildPaymentRequest', () => {
  it('builds a single giro payment with a structured OCR reference', () => {
    const result = build([instruction()])
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.request.payment_type).toBe('DOMESTIC_SE_GIRO')
    expect(result.request.state).toBe('state-1')
    expect(result.request.psu_type).toBe('business')

    const [tx] = result.request.payment_request.credit_transfer_transaction
    expect(tx.instructed_amount).toEqual({ currency: 'SEK', amount: '1234.50' })
    expect(tx.beneficiary.creditor_account).toEqual({
      identification: '50501055',
      scheme_name: 'BGNR',
    })
    expect(tx.beneficiary.creditor.name).toBe('Skatteverket')
    expect(tx.reference_number).toBe('1234567890123')
    expect(tx.remittance_information).toBeUndefined()
    expect(tx.requested_execution_date).toBe('2026-09-12')
  })

  it('sends an OCR as plain text when the bank has no structured reference rail', () => {
    const result = build([instruction()], [{ ...GIRO_SINGLE, reference_number_supported: false }])
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const [tx] = result.request.payment_request.credit_transfer_transaction
    expect(tx.reference_number).toBeUndefined()
    expect(tx.remittance_information).toEqual(['1234567890123'])
  })

  it('sends an OCR as plain text when the bank names only foreign reference schemes', () => {
    const result = build(
      [instruction()],
      [{ ...GIRO_SINGLE, reference_number_schemas: ['FIRF'] }],
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.request.payment_request.credit_transfer_transaction[0].reference_number).toBeUndefined()
  })

  it('truncates a free-text reference to the giro message field', () => {
    const result = build([
      instruction({
        reference: { type: 'invoice_number', value: 'FAKTURA-1234567890-ABCDEFGHIJKLMNOP' },
      }),
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [tx] = result.request.payment_request.credit_transfer_transaction
    expect(tx.remittance_information?.[0]).toHaveLength(25)
  })

  it('honours a bank-stated remittance line length over the giro default', () => {
    const result = build(
      [instruction({ reference: { type: 'invoice_number', value: 'A'.repeat(60) } })],
      [{ ...GIRO_SINGLE, remittance_information_lines: [{ max_length: 12 }] }],
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.request.payment_request.credit_transfer_transaction[0].remittance_information?.[0])
      .toHaveLength(12)
  })

  it('omits the execution date when the bank does not accept future dating', () => {
    const result = build(
      [instruction()],
      [{ ...GIRO_SINGLE, requested_execution_date_supported: false }],
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(
      result.request.payment_request.credit_transfer_transaction[0].requested_execution_date,
    ).toBeUndefined()
  })

  it('leaves the debtor account to the PSU unless the bank demands it', () => {
    const result = build([instruction()])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.request.payment_request.debtor_account).toBeUndefined()
  })

  it('sends the debtor IBAN when the bank requires a debtor account', () => {
    const result = build(
      [instruction()],
      [{ ...GIRO_SINGLE, debtor_account_required: true, debtor_account_schemas: ['IBAN'] }],
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.request.payment_request.debtor_account).toEqual({
      identification: 'SE4550000000058398257466',
      scheme_name: 'IBAN',
    })
  })

  it('refuses when the bank demands a debtor account we cannot supply', () => {
    const result = buildPaymentRequest({
      family: 'giro',
      instructions: [instruction()],
      debtor: { name: 'Testbolaget AB' },
      aspsp: { name: 'Länsförsäkringar', country: 'SE' },
      psuType: 'business',
      availablePaymentTypes: [{ ...GIRO_SINGLE, debtor_account_required: true }],
      redirectUrl: 'https://example.test/cb',
      state: 's',
    })
    expect(result).toMatchObject({ ok: false, reason: 'debtor_account_missing' })
  })

  it('refuses a creditor scheme the bank does not accept, naming the payee', () => {
    const result = build(
      [instruction({ payee: { type: 'plusgiro', plusgiro: '43210' }, payeeName: 'Leverantör AB' })],
      [{ ...GIRO_SINGLE, creditor_account_schemas: ['BGNR'] }],
    )
    expect(result).toMatchObject({
      ok: false,
      reason: 'creditor_scheme_unsupported',
      scheme: 'PGNR',
      payeeName: 'Leverantör AB',
    })
  })

  it('refuses a currency the bank does not settle on this payment type', () => {
    const result = buildPaymentRequest({
      family: 'giro',
      instructions: [instruction()],
      debtor: { name: 'Testbolaget AB' },
      aspsp: { name: 'Länsförsäkringar', country: 'SE' },
      psuType: 'business',
      availablePaymentTypes: [GIRO_SINGLE],
      redirectUrl: 'https://example.test/cb',
      state: 's',
      currency: 'EUR',
    })
    expect(result).toMatchObject({ ok: false, reason: 'currency_unsupported', currency: 'EUR' })
  })

  it('refuses when the bank offers no payment type in this family', () => {
    const result = build([instruction()], [])
    expect(result).toMatchObject({ ok: false, reason: 'payment_type_unavailable' })
  })

  it('refuses when there are more instructions than the bank accepts', () => {
    const many = Array.from({ length: 12 }, () => instruction())
    const result = build(many, [{ ...GIRO_BULK, max_transactions: 10 }])
    expect(result).toMatchObject({ ok: false, reason: 'too_many_transactions', max: 10, count: 12 })
  })

  it('refuses an empty batch', () => {
    expect(build([])).toMatchObject({ ok: false, reason: 'no_instructions' })
  })

  it('refuses a salary-style instruction when the bank requires remittance information', () => {
    const result = build(
      [instruction({ reference: undefined })],
      [{ ...GIRO_SINGLE, remittance_information_required: true }],
    )
    expect(result).toMatchObject({ ok: false, reason: 'remittance_required' })
  })
})

describe('canSendStructuredOcr', () => {
  it('accepts a bank that supports references but names no schema', () => {
    expect(canSendStructuredOcr({ ...GIRO_SINGLE, reference_number_schemas: undefined })).toBe(true)
  })

  it('rejects a bank that does not support reference numbers', () => {
    expect(canSendStructuredOcr({ ...GIRO_SINGLE, reference_number_supported: false })).toBe(false)
  })
})

describe('status classification', () => {
  it('uses the bank\'s own list of final successful statuses', () => {
    const capability = { final_successful_statuses: ['ACCP'] }
    expect(isSuccessfulStatus('ACCP', capability)).toBe(true)
    // ACSC settles, but this bank did not list it: we do not decide for it.
    expect(isSuccessfulStatus('ACSC', capability)).toBe(false)
  })

  it('falls back to the settlement codes when the bank states nothing', () => {
    expect(isSuccessfulStatus('ACSC', undefined)).toBe(true)
    expect(isSuccessfulStatus('ACSP', {})).toBe(true)
    expect(isSuccessfulStatus('RCVD', undefined)).toBe(false)
    // ACCP alone is not settlement, and no bank has claimed it is.
    expect(isSuccessfulStatus('ACCP', undefined)).toBe(false)
  })

  it('recognises the terminal failures', () => {
    expect(isFailedStatus('RJCT')).toBe(true)
    expect(isFailedStatus('CANC')).toBe(true)
    expect(isFailedStatus('PDNG')).toBe(false)
  })
})
