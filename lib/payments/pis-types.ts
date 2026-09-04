/**
 * Enable Banking Payment Initiation Service (PIS) wire types.
 *
 * Transcribed from the published OpenAPI schema
 * (https://enablebanking.com/docs/api/reference/enablebanking-api.yaml), narrowed
 * to the fields a Swedish domestic payment actually uses. Anything the Swedish
 * giro / domestic-transfer flows never send (standing orders, regulatory
 * reporting, Polish clearing systems, cross-border charge bearers) is left out
 * on purpose: an unused optional field is a field nobody validates.
 *
 * These live in `lib/` rather than in the enable-banking extension so the pure
 * request builders (pis-request.ts) can be unit-tested without loading the
 * extension, and so core never has to import from `@/extensions/`.
 */

/**
 * ISO 20022 payment status codes as Enable Banking reports them. Only the
 * subset the API documents is enumerated; `getPayment` widens to `string`
 * because a bank may report a code outside this list and misreading an unknown
 * code as a known one is worse than carrying it through untyped.
 */
export type PaymentStatus =
  | 'RCVD' // Received
  | 'ACTC' // AcceptedTechnicalValidation
  | 'ACCP' // AcceptedCustomerProfile
  | 'ACSC' // AcceptedSettlementCompleted
  | 'ACSP' // AcceptedSettlementInProcess
  | 'ACWC' // AcceptedWithChange
  | 'ACWP' // AcceptedWithoutPosting
  | 'PDNG' // Pending
  | 'PATC' // PartiallyAcceptedTechnicalCorrect
  | 'RCVD_AUTH' // Received, awaiting authorisation
  | 'RJCT' // Rejected
  | 'CANC' // Cancelled

/**
 * Payment types Enable Banking exposes. The Swedish flows use exactly two
 * families: the giro types (BankGiro/PlusGiro creditors, used for supplier
 * invoices and the Skatteverket payment) and the plain domestic types (clearing
 * + account creditors, used for salary payouts).
 */
export type PaymentType =
  | 'DOMESTIC_SE_GIRO'
  | 'BULK_DOMESTIC_SE_GIRO'
  | 'DOMESTIC'
  | 'BULK_DOMESTIC'
  | 'INTERNAL'
  | 'SEPA'
  | 'INST_SEPA'
  | 'BULK_SEPA'
  | 'CROSSBORDER'

/** Account identification schemes relevant to Swedish domestic payments. */
export type SchemeName = 'BGNR' | 'PGNR' | 'BBAN' | 'IBAN'

/** Reference number schemes. SEBG is the Swedish BankGiro OCR scheme. */
export type ReferenceNumberScheme = 'SEBG' | 'NORF' | 'FIRF'

export type PsuType = 'personal' | 'business'

export interface AmountType {
  currency: string
  /** Decimal string with `.` as separator, e.g. "1234.50". */
  amount: string
}

export interface GenericIdentification {
  identification: string
  scheme_name: SchemeName
  issuer?: string
}

export interface PartyIdentification {
  name?: string
  postal_address?: {
    country?: string
    town_name?: string
  }
}

export interface Beneficiary {
  creditor: PartyIdentification
  creditor_account: GenericIdentification
}

export interface CreditTransferTransaction {
  instructed_amount: AmountType
  beneficiary: Beneficiary
  /** Structured reference (OCR). Only when the ASPSP supports it. */
  reference_number?: string
  /** Free-text payment message lines. */
  remittance_information?: string[]
  /** YYYY-MM-DD. Only when the ASPSP supports future-dating. */
  requested_execution_date?: string
}

export interface PaymentRequestResource {
  credit_transfer_transaction: CreditTransferTransaction[]
  debtor?: PartyIdentification
  /** Omitted unless the ASPSP requires it; the PSU then picks in the bank UI. */
  debtor_account?: GenericIdentification
}

export interface CreatePaymentRequest {
  payment_type: PaymentType
  payment_request: PaymentRequestResource
  aspsp: { name: string; country: string }
  /** Arbitrary value echoed back on the redirect; our CSRF/lookup handle. */
  state: string
  redirect_url: string
  psu_type: PsuType
  auth_method?: string
  language?: string
  /**
   * Defer execution until an explicit POST /payments/{id}/submit. Only
   * effective when the ASPSP payment type has deferred_submission_supported.
   */
  defer_submission?: boolean
}

export interface CreatePaymentResponse {
  payment_id: string
  status: string
  /** URL the PSU must be redirected to in order to authorise the payment. */
  url: string
  psu_id_hash: string
}

export interface StatusReasonInformation {
  reason?: { code?: string; proprietary?: string }
  additional_information?: string[]
}

export interface GetPaymentResponse {
  payment_id: string
  status: string
  /** True when Enable Banking expects no further status change. */
  final_status?: boolean
  status_reason_information?: StatusReasonInformation
  payment_type?: PaymentType
  aspsp?: { name: string; country: string }
  payment_details?: {
    credit_transfer_transaction?: {
      payment_id?: { instruction_identification?: string; end_to_end_identification?: string }
      transaction_id?: string
    }[]
  }
}

export interface RemittanceInformationLineInfo {
  max_length?: number
  min_length?: number
  pattern?: string
}

/**
 * One entry of an ASPSP's `payments` array from GET /aspsps. This is the
 * capability record the request builder reads instead of branching on bank
 * name: which schemes the creditor account may use, whether an OCR may ride as
 * a structured reference_number, whether a future execution date is accepted,
 * and which statuses that bank considers final and successful.
 */
export interface ResponsePaymentType {
  payment_type: PaymentType
  psu_type: PsuType
  max_transactions?: number
  currencies?: string[]
  debtor_account_required?: boolean
  debtor_account_schemas?: SchemeName[]
  creditor_account_schemas?: SchemeName[]
  creditor_name_required?: boolean
  creditor_country_required?: boolean
  creditor_postal_address_required?: boolean
  remittance_information_required?: boolean
  remittance_information_lines?: RemittanceInformationLineInfo[]
  reference_number_supported?: boolean
  reference_number_schemas?: ReferenceNumberScheme[]
  remittance_reference_supported?: boolean
  requested_execution_date_supported?: boolean
  requested_execution_date_max_period?: number
  deferred_submission_supported?: boolean
  final_successful_statuses?: string[]
  allowed_auth_methods?: string[]
}

/** Services an Enable Banking application is licensed/contracted for. */
export type EnableBankingService = 'AIS' | 'PIS'
