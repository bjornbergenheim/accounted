/**
 * Payment orders: creating, sending and following up a PSD2 payment.
 *
 * The lifecycle, and why each step is where it is:
 *
 *   1. Build the request from a stored snapshot (a betalfil batch, an AGI
 *      period, a salary run). Everything that could refuse is checked BEFORE
 *      the user is sent to BankID: a payment that fails after signing leaves
 *      them unsure whether money moved.
 *   2. Write the order in status 'draft' through create_bank_payment_order.
 *      The RPC is the only writer and holds the one-live-order-per-source
 *      guarantee.
 *   3. POST /payments, exactly once, never retried.
 *   4. Follow the status with GET /payments/{id}, from the callback and from
 *      the polling cron.
 *
 * Nothing here books anything. Settlement stays with bank matching and
 * mark-as-paid (DECISIONS.md 2026-08-10).
 */

import { randomUUID } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  BankPaymentOrder,
  BankPaymentOrderSourceType,
  BankPaymentOrderStatus,
} from '@/types'
import {
  buildPaymentRequest,
  isFailedStatus,
  isSuccessfulStatus,
  payeeFromSnapshot,
  type PaymentFamily,
  type PisBuildFailure,
  type PisDebtor,
  type PisPaymentInstruction,
} from '@/lib/payments/pis-request'
import type { PsuType, ResponsePaymentType } from '@/lib/payments/pis-types'
import {
  createPayment,
  getPayment,
  PaymentInitiationError,
  PisUnavailableError,
  PAYMENT_CREATE_FAILED_MESSAGE,
  PAYMENT_STATUS_UNKNOWN_MESSAGE,
} from './payments-client'
import { getAspspPaymentTypes, resolvePisAvailability, type PisUnavailableCode } from './payment-capabilities'

/** Bank identity a payment is initiated against. */
export interface OrderBankIdentity {
  connectionId: string | null
  aspspName: string
  aspspCountry: string
  psuType: PsuType
}

export type OrderFailure =
  | { reason: 'pis_unavailable'; code: PisUnavailableCode }
  | { reason: 'no_bank_connection' }
  | { reason: 'aspsp_has_no_payments' }
  | { reason: 'build_failed'; failure: PisBuildFailure }
  | { reason: 'already_sent'; orderId: string; status: string }
  | { reason: 'create_failed'; detail: string }
  /**
   * The create call failed in a way that proves nothing was created upstream
   * (the bank rejected the request). The source is free to retry.
   */
  | { reason: 'send_rejected'; orderId: string; detail: string }
  /**
   * The create call failed without telling us whether a payment exists. The
   * order is parked in 'unknown' and the source stays blocked until a human
   * confirms in their internet bank.
   */
  | { reason: 'send_indeterminate'; orderId: string }

export type OrderResult =
  | { ok: true; order: BankPaymentOrder; authUrl: string }
  | ({ ok: false } & OrderFailure)

/**
 * Resolve which bank a payment goes to.
 *
 * Payment initiation needs no AIS consent, but it does need to know the ASPSP,
 * and the company's existing bank connection is the only place that knowledge
 * lives. An active connection wins; a lapsed one still names the right bank, so
 * it is accepted rather than forcing a reconnect the payment does not need.
 */
export async function resolveOrderBankIdentity(
  supabase: SupabaseClient,
  companyId: string,
): Promise<OrderBankIdentity | null> {
  const { data, error } = await supabase
    .from('bank_connections')
    .select('id, bank_name, provider, psu_type, status, last_synced_at')
    .eq('company_id', companyId)
    .is('superseded_by', null)
    .in('status', ['active', 'pending_selection', 'expired', 'error'])
    .order('last_synced_at', { ascending: false, nullsFirst: false })

  if (error || !data || data.length === 0) return null

  const preferred = data.find((row) => row.status === 'active') ?? data[0]
  if (!preferred.bank_name) return null

  // The provider slug ends with the country code, e.g. "nordea-se". Same
  // derivation the reconnect path uses.
  const country = preferred.provider?.split('-').pop()?.toUpperCase() || 'SE'
  const psuType: PsuType = preferred.psu_type === 'personal' ? 'personal' : 'business'

  return {
    connectionId: preferred.id,
    aspspName: preferred.bank_name,
    aspspCountry: country,
    psuType,
  }
}

