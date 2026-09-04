import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany, insertAuthUser, insertCompanyMember } from './fixtures'

// pg-real coverage for 20260905090000_bank_payment_orders.sql.
//
// The properties worth having a real database prove, in the order they matter:
//
//   1. uq_bank_payment_orders_live_source: a second order for the same source
//      is impossible while the first is alive or already succeeded, and becomes
//      possible again only after an explicit cancel/failure/rejection. This is
//      the double-payment guard, and app code cannot enforce it under races.
//   2. The immutability trigger: amounts, the request snapshot and the upstream
//      payment id cannot be rewritten, terminal statuses are terminal, and a
//      draft can only go where a draft can honestly go.
//   3. RLS: no INSERT policy anywhere (the RPC is the only writer), items are
//      read-only to members, and nothing leaks across companies.
//   4. create_bank_payment_order: totals derived from the items, the tenant and
//      write-role guards, and the friendly already_sent refusal.

async function insertSupplier(companyId: string, userId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers (id, user_id, company_id, name, bankgiro)
     VALUES ($1, $2, $3, 'Derome Bygg AB', '5050-1055')`,
    [id, userId, companyId],
  )
  return id
}

async function insertSupplierInvoice(
  companyId: string,
  userId: string,
  supplierId: string,
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number,
        supplier_invoice_number, invoice_date, due_date,
        subtotal, vat_amount, total, remaining_amount, status)
     VALUES ($1, $2, $3, $4, floor(random() * 1000000)::int,
             $5, '2026-06-23', '2026-07-07',
             590, 147.5, 737.5, 737.5, 'approved')`,
    [id, userId, companyId, supplierId, `CD-${id.slice(0, 8)}`],
  )
  return id
}

const ITEM = (supplierInvoiceId: string | null, amount = 737.5) => ({
  supplier_invoice_id: supplierInvoiceId,
  amount,
  payment_date: '2026-09-12',
  payee_type: 'bankgiro',
  payee_bankgiro: '50501055',
  payee_name: 'Derome Bygg AB',
  reference_type: 'invoice_number',
  reference: 'CD3014794407',
})

async function callCreate(params: {
  companyId: string
  userId?: string | null
  orderId?: string
  sourceType?: string
  sourceId?: string
  items: unknown[]
  asUser?: string
}): Promise<Record<string, unknown>> {
  const args = [
    params.companyId,
    params.orderId ?? randomUUID(),
    params.sourceType ?? 'supplier_batch',
    params.sourceId ?? 'batch-1',
    'Länsförsäkringar',
    'SE',
    'business',
    'DOMESTIC_SE_GIRO',
    'SEK',
    '2026-09-12',
    null,
    JSON.stringify({ payment_type: 'DOMESTIC_SE_GIRO' }),
    randomUUID(),
    '/supplier-invoices/payment-files',
    JSON.stringify(params.items),
    params.userId ?? null,
  ]
  const sql = `SELECT public.create_bank_payment_order(
    $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text,
    $9::text, $10::date, $11::uuid, $12::jsonb, $13::text, $14::text, $15::jsonb, $16::uuid
  ) AS result`

  if (params.asUser) {
    return withUserContext(params.asUser, async (client) => {
      const res = await client.query(sql, args)
      return res.rows[0].result
    })
  }
  const res = await getPool().query(sql, args)
  return res.rows[0].result
}

/**
 * current_user_can_write() reads the caller's role in their ACTIVE company, so
 * an update-policy test has to say which company is active.
 */
