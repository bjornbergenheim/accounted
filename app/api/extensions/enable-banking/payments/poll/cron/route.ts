import { NextResponse } from 'next/server'
import { loadExtensions } from '@/lib/extensions/loader'
import { extensionRegistry } from '@/lib/extensions/registry'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { refreshOrderStatus } from '@/extensions/general/enable-banking/lib/payment-orders'
import { pisFlagEnabled } from '@/extensions/general/enable-banking/lib/payment-capabilities'
import type { BankPaymentOrder } from '@/types'

/**
 * GET /api/extensions/enable-banking/payments/poll/cron
 *
 * Follows unsettled payment orders to their final status.
 *
 * Polling rather than webhooks is deliberate. Enable Banking can POST a status
 * webhook, but the URL has to be whitelisted in their control panel AND
 * reachable from the internet, and a self-hosted instance on a LAN is neither.
 * A poll works everywhere, and the volume is trivial: a company sends a handful
 * of payments a month, and an order stops being polled the moment it settles.
 *
 * Orders that were never sent (no eb_payment_id) are skipped: there is nothing
 * upstream to ask about. That includes the 'unknown' orders parked by an
 * indeterminate create failure, which only a human can resolve.
 */

export const maxDuration = 120

/** One run's ceiling. Far above any realistic backlog; a guard, not a budget. */
const MAX_ORDERS_PER_RUN = 100

/**
 * Do not re-ask the bank about a payment we polled seconds ago. The redirect
 * callback already polls once on return from BankID, so the cron's job is the
 * slow tail: a decoupled BankID signature the user completed in their phone
 * without ever coming back to the browser.
 */
const MIN_POLL_INTERVAL_MS = 2 * 60 * 1000

export const GET = withCronContext('cron.bank_payment_poll', async (_request, ctx) => {
  loadExtensions()
  if (!extensionRegistry.get('enable-banking')) {
    ctx.log.warn('enable-banking extension is not enabled; payment poll refused')
    return NextResponse.json(
      { error: 'Enable Banking extension is not enabled', code: 'EXTENSION_DISABLED' },
      { status: 503 },
    )
  }

  // Payment initiation is opt-in. With the flag off there is nothing to poll,
  // and the polling client would refuse every call anyway.
  if (!pisFlagEnabled()) {
    return NextResponse.json({ data: { skipped: 'pis_disabled' } })
  }

  const supabase = createServiceClientNoCookies()
  const cutoff = new Date(Date.now() - MIN_POLL_INTERVAL_MS).toISOString()

  const { data: orders, error } = await supabase
    .from('bank_payment_orders')
    .select('*')
    .eq('final_status', false)
    .not('eb_payment_id', 'is', null)
    .in('status', ['awaiting_authorization', 'authorized', 'submitted'])
    // last_polled_at defaults to 'epoch', so this single comparison already
    // covers the orders that have never been polled.
    .lt('last_polled_at', cutoff)
    .order('last_polled_at', { ascending: true })
    .limit(MAX_ORDERS_PER_RUN)
    .returns<BankPaymentOrder[]>()

  if (error) {
    ctx.log.error('could not load payment orders to poll', { error: error.message })
    return NextResponse.json(
      { error: 'Could not load payment orders', code: 'INTERNAL_ERROR' },
      { status: 500 },
    )
  }

  let settled = 0
  let unchanged = 0
  let failed = 0

  // Sequential on purpose: the whole point is a handful of orders, and a
  // per-payment status call against an ASPSP is not something to fan out.
  for (const order of orders ?? []) {
    const result = await refreshOrderStatus(supabase, order)
    if (!result.ok) {
      failed += 1
      continue
    }
    if (result.changed) settled += 1
    else unchanged += 1
  }

  const summary = { considered: orders?.length ?? 0, settled, unchanged, failed }
  ctx.log.info('bank payment poll complete', summary)
  return NextResponse.json({ data: summary })
})
