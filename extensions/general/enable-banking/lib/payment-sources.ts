/**
 * Turning a stored payment snapshot into payment instructions.
 *
 * Each source already exists as a file today, and this module deliberately
 * reads the SAME rows the file generator reads. A betalfil and a payment order
 * for the same batch must never disagree about who gets paid, how much, or with
 * which reference: that is a property of reading one snapshot, not of two code
 * paths agreeing by inspection.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { SupplierPaymentBatch, SupplierPaymentBatchItem } from '@/types'
import {
  payeeFromSnapshot,
  type PisDebtor,
  type PisPaymentInstruction,
} from '@/lib/payments/pis-request'
import { resolveBatchDebtor } from '@/lib/payments/batch-service'
import { resolveSkattekontoOcr, SKATTEKONTO_BANKGIRO } from '@/lib/skatteverket/skattekonto-ocr'
import {
  computeTaxPaymentDate,
  parseAgiPeriod,
  resolveDeclaredTaxTotal,
} from '@/lib/skatteverket/tax-payment'
import { effectiveNetPayout } from '@/lib/salary/payment/effective-net'

export interface PaymentSource {
  instructions: PisPaymentInstruction[]
  debtor: PisDebtor
  /** Human label for the confirmation dialog, e.g. "Betalfil 2026-09-05". */
  label: string
}

export type PaymentSourceReason =
  | 'not_found'
  | 'cancelled'
  | 'empty'
  /** Nothing to pay: a zero AGI, or a salary run where every payout is 0. */
  | 'nothing_to_pay'
  /** The salary run has not been approved yet. */
  | 'not_approved'
  /** Company payment details (org number, IBAN) are missing. */
  | 'debtor_incomplete'
  /** Payee bank details are missing on one or more employees. */
  | 'payee_incomplete'
  /** The Skatteverket OCR could not be resolved. */
  | 'reference_unresolvable'

export type PaymentSourceResult =
  | { ok: true; source: PaymentSource }
  | { ok: false; reason: PaymentSourceReason; detail?: string }

/**
 * Load a supplier payment batch as payment instructions.
 *
 * A cancelled batch is refused: cancelling is the user saying this instruction
 * is void, and paying it anyway would make the cancel meaningless.
 */
export async function loadSupplierBatchSource(
  supabase: SupabaseClient,
  companyId: string,
  batchId: string,
): Promise<PaymentSourceResult> {
  const { data: batch, error: batchError } = await supabase
    .from('supplier_payment_batches')
    .select('id, status, currency, debtor_snapshot, created_at')
    .eq('id', batchId)
    .eq('company_id', companyId)
    .maybeSingle<Pick<SupplierPaymentBatch, 'id' | 'status' | 'currency' | 'debtor_snapshot' | 'created_at'>>()

  if (batchError || !batch) return { ok: false, reason: 'not_found' }
  if (batch.status === 'cancelled') return { ok: false, reason: 'cancelled' }

  const { data: items, error: itemsError } = await supabase
    .from('supplier_payment_batch_items')
    .select(
      'id, supplier_invoice_id, amount, payment_date, payee_type, payee_bankgiro, payee_plusgiro, payee_clearing, payee_account, payee_name, reference_type, reference',
    )
    .eq('batch_id', batchId)
    .eq('company_id', companyId)
    .order('created_at', { ascending: true })
    .returns<
      Pick<
        SupplierPaymentBatchItem,
        | 'id'
        | 'supplier_invoice_id'
        | 'amount'
        | 'payment_date'
        | 'payee_type'
        | 'payee_bankgiro'
        | 'payee_plusgiro'
        | 'payee_clearing'
        | 'payee_account'
        | 'payee_name'
        | 'reference_type'
        | 'reference'
      >[]
    >()

  if (itemsError || !items || items.length === 0) return { ok: false, reason: 'empty' }

  const instructions: PisPaymentInstruction[] = items.map((item) => ({
    payee: payeeFromSnapshot(item),
    payeeName: item.payee_name,
    amount: item.amount,
    paymentDate: item.payment_date,
    reference: { type: item.reference_type, value: item.reference },
    supplierInvoiceId: item.supplier_invoice_id,
  }))

  const debtor: PisDebtor = {
    name: batch.debtor_snapshot.name,
    iban: batch.debtor_snapshot.iban ?? null,
    bankgiro: batch.debtor_snapshot.bankgiro ?? null,
  }

  return {
    ok: true,
    source: { instructions, debtor, label: `Betalfil ${batch.created_at.slice(0, 10)}` },
  }
}

/**
 * Load the skattekonto payment for an AGI period as a single instruction.
 *
 * Amount, OCR and due date all come from the same helpers the payment-file
 * route uses (resolveDeclaredTaxTotal, resolveSkattekontoOcr,
 * computeTaxPaymentDate), so a file and a directly-sent payment can never
 * disagree about how much is owed, by whom, or when.
 */
