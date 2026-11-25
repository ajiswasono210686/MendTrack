-- =============================================================================
-- MendTrack Stage 1: Multi-Tenant Foundation (Greenfield Migration)
-- Target project : mendtrack_dev (ncobbhceczfpxosgszwz)
-- DO NOT RUN on legacy production project mendtrack (zurtrvuyigwtmyfvrelb).
--
-- Includes:
--   1. Greenfield drop & recreate of 12 public tables (tenants, tenant_members,
--      and 10 tenant-scoped operational tables) with composite FKs & indexes.
--   2. Non-exposed `private` schema & `private.is_verified_tenant_member(uuid)`.
--   3. Strict RLS on all 12 public tables (zero `anon` policies).
--   4. All 7 operational triggers with locked search_path & tenant propagation.
--   5. 4 SECURITY INVOKER operational RPCs:
--        - save_order_with_items(p_tenant_id, ...)
--        - record_order_payment_v3(p_tenant_id, ...)
--        - add_manual_cash_transaction(p_tenant_id, ...)
--        - delete_order_cascade(p_tenant_id, p_order_id)
--   6. 1 SECURITY DEFINER atomic onboarding RPC:
--        - create_tenant_workspace(...) with starter measurement seeding.
--   7. Private `garment-photos` Storage bucket (5 MB, JPEG/PNG/WebP) + Storage RLS.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Drop legacy functions and single-tenant tables
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_public_order_tracking(text);
DROP FUNCTION IF EXISTS public.record_order_payment(uuid, numeric, text);
DROP FUNCTION IF EXISTS public.record_order_payment_v2(uuid, numeric, text, text, text);
DROP FUNCTION IF EXISTS public.record_order_payment_v3(uuid, numeric, text, text, text, text);
DROP FUNCTION IF EXISTS public.record_order_payment_v3(uuid, uuid, numeric, text, text, text, text);
DROP FUNCTION IF EXISTS public.save_order_with_items(uuid, text, text, text, date, text, numeric, jsonb);
DROP FUNCTION IF EXISTS public.save_order_with_items(uuid, uuid, text, text, text, date, text, numeric, jsonb);
DROP FUNCTION IF EXISTS public.add_manual_cash_transaction(text, text, numeric, text, text, timestamptz);
DROP FUNCTION IF EXISTS public.add_manual_cash_transaction(uuid, text, text, numeric, text, text, timestamptz);
DROP FUNCTION IF EXISTS public.delete_order_cascade(uuid);
DROP FUNCTION IF EXISTS public.delete_order_cascade(uuid, uuid);
DROP FUNCTION IF EXISTS public.create_tenant_workspace(text, text, text, text, text, text, integer);
DROP FUNCTION IF EXISTS public.normalize_customer_phone(text);
DROP FUNCTION IF EXISTS public.fn_log_status_change() CASCADE;
DROP FUNCTION IF EXISTS public.fn_sync_payment_status() CASCADE;
DROP FUNCTION IF EXISTS public.fn_audit_order_header_changes() CASCADE;
DROP FUNCTION IF EXISTS public.fn_sync_order_total() CASCADE;
DROP FUNCTION IF EXISTS public.fn_audit_order_item_changes() CASCADE;
DROP FUNCTION IF EXISTS public.set_measurement_updated_at() CASCADE;

DROP TABLE IF EXISTS public.order_payments CASCADE;
DROP TABLE IF EXISTS public.cash_transactions CASCADE;
DROP TABLE IF EXISTS public.order_logs CASCADE;
DROP TABLE IF EXISTS public.order_items CASCADE;
DROP TABLE IF EXISTS public.customer_measurements CASCADE;
DROP TABLE IF EXISTS public.measurement_template_fields CASCADE;
DROP TABLE IF EXISTS public.measurement_templates CASCADE;
DROP TABLE IF EXISTS public.orders CASCADE;
DROP TABLE IF EXISTS public.customers CASCADE;
DROP TABLE IF EXISTS public.services CASCADE;
DROP TABLE IF EXISTS public.store_settings CASCADE;
DROP TABLE IF EXISTS public.tenant_members CASCADE;
DROP TABLE IF EXISTS public.tenants CASCADE;

-- -----------------------------------------------------------------------------
-- 2. Core Multi-Tenant Tables (`tenants` & `tenant_members`)
-- -----------------------------------------------------------------------------
CREATE TABLE public.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  name text NOT NULL,
  address text NOT NULL DEFAULT '',
  admin_phone text NOT NULL DEFAULT '',
  tagline text NOT NULL DEFAULT '',
  opening_hours text NOT NULL DEFAULT '',
  daily_capacity_minutes integer NOT NULL DEFAULT 480,
  logo_data_url text,
  locale text NOT NULL DEFAULT 'id',
  currency text NOT NULL DEFAULT 'IDR',
  timezone text NOT NULL DEFAULT 'Asia/Jakarta',
  ticket_prefix text NOT NULL DEFAULT 'MND',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenants_slug_format_check CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$'),
  CONSTRAINT tenants_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT tenants_daily_capacity_positive CHECK (daily_capacity_minutes > 0),
  CONSTRAINT tenants_logo_data_url_check CHECK (
    logo_data_url IS NULL
    OR (logo_data_url ~ '^data:image/(png|jpeg|webp);base64,' AND length(logo_data_url) <= 500000)
  ),
  CONSTRAINT tenants_locale_check CHECK (locale IN ('id', 'en')),
  CONSTRAINT tenants_currency_not_blank CHECK (length(btrim(currency)) > 0),
  CONSTRAINT tenants_timezone_not_blank CHECK (length(btrim(timezone)) > 0),
  CONSTRAINT tenants_ticket_prefix_check CHECK (ticket_prefix ~ '^[A-Z0-9]{2,8}$')
);

CREATE TABLE public.tenant_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_members_role_check CHECK (role IN ('owner', 'admin', 'staff')),
  CONSTRAINT tenant_members_tenant_user_key UNIQUE (tenant_id, user_id)
);

CREATE INDEX idx_tenant_members_active_user_tenant
  ON public.tenant_members (user_id, tenant_id)
  WHERE is_active = true;

CREATE INDEX idx_tenant_members_tenant_id
  ON public.tenant_members (tenant_id);

-- -----------------------------------------------------------------------------
-- 3. Tenant-Scoped Operational Tables (10 Tables)
-- -----------------------------------------------------------------------------
CREATE TABLE public.services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  estimated_minutes integer NOT NULL,
  service_category text NOT NULL DEFAULT 'reparasi',
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT services_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT services_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT services_estimated_minutes_positive CHECK (estimated_minutes > 0),
  CONSTRAINT services_service_category_check CHECK (service_category IN ('reparasi', 'custom'))
);

COMMENT ON COLUMN public.services.service_category IS
  'Jenis layanan untuk klasifikasi pendapatan: reparasi atau custom.';

CREATE INDEX idx_services_tenant_sort
  ON public.services (tenant_id, sort_order, name);

CREATE TABLE public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  phone text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customers_tenant_phone_key UNIQUE (tenant_id, phone),
  CONSTRAINT customers_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT customers_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT customers_phone_not_blank CHECK (length(btrim(phone)) > 0)
);

