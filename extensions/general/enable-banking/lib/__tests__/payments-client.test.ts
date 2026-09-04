import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../jwt', () => ({
  generateJWT: () => 'test-jwt-token',
  getAuthorizationHeader: () => 'Bearer test-jwt-token',
  _resetTokenCache: vi.fn(),
}))

const mockBankConnectorMode = vi.fn<() => { baseUrl: string; key: string } | null>(() => null)
const mockHasOwnCredentials = vi.fn(() => true)

vi.mock('@/lib/connect/instance/upstreams', () => ({
  bankConnectorMode: (...args: unknown[]) => mockBankConnectorMode(...(args as [])),
  CONNECTOR_COMPANY_HEADER: 'X-Connector-Company',
}))
vi.mock('@/lib/entitlements/own-credentials', () => ({
  hasOwnEnableBankingCredentials: () => mockHasOwnCredentials(),
}))

// api-client resolves its base URL at module scope, so the override has to land
// before the import graph is evaluated: vi.hoisted runs ahead of the imports,
// vi.stubEnv would not.
vi.hoisted(() => {
  process.env.ENABLE_BANKING_API_URL = 'https://api.test.com'
})

import {
  assertPisRoutable,
  createPayment,
  getPayment,
  PaymentInitiationError,
  PisUnavailableError,
  submitPayment,
} from '../payments-client'
import type { CreatePaymentRequest } from '@/lib/payments/pis-types'

const REQUEST: CreatePaymentRequest = {
  payment_type: 'DOMESTIC_SE_GIRO',
  payment_request: {
    credit_transfer_transaction: [
      {
        instructed_amount: { currency: 'SEK', amount: '100.00' },
        beneficiary: {
          creditor: { name: 'Leverantör AB' },
          creditor_account: { identification: '50501055', scheme_name: 'BGNR' },
        },
      },
    ],
  },
  aspsp: { name: 'Länsförsäkringar', country: 'SE' },
  state: 'state-1',
  redirect_url: 'https://example.test/cb',
  psu_type: 'business',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('payments-client routability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBankConnectorMode.mockReturnValue(null)
    mockHasOwnCredentials.mockReturnValue(true)
  })

  it('refuses without own Enable Banking credentials', () => {
    mockHasOwnCredentials.mockReturnValue(false)
    expect(() => assertPisRoutable()).toThrow(PisUnavailableError)
    try {
      assertPisRoutable()
    } catch (error) {
      expect((error as PisUnavailableError).reason).toBe('no_own_credentials')
    }
  })

  it('refuses in connector mode even with own credentials', () => {
    // A canaried company has own credentials but is routed through the hosted
    // proxy, which has no /payments path and no PISP licence behind it.
    mockBankConnectorMode.mockReturnValue({ baseUrl: 'https://hosted/api/connect/bank', key: 'k' })
    try {
      assertPisRoutable('company-1')
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(PisUnavailableError)
      expect((error as PisUnavailableError).reason).toBe('connector_mode')
    }
  })

  it('allows the direct path with own credentials and no connector', () => {
    expect(() => assertPisRoutable('company-1')).not.toThrow()
  })
})

describe('createPayment', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockBankConnectorMode.mockReturnValue(null)
    mockHasOwnCredentials.mockReturnValue(true)
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('posts to /payments and returns the authorisation URL', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        payment_id: 'pay-1',
        status: 'RCVD',
        url: 'https://auth.enablebanking.com/pis/start?payment_id=pay-1',
        psu_id_hash: 'hash',
      }),
    )

    const result = await createPayment(REQUEST, 'company-1')
    expect(result.payment_id).toBe('pay-1')
    expect(result.url).toContain('auth.enablebanking.com')

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.test.com/payments')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string).payment_type).toBe('DOMESTIC_SE_GIRO')
  })

  it('never retries: one create call is one payment', async () => {
    // 503 is retryable for reads; on a create it must not be, because a retried
    // create can produce two real payments.
    fetchSpy.mockResolvedValue(jsonResponse({ error: 'upstream' }, 503))

    await expect(createPayment(REQUEST)).rejects.toBeInstanceOf(PaymentInitiationError)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('carries the upstream status so the caller can tell refusal from doubt', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ error: 'BAD_REQUEST' }, 400))
    await expect(createPayment(REQUEST)).rejects.toMatchObject({ status: 400 })
  })

  it('does not reach the network in connector mode', async () => {
    mockBankConnectorMode.mockReturnValue({ baseUrl: 'https://hosted/api/connect/bank', key: 'k' })
    await expect(createPayment(REQUEST, 'company-1')).rejects.toBeInstanceOf(PisUnavailableError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('getPayment', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockBankConnectorMode.mockReturnValue(null)
    mockHasOwnCredentials.mockReturnValue(true)
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('reads the status', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ payment_id: 'pay-1', status: 'ACSC', final_status: true }),
    )
    const result = await getPayment('pay-1', 'company-1')
    expect(result.status).toBe('ACSC')
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.test.com/payments/pay-1')
  })

  it('retries a transient upstream failure, because a read is safe to repeat', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ error: 'busy' }, 503))
      .mockResolvedValueOnce(jsonResponse({ payment_id: 'pay-1', status: 'PDNG' }))

    const result = await getPayment('pay-1')
    expect(result.status).toBe('PDNG')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('gives up with the upstream status after exhausting retries', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ error: 'busy' }, 503))
    await expect(getPayment('pay-1')).rejects.toMatchObject({ status: 503 })
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('encodes the payment id into the path', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ payment_id: 'a/b', status: 'RCVD' }))
    await getPayment('a/b')
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.test.com/payments/a%2Fb')
  })
})

describe('submitPayment', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockBankConnectorMode.mockReturnValue(null)
    mockHasOwnCredentials.mockReturnValue(true)
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('posts an empty body and does not retry', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ error: 'busy' }, 503))
    await expect(submitPayment('pay-1')).rejects.toBeInstanceOf(PaymentInitiationError)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.test.com/payments/pay-1/submit')
    expect(init.body).toBe('{}')
  })
})
