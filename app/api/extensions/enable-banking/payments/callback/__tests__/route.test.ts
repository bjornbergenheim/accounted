import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRegistryGet = vi.fn(() => ({ id: 'enable-banking' }))
const mockRequireFlowInitiator = vi.fn()
const mockRefreshOrderStatus = vi.fn()
const mockMaybeSingle = vi.fn()

vi.mock('@/lib/extensions/loader', () => ({ loadExtensions: vi.fn() }))
vi.mock('@/lib/extensions/registry', () => ({
  extensionRegistry: { get: (...args: unknown[]) => mockRegistryGet(...(args as [])) },
}))
vi.mock('@/lib/auth/oauth-flow-binding', () => ({
  requireFlowInitiator: (...args: unknown[]) => mockRequireFlowInitiator(...args),
}))
vi.mock('@/extensions/general/enable-banking/lib/payment-orders', () => ({
  refreshOrderStatus: (...args: unknown[]) => mockRefreshOrderStatus(...args),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: async () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: mockMaybeSingle }) }),
    }),
  }),
}))

import { GET } from '../route'

const CALLBACK = 'https://accounted.test/api/extensions/enable-banking/payments/callback'

const ORDER = {
  id: 'order-1',
  user_id: 'user-1',
  company_id: 'company-1',
  source_type: 'salary_run',
  return_path: '/salary/runs/run-1',
  eb_payment_id: 'pay-1',
  status: 'awaiting_authorization',
}

function locationOf(response: Response): URL {
  return new URL(response.headers.get('location') ?? '')
}

describe('payment callback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = 'https://accounted.test'
    mockRegistryGet.mockReturnValue({ id: 'enable-banking' })
    mockMaybeSingle.mockResolvedValue({ data: ORDER, error: null })
    mockRequireFlowInitiator.mockResolvedValue({ ok: true, userId: 'user-1' })
    mockRefreshOrderStatus.mockResolvedValue({ ok: true, status: 'accepted', changed: true })
  })

  it('refuses when the extension is not enabled', async () => {
    // Physical routes compile into every build, including the core build with
    // zero extensions; the registry is what actually switches this one on.
    mockRegistryGet.mockReturnValue(undefined as unknown as { id: string })
    const response = await GET(new Request(`${CALLBACK}?state=abc`))
    expect(response.status).toBe(503)
  })

  it('returns the user to the screen the payment was started from', async () => {
    const response = await GET(new Request(`${CALLBACK}?state=abc`))
    const url = locationOf(response)
    expect(url.pathname).toBe('/salary/runs/run-1')
    expect(url.searchParams.get('payment_order')).toBe('order-1')
    expect(url.searchParams.get('payment_status')).toBe('accepted')
    expect(mockRefreshOrderStatus).toHaveBeenCalled()
  })

  it('ignores a stored return path that is not a plain local path', async () => {
    // An open redirect at the end of a payment flow is exactly the phishing
    // surface not to leave open.
    mockMaybeSingle.mockResolvedValue({
      data: { ...ORDER, return_path: '//evil.example/pwn' },
      error: null,
    })
    const url = locationOf(await GET(new Request(`${CALLBACK}?state=abc`)))
    expect(url.host).toBe('accounted.test')
    expect(url.pathname).toBe('/salary')
  })

  it('falls back per source type when no return path was stored', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { ...ORDER, source_type: 'supplier_batch', return_path: null },
      error: null,
    })
    const url = locationOf(await GET(new Request(`${CALLBACK}?state=abc`)))
    expect(url.pathname).toBe('/supplier-invoices/payment-files')
  })

  it('redirects with an error rather than showing JSON when the state is unknown', async () => {
    // A user who has just signed a payment must never land on an error page
    // wondering whether their money moved.
    mockMaybeSingle.mockResolvedValue({ data: null, error: null })
    const url = locationOf(await GET(new Request(`${CALLBACK}?state=abc`)))
    expect(url.searchParams.get('payment_error')).toBe('unknown_state')
  })

  it('redirects with an error when the bank sent no state at all', async () => {
    const url = locationOf(await GET(new Request(CALLBACK)))
    expect(url.searchParams.get('payment_error')).toBe('missing_state')
    expect(mockMaybeSingle).not.toHaveBeenCalled()
  })

  it('does not finalise for a different user than the initiator', async () => {
    mockRequireFlowInitiator.mockResolvedValue({ ok: false, reason: 'mismatch' })
    const url = locationOf(await GET(new Request(`${CALLBACK}?state=abc`)))
    expect(url.searchParams.get('payment_error')).toBe('initiator_mismatch')
    expect(mockRefreshOrderStatus).not.toHaveBeenCalled()
  })

  it('sends an unauthenticated visitor to log in, keeping the flow resumable', async () => {
    const loginRedirect = new Response(null, {
      status: 302,
      headers: { location: 'https://accounted.test/login' },
    })
    mockRequireFlowInitiator.mockResolvedValue({
      ok: false,
      reason: 'no_session',
      response: loginRedirect,
    })
    const response = await GET(new Request(`${CALLBACK}?state=abc`))
    expect(response).toBe(loginRedirect)
  })

  it('reports a failed status lookup instead of claiming success', async () => {
    mockRefreshOrderStatus.mockResolvedValue({ ok: false, reason: 'lookup_failed' })
    const url = locationOf(await GET(new Request(`${CALLBACK}?state=abc`)))
    expect(url.searchParams.get('payment_error')).toBe('lookup_failed')
    expect(url.searchParams.get('payment_status')).toBeNull()
  })
})