export interface CreateOrderInput {
  supabase: SupabaseClient
  companyId: string
  userId: string
  sourceType: BankPaymentOrderSourceType
  sourceId: string
  family: PaymentFamily
  instructions: PisPaymentInstruction[]
  debtor: PisDebtor
  /** Absolute origin of this instance, e.g. https://accounted.example.com */
  origin: string
  /** Where to send the user after the bank redirect, as a path on this instance. */
  returnPath: string
}

/**
 * The redirect Enable Banking sends the PSU back to. Must be whitelisted in the
 * Enable Banking control panel alongside the AIS callback.
 */
export function paymentCallbackUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/api/extensions/enable-banking/payments/callback`
}

/**
 * Build, persist and send a payment order in one call.
 *
 * Returns the order plus the URL the caller must redirect the user to. Every
 * failure mode is named, because "something went wrong" is the one answer a
 * payment screen may never give.
 */
export async function createAndSendOrder(input: CreateOrderInput): Promise<OrderResult> {
  const { supabase, companyId, userId, sourceType, sourceId, family, instructions, debtor } = input

  const availability = await resolvePisAvailability(companyId)
  if (!availability.enabled) {
    return { ok: false, reason: 'pis_unavailable', code: availability.reason }
  }

  const identity = await resolveOrderBankIdentity(supabase, companyId)
  if (!identity) return { ok: false, reason: 'no_bank_connection' }

  const paymentTypes = await getAspspPaymentTypes(
    identity.aspspName,
    identity.aspspCountry,
    identity.psuType,
  )
  if (paymentTypes.length === 0) return { ok: false, reason: 'aspsp_has_no_payments' }

  const orderId = randomUUID()
  const state = randomUUID()

  const built = buildPaymentRequest({
    family,
    instructions,
    debtor,
    aspsp: { name: identity.aspspName, country: identity.aspspCountry },
    psuType: identity.psuType,
    availablePaymentTypes: paymentTypes,
    redirectUrl: paymentCallbackUrl(input.origin),
    state,
  })
  if (!built.ok) {
    const { ok: _ok, ...failure } = built
    return { ok: false, reason: 'build_failed', failure }
  }

  const { data: rpcData, error: rpcError } = await supabase.rpc('create_bank_payment_order', {
    p_company_id: companyId,
    p_order_id: orderId,
    p_source_type: sourceType,
    p_source_id: sourceId,
    p_aspsp_name: identity.aspspName,
    p_aspsp_country: identity.aspspCountry,
    p_psu_type: identity.psuType,
    p_payment_type: built.request.payment_type,
    p_currency: built.request.payment_request.credit_transfer_transaction[0].instructed_amount.currency,
    p_requested_execution_date:
      built.request.payment_request.credit_transfer_transaction[0].requested_execution_date ?? null,
    p_bank_connection_id: identity.connectionId,
    p_request_snapshot: built.request,
    p_oauth_state: state,
    p_return_path: input.returnPath,
    p_items: instructions.map((instruction) => toItemRow(instruction)),
    p_user_id: userId,
  })

  if (rpcError) {
    return { ok: false, reason: 'create_failed', detail: rpcError.message }
  }
  const rpc = rpcData as { ok: boolean; code?: string; details?: unknown; order?: BankPaymentOrder }
  if (!rpc?.ok) {
    if (rpc?.code === 'already_sent') {
      const details = rpc.details as { order_id?: string; status?: string } | undefined
      return {
        ok: false,
        reason: 'already_sent',
        orderId: details?.order_id ?? '',
        status: details?.status ?? 'unknown',
      }
    }
    return { ok: false, reason: 'create_failed', detail: String(rpc?.code ?? 'create_failed') }
  }

  // From here on an order row exists, so every exit updates it.
  try {
    const created = await createPayment(built.request, companyId)
    const { data: updated } = await supabase
      .from('bank_payment_orders')
      .update({
        eb_payment_id: created.payment_id,
        auth_url: created.url,
        eb_status: created.status,
        status: AWAITING_AUTHORIZATION,
      })
      .eq('id', orderId)
      .eq('company_id', companyId)
      .select()
      .single()

    return { ok: true, order: (updated ?? rpc.order) as BankPaymentOrder, authUrl: created.url }
  } catch (error) {
    // A 4xx from Enable Banking means the request was refused and no payment
    // exists: the order fails and the source is free to try again. Anything
    // else (timeout, network drop, 5xx) does NOT tell us whether a payment was
    // created, so the order parks in 'unknown' and keeps the source blocked
    // until a human has looked in the bank. Claiming failure there would invite
    // the retry that double-pays.
    const indeterminate =
      !(error instanceof PaymentInitiationError) ||
      error.status >= 500 ||
      error.status === 408 ||
      error.status === 429

    if (error instanceof PisUnavailableError) {
      await supabase
        .from('bank_payment_orders')
        .update({
          status: FAILED,
          error_message: PAYMENT_CREATE_FAILED_MESSAGE,
        })
        .eq('id', orderId)
        .eq('company_id', companyId)
      return { ok: false, reason: 'pis_unavailable', code: error.reason }
    }

    await supabase
      .from('bank_payment_orders')
      .update({
        status: indeterminate ? UNKNOWN : FAILED,
        error_message: indeterminate
          ? PAYMENT_STATUS_UNKNOWN_MESSAGE
          : PAYMENT_CREATE_FAILED_MESSAGE,
        status_reason: error instanceof PaymentInitiationError ? String(error.status) : 'network',
      })
      .eq('id', orderId)
      .eq('company_id', companyId)

    if (indeterminate) return { ok: false, reason: 'send_indeterminate', orderId }
    return {
      ok: false,
      reason: 'send_rejected',
      orderId,
      detail: error instanceof PaymentInitiationError ? error.body : String(error),
    }
  }
}

function toItemRow(instruction: PisPaymentInstruction) {
  const payee = instruction.payee
  return {
    supplier_invoice_id: instruction.supplierInvoiceId ?? null,
    amount: instruction.amount,
    payment_date: instruction.paymentDate,
    payee_type: payee.type,
    payee_bankgiro: payee.type === 'bankgiro' ? payee.bankgiro : null,
    payee_plusgiro: payee.type === 'plusgiro' ? payee.plusgiro : null,
    payee_clearing: payee.type === 'bank_account' ? payee.clearing : null,
    payee_account: payee.type === 'bank_account' ? payee.account : null,
    payee_name: instruction.payeeName,
    reference_type: instruction.reference?.type ?? null,
    reference: instruction.reference?.value ?? null,
  }
}

/**
 * Map the bank's raw ISO 20022 code onto our lifecycle.
 *
 * Success is whatever the ASPSP itself calls final and successful; we do not
 * decide on its behalf, because banks disagree about whether ACCP alone means
 * the money will move. A code that is final but neither a known success nor a
 * known failure becomes 'unknown', which is an answer the UI can act on
 * (check your internet bank) rather than a guess.
 */
export function mapPaymentStatus(
  ebStatus: string,
  finalStatus: boolean,
  capability: ResponsePaymentType | undefined,
): BankPaymentOrderStatus {
  if (ebStatus === 'RJCT') return 'rejected'
  if (ebStatus === 'CANC') return 'cancelled'
  if (isSuccessfulStatus(ebStatus, capability)) return 'accepted'
  if (isFailedStatus(ebStatus)) return 'rejected'
  if (finalStatus) return 'unknown'
  if (ebStatus === 'RCVD') return 'awaiting_authorization'
  return 'submitted'
}

// Named constants so every write is a plain literal the schema guard can read.
const AWAITING_AUTHORIZATION: BankPaymentOrderStatus = 'awaiting_authorization'
const FAILED: BankPaymentOrderStatus = 'failed'
const UNKNOWN: BankPaymentOrderStatus = 'unknown'

const TERMINAL_STATUSES: BankPaymentOrderStatus[] = ['accepted', 'rejected', 'cancelled', 'failed']

/** Swedish, user-facing. Stored on the order when the bank refuses it. */
const PAYMENT_REJECTED_MESSAGE =
  'Banken avvisade betalningen. Kontrollera uppgifterna och försök igen.'

export type RefreshResult =
  | { ok: true; status: BankPaymentOrderStatus; changed: boolean }
  | { ok: false; reason: 'not_sent' | 'terminal' | 'lookup_failed' }

/**
 * Re-read a payment's status from the bank and persist it. Idempotent: safe to
 * call from the redirect callback and the polling cron for the same order.
 */
export async function refreshOrderStatus(
  supabase: SupabaseClient,
  order: Pick<
    BankPaymentOrder,
    | 'id'
    | 'company_id'
    | 'eb_payment_id'
    | 'status'
    | 'aspsp_name'
    | 'aspsp_country'
    | 'psu_type'
    | 'payment_type'
    | 'submitted_at'
    | 'completed_at'
    | 'error_message'
  >,
): Promise<RefreshResult> {
  if (!order.eb_payment_id) return { ok: false, reason: 'not_sent' }
  if (TERMINAL_STATUSES.includes(order.status)) return { ok: false, reason: 'terminal' }

  let payment
  try {
    payment = await getPayment(order.eb_payment_id, order.company_id)
  } catch (error) {
    console.error('[enable-banking] refreshOrderStatus: status lookup failed', {
      orderId: order.id,
      paymentId: order.eb_payment_id,
      error: error instanceof Error ? error.message : String(error),
    })
    await supabase
      .from('bank_payment_orders')
      .update({ last_polled_at: new Date().toISOString() })
      .eq('id', order.id)
      .eq('company_id', order.company_id)
    return { ok: false, reason: 'lookup_failed' }
  }

  // Best effort: a capability lookup failure only costs us the bank's own
  // definition of success, and isSuccessfulStatus falls back to the settlement
  // codes. It must never block recording a status we already have.
  let capability: ResponsePaymentType | undefined
  try {
    const psuType: PsuType = order.psu_type === 'personal' ? 'personal' : 'business'
    const types = await getAspspPaymentTypes(order.aspsp_name, order.aspsp_country, psuType)
    capability = types.find((t) => t.payment_type === order.payment_type)
  } catch {
    capability = undefined
  }

  const ebStatus = payment.status
  const finalStatus = payment.final_status === true
  const status = mapPaymentStatus(ebStatus, finalStatus, capability)
  const now = new Date().toISOString()

  const settled = status === 'accepted' || status === 'rejected'

  // One literal payload, every field written every time. Each conditional
  // resolves to the value the column should hold now, so a repeat poll cannot
  // move a timestamp that was already stamped:
  // 'authorized' / authorized_at belong to the deferred-submission path
  // (defer_submission + POST /payments/{id}/submit), which no flow uses yet:
  // GET /payments alone cannot distinguish "signed" from "submitted".
  const { error } = await supabase
    .from('bank_payment_orders')
    .update({
      status,
      eb_status: ebStatus,
      final_status: finalStatus || TERMINAL_STATUSES.includes(status),
      status_reason: describeStatusReason(payment.status_reason_information),
      error_message: status === 'rejected' ? PAYMENT_REJECTED_MESSAGE : order.error_message,
      last_polled_at: now,
      submitted_at: status === 'submitted' ? (order.submitted_at ?? now) : order.submitted_at,
      completed_at: settled ? (order.completed_at ?? now) : order.completed_at,
    })
    .eq('id', order.id)
    .eq('company_id', order.company_id)

  if (error) {
    console.error('[enable-banking] refreshOrderStatus: persist failed', {
      orderId: order.id,
      error: error.message,
    })
    return { ok: false, reason: 'lookup_failed' }
  }

  return { ok: true, status, changed: status !== order.status }
}

function describeStatusReason(
  info: { reason?: { code?: string; proprietary?: string }; additional_information?: string[] } | undefined,
): string | null {
  if (!info) return null
  const parts = [info.reason?.code, info.reason?.proprietary, ...(info.additional_information ?? [])]
  const joined = parts.filter(Boolean).join(' ').trim()
  return joined ? joined.slice(0, 500) : null
}

export { payeeFromSnapshot }
