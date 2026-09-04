/**
 * Builds Enable Banking payment-initiation requests from the same payment
 * instructions the pain.001 generators consume.
 *
 * The design rule here is that NOTHING branches on a bank's name. Every choice
 * the request makes (which payment type, whether a BankGiro creditor is even
 * addressable, whether an OCR may ride as a structured reference_number,
 * whether a future execution date is accepted, whether the debtor account must
 * be named up front) is read from the ASPSP's own `payments` capability record
 * as returned by GET /aspsps. A bank that reports it cannot do something gets a
 * refusal with a reason, never a request it will reject at signing time, after
 * the user has already been sent to BankID.
 *
 * Pure functions only: no network, no Supabase, no environment. The extension
 * layer owns the I/O.
 */

import { roundOre } from '@/lib/money'
import type { PaymentReference, SupplierPayee } from './supplier-payee'
import type {
  CreatePaymentRequest,
  CreditTransferTransaction,
  GenericIdentification,
  PaymentType,
  PsuType,
  ResponsePaymentType,
  SchemeName,
} from './pis-types'

/**
 * One payment instruction. Mirrors SupplierPain001Payment so a batch already
 * rendered into a betalfil maps to PIS without a second resolution pass.
 */
export interface PisPaymentInstruction {
  payee: SupplierPayee
  payeeName: string
  amount: number
  /** YYYY-MM-DD requested execution date. */
  paymentDate: string
  /**
   * Receiver-side matching reference. Omitted for salary payouts: the salary
   * dialect forbids remittance information (see pain001-generator.ts).
   */
  reference?: PaymentReference
  /**
   * The supplier invoice this line pays, when there is one. Carried into the
   * order item so "which invoices are sitting at the bank" is one join, not a
   * reconstruction. Null for tax and salary payments.
   */
  supplierInvoiceId?: string | null
}

/**
 * The payee columns as every payment snapshot table spells them
 * (supplier_payment_batch_items, bank_payment_order_items). Structural on
 * purpose: the same reader serves a betalfil batch row and a payment order row
 * without either table's full type being dragged in here.
 */
export interface PayeeSnapshotFields {
  payee_type: 'bankgiro' | 'plusgiro' | 'bank_account'
  payee_bankgiro?: string | null
  payee_plusgiro?: string | null
  payee_clearing?: string | null
  payee_account?: string | null
}

/**
 * Rebuild the discriminated payee from a stored snapshot row. The row's CHECK
 * constraint guarantees the matching column is present, so a missing value here
 * is a corrupted row rather than a case to paper over: it throws instead of
 * paying an empty account number.
 */
export function payeeFromSnapshot(row: PayeeSnapshotFields): SupplierPayee {
  switch (row.payee_type) {
    case 'bankgiro':
      if (!row.payee_bankgiro) throw new Error('Betalningsraden saknar bankgironummer')
      return { type: 'bankgiro', bankgiro: row.payee_bankgiro }
    case 'plusgiro':
      if (!row.payee_plusgiro) throw new Error('Betalningsraden saknar plusgironummer')
      return { type: 'plusgiro', plusgiro: row.payee_plusgiro }
    case 'bank_account':
      if (!row.payee_clearing || !row.payee_account) {
        throw new Error('Betalningsraden saknar clearing- eller kontonummer')
      }
      return { type: 'bank_account', clearing: row.payee_clearing, account: row.payee_account }
  }
}

export interface PisDebtor {
  name: string
  /** Company IBAN, digits/letters as stored. Only sent when the ASPSP demands it. */
  iban?: string | null
  bankgiro?: string | null
}

/**
 * 'giro' pays BankGiro/PlusGiro creditors (supplier invoices, the Skatteverket
 * payment); 'domestic' pays clearing+account creditors (salary payouts).
 */
export type PaymentFamily = 'giro' | 'domestic'

const FAMILY_TYPES: Record<PaymentFamily, { bulk: PaymentType; single: PaymentType }> = {
  giro: { bulk: 'BULK_DOMESTIC_SE_GIRO', single: 'DOMESTIC_SE_GIRO' },
  domestic: { bulk: 'BULK_DOMESTIC', single: 'DOMESTIC' },
}

/**
 * The receiver-side giro message field is 25 positions, same cap the pain.001
 * supplier generator applies to Ustrd. Used only when the ASPSP does not state
 * its own remittance line length.
 */
const GIRO_REMITTANCE_MAX = 25
const DOMESTIC_REMITTANCE_MAX = 140

export type PisBuildFailure =
  /** The ASPSP reports no payment type in this family at all. */
  | { reason: 'payment_type_unavailable' }
  /** More instructions than the ASPSP accepts in one payment. */
  | { reason: 'too_many_transactions'; max: number; count: number }
  /** The creditor's account scheme is not one the ASPSP accepts. */
  | { reason: 'creditor_scheme_unsupported'; scheme: SchemeName; payeeName: string }
  /** The ASPSP does not settle this currency on this payment type. */
  | { reason: 'currency_unsupported'; currency: string }
  /** The ASPSP demands a debtor account and we have none to give. */
  | { reason: 'debtor_account_missing' }
  /** The ASPSP demands remittance information the instruction cannot carry. */
  | { reason: 'remittance_required' }
  | { reason: 'no_instructions' }

