'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useToast } from '@/components/ui/use-toast'
import type {
  BankPaymentOrder,
  BankPaymentOrderSourceType,
  BankPaymentOrderStatus,
} from '@/types'

/**
 * Shared client state for handing a payment to the bank over PSD2.
 *
 * Three screens can send a payment (supplier betalfil, skattekonto, salary
 * run) and they must agree on every sentence, because the sentences are about
 * money that may or may not have moved. One hook, one namespace.
 *
 * The capability answer comes from the server on every mount. It is never a
 * build-time flag: a NEXT_PUBLIC_ value is folded into the bundle and could
 * never be turned on afterwards, which is how self-hosted installs once
 * shipped silently paywalled.
 */

export interface PisCapabilities {
  enabled: boolean
  reason?: string
  bank_name?: string
  environment?: string
  payment_types?: string[]
}

/**
 * Statuses in which an order still stands between its source and a new
 * attempt. 'unknown' is included deliberately: an order whose fate could not
 * be read must be resolved by a human before the same money is sent again.
 */
export const LIVE_ORDER_STATUSES: BankPaymentOrderStatus[] = [
  'draft',
  'awaiting_authorization',
  'authorized',
  'submitted',
  'accepted',
  'unknown',
]

const CAPABILITIES_URL = '/api/extensions/ext/enable-banking/payments/capabilities'
const ORDERS_URL = '/api/extensions/ext/enable-banking/payments/orders'

export interface UseBankPaymentsOptions {
  sourceType: BankPaymentOrderSourceType
  /** Path to return to after the bank redirect; also where the toast fires. */
  returnPath: string
}

export interface UseBankPayments {
  pis: PisCapabilities | null
  /** Latest order per source id. */
  orders: Record<string, BankPaymentOrder>
  refreshOrders: () => Promise<void>
  /** True while a send is in flight. */
  sending: boolean
  /**
   * Hand a source to the bank. On success the browser navigates to BankID and
   * this never returns; on failure it toasts and resolves false.
   */
  send: (sourceId: string) => Promise<boolean>
  /** Whether this source can still be handed to the bank. */
  canSend: (sourceId: string, sourceIsOpen: boolean) => boolean
  orderFor: (sourceId: string) => BankPaymentOrder | undefined
  orderLabel: (status: BankPaymentOrderStatus) => string
}