async function setActiveCompany(userId: string, companyId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.user_preferences (user_id, active_company_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET active_company_id = EXCLUDED.active_company_id`,
    [userId, companyId],
  )
}

/**
 * Create an order straight on the pool (service-role equivalent).
 *
 * A requested non-draft status is reached by walking the real transitions
 * (draft -> awaiting_authorization -> target) rather than by writing the value
 * directly: the immutability trigger refuses a draft that jumps straight to a
 * settled state, which is exactly the guarantee the other tests lean on.
 */
async function seedOrder(overrides: { status?: string; sourceId?: string } = {}) {
  const ctx = await seedCompany()
  const supplierId = await insertSupplier(ctx.companyId, ctx.userId)
  const invoiceId = await insertSupplierInvoice(ctx.companyId, ctx.userId, supplierId)
  const orderId = randomUUID()

  const result = await callCreate({
    companyId: ctx.companyId,
    userId: ctx.userId,
    orderId,
    sourceId: overrides.sourceId ?? `batch-${orderId.slice(0, 8)}`,
    items: [ITEM(invoiceId)],
  })
  expect(result.ok).toBe(true)

  const target = overrides.status
  if (target && target !== 'draft') {
    await getPool().query(
      `UPDATE public.bank_payment_orders
          SET status = 'awaiting_authorization', eb_payment_id = 'pay-seed'
        WHERE id = $1`,
      [orderId],
    )
    if (target !== 'awaiting_authorization') {
      await getPool().query(`UPDATE public.bank_payment_orders SET status = $2 WHERE id = $1`, [
        orderId,
        target,
      ])
    }
  }

  return {
    ...ctx,
    supplierId,
    invoiceId,
    orderId,
    sourceId: (result.order as Record<string, unknown>).source_id as string,
  }
}

describe('create_bank_payment_order', () => {
  it('derives the header totals from the items so the two can never disagree', async () => {
    const ctx = await seedCompany()
    const supplierId = await insertSupplier(ctx.companyId, ctx.userId)
    const a = await insertSupplierInvoice(ctx.companyId, ctx.userId, supplierId)
    const b = await insertSupplierInvoice(ctx.companyId, ctx.userId, supplierId)

    const result = await callCreate({
      companyId: ctx.companyId,
      userId: ctx.userId,
      items: [ITEM(a, 100.25), ITEM(b, 200.5)],
    })

    expect(result.ok).toBe(true)
    const order = result.order as Record<string, unknown>
    expect(Number(order.total_amount)).toBe(300.75)
    expect(order.item_count).toBe(2)
    expect(order.status).toBe('draft')
  })

  it('accepts items without a supplier invoice (tax and salary payments)', async () => {
    const ctx = await seedCompany()
    const result = await callCreate({
      companyId: ctx.companyId,
      userId: ctx.userId,
      sourceType: 'tax_payment',
      sourceId: '2026-08',
      items: [ITEM(null, 4200)],
    })
    expect(result.ok).toBe(true)
  })

  it('refuses an empty item list', async () => {
    const ctx = await seedCompany()
    const result = await callCreate({ companyId: ctx.companyId, userId: ctx.userId, items: [] })
    expect(result).toMatchObject({ ok: false, code: 'create_failed' })
  })

  it('refuses an unknown source type', async () => {
    const ctx = await seedCompany()
    const result = await callCreate({
      companyId: ctx.companyId,
      userId: ctx.userId,
      sourceType: 'invented',
      items: [ITEM(null)],
    })
    expect(result).toMatchObject({ ok: false, code: 'create_failed' })
  })

  it('refuses a second order for a source that already has a live one', async () => {
    const ctx = await seedOrder()
    const result = await callCreate({
      companyId: ctx.companyId,
      userId: ctx.userId,
      sourceId: ctx.sourceId,
      items: [ITEM(ctx.invoiceId)],
    })
    expect(result).toMatchObject({ ok: false, code: 'already_sent' })
  })

  it('refuses a second order even after the first one succeeded', async () => {
    // 'accepted' is not a free source: re-sending a batch the bank already paid
    // is the double payment this table exists to prevent.
    const ctx = await seedOrder({ status: 'accepted' })
    const result = await callCreate({
      companyId: ctx.companyId,
      userId: ctx.userId,
      sourceId: ctx.sourceId,
      items: [ITEM(ctx.invoiceId)],
    })
    expect(result).toMatchObject({ ok: false, code: 'already_sent' })
  })

  it('frees the source again after a cancel, a failure or a rejection', async () => {
    for (const terminal of ['cancelled', 'failed', 'rejected']) {
      const ctx = await seedOrder({ status: terminal })
      const result = await callCreate({
        companyId: ctx.companyId,
        userId: ctx.userId,
        sourceId: ctx.sourceId,
        items: [ITEM(ctx.invoiceId)],
      })
      expect(result.ok, `${terminal} should free the source`).toBe(true)
    }
  })

  it('keeps an order whose fate is unknown blocking its source', async () => {
    const ctx = await seedOrder({ status: 'unknown' })
    const result = await callCreate({
      companyId: ctx.companyId,
      userId: ctx.userId,
      sourceId: ctx.sourceId,
      items: [ITEM(ctx.invoiceId)],
    })
    expect(result).toMatchObject({ ok: false, code: 'already_sent' })
  })

  it('rejects a JWT caller who is not a member of the company', async () => {
    const ctx = await seedCompany()
    const stranger = await insertAuthUser()

    await expect(
      callCreate({
        companyId: ctx.companyId,
        userId: ctx.userId,
        items: [ITEM(null)],
        asUser: stranger,
      }),
    ).rejects.toThrow(/not a member/)
  })

  it('rejects a viewer: viewers may read orders, never create one', async () => {
    const ctx = await seedCompany()
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId: ctx.companyId, userId: viewer, role: 'viewer' })

    await expect(
      callCreate({
        companyId: ctx.companyId,
        items: [ITEM(null)],
        asUser: viewer,
      }),
    ).rejects.toThrow(/no write role/)
  })

  it('pins the actor to the JWT user, ignoring a spoofed p_user_id', async () => {
    const ctx = await seedCompany()
    const other = await insertAuthUser()
    await insertCompanyMember({ companyId: ctx.companyId, userId: other, role: 'member' })

    const result = await callCreate({
      companyId: ctx.companyId,
      userId: ctx.userId,
      items: [ITEM(null)],
      asUser: other,
    })
    expect(result.ok).toBe(true)
    expect((result.order as Record<string, unknown>).user_id).toBe(other)
  })
})

describe('uq_bank_payment_orders_live_source', () => {
  it('is enforced by the index, not only by the RPC recheck', async () => {
    const ctx = await seedOrder()
    await expect(
      getPool().query(
        `INSERT INTO public.bank_payment_orders
           (company_id, user_id, aspsp_name, source_type, source_id, payment_type,
            total_amount, item_count, request_snapshot)
         VALUES ($1, $2, 'Länsförsäkringar', 'supplier_batch', $3, 'DOMESTIC_SE_GIRO', 1, 1, '{}')`,
        [ctx.companyId, ctx.userId, ctx.sourceId],
      ),
    ).rejects.toThrow(/uq_bank_payment_orders_live_source/)
  })

  it('scopes the uniqueness to one company', async () => {
    const a = await seedOrder({ sourceId: 'shared-source' })
    const b = await seedCompany()
    const result = await callCreate({
      companyId: b.companyId,
      userId: b.userId,
      sourceId: 'shared-source',
      items: [ITEM(null)],
    })
    expect(result.ok).toBe(true)
    expect(a.sourceId).toBe('shared-source')
  })
})

describe('enforce_bank_payment_order_immutability', () => {
  it('refuses to rewrite the amount, the request snapshot or the return path', async () => {
    const ctx = await seedOrder()

    await expect(
      getPool().query(`UPDATE public.bank_payment_orders SET total_amount = 1 WHERE id = $1`, [
        ctx.orderId,
      ]),
    ).rejects.toThrow(/immutable snapshots/)

    // The return path is where the user is redirected after signing at the
    // bank: repointing it after the fact is an open-redirect primitive.
    await expect(
      getPool().query(
        `UPDATE public.bank_payment_orders SET return_path = '//evil.example' WHERE id = $1`,
        [ctx.orderId],
      ),
    ).rejects.toThrow(/immutable snapshots/)

    await expect(
      getPool().query(
        `UPDATE public.bank_payment_orders SET request_snapshot = '{"x":1}' WHERE id = $1`,
        [ctx.orderId],
      ),
    ).rejects.toThrow(/immutable snapshots/)
  })

  it('lets the upstream payment id be set once and never repointed', async () => {
    const ctx = await seedOrder()

    await getPool().query(
      `UPDATE public.bank_payment_orders
          SET eb_payment_id = 'pay-1', status = 'awaiting_authorization'
        WHERE id = $1`,
      [ctx.orderId],
    )

    await expect(
      getPool().query(`UPDATE public.bank_payment_orders SET eb_payment_id = 'pay-2' WHERE id = $1`, [
        ctx.orderId,
      ]),
    ).rejects.toThrow(/may only be set once/)
  })

  it('lets status and poll metadata move forward', async () => {
    const ctx = await seedOrder()
    const updated = await getPool().query(
      `UPDATE public.bank_payment_orders
          SET status = 'awaiting_authorization', eb_status = 'RCVD', last_polled_at = now()
        WHERE id = $1`,
      [ctx.orderId],
    )
    expect(updated.rowCount).toBe(1)
  })

  it('treats accepted as terminal', async () => {
    const ctx = await seedOrder({ status: 'accepted' })
    await expect(
      getPool().query(`UPDATE public.bank_payment_orders SET status = 'submitted' WHERE id = $1`, [
        ctx.orderId,
      ]),
    ).rejects.toThrow(/terminal status/)
  })

  it('lets an unknown order be closed by a human', async () => {
    // The only way out of 'unknown', and deliberately so.
    const ctx = await seedOrder({ status: 'unknown' })
    const updated = await getPool().query(
      `UPDATE public.bank_payment_orders SET status = 'cancelled' WHERE id = $1`,
      [ctx.orderId],
    )
    expect(updated.rowCount).toBe(1)
  })

  it('refuses to jump a draft straight to accepted', async () => {
    const ctx = await seedOrder()
    await expect(
      getPool().query(`UPDATE public.bank_payment_orders SET status = 'accepted' WHERE id = $1`, [
        ctx.orderId,
      ]),
    ).rejects.toThrow(/draft may only become/)
  })

  it('refuses to send an order back to draft', async () => {
    const ctx = await seedOrder({ status: 'submitted' })
    await expect(
      getPool().query(`UPDATE public.bank_payment_orders SET status = 'draft' WHERE id = $1`, [
        ctx.orderId,
      ]),
    ).rejects.toThrow(/never return to draft/)
  })
})

describe('bank_payment_order_items', () => {
  it('only ever gains the two facts the bank reports back', async () => {
    const ctx = await seedOrder()

    const ok = await getPool().query(
      `UPDATE public.bank_payment_order_items
          SET eb_transaction_id = 'tx-1', item_status = 'ACSC'
        WHERE order_id = $1`,
      [ctx.orderId],
    )
    expect(ok.rowCount).toBe(1)

    await expect(
      getPool().query(`UPDATE public.bank_payment_order_items SET amount = 1 WHERE order_id = $1`, [
        ctx.orderId,
      ]),
    ).rejects.toThrow(/immutable snapshots/)
  })

  it('keeps an invoice that sits at the bank from being deleted', async () => {
    const ctx = await seedOrder()
    await expect(
      getPool().query(`DELETE FROM public.supplier_invoices WHERE id = $1`, [ctx.invoiceId]),
    ).rejects.toThrow(/foreign key/)
  })

  it('rejects a payee whose type and columns disagree', async () => {
    const ctx = await seedOrder()
    await expect(
      getPool().query(
        `INSERT INTO public.bank_payment_order_items
           (order_id, company_id, amount, payment_date, payee_type, payee_name)
         VALUES ($1, $2, 1, '2026-09-12', 'bankgiro', 'Utan nummer')`,
        [ctx.orderId, ctx.companyId],
      ),
    ).rejects.toThrow(/payee_fields_match/)
  })

  it('rejects a half-filled reference', async () => {
    const ctx = await seedOrder()
    await expect(
      getPool().query(
        `INSERT INTO public.bank_payment_order_items
           (order_id, company_id, amount, payment_date, payee_type, payee_bankgiro,
            payee_name, reference_type)
         VALUES ($1, $2, 1, '2026-09-12', 'bankgiro', '50501055', 'Derome', 'ocr')`,
        [ctx.orderId, ctx.companyId],
      ),
    ).rejects.toThrow(/reference_pair/)
  })
})

describe('bank_payment_orders RLS', () => {
  it('shows orders and items to members and hides them from everyone else', async () => {
    const ctx = await seedOrder()
    const stranger = await insertAuthUser()

    const mine = await withUserContext(ctx.userId, (client) =>
      client.query(`SELECT id FROM public.bank_payment_orders WHERE id = $1`, [ctx.orderId]),
    )
    expect(mine.rows).toHaveLength(1)

    const theirs = await withUserContext(stranger, (client) =>
      client.query(`SELECT id FROM public.bank_payment_orders WHERE id = $1`, [ctx.orderId]),
    )
    expect(theirs.rows).toHaveLength(0)

    const myItems = await withUserContext(ctx.userId, (client) =>
      client.query(`SELECT id FROM public.bank_payment_order_items WHERE order_id = $1`, [
        ctx.orderId,
      ]),
    )
    expect(myItems.rows).toHaveLength(1)
  })

  it('has no INSERT policy: the RPC is the only writer in the database too', async () => {
    const ctx = await seedOrder()
    await expect(
      withUserContext(ctx.userId, (client) =>
        client.query(
          `INSERT INTO public.bank_payment_orders
             (company_id, user_id, aspsp_name, source_type, source_id, payment_type,
              total_amount, item_count, request_snapshot)
           VALUES ($1, $2, 'X', 'supplier_batch', 'other-source', 'DOMESTIC_SE_GIRO', 1, 1, '{}')`,
          [ctx.companyId, ctx.userId],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
  })

  it('lets a member cancel an order but never write its items', async () => {
    const ctx = await seedOrder()
    await setActiveCompany(ctx.userId, ctx.companyId)

    const cancel = await withUserContext(ctx.userId, (client) =>
      client.query(
        `UPDATE public.bank_payment_orders SET status = 'cancelled' WHERE id = $1`,
        [ctx.orderId],
      ),
    )
    expect(cancel.rowCount).toBe(1)

    const items = await withUserContext(ctx.userId, (client) =>
      client.query(
        `UPDATE public.bank_payment_order_items SET item_status = 'X' WHERE order_id = $1`,
        [ctx.orderId],
      ),
    )
    expect(items.rowCount).toBe(0)
  })

  it('lets a viewer read an order but never cancel it', async () => {
    const ctx = await seedOrder()
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId: ctx.companyId, userId: viewer, role: 'viewer' })
    await setActiveCompany(viewer, ctx.companyId)

    const read = await withUserContext(viewer, (client) =>
      client.query(`SELECT id FROM public.bank_payment_orders WHERE id = $1`, [ctx.orderId]),
    )
    expect(read.rows).toHaveLength(1)

    const cancel = await withUserContext(viewer, (client) =>
      client.query(`UPDATE public.bank_payment_orders SET status = 'cancelled' WHERE id = $1`, [
        ctx.orderId,
      ]),
    )
    expect(cancel.rowCount).toBe(0)
  })

  it('does not let a member delete an order', async () => {
    const ctx = await seedOrder()
    const deleted = await withUserContext(ctx.userId, (client) =>
      client.query(`DELETE FROM public.bank_payment_orders WHERE id = $1`, [ctx.orderId]),
    )
    expect(deleted.rowCount).toBe(0)
  })
})