export type PisBuildResult =
  | { ok: true; request: CreatePaymentRequest; capability: ResponsePaymentType }
  | ({ ok: false } & PisBuildFailure)

/**
 * Pick the payment type to use: the bulk variant when there is more than one
 * instruction and the ASPSP offers it, otherwise the single variant. A bulk
 * payment is one BankID signature for the whole batch (Länsförsäkringar calls
 * this a signed basket); falling back to the single type means one signature
 * per row, which is why bulk is preferred whenever it exists.
 *
 * Returns undefined when neither variant is offered for this PSU type.
 */
export function selectPaymentCapability(
  available: ResponsePaymentType[],
  family: PaymentFamily,
  psuType: PsuType,
  instructionCount: number,
): ResponsePaymentType | undefined {
  const { bulk, single } = FAMILY_TYPES[family]
  const forPsu = available.filter((p) => p.psu_type === psuType)
  const bulkCap = forPsu.find((p) => p.payment_type === bulk)
  const singleCap = forPsu.find((p) => p.payment_type === single)

  if (instructionCount > 1 && bulkCap) {
    // A bulk type that cannot hold the whole batch is no better than the
    // single type: the caller has to split either way, so let it fall through
    // and report the real limit against whichever type it ends up using.
    const max = bulkCap.max_transactions
    if (max === undefined || max >= instructionCount) return bulkCap
  }
  return singleCap ?? bulkCap
}

/** Wire amount: round to öre first, then render. Never rounds twice. */
export function formatWireAmount(amount: number): string {
  return roundOre(amount).toFixed(2)
}

function digits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '')
}

/** The account scheme a payee is addressed by. */
export function schemeForPayee(payee: SupplierPayee): SchemeName {
  switch (payee.type) {
    case 'bankgiro':
      return 'BGNR'
    case 'plusgiro':
      return 'PGNR'
    case 'bank_account':
      return 'BBAN'
  }
}

/**
 * Creditor account identification.
 *
 * BGNR/PGNR carry the giro number as bare digits. BBAN carries the Swedish
 * basic bank account number, which is the clearing number immediately followed
 * by the account number with no separator: that is the form Swedish ASPSPs
 * expect under the BBAN scheme, and the same pairing splitDomesticBankAccount
 * produces for the pain.001 path.
 */
export function creditorAccountFor(payee: SupplierPayee): GenericIdentification {
  switch (payee.type) {
    case 'bankgiro':
      return { identification: digits(payee.bankgiro), scheme_name: 'BGNR' }
    case 'plusgiro':
      return { identification: digits(payee.plusgiro), scheme_name: 'PGNR' }
    case 'bank_account':
      return {
        identification: `${digits(payee.clearing)}${digits(payee.account)}`,
        scheme_name: 'BBAN',
      }
  }
}

function remittanceMax(capability: ResponsePaymentType, family: PaymentFamily): number {
  const stated = capability.remittance_information_lines?.[0]?.max_length
  if (typeof stated === 'number' && stated > 0) return stated
  return family === 'giro' ? GIRO_REMITTANCE_MAX : DOMESTIC_REMITTANCE_MAX
}

/**
 * Whether a Luhn-valid OCR may ride the structured rail. Requires both that the
 * ASPSP accepts a reference_number at all and that it lists SEBG, the Swedish
 * BankGiro reference scheme. Anything else sends the OCR as plain text, which
 * still reaches the receiver as something a human can match: the same fallback
 * reasoning as resolvePaymentReference.
 */
export function canSendStructuredOcr(capability: ResponsePaymentType): boolean {
  if (!capability.reference_number_supported) return false
  const schemas = capability.reference_number_schemas
  // A bank that supports reference numbers but names no schema is taken at its
  // word: SEBG is the only Swedish scheme, so there is nothing else it could
  // mean on a domestic SE payment.
  return !schemas || schemas.length === 0 || schemas.includes('SEBG')
}

export interface BuildPaymentRequestInput {
  family: PaymentFamily
  instructions: PisPaymentInstruction[]
  debtor: PisDebtor
  aspsp: { name: string; country: string }
  psuType: PsuType
  /** Everything GET /aspsps reported for this bank and PSU type. */
  availablePaymentTypes: ResponsePaymentType[]
  redirectUrl: string
  /** Opaque handle echoed back on the redirect; the order's oauth_state. */
  state: string
  currency?: string
  language?: string
  authMethod?: string
}

/**
 * Build the CreatePaymentRequest, or refuse with a machine-readable reason.
 *
 * Every refusal here is a refusal BEFORE the user is sent to sign. That is the
 * whole point: a payment that fails at the bank after BankID leaves the user
 * unsure whether money moved, which is the one outcome this flow must not
 * produce.
 */