CREATE INDEX idx_customers_tenant_name
  ON public.customers (tenant_id, name);

CREATE TABLE public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  ticket_code varchar NOT NULL,
  customer_id uuid,
  customer_name varchar NOT NULL,
  customer_phone varchar NOT NULL,
  status varchar NOT NULL DEFAULT 'received',
  total_amount numeric(14, 2) NOT NULL DEFAULT 0,
  paid_amount numeric(14, 2) NOT NULL DEFAULT 0,
  payment_status varchar NOT NULL DEFAULT 'unpaid',
  estimated_done_date date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_tenant_ticket_key UNIQUE (tenant_id, ticket_code),
  CONSTRAINT orders_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT orders_tenant_customer_fkey
    FOREIGN KEY (tenant_id, customer_id)
    REFERENCES public.customers(tenant_id, id)
    ON DELETE SET NULL (customer_id),
  CONSTRAINT orders_ticket_code_not_blank CHECK (length(btrim(ticket_code)) > 0),
  CONSTRAINT orders_status_check CHECK (
    status IN ('received', 'queued', 'in_progress', 'qc', 'ready', 'completed')
  ),
  CONSTRAINT orders_total_amount_non_negative CHECK (total_amount >= 0),
  CONSTRAINT orders_paid_amount_non_negative CHECK (paid_amount >= 0),
  CONSTRAINT orders_payment_status_check CHECK (payment_status IN ('unpaid', 'partial', 'paid'))
);

CREATE INDEX idx_orders_tenant_created_at
  ON public.orders (tenant_id, created_at DESC);

CREATE INDEX idx_orders_tenant_status
  ON public.orders (tenant_id, status);

CREATE INDEX idx_orders_tenant_customer_phone
  ON public.orders (tenant_id, customer_phone);

CREATE INDEX idx_orders_tenant_customer_id
  ON public.orders (tenant_id, customer_id)
  WHERE customer_id IS NOT NULL;

CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  garment_name varchar NOT NULL,
  service_type varchar NOT NULL,
  measurement_specs jsonb NOT NULL DEFAULT '{}'::jsonb,
  price numeric(14, 2) NOT NULL DEFAULT 0,
  before_photo_path text,
  after_photo_path text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_items_tenant_order_fkey
    FOREIGN KEY (tenant_id, order_id)
    REFERENCES public.orders(tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT order_items_price_non_negative CHECK (price >= 0),
  CONSTRAINT order_items_before_photo_path_prefix_check CHECK (
    before_photo_path IS NULL
    OR left(before_photo_path, length(tenant_id::text || '/' || order_id::text || '/'))
       = (tenant_id::text || '/' || order_id::text || '/')
  ),
  CONSTRAINT order_items_after_photo_path_prefix_check CHECK (
    after_photo_path IS NULL
    OR left(after_photo_path, length(tenant_id::text || '/' || order_id::text || '/'))
       = (tenant_id::text || '/' || order_id::text || '/')
  )
);

CREATE INDEX idx_order_items_tenant_order_created
  ON public.order_items (tenant_id, order_id, created_at ASC);

CREATE TABLE public.order_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  status varchar NOT NULL,
  log_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_logs_tenant_order_fkey
    FOREIGN KEY (tenant_id, order_id)
    REFERENCES public.orders(tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT order_logs_status_check CHECK (
    status IN ('received', 'queued', 'in_progress', 'qc', 'ready', 'completed')
  )
);

COMMENT ON TABLE public.order_logs IS
  'Riwayat aktivitas MendTrack per tenant. Catatan bersifat append-only untuk role authenticated.';

CREATE INDEX idx_order_logs_tenant_order_created
  ON public.order_logs (tenant_id, order_id, created_at ASC);

CREATE TABLE public.cash_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  transaction_type text NOT NULL,
  category text NOT NULL,
  amount numeric(14, 2) NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  payment_method text NOT NULL DEFAULT 'Tunai',
  description text,
  order_id uuid,
  source_type text NOT NULL DEFAULT 'manual',
  source_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid(),
  CONSTRAINT cash_transactions_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT cash_transactions_tenant_order_fkey
    FOREIGN KEY (tenant_id, order_id)
    REFERENCES public.orders(tenant_id, id)
    ON DELETE SET NULL (order_id),
  CONSTRAINT cash_transactions_type_check CHECK (transaction_type IN ('income', 'expense')),
  CONSTRAINT cash_transactions_amount_positive CHECK (amount > 0),
  CONSTRAINT cash_transactions_payment_method_check CHECK (
    payment_method IN ('Tunai', 'Transfer', 'QRIS', 'Lainnya')
  ),
  CONSTRAINT cash_transactions_source_type_check CHECK (source_type IN ('manual', 'order_payment'))
);

COMMENT ON TABLE public.cash_transactions IS
  'Buku kas terpadu per tenant. Saldo gabungan = total income - total expense.';

CREATE UNIQUE INDEX uq_cash_transactions_tenant_source_key
  ON public.cash_transactions (tenant_id, source_key)
  WHERE source_key IS NOT NULL;

CREATE INDEX idx_cash_transactions_tenant_occurred_at
  ON public.cash_transactions (tenant_id, occurred_at DESC);

CREATE INDEX idx_cash_transactions_tenant_order_id
  ON public.cash_transactions (tenant_id, order_id)
  WHERE order_id IS NOT NULL;

