import { describe, it, expect } from 'vitest'
import {
  computeTaxPaymentDate,
  parseAgiPeriod,
  resolveDeclaredTaxTotal,
} from '../tax-payment'

describe('resolveDeclaredTaxTotal', () => {
  it('pays the declared whole-krona amounts exactly', () => {
    expect(resolveDeclaredTaxTotal({ total_tax: 12000, total_avgifter: 9426 })).toBe(21426)
  })

  it('keeps legacy öre-bearing rows öre-exact', () => {
    // Their salary bookings credited 2731 with the öre, so truncating here
    // would strand it on 2731 with no counterpart (DECISIONS.md 2026-08-14).
    expect(resolveDeclaredTaxTotal({ total_tax: 12000.5, total_avgifter: 9426.25 })).toBe(21426.75)
  })

  it('rounds a float sum to öre rather than emitting drift', () => {
    expect(resolveDeclaredTaxTotal({ total_tax: 0.1, total_avgifter: 0.2 })).toBe(0.3)
  })
})

describe('computeTaxPaymentDate', () => {
  it('is the 12th of the month after the period', () => {
    expect(computeTaxPaymentDate(2026, 8)).toBe('2026-09-12')
  })

  it('rolls December over into the next year', () => {
    expect(computeTaxPaymentDate(2026, 12)).toBe('2027-01-12')
  })

  it('zero-pads single-digit months', () => {
    expect(computeTaxPaymentDate(2026, 1)).toBe('2026-02-12')
  })
})

describe('parseAgiPeriod', () => {
  it('accepts YYYY-MM', () => {
    expect(parseAgiPeriod('2026-08')).toEqual({ year: 2026, month: 8 })
  })

  it('rejects anything else, including an impossible month', () => {
    expect(parseAgiPeriod('2026-13')).toBeNull()
    expect(parseAgiPeriod('2026-00')).toBeNull()
    expect(parseAgiPeriod('2026-8')).toBeNull()
    expect(parseAgiPeriod('')).toBeNull()
  })
})
