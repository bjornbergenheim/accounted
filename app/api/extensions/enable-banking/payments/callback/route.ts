import { NextResponse } from 'next/server'
import { loadExtensions } from '@/lib/extensions/loader'
import { extensionRegistry } from '@/lib/extensions/registry'
import { createServiceClient } from '@/lib/supabase/server'
import { requireFlowInitiator } from '@/lib/auth/oauth-flow-binding'
import { refreshOrderStatus } from '@/extensions/general/enable-banking/lib/payment-orders'
import type { BankPaymentOrder } from '@/types'

/**
 * GET /api/extensions/enable-banking/payments/callback
 *
 * Where the bank sends the user after they have signed (or declined) a payment
 * with BankID. Unlike the AIS callback there is no code to exchange: the
 * payment authorises itself at the ASPSP, and the only thing left to do is ask
 * Enable Banking what happened and record it.
 *
 * This URL must be whitelisted in the Enable Banking control panel alongside
 * the account-information callback, otherwise POST /payments is refused before
 * the user ever sees BankID.
 *
 * The redirect back into the app always happens, on every path. A user who has
 * just signed a payment must never be left staring at a JSON error page
 * wondering whether their money moved.
 */

// One status read plus one update. Nowhere near the platform default, but
// stated so a slow ASPSP status call cannot truncate the redirect.
export const maxDuration = 60

const RETURN_PATHS: Record<string, string> = {
  supplier_batch: '/supplier-invoices/payment-files',
  tax_payment: '/skattekonto',
  salary_run: '/salary',
}

function redirectTo(request: Request, path: string, params: Record<string, string>): NextResponse {
  const base = process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin
  const url = new URL(path, base)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return NextResponse.redirect(url.toString())
}

export async function GET(request: Request) {
  // Physical routes under app/api/extensions/<id>/ compile into EVERY build,
  // including the core-with-zero-extensions one; the registry is what actually
  // switches an extension on. A disabled extension must not expose a live
  // surface that moves money.
  loadExtensions()
  if (!extensionRegistry.get('enable-banking')) {
    return NextResponse.json(
      { error: 'Enable Banking extension is not enabled', code: 'EXTENSION_DISABLED' },
      { status: 503 },
    )
  }

  const url = new URL(request.url)
  const state = url.searchParams.get('state')

  if (!state) {
    return redirectTo(request, '/supplier-invoices/payment-files', {
      payment_error: 'missing_state',
    })
  }

  // Service client: the row is found by the opaque state the bank echoed back,
  // before we know who the user is. The initiator check below is what binds the
  // completion to a session.
  const service = await createServiceClient()
  const { data: order, error } = await service
    .from('bank_payment_orders')
    .select('*')
    .eq('oauth_state', state)
    .maybeSingle<BankPaymentOrder>()

  if (error || !order) {
    console.warn('[enable-banking] payment callback: no order for state', {
      hasState: !!state,
      error: error?.message,
    })
    return redirectTo(request, '/supplier-invoices/payment-files', {
      payment_error: 'unknown_state',
    })
  }

  const returnPath = RETURN_PATHS[order.source_type] ?? '/supplier-invoices/payment-files'

  // The person who comes back must be the person who sent the payment. Anything
  // else is either a stale link in someone else's browser or an attempt to
  // finish a stranger's payment flow.
  const initiator = await requireFlowInitiator(request, order.user_id, {
    flow: 'enable-banking-payment',
  })
  if (!initiator.ok) {
    if (initiator.reason === 'no_session') return initiator.response
    return redirectTo(request, returnPath, {
      payment_error: 'initiator_mismatch',
      payment_order: order.id,
    })
  }

  const refreshed = await refreshOrderStatus(service, order)

  return redirectTo(request, returnPath, {
    payment_order: order.id,
    ...(refreshed.ok ? { payment_status: refreshed.status } : { payment_error: refreshed.reason }),
  })
}