export function useBankPayments(options: UseBankPaymentsOptions): UseBankPayments {
  const { sourceType, returnPath } = options
  const t = useTranslations('bank_payments')
  const { toast } = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [pis, setPis] = useState<PisCapabilities | null>(null)
  const [orders, setOrders] = useState<Record<string, BankPaymentOrder>>({})
  const [sending, setSending] = useState(false)

  const refreshOrders = useCallback(async () => {
    try {
      const res = await fetch(`${ORDERS_URL}?source_type=${sourceType}`)
      if (!res.ok) return
      const body = await res.json()
      const bySource: Record<string, BankPaymentOrder> = {}
      // Newest first, so the first row seen for a source is the current one.
      for (const order of (body.orders as BankPaymentOrder[]) ?? []) {
        if (!bySource[order.source_id]) bySource[order.source_id] = order
      }
      setOrders(bySource)
    } catch {
      // A disabled or absent extension is not an error on these screens: the
      // download flow is unaffected and simply nothing extra renders.
    }
  }, [sourceType])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(CAPABILITIES_URL)
        if (!res.ok) return
        const body = (await res.json()) as PisCapabilities
        if (cancelled) return
        setPis(body)
        if (body.enabled) refreshOrders()
      } catch {
        // Same reasoning as refreshOrders: silence is the correct fallback.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refreshOrders])

  // Coming back from BankID. The callback already asked the bank what happened,
  // so this only reports it and clears the params so a reload does not repeat
  // the toast.
  useEffect(() => {
    const orderId = searchParams.get('payment_order')
    const status = searchParams.get('payment_status')
    const error = searchParams.get('payment_error')
    if (!orderId && !error) return

    if (status === 'accepted') toast({ title: t('returned_accepted') })
    else if (status === 'rejected') {
      toast({ title: t('returned_rejected'), variant: 'destructive' })
    } else if (error) {
      toast({ title: t('returned_error'), variant: 'destructive' })
    } else {
      toast({ title: t('returned_pending') })
    }

    refreshOrders()
    router.replace(returnPath)
  }, [searchParams, router, toast, t, refreshOrders, returnPath])

  /**
   * Each refusal gets its own sentence. "Something went wrong" is not an answer
   * a payment screen may give: the user needs to know whether to fix data,
   * wait, or check their internet bank.
   */
  const failureDescription = useCallback(
    (reason: string | undefined, code: string | undefined): string => {
      switch (reason ?? code) {
        case 'already_sent':
          return t('error_already_sent')
        case 'no_bank_connection':
          return t('error_no_bank_connection')
        case 'aspsp_has_no_payments':
          return t('error_bank_unsupported')
        case 'build_failed':
          return t('error_build_failed')
        case 'send_indeterminate':
          return t('error_indeterminate')
        case 'send_rejected':
          return t('error_rejected')
        case 'pis_unavailable':
          return t('error_unavailable')
        case 'not_approved':
          return t('error_not_approved')
        case 'nothing_to_pay':
          return t('error_nothing_to_pay')
        case 'payee_incomplete':
          return t('error_payee_incomplete')
        case 'debtor_incomplete':
          return t('error_debtor_incomplete')
        case 'reference_unresolvable':
          return t('error_reference')
        case 'cancelled':
          return t('error_source_cancelled')
        default:
          return t('error_generic')
      }
    },
    [t],
  )

  const send = useCallback(
    async (sourceId: string): Promise<boolean> => {
      if (sending) return false
      setSending(true)
      try {
        const res = await fetch(ORDERS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // The bank redirects to one fixed callback URL, so the order has to
          // carry the screen this payment was started from.
          body: JSON.stringify({
            source_type: sourceType,
            source_id: sourceId,
            return_path: returnPath,
          }),
        })
        const body = await res.json()

        if (res.ok && body?.auth_url) {
          // The redirect IS the success path: nothing has been paid yet, and
          // saying so here would be a lie the bank has not confirmed.
          window.location.href = body.auth_url as string
          return true
        }

        toast({
          title: t('send_failed_title'),
          description: failureDescription(body?.reason, body?.code),
          variant: 'destructive',
        })
        refreshOrders()
        return false
      } catch {
        toast({
          title: t('send_failed_title'),
          description: t('error_network'),
          variant: 'destructive',
        })
        return false
      } finally {
        setSending(false)
      }
    },
    [sending, sourceType, returnPath, toast, t, failureDescription, refreshOrders],
  )

  const orderLabel = useCallback(
    (status: BankPaymentOrderStatus): string => {
      switch (status) {
        case 'draft':
        case 'awaiting_authorization':
          return t('status_awaiting')
        case 'authorized':
        case 'submitted':
          return t('status_submitted')
        case 'accepted':
          return t('status_accepted')
        case 'rejected':
          return t('status_rejected')
        case 'cancelled':
          return t('status_cancelled')
        case 'failed':
          return t('status_failed')
        case 'unknown':
          return t('status_unknown')
      }
    },
    [t],
  )

  const orderFor = useCallback((sourceId: string) => orders[sourceId], [orders])

  const canSend = useCallback(
    (sourceId: string, sourceIsOpen: boolean): boolean => {
      if (!pis?.enabled || !sourceIsOpen) return false
      const order = orders[sourceId]
      return !order || !LIVE_ORDER_STATUSES.includes(order.status)
    },
    [pis, orders],
  )

  return { pis, orders, refreshOrders, sending, send, canSend, orderFor, orderLabel }
}
