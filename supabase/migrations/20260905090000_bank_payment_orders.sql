-- Bank payment orders: payment initiation (PIS) through Enable Banking.
-- pg-test: tests/pg/bank-payment-orders.pg.test.ts
--
-- Today every outgoing payment in Accounted ends in a file the user uploads to
-- their bank: a pain.001 supplier batch, the skattekonto payment file, the
-- salary LB/pain.001 file. A payment ORDER is the same instruction handed
-- straight to the bank over PSD2 instead, authorised by the user with BankID.
--
-- Three invariants shape this schema.
--
--   1. An order is an immutable snapshot of what we asked the bank to do.
--      request_snapshot holds the exact payload sent, and the items hold the
--      payee/reference/amount as they stood at creation. A later edit to a
--      supplier or to company settings can never change what an order says it
--      paid. That is both the BFL underlag for the instruction and the only
--      way to answer "what did the bank actually receive" after the fact.
--
--   2. One live order per source, enforced by the database and not only by
--      code. uq_bank_payment_orders_live_source makes a second order for the
--      same batch/period/salary run impossible while the first one is alive OR
--      already succeeded; only an explicit cancel, rejection or failure frees
--      the source for a retry. Double-paying a supplier is the failure mode
--      this table exists to prevent, and app-side checks race (the same lesson
--      as create_supplier_payment_batch, #1503).
--
--   3. Creating or completing an order books NOTHING. Settlement stays with
--      bank matching and mark-as-paid, exactly as for the payment files
--      (DECISIONS.md 2026-08-10: payment truth comes from the bank). Nothing
--      here touches journal_entries.
--
-- Writes go through create_bank_payment_order (SECURITY DEFINER) only: there
-- are no INSERT policies, following 20260904121000 which removed them from the
-- supplier batch tables for exactly this reason.

CREATE TABLE public.bank_payment_orders (
  id                       uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id               uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id                  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The AIS connection the bank identity came from, when there is one. Nullable
  -- and ON DELETE SET NULL: a payment order outlives the account-information
  -- consent it was created alongside, and revoking bank sync must not erase
  -- the record of a payment that was actually sent.
  bank_connection_id       uuid REFERENCES public.bank_connections(id) ON DELETE SET NULL,

  aspsp_name               text NOT NULL,
  aspsp_country            text NOT NULL DEFAULT 'SE',
  psu_type                 text CHECK (psu_type IS NULL OR psu_type IN ('personal', 'business')),

  -- What is being paid. source_id is text rather than uuid because the tax
  -- payment is keyed by period ('2026-08'), not by a row id.
  source_type              text NOT NULL CHECK (source_type IN ('supplier_batch', 'tax_payment', 'salary_run')),
  source_id                text NOT NULL,

  payment_type             text NOT NULL,
  currency                 text NOT NULL DEFAULT 'SEK',
  total_amount             numeric NOT NULL CHECK (total_amount > 0),
  item_count               integer NOT NULL CHECK (item_count > 0),
  requested_execution_date date,

  -- The exact CreatePaymentRequest body sent to Enable Banking.
  request_snapshot         jsonb NOT NULL,

  -- Enable Banking's payment id, set once the create call succeeds. NULL means
  -- nothing was ever sent upstream.
  eb_payment_id            text,
  -- Where to send the PSU to authorise. Transient; useful while the order is
  -- awaiting signature.
  auth_url                 text,
  -- CSRF/lookup handle echoed back on the bank's redirect. Same role as
  -- bank_connections.oauth_state.
  oauth_state              text UNIQUE,

  status                   text NOT NULL DEFAULT 'draft' CHECK (status IN (
                             'draft',
                             'awaiting_authorization',
                             'authorized',
                             'submitted',
                             'accepted',
                             'rejected',
                             'cancelled',
                             'failed',
                             'unknown'
                           )),
  -- The raw ISO 20022 code the bank reported (RCVD, ACCP, ACSC, RJCT, ...),
  -- kept alongside our own status because banks disagree about what each code
  -- promises and the raw value is what support needs to see.
  eb_status                text,
  final_status             boolean NOT NULL DEFAULT false,
  status_reason            text,
  -- Swedish, user-facing. Raw Enable Banking envelopes are English JSON and
  -- belong in the server log, never here.
  error_message            text,

  -- 'epoch' rather than NULL, the same trick bank_connections.sync_lease_until
  -- uses: the polling cron's work list is then a single `last_polled_at < cutoff`
  -- comparison that already includes never-polled rows, instead of an OR with a
  -- NULL branch.
  last_polled_at           timestamptz NOT NULL DEFAULT 'epoch',
  authorized_at            timestamptz,
  submitted_at             timestamptz,
  completed_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  -- Composite-FK target so items can enforce company agreement with their
  -- order. Trivially unique (id is the PK).
  CONSTRAINT uq_bank_payment_orders_id_company UNIQUE (id, company_id)
);

CREATE TABLE public.bank_payment_order_items (
  id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id            uuid NOT NULL,
  company_id          uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Set for supplier_batch orders; NULL for tax and salary payments, which have
  -- no supplier invoice behind them. RESTRICT for the same reason as the
  -- betalfil items: an invoice whose payment instruction sits at the bank must
  -- not be able to vanish.
  supplier_invoice_id uuid,

  amount              numeric NOT NULL CHECK (amount > 0),
  payment_date        date NOT NULL,

  payee_type          text NOT NULL CHECK (payee_type IN ('bankgiro', 'plusgiro', 'bank_account')),
  payee_bankgiro      text,
  payee_plusgiro      text,
  payee_clearing      text,
  payee_account       text,
  payee_name          text NOT NULL,
  -- Salary payouts carry no reference at all (the salary dialect forbids
  -- remittance information), so both columns are nullable here where the
  -- betalfil items require them.
  reference_type      text CHECK (reference_type IS NULL OR reference_type IN ('ocr', 'invoice_number')),
  reference           text,

  -- Per-transaction id inside a bulk payment, once the bank reports one.
  eb_transaction_id   text,
  item_status         text,
  created_at          timestamptz NOT NULL DEFAULT now(),

  -- Composite FKs: company_id must agree with BOTH parents, so a user who
  -- belongs to two companies can never cross-link an order in one company to
  -- an invoice in another (plain per-column FKs would allow it).
  CONSTRAINT fk_bank_payment_order_items_order
    FOREIGN KEY (order_id, company_id)
    REFERENCES public.bank_payment_orders (id, company_id) ON DELETE CASCADE,
  CONSTRAINT fk_bank_payment_order_items_invoice
    FOREIGN KEY (supplier_invoice_id, company_id)
    REFERENCES public.supplier_invoices (id, company_id) ON DELETE RESTRICT,
  CONSTRAINT bank_payment_order_items_payee_fields_match CHECK (
    (payee_type = 'bankgiro' AND payee_bankgiro IS NOT NULL)
    OR (payee_type = 'plusgiro' AND payee_plusgiro IS NOT NULL)
    OR (payee_type = 'bank_account' AND payee_clearing IS NOT NULL AND payee_account IS NOT NULL)
  ),
  CONSTRAINT bank_payment_order_items_reference_pair CHECK (
    (reference_type IS NULL AND reference IS NULL)
    OR (reference_type IS NOT NULL AND reference IS NOT NULL)
  )
);

-- Invariant 2, in the database. An order blocks its source while it is alive
-- (draft/awaiting/authorized/submitted), while its outcome is unknown, and
-- after it succeeded. Only cancelled, failed and rejected free the source, and
-- each of those is an explicit statement that no money moved.
CREATE UNIQUE INDEX uq_bank_payment_orders_live_source
  ON public.bank_payment_orders (company_id, source_type, source_id)
  WHERE status NOT IN ('cancelled', 'failed', 'rejected');

CREATE INDEX idx_bank_payment_orders_company_created
  ON public.bank_payment_orders (company_id, created_at DESC);
CREATE INDEX idx_bank_payment_orders_company_status
  ON public.bank_payment_orders (company_id, status);
-- The polling cron's work list: everything not yet settled, oldest poll first.
CREATE INDEX idx_bank_payment_orders_pending_poll
  ON public.bank_payment_orders (last_polled_at)
  WHERE final_status = false AND eb_payment_id IS NOT NULL;
CREATE INDEX idx_bank_payment_orders_eb_payment_id
  ON public.bank_payment_orders (eb_payment_id) WHERE eb_payment_id IS NOT NULL;
CREATE INDEX idx_bank_payment_orders_bank_connection_id
  ON public.bank_payment_orders (bank_connection_id) WHERE bank_connection_id IS NOT NULL;

CREATE INDEX idx_bank_payment_order_items_order_id
  ON public.bank_payment_order_items (order_id);
CREATE INDEX idx_bank_payment_order_items_company_id
  ON public.bank_payment_order_items (company_id);
CREATE INDEX idx_bank_payment_order_items_supplier_invoice_id
  ON public.bank_payment_order_items (supplier_invoice_id)
  WHERE supplier_invoice_id IS NOT NULL;

ALTER TABLE public.bank_payment_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_payment_order_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company bank_payment_orders"
  ON public.bank_payment_orders FOR SELECT
  USING (company_id IN (SELECT user_company_ids()));
-- UPDATE covers the user-facing lifecycle actions (cancel an unsigned order,
-- refresh its status). The immutability trigger below decides WHICH columns may
-- move; this policy only decides who may try. Role-gated on the active company,
-- the same predicate the bank_connections write policies use: a viewer may read
-- what was paid but must never touch a payment in flight. No INSERT policy:
-- creation is create_bank_payment_order's alone. No DELETE policy: an order
-- documents a payment instruction that may already sit at the bank.
CREATE POLICY "update own-company bank_payment_orders"
  ON public.bank_payment_orders FOR UPDATE
  USING (company_id = current_active_company_id() AND current_user_can_write());

CREATE POLICY "view own-company bank_payment_order_items"
  ON public.bank_payment_order_items FOR SELECT
  USING (company_id IN (SELECT user_company_ids()));
-- No INSERT/UPDATE/DELETE policies: items are immutable snapshots written by
-- the RPC, and the two fields the bank fills in later (eb_transaction_id,
-- item_status) are written by the service-role poller.

-- Column-level immutability. RLS cannot compare OLD and NEW, and an order whose
-- amount or request_snapshot could be rewritten after the fact would be
-- worthless as the record of what the bank was asked to do.
CREATE OR REPLACE FUNCTION public.enforce_bank_payment_order_immutability()
RETURNS TRIGGER AS $$
DECLARE
  v_terminal text[] := ARRAY['accepted', 'rejected', 'cancelled', 'failed'];
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.source_type IS DISTINCT FROM OLD.source_type
     OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.aspsp_name IS DISTINCT FROM OLD.aspsp_name
     OR NEW.aspsp_country IS DISTINCT FROM OLD.aspsp_country
     OR NEW.payment_type IS DISTINCT FROM OLD.payment_type
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
     OR NEW.item_count IS DISTINCT FROM OLD.item_count
     OR NEW.requested_execution_date IS DISTINCT FROM OLD.requested_execution_date
     OR NEW.request_snapshot IS DISTINCT FROM OLD.request_snapshot
     OR NEW.oauth_state IS DISTINCT FROM OLD.oauth_state
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'bank_payment_orders are immutable snapshots: only lifecycle and status metadata may change';
  END IF;

  -- The upstream payment id is written exactly once, when the create call
  -- succeeds. Repointing an order at a different payment would silently move
  -- its whole audit trail onto someone else's money.
  IF OLD.eb_payment_id IS NOT NULL AND NEW.eb_payment_id IS DISTINCT FROM OLD.eb_payment_id THEN
    RAISE EXCEPTION 'bank_payment_orders.eb_payment_id may only be set once';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = ANY(v_terminal) THEN
      RAISE EXCEPTION 'bank_payment_orders: % is a terminal status', OLD.status;
    END IF;
    -- A draft was never sent anywhere, so the only honest moves out of it are
    -- "we sent it", "sending failed" and "the user changed their mind".
    IF OLD.status = 'draft'
       AND NEW.status NOT IN ('awaiting_authorization', 'failed', 'cancelled') THEN
      RAISE EXCEPTION 'bank_payment_orders: draft may only become awaiting_authorization, failed or cancelled';
    END IF;
    IF NEW.status = 'draft' THEN
      RAISE EXCEPTION 'bank_payment_orders: an order can never return to draft';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_bank_payment_order_immutability
  BEFORE UPDATE ON public.bank_payment_orders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_bank_payment_order_immutability();

-- Items may only ever gain the two facts the bank reports back.
CREATE OR REPLACE FUNCTION public.enforce_bank_payment_order_item_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.supplier_invoice_id IS DISTINCT FROM OLD.supplier_invoice_id
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.payment_date IS DISTINCT FROM OLD.payment_date
     OR NEW.payee_type IS DISTINCT FROM OLD.payee_type
     OR NEW.payee_bankgiro IS DISTINCT FROM OLD.payee_bankgiro
     OR NEW.payee_plusgiro IS DISTINCT FROM OLD.payee_plusgiro
     OR NEW.payee_clearing IS DISTINCT FROM OLD.payee_clearing
     OR NEW.payee_account IS DISTINCT FROM OLD.payee_account
     OR NEW.payee_name IS DISTINCT FROM OLD.payee_name
     OR NEW.reference_type IS DISTINCT FROM OLD.reference_type
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'bank_payment_order_items are immutable snapshots: only eb_transaction_id and item_status may change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_bank_payment_order_item_immutability
  BEFORE UPDATE ON public.bank_payment_order_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_bank_payment_order_item_immutability();

CREATE TRIGGER set_updated_at_bank_payment_orders
  BEFORE UPDATE ON public.bank_payment_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_bank_payment_orders
  AFTER INSERT OR UPDATE OR DELETE ON public.bank_payment_orders
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

CREATE TRIGGER audit_bank_payment_order_items
  AFTER INSERT OR UPDATE OR DELETE ON public.bank_payment_order_items
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- create_bank_payment_order: the single write path for a payment order.
--
-- Header and items land in one transaction, and the header totals are computed
-- from the items so the two can never disagree. Domain refusals return
-- jsonb {ok:false, code, details} in the create_supplier_payment_batch shape;
-- the tenant guard RAISEs 42501, and parses request.jwt.claims directly rather
-- than calling auth.role() (the CI auth shim leaves auth.role() NULL under a
-- claims-only session).
--
-- SECURITY DEFINER bypasses RLS, which is why the membership and write-role
-- guards below are mandatory.
CREATE OR REPLACE FUNCTION public.create_bank_payment_order(
  p_company_id               uuid,
  p_order_id                 uuid,
  p_source_type              text,
  p_source_id                text,
  p_aspsp_name               text,
  p_aspsp_country            text,
  p_psu_type                 text,
  p_payment_type             text,
  p_currency                 text,
  p_requested_execution_date date,
  p_bank_connection_id       uuid,
  p_request_snapshot         jsonb,
  p_oauth_state              text,
  p_items                    jsonb,
  p_user_id                  uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role    text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_actor       uuid := COALESCE(p_user_id, auth.uid());
  v_caller_role text;
  v_existing    jsonb;
  v_total       numeric;
  v_count       integer;
  v_order       public.bank_payment_orders%ROWTYPE;
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF NOT public.caller_is_company_member(p_company_id) THEN
      RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
        USING ERRCODE = '42501';
    END IF;
    v_actor := auth.uid();
  END IF;

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthorized: no actor' USING ERRCODE = '42501';
  END IF;

  SELECT cm.role INTO v_caller_role
    FROM public.company_members cm
   WHERE cm.company_id = p_company_id AND cm.user_id = v_actor;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'unauthorized: caller has no write role in company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  IF p_order_id IS NULL OR p_request_snapshot IS NULL OR p_oauth_state IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'create_failed', 'details', 'missing header fields');
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'create_failed', 'details', 'no items');
  END IF;
  IF p_source_type NOT IN ('supplier_batch', 'tax_payment', 'salary_run') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'create_failed', 'details', 'unsupported source type');
  END IF;

  -- Friendly form of uq_bank_payment_orders_live_source. The index is the real
  -- guarantee; this exists so the common case returns a code the UI can explain
  -- instead of a raw unique-violation.
  SELECT jsonb_build_object('order_id', o.id, 'status', o.status)
    INTO v_existing
    FROM public.bank_payment_orders o
   WHERE o.company_id = p_company_id
     AND o.source_type = p_source_type
     AND o.source_id = p_source_id
     AND o.status NOT IN ('cancelled', 'failed', 'rejected')
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'already_sent', 'details', v_existing);
  END IF;

  SELECT round(sum((x ->> 'amount')::numeric), 2), count(*)
    INTO v_total, v_count
    FROM jsonb_array_elements(p_items) AS x;

  INSERT INTO public.bank_payment_orders
    (id, company_id, user_id, bank_connection_id, aspsp_name, aspsp_country, psu_type,
     source_type, source_id, payment_type, currency, total_amount, item_count,
     requested_execution_date, request_snapshot, oauth_state, status)
  VALUES
    (p_order_id, p_company_id, v_actor, p_bank_connection_id, p_aspsp_name,
     COALESCE(p_aspsp_country, 'SE'), p_psu_type, p_source_type, p_source_id, p_payment_type,
     COALESCE(p_currency, 'SEK'), v_total, v_count, p_requested_execution_date,
     p_request_snapshot, p_oauth_state, 'draft')
  RETURNING * INTO v_order;

  INSERT INTO public.bank_payment_order_items
    (order_id, company_id, supplier_invoice_id, amount, payment_date, payee_type,
     payee_bankgiro, payee_plusgiro, payee_clearing, payee_account, payee_name,
     reference_type, reference)
  SELECT p_order_id, p_company_id, r.supplier_invoice_id, r.amount, r.payment_date, r.payee_type,
         r.payee_bankgiro, r.payee_plusgiro, r.payee_clearing, r.payee_account, r.payee_name,
         r.reference_type, r.reference
    FROM jsonb_to_recordset(p_items) AS r(
      supplier_invoice_id uuid,
      amount              numeric,
      payment_date        date,
      payee_type          text,
      payee_bankgiro      text,
      payee_plusgiro      text,
      payee_clearing      text,
      payee_account       text,
      payee_name          text,
      reference_type      text,
      reference           text
    );

  RETURN jsonb_build_object('ok', true, 'order', to_jsonb(v_order));
END;
$function$;

REVOKE ALL ON FUNCTION public.create_bank_payment_order(uuid, uuid, text, text, text, text, text, text, text, date, uuid, jsonb, text, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_bank_payment_order(uuid, uuid, text, text, text, text, text, text, text, date, uuid, jsonb, text, jsonb, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
