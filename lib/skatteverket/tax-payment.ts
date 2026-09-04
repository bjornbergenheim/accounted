/**
 * What to pay Skatteverket for an AGI period, and when.
 *
 * Extracted from the payment-file route so the file and the PSD2 payment order
 * cannot drift: both must agree on the amount and the due date, or a company
 * that switches from downloading a file to sending the payment directly would
 * silently pay something else.
 */

import { roundOre } from '@/lib/money'

/**
 * The amount to draw for an AGI period.
 *
 * Declarations generated since the whole-krona change store the declared
 * amounts (what Skatteverket computes from the underlag and draws): pay exactly
 * those. Legacy öre-bearing rows predate that storage; their salary bookings
 * credited 2731 with the öre, so keep paying öre-exact as before. The öre then
 * lands as a small skattekonto överskott (the pre-existing equilibrium) instead
 * of stranding on 2731 with no counterpart. See DECISIONS.md 2026-08-14.
 */
export function resolveDeclaredTaxTotal(agi: {
  total_tax: number
  total_avgifter: number
}): number {
  const declaredWholeKronor =
    Number.isInteger(agi.total_tax) && Number.isInteger(agi.total_avgifter)
  const sum = agi.total_tax + agi.total_avgifter
  return declaredWholeKronor ? sum : roundOre(sum)
}

/**
 * Tax payment deadline = the 12th of the month *following* the AGI period.
 * (Skatteverket also accepts the 17th in Jan/Aug for turnover <= 40 MSEK, but
 * the conservative date is the 12th: money must be on the Skattekonto by then
 * to avoid kostnadsränta.)
 */
export function computeTaxPaymentDate(periodYear: number, periodMonth: number): string {
  const deadlineMonth = periodMonth === 12 ? 1 : periodMonth + 1
  const deadlineYear = periodMonth === 12 ? periodYear + 1 : periodYear
  return `${deadlineYear}-${String(deadlineMonth).padStart(2, '0')}-12`
}

/** Parse a "YYYY-MM" AGI period, or null when it is not one. */
export function parseAgiPeriod(period: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(period)
  if (!match) return null
  const month = parseInt(match[2], 10)
  if (month < 1 || month > 12) return null
  return { year: parseInt(match[1], 10), month }
}
