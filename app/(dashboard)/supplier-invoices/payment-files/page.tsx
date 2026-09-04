'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { PageHeader } from '@/components/ui/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { TH_CLASS, TD_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  SlideOver,
  SlideOverBody,
  SlideOverContent,
  SlideOverFooter,
  SlideOverHeader,
} from '@/components/ui/slide-over'
import { FileText, Loader2 } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { downloadFile } from '@/lib/browser/download-file'
import { failureDescription } from '@/lib/browser/action-failure'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import type {
  BankPaymentOrder,
  BankPaymentOrderStatus,
  SupplierPaymentBatch,
  SupplierPaymentBatchItem,
} from '@/types'

type BatchListRow = SupplierPaymentBatch & { settled_count: number }

/**
 * Payment initiation is opt-in and self-host-only, so the affordance below only
 * appears when the server says the whole chain is in place (own Enable Banking
 * credentials, the PIS service on the application, a bank that supports it).
 * The answer must come from the server: a NEXT_PUBLIC_ flag would be folded
 * into the bundle at build time and could never be turned on afterwards.
 */
interface PisCapabilities {
  enabled: boolean
  reason?: string
  bank_name?: string
}

/**
 * Statuses in which an order still stands between a batch and a new attempt.
 * 'unknown' is included deliberately: an order whose fate we could not read
 * must be resolved by a human before the same money can be sent again.
 */
const LIVE_ORDER_STATUSES: BankPaymentOrderStatus[] = [
  'draft',
  'awaiting_authorization',
  'authorized',
  'submitted',
  'accepted',
  'unknown',
]

type BatchItemWithInvoice = SupplierPaymentBatchItem & {
  invoice: {
    id: string
    status: string
    remaining_amount: number
    supplier_invoice_number: string
    arrival_number: number
  } | null
}

type BatchDetail = SupplierPaymentBatch & { items: BatchItemWithInvoice[] }

/** Mirrors the öre epsilon the server derives settled_count with. */
const SETTLED_EPSILON = 0.005

function batchFilename(batch: Pick<SupplierPaymentBatch, 'id' | 'created_at'>): string {
  const datePart = batch.created_at.slice(0, 10).replace(/-/g, '')
  return `betalfil_${datePart}_${batch.id.replace(/-/g, '').slice(0, 8)}.xml`
}