CREATE TABLE public.order_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  amount numeric(14, 2) NOT NULL,
  payment_type text NOT NULL,
  payment_method text NOT NULL DEFAULT 'Tunai',
  paid_at timestamptz NOT NULL DEFAULT now(),
  note text,
  cash_transaction_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid(),
  idempotency_key text,
  CONSTRAINT order_payments_tenant_order_fkey
    FOREIGN KEY (tenant_id, order_id)
    REFERENCES public.orders(tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT order_payments_tenant_cash_fkey
    FOREIGN KEY (tenant_id, cash_transaction_id)
    REFERENCES public.cash_transactions(tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT order_payments_amount_positive CHECK (amount > 0),
  CONSTRAINT order_payments_type_check CHECK (payment_type IN ('dp', 'pelunasan')),
  CONSTRAINT order_payments_method_check CHECK (
    payment_method IN ('Tunai', 'Transfer', 'QRIS', 'Lainnya')
  )
);

COMMENT ON TABLE public.order_payments IS
  'Riwayat penerimaan uang order per tenant (DP dan pelunasan).';

CREATE UNIQUE INDEX uq_order_payments_tenant_idempotency_key
  ON public.order_payments (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_order_payments_tenant_order_paid_at
  ON public.order_payments (tenant_id, order_id, paid_at DESC);

CREATE INDEX idx_order_payments_tenant_cash_tx
  ON public.order_payments (tenant_id, cash_transaction_id)
  WHERE cash_transaction_id IS NOT NULL;

CREATE TABLE public.measurement_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  garment_type text NOT NULL,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT measurement_templates_tenant_garment_key UNIQUE (tenant_id, garment_type),
  CONSTRAINT measurement_templates_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT measurement_templates_garment_type_not_blank CHECK (length(btrim(garment_type)) > 0)
);

CREATE INDEX idx_measurement_templates_tenant_type
  ON public.measurement_templates (tenant_id, garment_type);

CREATE TABLE public.measurement_template_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  template_id uuid NOT NULL,
  field_key text NOT NULL,
  field_label text NOT NULL,
  unit text NOT NULL DEFAULT 'cm',
  is_required boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT measurement_template_fields_tenant_template_fkey
    FOREIGN KEY (tenant_id, template_id)
    REFERENCES public.measurement_templates(tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT measurement_template_fields_template_field_key UNIQUE (template_id, field_key),
  CONSTRAINT measurement_template_fields_key_not_blank CHECK (length(btrim(field_key)) > 0),
  CONSTRAINT measurement_template_fields_label_not_blank CHECK (length(btrim(field_label)) > 0)
);

CREATE INDEX idx_measurement_template_fields_tenant_template_sort
  ON public.measurement_template_fields (tenant_id, template_id, sort_order);

CREATE TABLE public.customer_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  template_id uuid,
  garment_type text NOT NULL,
  model text,
  description text,
  measurement_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  template_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_measurements_tenant_customer_fkey
    FOREIGN KEY (tenant_id, customer_id)
    REFERENCES public.customers(tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT customer_measurements_tenant_template_fkey
    FOREIGN KEY (tenant_id, template_id)
    REFERENCES public.measurement_templates(tenant_id, id)
    ON DELETE SET NULL (template_id),
  CONSTRAINT customer_measurements_garment_type_not_blank CHECK (length(btrim(garment_type)) > 0),
  CONSTRAINT customer_measurements_data_object CHECK (jsonb_typeof(measurement_data) = 'object'),
  CONSTRAINT customer_measurements_snapshot_array CHECK (jsonb_typeof(template_snapshot) = 'array')
);

CREATE INDEX idx_customer_measurements_tenant_customer_created
  ON public.customer_measurements (tenant_id, customer_id, created_at DESC);

CREATE INDEX idx_customer_measurements_tenant_customer_type
  ON public.customer_measurements (tenant_id, customer_id, garment_type);

CREATE INDEX idx_customer_measurements_tenant_template
  ON public.customer_measurements (tenant_id, template_id)
  WHERE template_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 4. Non-Exposed `private` Schema & Verified Tenant Membership Helper
-- -----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS private;

REVOKE ALL ON SCHEMA private FROM PUBLIC;
REVOKE ALL ON SCHEMA private FROM anon;
GRANT USAGE ON SCHEMA private TO authenticated;
GRANT USAGE ON SCHEMA private TO service_role;

CREATE OR REPLACE FUNCTION private.is_verified_tenant_member(p_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    p_tenant_id IS NOT NULL
    AND (SELECT auth.uid()) IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM auth.users u
      JOIN public.tenant_members tm
        ON tm.user_id = u.id
      JOIN public.tenants t
        ON t.id = tm.tenant_id
      WHERE u.id = (SELECT auth.uid())
        AND u.email_confirmed_at IS NOT NULL
        AND tm.tenant_id = p_tenant_id
        AND tm.is_active = true
        AND t.is_active = true
    );
$$;

REVOKE ALL ON FUNCTION private.is_verified_tenant_member(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.is_verified_tenant_member(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION private.is_verified_tenant_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.is_verified_tenant_member(uuid) TO service_role;

-- -----------------------------------------------------------------------------
-- 5. Table Grants & Strict Row-Level Security (Zero `anon` Access)
-- -----------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;

GRANT SELECT, UPDATE ON public.tenants TO authenticated;
GRANT SELECT ON public.tenant_members TO authenticated;
GRANT SELECT, INSERT ON public.order_logs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.services,
  public.customers,
  public.orders,
  public.order_items,
  public.order_payments,
  public.cash_transactions,
  public.measurement_templates,
  public.measurement_template_fields,
  public.customer_measurements
TO authenticated;

GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.measurement_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.measurement_template_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_measurements ENABLE ROW LEVEL SECURITY;

-- tenants: SELECT and UPDATE only for verified active members (no direct INSERT/DELETE)
CREATE POLICY tenants_member_select
  ON public.tenants
  FOR SELECT
  TO authenticated
  USING ((SELECT private.is_verified_tenant_member(id)));

CREATE POLICY tenants_member_update
  ON public.tenants
  FOR UPDATE
  TO authenticated
  USING ((SELECT private.is_verified_tenant_member(id)))
  WITH CHECK ((SELECT private.is_verified_tenant_member(id)));

-- tenant_members: authenticated user can SELECT only their own rows (no direct INSERT/UPDATE/DELETE)
CREATE POLICY tenant_members_self_select
  ON public.tenant_members
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- order_logs: append-only (SELECT + INSERT only)
CREATE POLICY order_logs_tenant_select
  ON public.order_logs
  FOR SELECT
  TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)));

CREATE POLICY order_logs_tenant_insert
  ON public.order_logs
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT private.is_verified_tenant_member(tenant_id)));

-- services
CREATE POLICY services_tenant_select
  ON public.services FOR SELECT TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)));
CREATE POLICY services_tenant_insert
  ON public.services FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.is_verified_tenant_member(tenant_id)));
CREATE POLICY services_tenant_update
  ON public.services FOR UPDATE TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)))
  WITH CHECK ((SELECT private.is_verified_tenant_member(tenant_id)));
CREATE POLICY services_tenant_delete
  ON public.services FOR DELETE TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)));

-- customers
CREATE POLICY customers_tenant_select
  ON public.customers FOR SELECT TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)));
CREATE POLICY customers_tenant_insert
  ON public.customers FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.is_verified_tenant_member(tenant_id)));
CREATE POLICY customers_tenant_update
  ON public.customers FOR UPDATE TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)))
  WITH CHECK ((SELECT private.is_verified_tenant_member(tenant_id)));
CREATE POLICY customers_tenant_delete
  ON public.customers FOR DELETE TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)));

-- orders
CREATE POLICY orders_tenant_select
  ON public.orders FOR SELECT TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)));
CREATE POLICY orders_tenant_insert
  ON public.orders FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.is_verified_tenant_member(tenant_id)));
CREATE POLICY orders_tenant_update
  ON public.orders FOR UPDATE TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)))
  WITH CHECK ((SELECT private.is_verified_tenant_member(tenant_id)));
CREATE POLICY orders_tenant_delete
  ON public.orders FOR DELETE TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)));

-- order_items
CREATE POLICY order_items_tenant_select
  ON public.order_items FOR SELECT TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)));
CREATE POLICY order_items_tenant_insert
  ON public.order_items FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.is_verified_tenant_member(tenant_id)));
CREATE POLICY order_items_tenant_update
  ON public.order_items FOR UPDATE TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)))
  WITH CHECK ((SELECT private.is_verified_tenant_member(tenant_id)));
CREATE POLICY order_items_tenant_delete
  ON public.order_items FOR DELETE TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)));

-- order_payments
CREATE POLICY order_payments_tenant_select
  ON public.order_payments FOR SELECT TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)));
CREATE POLICY order_payments_tenant_insert
  ON public.order_payments FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.is_verified_tenant_member(tenant_id)));
