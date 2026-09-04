import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockResolveBatchDebtor = vi.fn()
const mockResolveSkattekontoOcr = vi.fn()

vi.mock('@/lib/payments/batch-service', () => ({
  resolveBatchDebtor: (...args: unknown[]) => mockResolveBatchDebtor(...args),
}))
vi.mock('@/lib/skatteverket/skattekonto-ocr', () => ({
  SKATTEKONTO_BANKGIRO: '5050-1055',
  resolveSkattekontoOcr: (...args: unknown[]) => mockResolveSkattekontoOcr(...args),
}))

import {
  loadSalaryRunSource,
  loadSupplierBatchSource,
  loadTaxPaymentSource,
} from '../payment-sources'

/**
 * Table-driven Supabase stub: each `from()` returns a chain that resolves to
 * whatever the table was seeded with. Only the shapes these loaders actually
 * use are supported, on purpose.
 */
function makeSupabase(tables: Record<string, { data: unknown; error?: unknown }>) {
  const client = {
    from: vi.fn((table: string) => {
      const result = tables[table] ?? { data: null, error: null }
      const chain: Record<string, unknown> = {}
      const passthrough = () => chain
      chain.select = passthrough
      chain.eq = passthrough
      chain.order = vi.fn(() => ({ ...chain, returns: () => Promise.resolve(result) }))
      chain.returns = () => Promise.resolve(result)
      chain.maybeSingle = () => Promise.resolve(result)
      chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve)
      return chain
    }),
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return client as any
}

const BATCH = {
  id: 'batch-1',
  status: 'created',
  currency: 'SEK',
  created_at: '2026-09-05T08:00:00.000Z',
  debtor_snapshot: {
    name: 'Testbolaget AB',
    org_number: '556677-8899',
    iban: 'SE4550000000058398257466',
    bic: 'ESSESESS',
    bankgiro: '1234567',
  },
}

const BATCH_ITEM = {
  id: 'item-1',
  supplier_invoice_id: 'inv-1',
  amount: 737.5,
  payment_date: '2026-09-12',
  payee_type: 'bankgiro',
  payee_bankgiro: '50501055',
  payee_plusgiro: null,
  payee_clearing: null,
  payee_account: null,
  payee_name: 'Derome Bygg AB',
  reference_type: 'invoice_number',
  reference: 'CD3014794407',
}

describe('loadSupplierBatchSource', () => {
  beforeEach(() => vi.clearAllMocks())

  it('maps stored items to instructions without re-resolving anything', async () => {
    const supabase = makeSupabase({
      supplier_payment_batches: { data: BATCH, error: null },
      supplier_payment_batch_items: { data: [BATCH_ITEM], error: null },
    })

    const result = await loadSupplierBatchSource(supabase, 'company-1', 'batch-1')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.source.instructions).toHaveLength(1)
    expect(result.source.instructions[0]).toMatchObject({
      payee: { type: 'bankgiro', bankgiro: '50501055' },
      payeeName: 'Derome Bygg AB',
      amount: 737.5,
      paymentDate: '2026-09-12',
      supplierInvoiceId: 'inv-1',
    })
    expect(result.source.debtor).toMatchObject({ name: 'Testbolaget AB', bankgiro: '1234567' })
  })

  it('refuses a cancelled batch: cancelling means the instruction is void', async () => {
    const supabase = makeSupabase({
      supplier_payment_batches: { data: { ...BATCH, status: 'cancelled' }, error: null },
    })
    await expect(loadSupplierBatchSource(supabase, 'company-1', 'batch-1')).resolves.toMatchObject({
      ok: false,
      reason: 'cancelled',
    })
  })

  it('refuses a batch with no items', async () => {
    const supabase = makeSupabase({
      supplier_payment_batches: { data: BATCH, error: null },
      supplier_payment_batch_items: { data: [], error: null },
    })
    await expect(loadSupplierBatchSource(supabase, 'company-1', 'batch-1')).resolves.toMatchObject({
      ok: false,
      reason: 'empty',
    })
  })
})

