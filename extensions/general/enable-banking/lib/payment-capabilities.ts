/**
 * Is payment initiation available here, and what can this bank actually do?
 *
 * Two questions, deliberately separated:
 *
 *  - `resolvePisAvailability` answers "may this installation initiate payments
 *    at all". It is the ONLY source the UI consults before showing a
 *    "send to bank" affordance. It is a server-side answer delivered over an
 *    endpoint, never a NEXT_PUBLIC_ flag: a public flag is constant-folded at
 *    build time, which is exactly how every Docker self-host once ended up
 *    silently paywalled.
 *
 *  - `getAspspPaymentTypes` answers "what does this bank support", straight
 *    from the ASPSP's own `payments` record. Nothing in the payment path
 *    branches on a bank's name.
 */

import { getASPSPs, getApplicationDetails } from './api-client'
import { bankConnectorMode } from '@/lib/connect/instance/upstreams'
import { hasOwnEnableBankingCredentials } from '@/lib/entitlements/own-credentials'
import type { PsuType, ResponsePaymentType } from '@/lib/payments/pis-types'

/**
 * Opt-in switch. Off by default: payment initiation moves real money and
 * requires a PIS contract with Enable Banking, so it must never appear because
 * an instance merely upgraded.
 */
export function pisFlagEnabled(): boolean {
  return process.env.ENABLE_BANKING_PIS_ENABLED === 'true'
}

export type PisUnavailableCode =
  | 'flag_off'
  | 'no_own_credentials'
  | 'connector_mode'
  | 'no_pis_service'
  | 'application_unreachable'

export type PisAvailability =
  | { enabled: true; environment?: string; services: string[] }
  | { enabled: false; reason: PisUnavailableCode; services?: string[] }

/**
 * Application details change only when someone edits the Enable Banking
 * control panel, so a short cache keeps the settings page from re-asking on
 * every render while still picking up a newly granted PIS contract within the
 * same working session.
 */
const APPLICATION_TTL_MS = 5 * 60 * 1000
let applicationCache: { at: number; services: string[]; environment?: string } | null = null

/** Test seam: drop the memoised application and ASPSP answers. */
export function _resetPaymentCapabilityCache(): void {
  applicationCache = null
  aspspCache.clear()
}

export async function resolvePisAvailability(companyId?: string): Promise<PisAvailability> {
  if (!pisFlagEnabled()) return { enabled: false, reason: 'flag_off' }
  if (!hasOwnEnableBankingCredentials()) {
    return { enabled: false, reason: 'no_own_credentials' }
  }
  if (bankConnectorMode(companyId)) {
    return { enabled: false, reason: 'connector_mode' }
  }

  const now = Date.now()
  if (!applicationCache || now - applicationCache.at > APPLICATION_TTL_MS) {
    try {
      const details = await getApplicationDetails()
      applicationCache = {
        at: now,
        services: details.services,
        environment: details.environment,
      }
    } catch (error) {
      console.error('[enable-banking] resolvePisAvailability: /application unreachable', {
        error: error instanceof Error ? error.message : String(error),
      })
      // Fail closed. An unreachable control-plane answer is not permission.
      return { enabled: false, reason: 'application_unreachable' }
    }
  }

  const { services, environment } = applicationCache
  if (!services.includes('PIS')) {
    return { enabled: false, reason: 'no_pis_service', services }
  }
  return { enabled: true, environment, services }
}

/**
 * ASPSP capability records are stable for hours at a time and the /aspsps call
 * is the same one the bank picker makes, so a short cache avoids paying for it
 * twice on the same page load.
 */
const ASPSP_TTL_MS = 10 * 60 * 1000
const aspspCache = new Map<string, { at: number; payments: ResponsePaymentType[] }>()

/**
 * The payment types this bank offers for this PSU type, or an empty array when
 * the bank offers none. An empty array is a real answer: it means this bank
 * cannot be paid from through Enable Banking, and the caller must say so
 * rather than building a request the bank will reject at signing.
 */
export async function getAspspPaymentTypes(
  aspspName: string,
  country: string,
  psuType: PsuType,
): Promise<ResponsePaymentType[]> {
  const key = `${country}|${psuType}|${aspspName}`
  const cached = aspspCache.get(key)
  if (cached && Date.now() - cached.at <= ASPSP_TTL_MS) return cached.payments

  const aspsps = await getASPSPs(country, psuType)
  const aspsp = aspsps.find((a) => a.name === aspspName)
  const payments = aspsp?.payments ?? []
  aspspCache.set(key, { at: Date.now(), payments })
  return payments
}