CREATE POLICY order_payments_tenant_update
  ON public.order_payments FOR UPDATE TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)))
  WITH CHECK ((SELECT private.is_verified_tenant_member(tenant_id)));
CREATE POLICY order_payments_tenant_delete
  ON public.order_payments FOR DELETE TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)));

-- cash_transactions
CREATE POLICY cash_transactions_tenant_select
  ON public.cash_transactions FOR SELECT TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)));
CREATE POLICY cash_transactions_tenant_insert
  ON public.cash_transactions FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.is_verified_tenant_member(tenant_id)));
CREATE POLICY cash_transactions_tenant_update
  ON public.cash_transactions FOR UPDATE TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)))
  WITH CHECK ((SELECT private.is_verified_tenant_member(tenant_id)));
CREATE POLICY cash_transactions_tenant_delete
  ON public.cash_transactions FOR DELETE TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)));

-- measurement_templates
CREATE POLICY measurement_templates_tenant_select
  ON public.measurement_templates FOR SELECT TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)));
CREATE POLICY measurement_templates_tenant_insert
  ON public.measurement_templates FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.is_verified_tenant_member(tenant_id)));
CREATE POLICY measurement_templates_tenant_update
  ON public.measurement_templates FOR UPDATE TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)))
  WITH CHECK ((SELECT private.is_verified_tenant_member(tenant_id)));
CREATE POLICY measurement_templates_tenant_delete
  ON public.measurement_templates FOR DELETE TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)));

-- measurement_template_fields
CREATE POLICY measurement_template_fields_tenant_select
  ON public.measurement_template_fields FOR SELECT TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)));
CREATE POLICY measurement_template_fields_tenant_insert
  ON public.measurement_template_fields FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.is_verified_tenant_member(tenant_id)));
CREATE POLICY measurement_template_fields_tenant_update
  ON public.measurement_template_fields FOR UPDATE TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)))
  WITH CHECK ((SELECT private.is_verified_tenant_member(tenant_id)));
CREATE POLICY measurement_template_fields_tenant_delete
  ON public.measurement_template_fields FOR DELETE TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)));

-- customer_measurements
CREATE POLICY customer_measurements_tenant_select
  ON public.customer_measurements FOR SELECT TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)));
CREATE POLICY customer_measurements_tenant_insert
  ON public.customer_measurements FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.is_verified_tenant_member(tenant_id)));
CREATE POLICY customer_measurements_tenant_update
  ON public.customer_measurements FOR UPDATE TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)))
  WITH CHECK ((SELECT private.is_verified_tenant_member(tenant_id)));
CREATE POLICY customer_measurements_tenant_delete
  ON public.customer_measurements FOR DELETE TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)));

-- -----------------------------------------------------------------------------
-- 6. Utility & Trigger Functions (All with locked `SET search_path = ''`)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.normalize_customer_phone(p_phone text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN digits = '' THEN ''
    WHEN digits LIKE '0%' THEN '62' || substring(digits FROM 2)
    WHEN digits LIKE '8%' THEN '62' || digits
    ELSE digits
  END
  FROM (
    SELECT regexp_replace(COALESCE(p_phone, ''), '[^0-9]', '', 'g') AS digits
  ) AS normalized;
$$;

CREATE OR REPLACE FUNCTION public.set_measurement_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_log_status_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_default_note text;
BEGIN
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status) THEN
    v_default_note := CASE NEW.status
      WHEN 'received' THEN 'Order diterima oleh workshop'
      WHEN 'queued' THEN 'Order masuk dalam antrean pengerjaan'
      WHEN 'in_progress' THEN 'Sedang dalam proses pengerjaan'
      WHEN 'qc' THEN 'Tahap pemeriksaan kualitas (Quality Check)'
      WHEN 'ready' THEN 'Pengerjaan selesai dan siap diambil'
      WHEN 'completed' THEN 'Order telah diambil / selesai'
      ELSE 'Status diperbarui'
    END;

    INSERT INTO public.order_logs (tenant_id, order_id, status, log_note)
    VALUES (NEW.tenant_id, NEW.id, NEW.status, v_default_note);
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_sync_payment_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.paid_amount <= 0 THEN
    NEW.payment_status := 'unpaid';
  ELSIF NEW.paid_amount < NEW.total_amount THEN
    NEW.payment_status := 'partial';
  ELSE
    NEW.payment_status := 'paid';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_audit_order_header_changes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_actor text := COALESCE((SELECT auth.uid())::text, 'system/unknown');
  v_changes text[] := ARRAY[]::text[];
