/**
 * Enable Banking Payment Initiation Service (PIS) client.
 *
 * Documentation: https://enablebanking.com/docs/api/reference/
 *
 * Flow (deliberately NOT the AIS session flow):
 * 1. POST /payments            -> { payment_id, status, url }
 * 2. Redirect the PSU to `url`, they authorise with BankID at their bank
 * 3. The bank redirects back to our redirect_url carrying our `state`
 * 4. GET /payments/{payment_id} -> status, final_status
 *
 * There is no session and no code exchange: a payment authorises itself. That
 * also means an AIS consent is neither required nor reusable here.
 *
 * The one rule this module enforces above all others: POST /payments is NOT
 * idempotent and is NEVER retried. A retried create can produce two real
 * payments, and no amount of convenience is worth that.
 */

import { ebFetch } from './api-client'
import { bankConnectorMode } from '@/lib/connect/instance/upstreams'
import { hasOwnEnableBankingCredentials } from '@/lib/entitlements/own-credentials'
import type {
  CreatePaymentRequest,
  CreatePaymentResponse,
  GetPaymentResponse,
} from '@/lib/payments/pis-types'

const MAX_STATUS_RETRIES = 2
const STATUS_RETRY_DELAY_MS = 1000

/**
 * Swedish, user-facing message persisted to bank_payment_orders.error_message.
 * Raw Enable Banking envelopes are English JSON and belong in server logs only,
 * exactly as with REAUTH_REQUIRED_MESSAGE on the AIS side.
 */
export const PAYMENT_CREATE_FAILED_MESSAGE =
  'Betalningen kunde inte skickas till banken. Försök igen, eller ladda ner betalfilen i stället.'
export const PAYMENT_STATUS_UNKNOWN_MESSAGE =
  'Betalningens status kunde inte hämtas från banken. Kontrollera i din internetbank innan du skickar om den.'

/**
 * Thrown when payment initiation is not available on this installation at all.
 * Distinct from a failed request: nothing was sent and nothing can be retried.
 */
export class PisUnavailableError extends Error {
  constructor(readonly reason: PisUnavailableReason) {
    super(`Payment initiation unavailable: ${reason}`)
    this.name = 'PisUnavailableError'
  }
}

export type PisUnavailableReason =
  /** No own Enable Banking credentials: this instance cannot sign a PIS request. */
  | 'no_own_credentials'
  /**
   * The instance routes bank traffic through the hosted connector proxy. That
   * proxy has no /payments path and hosted holds no PISP licence, so a payment
   * must never be attempted there.
   */
  | 'connector_mode'

/** Thrown on a non-OK response from the payments endpoints. */
export class PaymentInitiationError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Payment request failed (${status}): ${body}`)
    this.name = 'PaymentInitiationError'
  }
}

/**
 * Assert that payment initiation may run on this installation, or throw.
 *
 * Both conditions are checked, not one: own credentials answer "can we sign a
 * request", connector mode answers "should we be talking to Enable Banking
 * directly at all". A canaried company has own credentials but is routed
 * through the proxy, and a payment must not slip through that gap.
 */
export function assertPisRoutable(companyId?: string): void {
  if (!hasOwnEnableBankingCredentials()) {
    throw new PisUnavailableError('no_own_credentials')
  }
  if (bankConnectorMode(companyId)) {
    throw new PisUnavailableError('connector_mode')
  }
}

/**
 * Create a payment. Returns the Enable Banking payment id and the URL the PSU
 * must be redirected to in order to authorise it.
 *
 * No retry, at any status. If this throws, the caller must assume the payment
 * MAY have been created upstream and surface that ambiguity rather than
 * sending again.
 */
export async function createPayment(
  request: CreatePaymentRequest,
  companyId?: string,
): Promise<CreatePaymentResponse> {
  assertPisRoutable(companyId)

  const response = await ebFetch('/payments', {
    method: 'POST',
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    const body = await response.text()
    console.error('[enable-banking] createPayment failed', {
      status: response.status,
      statusText: response.statusText,
      body,
      paymentType: request.payment_type,
      aspsp: request.aspsp,
      transactionCount: request.payment_request.credit_transfer_transaction.length,
    })
    throw new PaymentInitiationError(response.status, body)
  }

  return response.json()
}

/**
 * Fetch a payment's current status. Safe to retry: this is a plain read, and
 * the polling cron depends on it surviving a transient upstream hiccup.
 */
export async function getPayment(
  paymentId: string,
  companyId?: string,
): Promise<GetPaymentResponse> {
  assertPisRoutable(companyId)

  for (let attempt = 0; attempt <= MAX_STATUS_RETRIES; attempt++) {
    let response: Response
    try {
      response = await ebFetch(`/payments/${encodeURIComponent(paymentId)}`)
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError'
      if (attempt < MAX_STATUS_RETRIES && isAbort) {
        await new Promise((resolve) => setTimeout(resolve, STATUS_RETRY_DELAY_MS * (attempt + 1)))
        continue
      }
      throw error
    }

    if (response.ok) return response.json()

    if (attempt < MAX_STATUS_RETRIES && [429, 502, 503, 504].includes(response.status)) {
      await new Promise((resolve) => setTimeout(resolve, STATUS_RETRY_DELAY_MS * (attempt + 1)))
      continue
    }

    const body = await response.text()
    console.error('[enable-banking] getPayment failed', {
      status: response.status,
      statusText: response.statusText,
      body,
      paymentId,
    })
    throw new PaymentInitiationError(response.status, body)
  }

  throw new Error('Max retries exceeded')
}

/**
 * Explicitly submit a payment created with defer_submission=true. Only valid
 * when the ASPSP payment type reports deferred_submission_supported; the
 * default flow submits automatically after authorisation and never calls this.
 *
 * Not retried, for the same reason createPayment is not.
 */
export async function submitPayment(
  paymentId: string,
  companyId?: string,
): Promise<GetPaymentResponse> {
  assertPisRoutable(companyId)

  const response = await ebFetch(`/payments/${encodeURIComponent(paymentId)}/submit`, {
    method: 'POST',
    body: JSON.stringify({}),
  })

  if (!response.ok) {
    const body = await response.text()
    console.error('[enable-banking] submitPayment failed', {
      status: response.status,
      statusText: response.statusText,
      body,
      paymentId,
    })
    throw new PaymentInitiationError(response.status, body)
  }

  return response.json()
}
