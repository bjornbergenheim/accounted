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

export interface PaymentSource {
  instructions: PisPaymentInstruction[]
  debtor: PisDebtor
  /** Human label for the confirmation dialog, e.g. "Betalfil 2026-09-05". */
  label: string
}

export type PaymentSourceResult =
  | { ok: true; source: PaymentSource }
  | { ok: false; reason: 'not_found' | 'cancelled' | 'empty' }

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