describe('loadTaxPaymentSource', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveSkattekontoOcr.mockResolvedValue('1234567890123')
    mockResolveBatchDebtor.mockResolvedValue({
      ok: true,
      debtor: {
        name: 'Testbolaget AB',
        org_number: '556677-8899',
        iban: 'SE45',
        bic: 'ESSESESS',
        bankgiro: '1234567',
        city: 'Solna',
      },
    })
  })

  function taxSupabase(agi: unknown, company: unknown = { name: 'Testbolaget AB', org_number: '556677-8899', entity_type: 'aktiebolag' }) {
    return makeSupabase({
      agi_declarations: { data: agi, error: null },
      companies: { data: company, error: null },
    })
  }

  it('pays the declared total to BG 5050-1055 with the OCR on the due date', async () => {
    const result = await loadTaxPaymentSource(
      taxSupabase({ id: 'agi-1', total_tax: 12000, total_avgifter: 9426 }),
      'company-1',
      '2026-08',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.source.instructions).toEqual([
      {
        payee: { type: 'bankgiro', bankgiro: '50501055' },
        payeeName: 'Skatteverket',
        amount: 21426,
        paymentDate: '2026-09-12',
        reference: { type: 'ocr', value: '1234567890123' },
      },
    ])
  })

  it('refuses a period with nothing to pay', async () => {
    await expect(
      loadTaxPaymentSource(
        taxSupabase({ id: 'agi-1', total_tax: 0, total_avgifter: 0 }),
        'company-1',
        '2026-08',
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'nothing_to_pay' })
  })

  it('refuses a period with no AGI at all', async () => {
    await expect(
      loadTaxPaymentSource(taxSupabase(null), 'company-1', '2026-08'),
    ).resolves.toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('refuses a malformed period', async () => {
    await expect(
      loadTaxPaymentSource(taxSupabase(null), 'company-1', 'augusti'),
    ).resolves.toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('refuses when the OCR cannot be resolved, rather than paying without one', async () => {
    mockResolveSkattekontoOcr.mockRejectedValue(new Error('no identity'))
    await expect(
      loadTaxPaymentSource(
        taxSupabase({ id: 'agi-1', total_tax: 100, total_avgifter: 0 }),
        'company-1',
        '2026-08',
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'reference_unresolvable' })
  })

  it('still builds a payment when the company has no IBAN', async () => {
    // Unlike pain.001, the PSD2 request carries a debtor account only when the
    // bank demands one; otherwise the user picks it while signing.
    mockResolveBatchDebtor.mockResolvedValue({ ok: false, missing: 'iban' })
    const result = await loadTaxPaymentSource(
      taxSupabase({ id: 'agi-1', total_tax: 100, total_avgifter: 0 }),
      'company-1',
      '2026-08',
    )
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(result.source.debtor).toEqual({ name: 'Testbolaget AB' })
  })
})

describe('loadSalaryRunSource', () => {
  const RUN = {
    id: 'run-1',
    status: 'approved',
    payment_date: '2026-09-25',
    period_year: 2026,
    period_month: 9,
  }

  const employee = (overrides: Record<string, unknown> = {}) => ({
    id: 'sre-1',
    net_salary: 24000,
    tax_withheld: 6000,
    tax_withheld_override: null,
    employee: {
      first_name: 'Anna',
      last_name: 'Andersson',
      clearing_number: '8327',
      bank_account_number: '123456789',
    },
    ...overrides,
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveBatchDebtor.mockResolvedValue({
      ok: true,
      debtor: { name: 'Testbolaget AB', iban: 'SE45', bankgiro: '1234567' },
    })
  })

  function salarySupabase(run: unknown, employees: unknown) {
    return makeSupabase({
      salary_runs: { data: run, error: null },
      salary_run_employees: { data: employees, error: null },
      companies: { data: { name: 'Testbolaget AB' }, error: null },
    })
  }

  it('pays each employee their effective net, with no reference at all', async () => {
    const result = await loadSalaryRunSource(salarySupabase(RUN, [employee()]), 'company-1', 'run-1')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.source.instructions).toEqual([
      {
        payee: { type: 'bank_account', clearing: '8327', account: '123456789' },
        payeeName: 'Anna Andersson',
        amount: 24000,
        paymentDate: '2026-09-25',
      },
    ])
    // The salary dialect forbids remittance information; a payslip line has no
    // business on the employee's bank statement.
    expect(result.source.instructions[0].reference).toBeUndefined()
  })

  it('honours a manual tax override, exactly like the payment files', async () => {
    const result = await loadSalaryRunSource(
      salarySupabase(RUN, [employee({ tax_withheld_override: 5000 })]),
      'company-1',
      'run-1',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source.instructions[0].amount).toBe(25000)
  })

  it('skips zero-payout employees instead of demanding bank details for them', async () => {
    const result = await loadSalaryRunSource(
      salarySupabase(RUN, [
        employee(),
        employee({
          id: 'sre-2',
          net_salary: 0,
          tax_withheld: 0,
          employee: {
            first_name: 'Bo',
            last_name: 'Bengtsson',
            clearing_number: null,
            bank_account_number: null,
          },
        }),
      ]),
      'company-1',
      'run-1',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source.instructions).toHaveLength(1)
  })

  it('refuses a run that has not been approved', async () => {
    await expect(
      loadSalaryRunSource(salarySupabase({ ...RUN, status: 'review' }, [employee()]), 'c', 'run-1'),
    ).resolves.toMatchObject({ ok: false, reason: 'not_approved' })
  })

  it('refuses when a paid employee is missing bank details', async () => {
    const broken = employee({
      employee: {
        first_name: 'Anna',
        last_name: 'Andersson',
        clearing_number: '8327',
        bank_account_number: null,
      },
    })
    await expect(
      loadSalaryRunSource(salarySupabase(RUN, [broken]), 'company-1', 'run-1'),
    ).resolves.toMatchObject({ ok: false, reason: 'payee_incomplete' })
  })

  it('refuses a run where nobody is paid anything', async () => {
    await expect(
      loadSalaryRunSource(
        salarySupabase(RUN, [employee({ net_salary: 0, tax_withheld: 0 })]),
        'company-1',
        'run-1',
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'nothing_to_pay' })
  })

  it('refuses a run that does not exist', async () => {
    await expect(
      loadSalaryRunSource(salarySupabase(null, []), 'company-1', 'run-1'),
    ).resolves.toMatchObject({ ok: false, reason: 'not_found' })
  })
})