export default function PaymentFilesPage() {
  const t = useTranslations('supplier_payment_files')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite } = useCanWrite()

  const [batches, setBatches] = useState<BatchListRow[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [detail, setDetail] = useState<BatchDetail | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [markingAll, setMarkingAll] = useState(false)

  const router = useRouter()
  const searchParams = useSearchParams()
  const [pis, setPis] = useState<PisCapabilities | null>(null)
  const [orders, setOrders] = useState<Record<string, BankPaymentOrder>>({})
  const [confirmSendBatch, setConfirmSendBatch] = useState<BatchListRow | BatchDetail | null>(null)
  const [sending, setSending] = useState(false)

  const fetchBatches = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await fetch('/api/supplier-invoices/payment-batches?status=all')
      const body = await res.json()
      setBatches((body.data as BatchListRow[]) ?? [])
    } finally {
      setIsLoading(false)
    }
  }, [])

  /**
   * Latest order per batch. The list is newest-first, so the first row seen for
   * a source is the one that decides what the batch shows.
   */
  const fetchOrders = useCallback(async () => {
    try {
      const res = await fetch(
        '/api/extensions/ext/enable-banking/payments/orders?source_type=supplier_batch',
      )
      if (!res.ok) return
      const body = await res.json()
      const bySource: Record<string, BankPaymentOrder> = {}
      for (const order of (body.orders as BankPaymentOrder[]) ?? []) {
        if (!bySource[order.source_id]) bySource[order.source_id] = order
      }
      setOrders(bySource)
    } catch {
      // A missing or disabled extension is not an error on this page: the
      // download flow is unaffected and simply nothing extra renders.
    }
  }, [])

  useEffect(() => {
    fetchBatches()
  }, [fetchBatches])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/extensions/ext/enable-banking/payments/capabilities')
        if (!res.ok) return
        const body = (await res.json()) as PisCapabilities
        if (cancelled) return
        setPis(body)
        if (body.enabled) fetchOrders()
      } catch {
        // Same reasoning as fetchOrders: silence is the correct fallback.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fetchOrders])

  // Coming back from BankID. The callback already asked the bank what happened,
  // so this only reports it and clears the params so a reload does not repeat
  // the toast.
  useEffect(() => {
    const orderId = searchParams.get('payment_order')
    const status = searchParams.get('payment_status')
    const error = searchParams.get('payment_error')
    if (!orderId && !error) return

    if (status === 'accepted') toast({ title: t('order_returned_accepted') })
    else if (status === 'rejected') {
      toast({ title: t('order_returned_rejected'), variant: 'destructive' })
    } else if (error) {
      toast({ title: t('order_returned_error'), variant: 'destructive' })
    } else {
      toast({ title: t('order_returned_pending') })
    }

    fetchOrders()
    router.replace('/supplier-invoices/payment-files')
  }, [searchParams, router, toast, t, fetchOrders])

  const openDetail = useCallback(async (id: string) => {
    setDetailId(id)
    setDetail(null)
    const res = await fetch(`/api/supplier-invoices/payment-batches/${id}`)
    if (!res.ok) {
      setDetailId(null)
      return
    }
    const body = await res.json()
    setDetail(body.data as BatchDetail)
  }, [])

  async function handleDownload(batch: Pick<SupplierPaymentBatch, 'id' | 'created_at'>) {
    if (downloadingId) return
    setDownloadingId(batch.id)
    try {
      const result = await downloadFile({
        url: `/api/supplier-invoices/payment-batches/${batch.id}/file`,
        filename: batchFilename(batch),
        locale,
      })
      if (!result.ok) {
        toast({
          title: t('download_failed_title'),
          description: failureDescription(result, {
            timeout: t('download_timeout'),
            network: t('download_network'),
          }),
          variant: 'destructive',
        })
      }
    } finally {
      setDownloadingId(null)
    }
  }

  /**
   * Hand the batch to the bank and send the user on to BankID.
   *
   * The redirect is the success path, so nothing is reported as done here: the
   * money has not moved until the bank says so, and the callback is what
   * records that. A 409 means an order for this batch already exists, which is
   * the guard against paying the same invoices twice.
   */
  async function handleSendToBank() {
    if (!confirmSendBatch || sending) return
    setSending(true)
    try {
      const res = await fetch('/api/extensions/ext/enable-banking/payments/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_type: 'supplier_batch', source_id: confirmSendBatch.id }),
      })
      const body = await res.json()

      if (res.ok && body?.auth_url) {
        window.location.href = body.auth_url as string
        return
      }

      toast({
        title: t('send_failed_title'),
        description: sendFailureDescription(body?.reason as string | undefined),
        variant: 'destructive',
      })
      setConfirmSendBatch(null)
      fetchOrders()
    } catch {
      toast({ title: t('send_failed_title'), description: t('send_network'), variant: 'destructive' })
      setConfirmSendBatch(null)
    } finally {
      setSending(false)
    }
  }

  /**
   * Each refusal gets its own sentence. "Something went wrong" is not an answer
   * a payment screen may give: the user needs to know whether to fix data, wait,
   * or check their internet bank.
   */
  function sendFailureDescription(reason: string | undefined): string {
    switch (reason) {
      case 'already_sent':
        return t('send_error_already_sent')
      case 'no_bank_connection':
        return t('send_error_no_bank_connection')
      case 'aspsp_has_no_payments':
        return t('send_error_bank_unsupported')
      case 'build_failed':
        return t('send_error_build_failed')
      case 'send_indeterminate':
        return t('send_error_indeterminate')
      case 'send_rejected':
        return t('send_error_rejected')
      case 'pis_unavailable':
        return t('send_error_unavailable')
      default:
        return t('send_error_generic')
    }
  }

  function orderLabel(status: BankPaymentOrderStatus): string {
    switch (status) {
      case 'draft':
      case 'awaiting_authorization':
        return t('order_status_awaiting')
      case 'authorized':
      case 'submitted':
        return t('order_status_submitted')
      case 'accepted':
        return t('order_status_accepted')
      case 'rejected':
        return t('order_status_rejected')
      case 'cancelled':
        return t('order_status_cancelled')
      case 'failed':
        return t('order_status_failed')
      case 'unknown':
        return t('order_status_unknown')
    }
  }

  /** Whether this batch can still be handed to the bank. */
  function canSend(batch: Pick<SupplierPaymentBatch, 'id' | 'status'>): boolean {
    if (!pis?.enabled || !canWrite) return false
    if (batch.status !== 'created') return false
    const order = orders[batch.id]
    return !order || !LIVE_ORDER_STATUSES.includes(order.status)
  }

  async function handleCancel() {
    if (!confirmCancelId || cancelling) return
    setCancelling(true)
    try {
      const res = await fetch(
        `/api/supplier-invoices/payment-batches/${confirmCancelId}/cancel`,
        { method: 'POST' },
      )
      const body = await res.json()
      if (!res.ok) {
        toast({
          title: t('cancel_failed_title'),
          description: getErrorMessage(body, { locale }),
          variant: 'destructive',
        })
      } else {
        toast({ title: t('cancelled_toast') })
      }
      setConfirmCancelId(null)
      setDetailId(null)
      fetchBatches()
    } finally {
      setCancelling(false)
    }
  }

  // Sequential mark-paid per item, reusing the existing per-invoice route with
  // its duplicate-payment guard intact. Never force: a 409 duplicate means a
  // matching bank transaction is already in the feed and bank matching is the
  // right way to settle that invoice.
  async function handleMarkAllPaid() {
    if (!detail || markingAll) return
    setMarkingAll(true)
    let booked = 0
    let skippedSettled = 0
    let skippedDuplicate = 0
    let failed = 0
    try {
      for (const item of detail.items) {
        const invoice = item.invoice
        if (!invoice || invoice.remaining_amount <= SETTLED_EPSILON) {
          skippedSettled += 1
          continue
        }
        try {
          const res = await fetch(`/api/supplier-invoices/${item.supplier_invoice_id}/mark-paid`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              amount: Math.min(item.amount, invoice.remaining_amount),
              payment_date: item.payment_date,
            }),
          })
          if (res.ok) {
            booked += 1
            continue
          }
          const body = await res.json()
          if (body?.error?.code === 'SI_PAID_LIKELY_DUPLICATE') skippedDuplicate += 1
          else failed += 1
        } catch {
          failed += 1
        }
      }

      toast({
        title: t('mark_all_result_title', { booked }),
        description:
          skippedDuplicate > 0
            ? t('mark_all_result_duplicates', { count: skippedDuplicate })
            : failed > 0
              ? t('mark_all_result_failed', { count: failed })
              : skippedSettled > 0
                ? t('mark_all_result_settled', { count: skippedSettled })
                : undefined,
        variant: failed > 0 ? 'destructive' : undefined,
      })
      await fetchBatches()
      if (detailId) await openDetail(detailId)
    } finally {
      setMarkingAll(false)
    }
  }

  const detailUnsettled =
    detail?.items.filter(
      (item) => item.invoice && item.invoice.remaining_amount > SETTLED_EPSILON,
    ).length ?? 0

  return (
    <div className="space-y-8">
      <PageHeader title={t('history_title')} />

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 w-20 flex-1" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      ) : batches.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={t('empty_title')}
          description={t('empty_description')}
          actionLabel={t('empty_action')}
          actionHref="/supplier-invoices"
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={TH_CLASS}>{t('th_created')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('th_count')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('th_total')}</th>
                <th className={cn(TH_CLASS, 'w-full')}>{t('th_status')}</th>
                <th className={cn(TH_CLASS, 'w-[260px]')} aria-hidden="true"></th>
              </tr>
            </thead>
            <tbody className="stagger-enter">
              {batches.map((batch) => (
                <tr
                  key={batch.id}
                  className="group cursor-pointer transition-colors duration-150 hover:bg-secondary/35"
                  onClick={() => openDetail(batch.id)}
                >
                  <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>
                    {formatDate(batch.created_at)}
                  </td>
                  <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>
                    {batch.item_count}
                  </td>
                  <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums rr-mask')}>
                    {formatCurrency(batch.total_amount)}
                  </td>
                  <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                    {batch.status === 'cancelled' ? (
                      <Badge variant="outline" className="font-normal">
                        {t('status_cancelled')}
                      </Badge>
                    ) : orders[batch.id] && orders[batch.id].status !== 'accepted' ? (
                      // Chips mark exceptions: an order that is waiting, was
                      // refused, or whose fate is unknown is exactly that. A
                      // completed one falls back to the normal settled counter.
                      <Badge variant="outline" className="font-normal">
                        {orderLabel(orders[batch.id].status)}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">
                        {t('settled_count', {
                          settled: batch.settled_count,
                          total: batch.item_count,
                        })}
                      </span>
                    )}
                  </td>
                  <td
                    className={cn(TD_CLASS, 'whitespace-nowrap text-right')}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className="flex items-center justify-end gap-4 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
                      {canSend(batch) && (
                        <button
                          type="button"
                          className={QUIET_LINK_CLASS}
                          onClick={() => setConfirmSendBatch(batch)}
                        >
                          {t('send_to_bank')}
                        </button>
                      )}
                      {batch.status === 'created' && (
                        <button
                          type="button"
                          className={QUIET_LINK_CLASS}
                          onClick={() => handleDownload(batch)}
                          disabled={downloadingId !== null}
                        >
                          {t('download_again')}
                        </button>
                      )}
                      {batch.status === 'created' && canWrite && (
                        <button
                          type="button"
                          className={QUIET_LINK_CLASS}
                          onClick={() => setConfirmCancelId(batch.id)}
                        >
                          {t('cancel_batch')}
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Batch detail: right slide-over (convention 13). */}
      <SlideOver
        open={detailId != null}
        onOpenChange={(open) => {
          if (!open) {
            setDetailId(null)
            setDetail(null)
          }
        }}
      >
        <SlideOverContent aria-describedby={undefined}>
          {detail ? (
            <>
              <SlideOverHeader
                kicker={formatDate(detail.created_at)}
                title={t('detail_title', { count: detail.item_count })}
              />
              <SlideOverBody className="space-y-4">
                {detail.status === 'cancelled' && (
                  <Badge variant="outline" className="font-normal">
                    {t('status_cancelled')}
                  </Badge>
                )}
                <div className="space-y-0">
                  {detail.items.map((item) => {
                    const settled =
                      !item.invoice || item.invoice.remaining_amount <= SETTLED_EPSILON
                    return (
                      <div
                        key={item.id}
                        className="flex items-center gap-3 border-b border-border/60 py-2.5 text-[13px]"
                      >
                        <div className="min-w-0 flex-1">
                          <Link
                            href={`/supplier-invoices/${item.supplier_invoice_id}`}
                            className="block truncate hover:underline"
                          >
                            {item.payee_name}
                          </Link>
                          <span className="block text-[11px] text-muted-foreground tabular-nums">
                            {item.invoice?.supplier_invoice_number ?? item.reference}
                            {' · '}
                            {formatDate(item.payment_date)}
                          </span>
                        </div>
                        {settled ? (
                          <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                            {t('item_settled')}
                          </span>
                        ) : (
                          <Badge variant="outline" className="font-normal">
                            {t('item_unsettled')}
                          </Badge>
                        )}
                        <span className="whitespace-nowrap text-right tabular-nums rr-mask">
                          {formatCurrency(item.amount)}
                        </span>
                      </div>
                    )
                  })}
                </div>
                <div className="flex items-center justify-between text-[13px]">
                  <span className="text-muted-foreground">{t('total_label')}</span>
                  <span className="font-medium tabular-nums rr-mask">
                    {formatCurrency(detail.total_amount)}
                  </span>
                </div>
                {detail.status === 'created' && detailUnsettled > 0 && (
                  <p className="text-xs text-muted-foreground">{t('mark_all_hint')}</p>
                )}
                {orders[detail.id] && (
                  <p className="attn">
                    {t('order_detail_line', {
                      status: orderLabel(orders[detail.id].status),
                      date: formatDate(orders[detail.id].created_at),
                    })}
                    {orders[detail.id].error_message ? ` ${orders[detail.id].error_message}` : ''}
                  </p>
                )}
              </SlideOverBody>
              <SlideOverFooter>
                <div className="flex w-full flex-wrap items-center justify-end gap-3">
                  {canSend(detail) && (
                    <Button variant="outline" onClick={() => setConfirmSendBatch(detail)}>
                      {t('send_to_bank')}
                    </Button>
                  )}
                  {detail.status === 'created' && (
                    <Button
                      variant="outline"
                      onClick={() => handleDownload(detail)}
                      disabled={downloadingId !== null}
                    >
                      {t('download_again')}
                    </Button>
                  )}
                  {detail.status === 'created' && canWrite && detailUnsettled > 0 && (
                    <Button onClick={handleMarkAllPaid} disabled={markingAll}>
                      {markingAll && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      {t('mark_all_paid', { count: detailUnsettled })}
                    </Button>
                  )}
                </div>
              </SlideOverFooter>
            </>
          ) : (
            <SlideOverBody className="space-y-3 pt-6">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-5 w-full" />
              ))}
            </SlideOverBody>
          )}
        </SlideOverContent>
      </SlideOver>

      {/* Send confirm (convention 10): name the amount, the count and the bank
          BEFORE anything leaves, because the next screen is BankID. */}
      <Dialog
        open={confirmSendBatch != null}
        onOpenChange={(open) => {
          if (!open && !sending) setConfirmSendBatch(null)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('send_confirm_title')}</DialogTitle>
            <DialogDescription>
              {t('send_confirm_body', {
                count: confirmSendBatch?.item_count ?? 0,
                total: formatCurrency(confirmSendBatch?.total_amount ?? 0),
                bank: pis?.bank_name ?? '',
              })}
            </DialogDescription>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">{t('send_confirm_note')}</p>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConfirmSendBatch(null)}
              disabled={sending}
            >
              {t('send_confirm_abort')}
            </Button>
            <Button onClick={handleSendToBank} disabled={sending}>
              {sending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('send_confirm_action')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel confirm (convention 10): describe the outcome up front. */}
      <Dialog
        open={confirmCancelId != null}
        onOpenChange={(open) => {
          if (!open && !cancelling) setConfirmCancelId(null)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('cancel_confirm_title')}</DialogTitle>
            <DialogDescription>{t('cancel_confirm_body')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConfirmCancelId(null)}
              disabled={cancelling}
            >
              {t('cancel_confirm_abort')}
            </Button>
            <Button variant="destructive" onClick={handleCancel} disabled={cancelling}>
              {cancelling && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('cancel_confirm_action')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