export function buildPaymentRequest(input: BuildPaymentRequestInput): PisBuildResult {
  const {
    family,
    instructions,
    debtor,
    aspsp,
    psuType,
    availablePaymentTypes,
    redirectUrl,
    state,
  } = input
  const currency = input.currency ?? 'SEK'

  if (instructions.length === 0) return { ok: false, reason: 'no_instructions' }

  const capability = selectPaymentCapability(
    availablePaymentTypes,
    family,
    psuType,
    instructions.length,
  )
  if (!capability) return { ok: false, reason: 'payment_type_unavailable' }

  const max = capability.max_transactions
  if (typeof max === 'number' && instructions.length > max) {
    return { ok: false, reason: 'too_many_transactions', max, count: instructions.length }
  }

  const currencies = capability.currencies
  if (currencies && currencies.length > 0 && !currencies.includes(currency)) {
    return { ok: false, reason: 'currency_unsupported', currency }
  }

  const allowedSchemes = capability.creditor_account_schemas
  for (const instruction of instructions) {
    const scheme = schemeForPayee(instruction.payee)
    if (allowedSchemes && allowedSchemes.length > 0 && !allowedSchemes.includes(scheme)) {
      return {
        ok: false,
        reason: 'creditor_scheme_unsupported',
        scheme,
        payeeName: instruction.payeeName,
      }
    }
    if (capability.remittance_information_required && !instruction.reference) {
      return { ok: false, reason: 'remittance_required' }
    }
  }

  const structuredOcr = canSendStructuredOcr(capability)
  const maxRemittance = remittanceMax(capability, family)
  const allowFutureDate = capability.requested_execution_date_supported === true

  const credit_transfer_transaction: CreditTransferTransaction[] = instructions.map(
    (instruction) => {
      const transaction: CreditTransferTransaction = {
        instructed_amount: { currency, amount: formatWireAmount(instruction.amount) },
        beneficiary: {
          creditor: { name: instruction.payeeName },
          creditor_account: creditorAccountFor(instruction.payee),
        },
      }

      if (instruction.reference) {
        if (instruction.reference.type === 'ocr' && structuredOcr) {
          transaction.reference_number = instruction.reference.value
        } else {
          transaction.remittance_information = [
            instruction.reference.value.slice(0, maxRemittance),
          ]
        }
      }

      if (allowFutureDate) {
        transaction.requested_execution_date = instruction.paymentDate
      }

      return transaction
    },
  )

  const request: CreatePaymentRequest = {
    payment_type: capability.payment_type,
    payment_request: { credit_transfer_transaction },
    aspsp,
    state,
    redirect_url: redirectUrl,
    psu_type: psuType,
  }

  if (capability.creditor_name_required || debtor.name) {
    request.payment_request.debtor = { name: debtor.name }
  }

  // The debtor account is sent ONLY when the bank insists. Otherwise the PSU
  // picks the funding account in the bank's own signing dialog, which is both
  // safer (we cannot name the wrong account) and the flow users already know
  // from uploading a betalfil.
  if (capability.debtor_account_required) {
    const debtorAccount = resolveDebtorAccount(debtor, capability.debtor_account_schemas)
    if (!debtorAccount) return { ok: false, reason: 'debtor_account_missing' }
    request.payment_request.debtor_account = debtorAccount
  }

  if (input.language) request.language = input.language
  if (input.authMethod) request.auth_method = input.authMethod

  return { ok: true, request, capability }
}

function resolveDebtorAccount(
  debtor: PisDebtor,
  schemas: SchemeName[] | undefined,
): GenericIdentification | undefined {
  const allows = (scheme: SchemeName) => !schemas || schemas.length === 0 || schemas.includes(scheme)

  const iban = (debtor.iban ?? '').replace(/\s+/g, '').toUpperCase()
  if (iban && allows('IBAN')) return { identification: iban, scheme_name: 'IBAN' }

  const bankgiro = digits(debtor.bankgiro)
  if (bankgiro && allows('BGNR')) return { identification: bankgiro, scheme_name: 'BGNR' }

  return undefined
}

/**
 * Whether an ASPSP-reported status means the payment is done and successful.
 *
 * The bank tells us which statuses are final and successful for the payment
 * type (`final_successful_statuses`); we use its answer rather than a
 * hardcoded ISO 20022 list, because banks disagree about whether ACCP alone
 * means the money will move. When the bank says nothing, fall back to the
 * settlement statuses, which are the only codes that assert settlement.
 */
const FALLBACK_SUCCESS_STATUSES = ['ACSC', 'ACSP', 'ACWC'] as const

export function isSuccessfulStatus(
  status: string,
  capability: Pick<ResponsePaymentType, 'final_successful_statuses'> | undefined,
): boolean {
  const stated = capability?.final_successful_statuses
  if (stated && stated.length > 0) return stated.includes(status)
  return (FALLBACK_SUCCESS_STATUSES as readonly string[]).includes(status)
}

/** Statuses that mean the payment will not happen. */
const TERMINAL_FAILURE_STATUSES = ['RJCT', 'CANC'] as const

export function isFailedStatus(status: string): boolean {
  return (TERMINAL_FAILURE_STATUSES as readonly string[]).includes(status)
}