export async function loadTaxPaymentSource(
  supabase: SupabaseClient,
  companyId: string,
  period: string,
): Promise<PaymentSourceResult> {
  const parsed = parseAgiPeriod(period)
  if (!parsed) return { ok: false, reason: 'not_found', detail: 'invalid period' }

  const { data: agi } = await supabase
    .from('agi_declarations')
    .select('id, total_tax, total_avgifter')
    .eq('company_id', companyId)
    .eq('period_year', parsed.year)
    .eq('period_month', parsed.month)
    .maybeSingle<{ id: string; total_tax: number; total_avgifter: number }>()

  if (!agi) return { ok: false, reason: 'not_found' }

  const amount = resolveDeclaredTaxTotal(agi)
  if (amount <= 0) return { ok: false, reason: 'nothing_to_pay' }

  const { data: company } = await supabase
    .from('companies')
    .select('name, org_number, entity_type')
    .eq('id', companyId)
    .maybeSingle<{ name: string; org_number: string | null; entity_type: string }>()

  if (!company?.org_number) return { ok: false, reason: 'debtor_incomplete' }

  let ocr: string
  try {
    ocr = await resolveSkattekontoOcr(
      supabase,
      companyId,
      company.org_number,
      company.entity_type === 'enskild_firma' ? 'enskild_firma' : 'aktiebolag',
    )
  } catch (error) {
    return {
      ok: false,
      reason: 'reference_unresolvable',
      detail: error instanceof Error ? error.message : String(error),
    }
  }

  // The debtor resolves exactly as for a supplier batch, but a missing IBAN is
  // NOT fatal here: unlike pain.001, the PSD2 request only carries a debtor
  // account when the bank demands one, and otherwise the user picks the
  // funding account while signing.
  const debtorResolution = await resolveBatchDebtor(supabase, companyId)
  const debtor: PisDebtor = debtorResolution.ok
    ? {
        name: debtorResolution.debtor.name,
        iban: debtorResolution.debtor.iban,
        bankgiro: debtorResolution.debtor.bankgiro,
      }
    : { name: company.name }

  return {
    ok: true,
    source: {
      instructions: [
        {
          payee: { type: 'bankgiro', bankgiro: SKATTEKONTO_BANKGIRO.replace(/\D/g, '') },
          payeeName: 'Skatteverket',
          amount,
          paymentDate: computeTaxPaymentDate(parsed.year, parsed.month),
          reference: { type: 'ocr', value: ocr },
        },
      ],
      debtor,
      label: `Skatt och avgifter ${period}`,
    },
  }
}

/**
 * Load a salary run's payouts as payment instructions.
 *
 * Deliberately identical in selection to the LB / pain.001 generators: only
 * employees with a positive effective net appear, and every one of them must
 * have complete bank details. No reference travels with a salary payment: the
 * salary dialect forbids remittance information, and a payslip line has no
 * business appearing on the employee's bank statement.
 */
export async function loadSalaryRunSource(
  supabase: SupabaseClient,
  companyId: string,
  runId: string,
): Promise<PaymentSourceResult> {
  const { data: run } = await supabase
    .from('salary_runs')
    .select('id, status, payment_date, period_year, period_month')
    .eq('id', runId)
    .eq('company_id', companyId)
    .maybeSingle<{
      id: string
      status: string
      payment_date: string
      period_year: number
      period_month: number
    }>()

  if (!run) return { ok: false, reason: 'not_found' }
  // Same gate as the payment-file routes: "Betalfil kan bara genereras efter
  // godkännande", and money leaving the account deserves it at least as much.
  if (!['approved', 'paid', 'booked'].includes(run.status)) {
    return { ok: false, reason: 'not_approved' }
  }

  const { data: runEmployees } = await supabase
    .from('salary_run_employees')
    .select(
      'id, net_salary, tax_withheld, tax_withheld_override, employee:employees(first_name, last_name, clearing_number, bank_account_number)',
    )
    .eq('salary_run_id', runId)

  if (!runEmployees || runEmployees.length === 0) return { ok: false, reason: 'empty' }

  type EmployeeRow = {
    first_name: string
    last_name: string
    clearing_number: string | null
    bank_account_number: string | null
  }

  const payable = runEmployees
    .map((sre) => ({
      sre: sre as unknown as {
        net_salary: number
        tax_withheld: number
        tax_withheld_override: number | null
      },
      employee: (sre as unknown as { employee: EmployeeRow | null }).employee,
    }))
    .map((row) => ({ ...row, amount: effectiveNetPayout(row.sre) }))
    .filter((row) => row.amount > 0)

  if (payable.length === 0) return { ok: false, reason: 'nothing_to_pay' }

  const missing = payable.filter(
    (row) => !row.employee?.clearing_number || !row.employee?.bank_account_number,
  )
  if (missing.length > 0) {
    return { ok: false, reason: 'payee_incomplete', detail: String(missing.length) }
  }

  const instructions: PisPaymentInstruction[] = payable.map((row) => ({
    payee: {
      type: 'bank_account',
      clearing: row.employee!.clearing_number!,
      account: row.employee!.bank_account_number!,
    },
    payeeName: `${row.employee!.first_name} ${row.employee!.last_name}`,
    amount: row.amount,
    paymentDate: run.payment_date,
  }))

  const { data: company } = await supabase
    .from('companies')
    .select('name')
    .eq('id', companyId)
    .maybeSingle<{ name: string }>()

  const debtorResolution = await resolveBatchDebtor(supabase, companyId)
  const debtor: PisDebtor = debtorResolution.ok
    ? {
        name: debtorResolution.debtor.name,
        iban: debtorResolution.debtor.iban,
        bankgiro: debtorResolution.debtor.bankgiro,
      }
    : { name: company?.name ?? '' }

  const periodLabel = `${run.period_year}-${String(run.period_month).padStart(2, '0')}`
  return { ok: true, source: { instructions, debtor, label: `Löner ${periodLabel}` } }
}
