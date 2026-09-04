'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Loader2 } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import type { UseBankPayments } from './use-bank-payments'

/**
 * "Skicka till banken" for a single payment source, plus the status of the
 * order that already exists for it.
 *
 * Renders nothing at all when payment initiation is unavailable, so every
 * screen that embeds it keeps its existing download flow untouched on an
 * instance that has not enabled PIS.
 */
export interface SendToBankActionProps {
  payments: UseBankPayments
  sourceId: string
  /** Whether the source is still in a state that may be paid. */
  sourceIsOpen: boolean
  /** Total to be paid, for the confirmation dialog. */
  amount: number
  /** Number of payment lines, for the confirmation dialog. */
  itemCount: number
  /** Whether the caller may write at all (viewer members may not). */
  canWrite?: boolean
  variant?: 'default' | 'outline'
}

export function SendToBankAction({
  payments,
  sourceId,
  sourceIsOpen,
  amount,
  itemCount,
  canWrite = true,
  variant = 'outline',
}: SendToBankActionProps) {
  const t = useTranslations('bank_payments')
  const [confirmOpen, setConfirmOpen] = useState(false)

  const order = payments.orderFor(sourceId)
  const showButton = canWrite && payments.canSend(sourceId, sourceIsOpen)

  if (!payments.pis?.enabled) return null

  return (
    <>
      {order && (
        <p className="attn">
          {t('order_line', { status: payments.orderLabel(order.status) })}
          {order.error_message ? ` ${order.error_message}` : ''}
        </p>
      )}

      {showButton && (
        <Button variant={variant} onClick={() => setConfirmOpen(true)} disabled={payments.sending}>
          {t('send_to_bank')}
        </Button>
      )}

      {!showButton && order && (
        <Badge variant="outline" className="font-normal">
          {payments.orderLabel(order.status)}
        </Badge>
      )}

      {/* Confirm up front (convention 10): name the amount, the count and the
          bank BEFORE anything leaves, because the next screen is BankID. */}
      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open && !payments.sending) setConfirmOpen(false)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('confirm_title')}</DialogTitle>
            <DialogDescription>
              {t('confirm_body', {
                count: itemCount,
                total: formatCurrency(amount),
                bank: payments.pis.bank_name ?? '',
              })}
            </DialogDescription>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">{t('confirm_note')}</p>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConfirmOpen(false)}
              disabled={payments.sending}
            >
              {t('confirm_abort')}
            </Button>
            <Button
              onClick={async () => {
                const started = await payments.send(sourceId)
                if (!started) setConfirmOpen(false)
              }}
              disabled={payments.sending}
            >
              {payments.sending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('confirm_action')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