BEGIN
  IF OLD.ticket_code IS DISTINCT FROM NEW.ticket_code THEN
    v_changes := array_append(
      v_changes,
      format('Kode tiket: %s -> %s', COALESCE(OLD.ticket_code, '(kosong)'), COALESCE(NEW.ticket_code, '(kosong)'))
    );
  END IF;
  IF OLD.customer_name IS DISTINCT FROM NEW.customer_name THEN
    v_changes := array_append(
      v_changes,
      format('Nama pelanggan: %s -> %s', COALESCE(OLD.customer_name, '(kosong)'), COALESCE(NEW.customer_name, '(kosong)'))
    );
  END IF;
  IF OLD.customer_phone IS DISTINCT FROM NEW.customer_phone THEN
    v_changes := array_append(
      v_changes,
      format('Nomor WhatsApp: %s -> %s', COALESCE(OLD.customer_phone, '(kosong)'), COALESCE(NEW.customer_phone, '(kosong)'))
    );
  END IF;
  IF OLD.estimated_done_date IS DISTINCT FROM NEW.estimated_done_date THEN
    v_changes := array_append(
      v_changes,
      format('Target selesai: %s -> %s', COALESCE(OLD.estimated_done_date::text, '(kosong)'), COALESCE(NEW.estimated_done_date::text, '(kosong)'))
    );
  END IF;
  IF OLD.notes IS DISTINCT FROM NEW.notes THEN
    v_changes := array_append(
      v_changes,
      format('Catatan workshop diperbarui. Sebelum: %s | Sesudah: %s', COALESCE(OLD.notes, '(kosong)'), COALESCE(NEW.notes, '(kosong)'))
    );
  END IF;

  IF cardinality(v_changes) > 0 THEN
    INSERT INTO public.order_logs (tenant_id, order_id, status, log_note)
    VALUES (
      NEW.tenant_id,
      NEW.id,
      NEW.status,
      'Data order diperbarui: ' || array_to_string(v_changes, '; ') || ' | Admin: ' || v_actor
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_sync_order_total()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_order_id uuid;
  v_new_total numeric(14, 2);
BEGIN
  v_tenant_id := COALESCE(NEW.tenant_id, OLD.tenant_id);
  v_order_id := COALESCE(NEW.order_id, OLD.order_id);

  SELECT COALESCE(SUM(price), 0)
  INTO v_new_total
  FROM public.order_items
  WHERE tenant_id = v_tenant_id
    AND order_id = v_order_id;

  UPDATE public.orders
  SET total_amount = v_new_total
  WHERE id = v_order_id
    AND tenant_id = v_tenant_id;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_audit_order_item_changes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_order_id uuid;
  v_status text;
  v_actor text := COALESCE((SELECT auth.uid())::text, 'system/unknown');
  v_details text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_tenant_id := NEW.tenant_id;
    v_order_id := NEW.order_id;
    SELECT status INTO v_status
    FROM public.orders
    WHERE id = v_order_id AND tenant_id = v_tenant_id;

    v_details := format(
      'Item ditambahkan: %s | Layanan: %s | Harga: %s | Spesifikasi: %s',
      COALESCE(NEW.garment_name, '(tanpa nama)'),
      COALESCE(NEW.service_type, '(tanpa layanan)'),
      COALESCE(NEW.price::text, '0'),
      COALESCE(NEW.measurement_specs::text, '{}')
    );
  ELSIF TG_OP = 'DELETE' THEN
    v_tenant_id := OLD.tenant_id;
    v_order_id := OLD.order_id;
    SELECT status INTO v_status
    FROM public.orders
    WHERE id = v_order_id AND tenant_id = v_tenant_id;

    -- Skip logging if parent order is already being deleted via cascade.
    IF NOT FOUND THEN
      RETURN OLD;
    END IF;

    v_details := format(
      'Item dihapus: %s | Layanan: %s | Harga: %s | Spesifikasi: %s',
      COALESCE(OLD.garment_name, '(tanpa nama)'),
      COALESCE(OLD.service_type, '(tanpa layanan)'),
      COALESCE(OLD.price::text, '0'),
      COALESCE(OLD.measurement_specs::text, '{}')
    );
  ELSE
    v_tenant_id := NEW.tenant_id;
    v_order_id := NEW.order_id;
    SELECT status INTO v_status
    FROM public.orders
    WHERE id = v_order_id AND tenant_id = v_tenant_id;

    v_details := 'Item diperbarui: ' || concat_ws(
      '; ',
      CASE WHEN OLD.garment_name IS DISTINCT FROM NEW.garment_name THEN format('Nama: %s -> %s', OLD.garment_name, NEW.garment_name) END,
      CASE WHEN OLD.service_type IS DISTINCT FROM NEW.service_type THEN format('Layanan: %s -> %s', OLD.service_type, NEW.service_type) END,
      CASE WHEN OLD.price IS DISTINCT FROM NEW.price THEN format('Harga: %s -> %s', OLD.price, NEW.price) END,
      CASE WHEN OLD.measurement_specs IS DISTINCT FROM NEW.measurement_specs THEN format('Spesifikasi: %s -> %s', OLD.measurement_specs, NEW.measurement_specs) END,
      CASE WHEN OLD.before_photo_path IS DISTINCT FROM NEW.before_photo_path THEN 'Foto Before diperbarui' END,
      CASE WHEN OLD.after_photo_path IS DISTINCT FROM NEW.after_photo_path THEN 'Foto After diperbarui' END
    );

    IF v_details = 'Item diperbarui: ' THEN
      RETURN NEW;
    END IF;
  END IF;

  INSERT INTO public.order_logs (tenant_id, order_id, status, log_note)
  VALUES (v_tenant_id, v_order_id, COALESCE(v_status, 'received'), v_details || ' | Admin: ' || v_actor);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$;

-- 7 Operational Triggers
CREATE TRIGGER trg_log_status_change
  AFTER INSERT OR UPDATE OF status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.fn_log_status_change();

CREATE TRIGGER trg_sync_payment_status
  BEFORE INSERT OR UPDATE OF total_amount, paid_amount, status, customer_name, customer_phone, estimated_done_date, notes ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.fn_sync_payment_status();

CREATE TRIGGER trg_audit_order_header_changes
  AFTER UPDATE OF ticket_code, customer_name, customer_phone, estimated_done_date, notes ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.fn_audit_order_header_changes();

CREATE TRIGGER trg_sync_order_total
  AFTER INSERT OR DELETE OR UPDATE OF price ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public.fn_sync_order_total();

CREATE TRIGGER trg_audit_order_item_changes
  AFTER INSERT OR DELETE OR UPDATE ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public.fn_audit_order_item_changes();

CREATE TRIGGER trg_measurement_templates_updated_at
  BEFORE UPDATE ON public.measurement_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_measurement_updated_at();

CREATE TRIGGER trg_customer_measurements_updated_at
  BEFORE UPDATE ON public.customer_measurements
  FOR EACH ROW EXECUTE FUNCTION public.set_measurement_updated_at();

-- -----------------------------------------------------------------------------
-- 7. Operational RPCs (SECURITY INVOKER, locked search_path, tenant-validated)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.add_manual_cash_transaction(
  p_tenant_id uuid,
  p_transaction_type text,
  p_category text,
  p_amount numeric,
  p_payment_method text DEFAULT 'Tunai',
  p_description text DEFAULT NULL,
  p_occurred_at timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  IF p_tenant_id IS NULL OR NOT private.is_verified_tenant_member(p_tenant_id) THEN
    RAISE EXCEPTION 'Akses tenant tidak valid.';
  END IF;
  IF p_transaction_type NOT IN ('income', 'expense') THEN
    RAISE EXCEPTION 'Jenis transaksi tidak valid.';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Nominal harus lebih dari nol.';
  END IF;
  IF COALESCE(p_payment_method, 'Tunai') NOT IN ('Tunai', 'Transfer', 'QRIS', 'Lainnya') THEN
    RAISE EXCEPTION 'Metode pembayaran tidak valid.';
  END IF;
  IF p_transaction_type = 'income' AND p_category NOT IN ('custom', 'reparasi', 'lain_lain') THEN
    RAISE EXCEPTION 'Kategori uang masuk tidak valid.';
  END IF;
  IF p_transaction_type = 'expense' AND p_category NOT IN ('alat_bahan', 'operasional', 'makan_minum', 'gaji', 'lain_lain') THEN
    RAISE EXCEPTION 'Kategori uang keluar tidak valid.';
  END IF;

  INSERT INTO public.cash_transactions (
    id, tenant_id, transaction_type, category, amount, occurred_at,
    payment_method, description, order_id, source_type, source_key, created_by
  )
  VALUES (
    v_id, p_tenant_id, p_transaction_type, p_category, p_amount, COALESCE(p_occurred_at, now()),
    COALESCE(p_payment_method, 'Tunai'), NULLIF(btrim(p_description), ''), NULL, 'manual', NULL, auth.uid()
  );

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_order_payment_v3(
  p_tenant_id uuid,
  p_order_id uuid,
  p_amount numeric,
  p_payment_type text,
  p_pay_method text DEFAULT 'Tunai',
  p_note text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_payment_id uuid := gen_random_uuid();
  v_existing_payment_id uuid;
  v_cash_id uuid := gen_random_uuid();
  v_old_paid numeric(14, 2);
  v_due numeric(14, 2);
  v_new_paid numeric(14, 2);
  v_category text := 'lain_lain';
  v_item_count integer := 0;
  v_matched_count integer := 0;
  v_distinct_categories integer := 0;
  v_method text;
BEGIN
  IF p_tenant_id IS NULL OR NOT private.is_verified_tenant_member(p_tenant_id) THEN
    RAISE EXCEPTION 'Akses tenant tidak valid.';
  END IF;
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'Order ID wajib diisi.';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Nominal pembayaran harus lebih dari nol.';
  END IF;
  IF p_payment_type NOT IN ('dp', 'pelunasan') THEN
    RAISE EXCEPTION 'Jenis pembayaran hanya DP atau Pelunasan.';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'Kunci idempotensi pembayaran wajib diisi.';
  END IF;

  v_method := COALESCE(NULLIF(btrim(p_pay_method), ''), 'Tunai');
  IF v_method NOT IN ('Tunai', 'Transfer', 'QRIS', 'Lainnya') THEN
    RAISE EXCEPTION 'Metode pembayaran tidak valid.';
  END IF;

  SELECT *
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
    AND tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order tidak ditemukan atau tidak dapat diakses.';
  END IF;

  SELECT id
  INTO v_existing_payment_id
  FROM public.order_payments
  WHERE tenant_id = p_tenant_id
    AND idempotency_key = p_idempotency_key;

  IF FOUND THEN
    RETURN v_existing_payment_id;
  END IF;

  v_payment_id := gen_random_uuid();
  v_old_paid := COALESCE(v_order.paid_amount, 0);
  v_due := GREATEST(0, COALESCE(v_order.total_amount, 0) - v_old_paid);

  IF p_amount > v_due THEN
    RAISE EXCEPTION 'Pembayaran melebihi sisa tagihan. Sisa: %', v_due;
  END IF;
  IF p_payment_type = 'pelunasan' AND p_amount <> v_due THEN
    RAISE EXCEPTION 'Nominal pelunasan harus sama dengan sisa tagihan: %', v_due;
  END IF;
  IF p_payment_type = 'dp' AND v_old_paid > 0 THEN
    RAISE EXCEPTION 'DP awal sudah tercatat. Gunakan tombol Pelunasan untuk pembayaran berikutnya.';
  END IF;

  -- Classify income category strictly using the same tenant's services catalog.
  SELECT count(*), count(s.id), count(DISTINCT s.service_category)
  INTO v_item_count, v_matched_count, v_distinct_categories
  FROM public.order_items oi
  LEFT JOIN public.services s
    ON s.tenant_id = v_order.tenant_id
   AND lower(btrim(s.name)) = lower(btrim(oi.service_type))
  WHERE oi.tenant_id = v_order.tenant_id
    AND oi.order_id = p_order_id;

  IF v_item_count > 0 AND v_matched_count = v_item_count AND v_distinct_categories = 1 THEN
    SELECT min(s.service_category)
    INTO v_category
    FROM public.order_items oi
    JOIN public.services s
      ON s.tenant_id = v_order.tenant_id
     AND lower(btrim(s.name)) = lower(btrim(oi.service_type))
    WHERE oi.tenant_id = v_order.tenant_id
      AND oi.order_id = p_order_id;
  END IF;

  INSERT INTO public.order_payments (
    id, tenant_id, order_id, amount, payment_type, payment_method,
    paid_at, note, idempotency_key, created_by
  )
  VALUES (
    v_payment_id, p_tenant_id, p_order_id, p_amount, p_payment_type, v_method,
    now(), p_note, p_idempotency_key, auth.uid()
  );

  INSERT INTO public.cash_transactions (
    id, tenant_id, transaction_type, category, amount, occurred_at,
    payment_method, description, order_id, source_type, source_key, created_by
  )
  VALUES (
    v_cash_id, p_tenant_id, 'income', v_category, p_amount, now(), v_method,
    concat('Pembayaran ', upper(p_payment_type), ' - ', COALESCE(v_order.ticket_code, p_order_id::text)),
    p_order_id, 'order_payment', 'order_payment:' || v_payment_id::text, auth.uid()
  );

  UPDATE public.order_payments
  SET cash_transaction_id = v_cash_id
  WHERE id = v_payment_id
    AND tenant_id = p_tenant_id;

  v_new_paid := v_old_paid + p_amount;

  UPDATE public.orders
  SET paid_amount = v_new_paid,
      payment_status = CASE
        WHEN v_new_paid >= COALESCE(total_amount, 0) THEN 'paid'
        WHEN v_new_paid > 0 THEN 'partial'
        ELSE 'unpaid'
      END,
      updated_at = now()
  WHERE id = p_order_id
    AND tenant_id = p_tenant_id;

  INSERT INTO public.order_logs (tenant_id, order_id, status, log_note)
  VALUES (
    p_tenant_id,
    p_order_id,
    v_order.status,
    format(
      'Pembayaran %s diterima: %s via %s',
      upper(p_payment_type),
      to_char(p_amount, 'FM999G999G999G990D00'),
      v_method
    )
  );

  RETURN v_payment_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_order_with_items(
  p_tenant_id uuid,
  p_order_id uuid,
  p_ticket_code text,
  p_customer_name text,
  p_customer_phone text,
  p_estimated_done_date date,
  p_notes text,
  p_paid_amount numeric,
  p_items jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_order_id uuid := COALESCE(p_order_id, gen_random_uuid());
  v_customer_id uuid;
  v_normalized_phone text;
  v_item jsonb;
  v_item_id uuid;
  v_keep_ids uuid[] := ARRAY[]::uuid[];
  v_is_new boolean := false;
  v_before_path text;
  v_after_path text;
BEGIN
  IF p_tenant_id IS NULL OR NOT private.is_verified_tenant_member(p_tenant_id) THEN
    RAISE EXCEPTION 'Akses tenant tidak valid.';
  END IF;
  IF p_ticket_code IS NULL OR btrim(p_ticket_code) = '' THEN
    RAISE EXCEPTION 'Kode tiket wajib diisi.';
  END IF;
  IF p_customer_name IS NULL OR btrim(p_customer_name) = '' THEN
    RAISE EXCEPTION 'Nama pelanggan wajib diisi.';
  END IF;
  IF p_customer_phone IS NULL OR btrim(p_customer_phone) = '' THEN
    RAISE EXCEPTION 'Nomor pelanggan wajib diisi.';
  END IF;
  IF p_paid_amount IS NULL OR p_paid_amount < 0 THEN
    RAISE EXCEPTION 'Nominal DP tidak valid.';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Order harus memiliki minimal satu item.';
  END IF;

  v_normalized_phone := public.normalize_customer_phone(p_customer_phone);
  IF v_normalized_phone = '' THEN
    RAISE EXCEPTION 'Nomor pelanggan tidak valid.';
  END IF;

  INSERT INTO public.customers (tenant_id, name, phone)
  VALUES (p_tenant_id, btrim(p_customer_name), v_normalized_phone)
  ON CONFLICT (tenant_id, phone) DO NOTHING
  RETURNING id INTO v_customer_id;

  IF v_customer_id IS NULL THEN
    SELECT id
    INTO v_customer_id
    FROM public.customers
    WHERE tenant_id = p_tenant_id
      AND phone = v_normalized_phone;
  END IF;

  IF v_customer_id IS NULL THEN
    RAISE EXCEPTION 'Data pelanggan gagal ditemukan atau dibuat.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.orders
    WHERE id = v_order_id
      AND tenant_id = p_tenant_id
  ) THEN
    PERFORM 1
    FROM public.orders
    WHERE id = v_order_id
      AND tenant_id = p_tenant_id
    FOR UPDATE;

    UPDATE public.orders
    SET ticket_code = upper(btrim(p_ticket_code)),
        customer_id = v_customer_id,
        customer_name = btrim(p_customer_name),
        customer_phone = v_normalized_phone,
        estimated_done_date = p_estimated_done_date,
        notes = NULLIF(btrim(COALESCE(p_notes, '')), '')
    WHERE id = v_order_id
      AND tenant_id = p_tenant_id;
  ELSE
    v_is_new := true;
    INSERT INTO public.orders (
      id, tenant_id, ticket_code, customer_id, customer_name, customer_phone,
      estimated_done_date, notes, paid_amount, payment_status
    )
    VALUES (
      v_order_id, p_tenant_id, upper(btrim(p_ticket_code)), v_customer_id,
      btrim(p_customer_name), v_normalized_phone, p_estimated_done_date,
      NULLIF(btrim(COALESCE(p_notes, '')), ''), 0, 'unpaid'
    );
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_before_path := NULLIF(btrim(COALESCE(v_item->>'before_photo_path', '')), '');
    v_after_path := NULLIF(btrim(COALESCE(v_item->>'after_photo_path', '')), '');

    IF NULLIF(v_item->>'item_id', '') IS NOT NULL THEN
      v_item_id := (v_item->>'item_id')::uuid;
      IF v_item_id = ANY(v_keep_ids) THEN
        RAISE EXCEPTION 'ID item duplikat pada data yang dikirim.';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM public.order_items
        WHERE id = v_item_id
          AND order_id = v_order_id
          AND tenant_id = p_tenant_id
      ) THEN
        RAISE EXCEPTION 'Item % tidak ditemukan pada order ini.', v_item_id;
      END IF;

      v_keep_ids := array_append(v_keep_ids, v_item_id);

      UPDATE public.order_items
      SET garment_name = v_item->>'garment_name',
          service_type = v_item->>'service_type',
          measurement_specs = COALESCE(v_item->'measurement_specs', '{}'::jsonb),
          price = COALESCE(NULLIF(v_item->>'price', '')::numeric, 0),
          before_photo_path = v_before_path,
          after_photo_path = v_after_path
      WHERE id = v_item_id
        AND order_id = v_order_id
        AND tenant_id = p_tenant_id;
    ELSE
      INSERT INTO public.order_items (
        tenant_id, order_id, garment_name, service_type,
        measurement_specs, price, before_photo_path, after_photo_path
      )
      VALUES (
        p_tenant_id, v_order_id, v_item->>'garment_name', v_item->>'service_type',
        COALESCE(v_item->'measurement_specs', '{}'::jsonb),
        COALESCE(NULLIF(v_item->>'price', '')::numeric, 0),
        v_before_path, v_after_path
      )
      RETURNING id INTO v_item_id;

      v_keep_ids := array_append(v_keep_ids, v_item_id);
    END IF;
  END LOOP;

  DELETE FROM public.order_items
  WHERE tenant_id = p_tenant_id
    AND order_id = v_order_id
    AND NOT (id = ANY(v_keep_ids));

  IF v_is_new AND p_paid_amount > 0 THEN
    PERFORM public.record_order_payment_v3(
      p_tenant_id,
      v_order_id,
      p_paid_amount,
      'dp',
      'Tunai',
      'DP saat New Order',
      'new-order-dp:' || v_order_id::text
    );
  END IF;

  RETURN v_order_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_order_cascade(
  p_tenant_id uuid,
  p_order_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_cash_ids uuid[];
BEGIN
  IF p_tenant_id IS NULL OR NOT private.is_verified_tenant_member(p_tenant_id) THEN
    RAISE EXCEPTION 'Akses tenant tidak valid.';
  END IF;
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'Order ID wajib diisi.';
  END IF;

  PERFORM 1
  FROM public.orders
  WHERE id = p_order_id
    AND tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order tidak ditemukan atau tidak dapat diakses.';
  END IF;

  SELECT COALESCE(array_agg(cash_transaction_id) FILTER (WHERE cash_transaction_id IS NOT NULL), ARRAY[]::uuid[])
  INTO v_cash_ids
  FROM public.order_payments
  WHERE tenant_id = p_tenant_id
    AND order_id = p_order_id;

  -- Remove payment rows first to satisfy ON DELETE RESTRICT FKs.
  DELETE FROM public.order_payments
  WHERE tenant_id = p_tenant_id
    AND order_id = p_order_id;

  -- Remove cash transactions linked to this order or its payments.
  DELETE FROM public.cash_transactions
  WHERE tenant_id = p_tenant_id
    AND (
      order_id = p_order_id
      OR id = ANY(v_cash_ids)
    );

  -- Delete order row; composite ON DELETE CASCADE removes order_items and order_logs.
  -- Customers and customer_measurements are preserved untouched.
  DELETE FROM public.orders
  WHERE id = p_order_id
    AND tenant_id = p_tenant_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- 8. Atomic Onboarding RPC (`create_tenant_workspace`, SECURITY DEFINER)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_tenant_workspace(
  p_name text,
  p_slug text,
  p_admin_phone text DEFAULT '',
  p_address text DEFAULT '',
  p_opening_hours text DEFAULT '',
  p_tagline text DEFAULT '',
  p_daily_capacity_minutes integer DEFAULT 480
)
RETURNS public.tenants
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_confirmed_at timestamptz;
  v_name text;
  v_slug text;
  v_phone text;
  v_capacity integer;
  v_tenant public.tenants%ROWTYPE;
  v_reserved CONSTANT text[] := ARRAY[
    'admin', 'api', 'app', 'auth', 'login', 'signup', 'register', 'onboarding',
    't', 'track', 'assets', 'css', 'js', 'icons', 'public', 'static',
    'support', 'help', 'docs', 'pricing', 'about', 'privacy', 'terms',
    'www', 'mail', 'status'
  ];
BEGIN
  v_user_id := (SELECT auth.uid());
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Autentikasi diperlukan untuk membuat workshop.';
  END IF;

  SELECT u.email_confirmed_at
  INTO v_confirmed_at
  FROM auth.users u
  WHERE u.id = v_user_id;

  IF v_confirmed_at IS NULL THEN
    RAISE EXCEPTION 'Email Anda belum diverifikasi. Silakan verifikasi email terlebih dahulu.';
  END IF;

  -- Serialize concurrent onboarding attempts per account.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));

  IF EXISTS (
    SELECT 1
    FROM public.tenant_members tm
    WHERE tm.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Akun ini sudah memiliki workshop terdaftar (batas Tahap 1: 1 workshop per akun).';
  END IF;

  v_name := btrim(COALESCE(p_name, ''));
  IF v_name = '' THEN
    RAISE EXCEPTION 'Nama workshop wajib diisi.';
  END IF;

  v_slug := lower(btrim(COALESCE(p_slug, '')));
  IF v_slug !~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$' THEN
    RAISE EXCEPTION 'Slug tidak valid. Gunakan 3-48 karakter huruf kecil, angka, atau tanda hubung (-).';
  END IF;

  IF v_slug = ANY(v_reserved) THEN
    RAISE EXCEPTION 'Slug "%" dicadangkan oleh sistem. Gunakan slug lain.', v_slug;
  END IF;

  IF EXISTS (SELECT 1 FROM public.tenants WHERE slug = v_slug) THEN
    RAISE EXCEPTION 'Slug "%" sudah digunakan workshop lain.', v_slug;
  END IF;

  v_capacity := COALESCE(p_daily_capacity_minutes, 480);
  IF v_capacity <= 0 THEN
    RAISE EXCEPTION 'Kapasitas harian harus lebih dari 0 menit.';
  END IF;

  v_phone := CASE
    WHEN btrim(COALESCE(p_admin_phone, '')) = '' THEN ''
    ELSE public.normalize_customer_phone(p_admin_phone)
  END;

  INSERT INTO public.tenants (
    name, slug, admin_phone, address, opening_hours, tagline, daily_capacity_minutes
  )
  VALUES (
    v_name,
    v_slug,
    v_phone,
    btrim(COALESCE(p_address, '')),
    btrim(COALESCE(p_opening_hours, '')),
    btrim(COALESCE(p_tagline, '')),
    v_capacity
  )
  RETURNING * INTO v_tenant;

  INSERT INTO public.tenant_members (tenant_id, user_id, role, is_active)
  VALUES (v_tenant.id, v_user_id, 'owner', true);

  -- Idempotently seed starter measurement templates for this new tenant.
  INSERT INTO public.measurement_templates (tenant_id, garment_type, description)
  VALUES
    (v_tenant.id, 'Celana', 'Template ukuran celana'),
    (v_tenant.id, 'Jaket', 'Template ukuran jaket'),
    (v_tenant.id, 'Rok', 'Template ukuran rok'),
    (v_tenant.id, 'Lainnya', 'Template fleksibel; komponen dapat ditambahkan sendiri')
  ON CONFLICT (tenant_id, garment_type) DO NOTHING;

  -- Celana starter fields
  WITH seed_fields(field_key, field_label, sort_order) AS (
    VALUES
      ('waist_circumference', 'Lingkar pinggang', 1),
      ('hip_circumference', 'Lingkar pinggul', 2),
      ('thigh_circumference', 'Lingkar paha', 3),
      ('trouser_length', 'Panjang celana', 4),
      ('leg_opening', 'Bukaan kaki', 5)
  )
  INSERT INTO public.measurement_template_fields (
    tenant_id, template_id, field_key, field_label, unit, is_required, sort_order
  )
  SELECT
    v_tenant.id, t.id, sf.field_key, sf.field_label, 'cm', true, sf.sort_order
  FROM public.measurement_templates t
  CROSS JOIN seed_fields sf
  WHERE t.tenant_id = v_tenant.id
    AND t.garment_type = 'Celana'
  ON CONFLICT (template_id, field_key) DO NOTHING;

  -- Jaket starter fields
  WITH seed_fields(field_key, field_label, sort_order) AS (
    VALUES
      ('shoulder_width', 'Lebar bahu', 1),
      ('chest_circumference', 'Lingkar dada', 2),
      ('body_length', 'Panjang badan', 3),
      ('sleeve_length', 'Panjang lengan', 4),
      ('upper_arm_circumference', 'Lingkar lengan', 5),
      ('bottom_circumference', 'Lingkar bawah', 6)
  )
  INSERT INTO public.measurement_template_fields (
    tenant_id, template_id, field_key, field_label, unit, is_required, sort_order
  )
  SELECT
    v_tenant.id, t.id, sf.field_key, sf.field_label, 'cm', true, sf.sort_order
  FROM public.measurement_templates t
  CROSS JOIN seed_fields sf
  WHERE t.tenant_id = v_tenant.id
    AND t.garment_type = 'Jaket'
  ON CONFLICT (template_id, field_key) DO NOTHING;

  -- Rok starter fields
  WITH seed_fields(field_key, field_label, sort_order) AS (
    VALUES
      ('waist_circumference', 'Lingkar pinggang', 1),
      ('hip_circumference', 'Lingkar pinggul', 2),
      ('skirt_length', 'Panjang rok', 3),
      ('bottom_width', 'Lebar bawah', 4)
  )
  INSERT INTO public.measurement_template_fields (
    tenant_id, template_id, field_key, field_label, unit, is_required, sort_order
  )
  SELECT
    v_tenant.id, t.id, sf.field_key, sf.field_label, 'cm', true, sf.sort_order
  FROM public.measurement_templates t
  CROSS JOIN seed_fields sf
  WHERE t.tenant_id = v_tenant.id
    AND t.garment_type = 'Rok'
  ON CONFLICT (template_id, field_key) DO NOTHING;

  RETURN v_tenant;
END;
$$;

-- Tighten function execution privileges (revoke PUBLIC & anon)
REVOKE ALL ON FUNCTION public.normalize_customer_phone(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.normalize_customer_phone(text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.add_manual_cash_transaction(uuid, text, text, numeric, text, text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_manual_cash_transaction(uuid, text, text, numeric, text, text, timestamptz) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.record_order_payment_v3(uuid, uuid, numeric, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_order_payment_v3(uuid, uuid, numeric, text, text, text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.save_order_with_items(uuid, uuid, text, text, text, date, text, numeric, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_order_with_items(uuid, uuid, text, text, text, date, text, numeric, jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.delete_order_cascade(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_order_cascade(uuid, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.create_tenant_workspace(text, text, text, text, text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_tenant_workspace(text, text, text, text, text, text, integer) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 9. Private Storage Bucket (`garment-photos`) & Tenant-Scoped Storage RLS
-- -----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'garment-photos',
  'garment-photos',
  false,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "authenticated users can upload garment photo l63th4_0" ON storage.objects;
DROP POLICY IF EXISTS "public can read garment photo l63th4_0" ON storage.objects;
DROP POLICY IF EXISTS "garment_photos_tenant_select" ON storage.objects;
DROP POLICY IF EXISTS "garment_photos_tenant_insert" ON storage.objects;
DROP POLICY IF EXISTS "garment_photos_tenant_update" ON storage.objects;
DROP POLICY IF EXISTS "garment_photos_tenant_delete" ON storage.objects;

CREATE POLICY "garment_photos_tenant_select"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'garment-photos'
    AND CASE
      WHEN (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (SELECT private.is_verified_tenant_member(((storage.foldername(name))[1])::uuid))
      ELSE false
    END
  );

CREATE POLICY "garment_photos_tenant_insert"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'garment-photos'
    AND CASE
      WHEN (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (SELECT private.is_verified_tenant_member(((storage.foldername(name))[1])::uuid))
      ELSE false
    END
  );

CREATE POLICY "garment_photos_tenant_update"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'garment-photos'
    AND CASE
      WHEN (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (SELECT private.is_verified_tenant_member(((storage.foldername(name))[1])::uuid))
      ELSE false
    END
  )
  WITH CHECK (
    bucket_id = 'garment-photos'
    AND CASE
      WHEN (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (SELECT private.is_verified_tenant_member(((storage.foldername(name))[1])::uuid))
      ELSE false
    END
  );

CREATE POLICY "garment_photos_tenant_delete"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'garment-photos'
    AND CASE
      WHEN (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (SELECT private.is_verified_tenant_member(((storage.foldername(name))[1])::uuid))
      ELSE false
    END
  );

COMMIT;
