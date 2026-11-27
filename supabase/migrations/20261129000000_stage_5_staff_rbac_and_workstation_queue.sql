-- MendTrack Stage 5: Staff Management, Invitations (RBAC), & Workstation Queue
-- Target project : mendtrack_dev (ncobbhceczfpxosgszwz)
-- DO NOT RUN on legacy production project mendtrack (zurtrvuyigwtmyfvrelb).
--
-- Execute once in Supabase SQL Editor on mendtrack_dev, then verify read-only.
-- Includes:
--   1. Non-exposed `private.get_tenant_role(uuid)` and `private.has_tenant_role(uuid, text[])`.
--   2. Additive `public.tenant_members.display_name` with safe backfill from `auth.users`.
--   3. Tenant-isolated `public.tenant_invitations` (token, normalized email, role,
--      expiry, status, invited_by, accepted_by, indexes, strict RLS).
--   4. Tenant-configurable `public.workstations` & per-item `public.order_item_workstations`
--      with composite tenant FKs, indexes, AFTER INSERT auto-seeding trigger on
--      `public.order_items`, starter seeding for existing tenants, and active-order backfill.
--   5. Updated `public.create_tenant_workspace` (11-arg signature preserved) seeding
--      starter workstations alongside starter measurement templates.
--   6. Role-aware RLS across all 16 public tables and `storage.objects` (`garment-photos`).
--   7. Role-gated operational RPCs + SECURITY DEFINER RPCs for team invitations,
--      last-owner-protected member updates, sanitized staff production orders/workload,
--      forward-only production status advancement, manual cash deletion, and
--      workstation checklist toggles/assignments.

BEGIN;

-- Ensure pgcrypto is available in extensions schema for secure invitation tokens.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- 1. Non-Exposed Role Helpers in `private` Schema
CREATE OR REPLACE FUNCTION private.get_tenant_role(p_tenant_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT tm.role
  FROM auth.users u
  JOIN public.tenant_members tm
    ON tm.user_id = u.id
  JOIN public.tenants t
    ON t.id = tm.tenant_id
  WHERE p_tenant_id IS NOT NULL
    AND (SELECT auth.uid()) IS NOT NULL
    AND u.id = (SELECT auth.uid())
    AND u.email_confirmed_at IS NOT NULL
    AND tm.tenant_id = p_tenant_id
    AND tm.is_active = true
    AND t.is_active = true
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION private.has_tenant_role(p_tenant_id uuid, p_roles text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(private.get_tenant_role(p_tenant_id) = ANY(p_roles), false);
$$;

REVOKE ALL ON FUNCTION private.get_tenant_role(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.get_tenant_role(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION private.has_tenant_role(uuid, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.has_tenant_role(uuid, text[]) TO authenticated, service_role;

-- 2. Member Display Name (`public.tenant_members.display_name`)
ALTER TABLE public.tenant_members
  ADD COLUMN IF NOT EXISTS display_name text;

UPDATE public.tenant_members tm
SET display_name = COALESCE(
  NULLIF(btrim(u.raw_user_meta_data->>'full_name'), ''),
  NULLIF(btrim(u.raw_user_meta_data->>'name'), ''),
  NULLIF(split_part(COALESCE(u.email, ''), '@', 1), ''),
  'Member'
)
FROM auth.users u
WHERE u.id = tm.user_id
  AND (tm.display_name IS NULL OR btrim(tm.display_name) = '');

COMMENT ON COLUMN public.tenant_members.display_name IS
  'Nama tampilan anggota tim untuk direktori tim dan penugasan stasiun mesin.';

-- 3. Team Invitations (`public.tenant_invitations`)
CREATE TABLE IF NOT EXISTS public.tenant_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL,
  token text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  invited_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  accepted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_invitations_token_key UNIQUE (token),
  CONSTRAINT tenant_invitations_email_format_check CHECK (
    email = lower(btrim(email))
    AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
  ),
  CONSTRAINT tenant_invitations_role_check CHECK (role IN ('admin', 'staff')),
  CONSTRAINT tenant_invitations_token_len_check CHECK (length(btrim(token)) >= 32),
  CONSTRAINT tenant_invitations_status_check CHECK (status IN ('pending', 'accepted', 'revoked'))
);

COMMENT ON TABLE public.tenant_invitations IS
  'Undangan anggota tim (admin/staff) berbasis token per tenant dengan masa berlaku.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_invitations_pending_email
  ON public.tenant_invitations (tenant_id, email)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_tenant_invitations_tenant_status_created
  ON public.tenant_invitations (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tenant_invitations_invited_by
  ON public.tenant_invitations (invited_by)
  WHERE invited_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tenant_invitations_accepted_by
  ON public.tenant_invitations (accepted_by)
  WHERE accepted_by IS NOT NULL;

-- 4. Workstation Queue (`public.workstations` & `public.order_item_workstations`)
CREATE TABLE IF NOT EXISTS public.workstations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workstations_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT workstations_tenant_name_key UNIQUE (tenant_id, name),
  CONSTRAINT workstations_name_not_blank CHECK (length(btrim(name)) > 0)
);

COMMENT ON TABLE public.workstations IS
  'Konfigurasi stasiun produksi/mesin per workshop (misal Prep/Cuci, Darning, Chain-stitch, QC).';

CREATE INDEX IF NOT EXISTS idx_workstations_tenant_sort
  ON public.workstations (tenant_id, sort_order, name);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_workstations_updated_at'
      AND tgrelid = 'public.workstations'::regclass
  ) THEN
    CREATE TRIGGER trg_workstations_updated_at
      BEFORE UPDATE ON public.workstations
      FOR EACH ROW EXECUTE FUNCTION public.set_measurement_updated_at();
  END IF;
END;
$$;

-- Ensure composite unique key (tenant_id, id) exists on public.order_items for cross-tenant-safe FK.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'order_items_tenant_id_key'
      AND conrelid = 'public.order_items'::regclass
  ) THEN
    ALTER TABLE public.order_items
      ADD CONSTRAINT order_items_tenant_id_key UNIQUE (tenant_id, id);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.order_item_workstations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL,
  workstation_id uuid,
  station_name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_done boolean NOT NULL DEFAULT false,
  assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  completed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_item_workstations_tenant_item_fkey
    FOREIGN KEY (tenant_id, order_item_id)
    REFERENCES public.order_items(tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT order_item_workstations_tenant_station_fkey
    FOREIGN KEY (tenant_id, workstation_id)
    REFERENCES public.workstations(tenant_id, id)
    ON DELETE SET NULL (workstation_id),
  CONSTRAINT order_item_workstations_station_name_not_blank CHECK (length(btrim(station_name)) > 0)
);

COMMENT ON TABLE public.order_item_workstations IS
  'Checklist sub-tahapan stasiun mesin per item order lengkap dengan penanggung jawab dan status selesai.';

CREATE INDEX IF NOT EXISTS idx_order_item_workstations_tenant_item_sort
  ON public.order_item_workstations (tenant_id, order_item_id, sort_order, created_at);

CREATE INDEX IF NOT EXISTS idx_order_item_workstations_tenant_station
  ON public.order_item_workstations (tenant_id, workstation_id)
  WHERE workstation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_order_item_workstations_tenant_assigned
  ON public.order_item_workstations (tenant_id, assigned_to)
  WHERE assigned_to IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_order_item_workstations_completed_by
  ON public.order_item_workstations (completed_by)
  WHERE completed_by IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_order_item_workstations_updated_at'
      AND tgrelid = 'public.order_item_workstations'::regclass
  ) THEN
    CREATE TRIGGER trg_order_item_workstations_updated_at
      BEFORE UPDATE ON public.order_item_workstations
      FOR EACH ROW EXECUTE FUNCTION public.set_measurement_updated_at();
  END IF;
END;
$$;

-- Internal starter workstation seeder (idempotent per tenant).
CREATE OR REPLACE FUNCTION private.seed_default_workstations(p_tenant_id uuid, p_locale text DEFAULT 'id')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_tenant_id IS NULL THEN
    RETURN;
  END IF;

  IF lower(COALESCE(p_locale, 'id')) = 'en' THEN
    INSERT INTO public.workstations (tenant_id, name, sort_order, is_active)
    VALUES
      (p_tenant_id, 'Prep / Wash', 1, true),
      (p_tenant_id, 'Darning', 2, true),
      (p_tenant_id, 'Chain-stitch', 3, true),
      (p_tenant_id, 'QC', 4, true)
    ON CONFLICT (tenant_id, name) DO NOTHING;
  ELSE
    INSERT INTO public.workstations (tenant_id, name, sort_order, is_active)
    VALUES
      (p_tenant_id, 'Prep / Cuci', 1, true),
      (p_tenant_id, 'Darning', 2, true),
      (p_tenant_id, 'Chain-stitch', 3, true),
      (p_tenant_id, 'QC', 4, true)
    ON CONFLICT (tenant_id, name) DO NOTHING;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION private.seed_default_workstations(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.seed_default_workstations(uuid, text) TO service_role;

-- Auto-populate workstation checklist rows whenever any order_item is inserted
-- (covers both save_order_with_items and Stage 4 approve_quote_to_order).
CREATE OR REPLACE FUNCTION public.fn_seed_order_item_workstations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.order_item_workstations (
    tenant_id,
    order_item_id,
    workstation_id,
    station_name,
    sort_order
  )
  SELECT
    NEW.tenant_id,
    NEW.id,
    w.id,
    w.name,
    w.sort_order
  FROM public.workstations w
  WHERE w.tenant_id = NEW.tenant_id
    AND w.is_active = true
  ORDER BY w.sort_order ASC, w.name ASC;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_seed_order_item_workstations() FROM PUBLIC, anon;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_seed_order_item_workstations'
      AND tgrelid = 'public.order_items'::regclass
  ) THEN
    CREATE TRIGGER trg_seed_order_item_workstations
      AFTER INSERT ON public.order_items
      FOR EACH ROW EXECUTE FUNCTION public.fn_seed_order_item_workstations();
  END IF;
END;
$$;

-- Seed default workstations for all existing tenants without stations yet.
DO $$
DECLARE
  v_t RECORD;
BEGIN
  FOR v_t IN
    SELECT t.id, t.locale
    FROM public.tenants t
    WHERE NOT EXISTS (
      SELECT 1 FROM public.workstations w WHERE w.tenant_id = t.id
    )
  LOOP
    PERFORM private.seed_default_workstations(v_t.id, v_t.locale);
  END LOOP;
END;
$$;

-- Backfill workstation checklist steps for existing active (non-completed) order items.
INSERT INTO public.order_item_workstations (
  tenant_id,
  order_item_id,
  workstation_id,
  station_name,
  sort_order
)
SELECT
  oi.tenant_id,
  oi.id,
  w.id,
  w.name,
  w.sort_order
FROM public.order_items oi
JOIN public.orders o
  ON o.tenant_id = oi.tenant_id
 AND o.id = oi.order_id
JOIN public.workstations w
  ON w.tenant_id = oi.tenant_id
 AND w.is_active = true
WHERE o.status <> 'completed'
  AND NOT EXISTS (
    SELECT 1
    FROM public.order_item_workstations oiw
    WHERE oiw.tenant_id = oi.tenant_id
      AND oiw.order_item_id = oi.id
  )
ORDER BY oi.id, w.sort_order ASC, w.name ASC;

-- 5. Table Grants & Role-Aware RLS Policies (All 16 Public Tables + Storage)
REVOKE ALL ON TABLE public.tenant_invitations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.tenant_invitations TO authenticated;
GRANT ALL ON TABLE public.tenant_invitations TO service_role;

REVOKE ALL ON TABLE public.workstations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.workstations TO authenticated;
GRANT ALL ON TABLE public.workstations TO service_role;

REVOKE ALL ON TABLE public.order_item_workstations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.order_item_workstations TO authenticated;
GRANT ALL ON TABLE public.order_item_workstations TO service_role;

ALTER TABLE public.tenant_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workstations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_item_workstations ENABLE ROW LEVEL SECURITY;

-- tenants: SELECT all active verified members; UPDATE owner only
DROP POLICY IF EXISTS tenants_member_select ON public.tenants;
DROP POLICY IF EXISTS tenants_member_update ON public.tenants;
CREATE POLICY tenants_member_select
  ON public.tenants FOR SELECT TO authenticated
  USING ((SELECT private.is_verified_tenant_member(id)));
CREATE POLICY tenants_member_update
  ON public.tenants FOR UPDATE TO authenticated
  USING ((SELECT private.has_tenant_role(id, ARRAY['owner'])))
  WITH CHECK ((SELECT private.has_tenant_role(id, ARRAY['owner'])));

-- tenant_invitations: SELECT for owner (all) or admin (staff invites only); writes via RPC only
DROP POLICY IF EXISTS tenant_invitations_role_select ON public.tenant_invitations;
CREATE POLICY tenant_invitations_role_select
  ON public.tenant_invitations FOR SELECT TO authenticated
  USING (
    (SELECT private.has_tenant_role(tenant_id, ARRAY['owner']))
    OR (
      (SELECT private.has_tenant_role(tenant_id, ARRAY['admin']))
      AND role = 'staff'
    )
  );

-- workstations: SELECT all verified members; writes owner & admin
DROP POLICY IF EXISTS workstations_tenant_select ON public.workstations;
DROP POLICY IF EXISTS workstations_tenant_insert ON public.workstations;
DROP POLICY IF EXISTS workstations_tenant_update ON public.workstations;
DROP POLICY IF EXISTS workstations_tenant_delete ON public.workstations;
CREATE POLICY workstations_tenant_select
  ON public.workstations FOR SELECT TO authenticated
  USING ((SELECT private.is_verified_tenant_member(tenant_id)));
CREATE POLICY workstations_tenant_insert
  ON public.workstations FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY workstations_tenant_update
  ON public.workstations FOR UPDATE TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])))
  WITH CHECK ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY workstations_tenant_delete
  ON public.workstations FOR DELETE TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));

-- order_item_workstations: SELECT for owner & admin (staff reads via get_staff_production_orders);
-- writes go exclusively through public.update_order_item_workstation RPC & insert trigger.
DROP POLICY IF EXISTS order_item_workstations_tenant_select ON public.order_item_workstations;
CREATE POLICY order_item_workstations_tenant_select
  ON public.order_item_workstations FOR SELECT TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));

-- services: owner & admin only (staff uses get_staff_workload_services without base_price)
DROP POLICY IF EXISTS services_tenant_select ON public.services;
DROP POLICY IF EXISTS services_tenant_insert ON public.services;
DROP POLICY IF EXISTS services_tenant_update ON public.services;
DROP POLICY IF EXISTS services_tenant_delete ON public.services;
CREATE POLICY services_tenant_select
  ON public.services FOR SELECT TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY services_tenant_insert
  ON public.services FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY services_tenant_update
  ON public.services FOR UPDATE TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])))
  WITH CHECK ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY services_tenant_delete
  ON public.services FOR DELETE TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));

-- customers: owner & admin only (staff blocked)
DROP POLICY IF EXISTS customers_tenant_select ON public.customers;
DROP POLICY IF EXISTS customers_tenant_insert ON public.customers;
DROP POLICY IF EXISTS customers_tenant_update ON public.customers;
DROP POLICY IF EXISTS customers_tenant_delete ON public.customers;
CREATE POLICY customers_tenant_select
  ON public.customers FOR SELECT TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY customers_tenant_insert
  ON public.customers FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY customers_tenant_update
  ON public.customers FOR UPDATE TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])))
  WITH CHECK ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY customers_tenant_delete
  ON public.customers FOR DELETE TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));

-- orders: SELECT/INSERT/UPDATE for owner & admin; DELETE for owner only
-- (staff reads active sanitized production fields via get_staff_production_orders
--  and advances status via advance_order_production_status)
DROP POLICY IF EXISTS orders_tenant_select ON public.orders;
DROP POLICY IF EXISTS orders_tenant_insert ON public.orders;
DROP POLICY IF EXISTS orders_tenant_update ON public.orders;
DROP POLICY IF EXISTS orders_tenant_delete ON public.orders;
CREATE POLICY orders_tenant_select
  ON public.orders FOR SELECT TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY orders_tenant_insert
  ON public.orders FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY orders_tenant_update
  ON public.orders FOR UPDATE TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])))
  WITH CHECK ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY orders_tenant_delete
  ON public.orders FOR DELETE TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner'])));

-- order_items: owner & admin only (staff reads without price via get_staff_production_orders)
DROP POLICY IF EXISTS order_items_tenant_select ON public.order_items;
DROP POLICY IF EXISTS order_items_tenant_insert ON public.order_items;
DROP POLICY IF EXISTS order_items_tenant_update ON public.order_items;
DROP POLICY IF EXISTS order_items_tenant_delete ON public.order_items;
CREATE POLICY order_items_tenant_select
  ON public.order_items FOR SELECT TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY order_items_tenant_insert
  ON public.order_items FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY order_items_tenant_update
  ON public.order_items FOR UPDATE TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])))
  WITH CHECK ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY order_items_tenant_delete
  ON public.order_items FOR DELETE TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));

-- order_logs: append-only for owner & admin (staff status changes logged by SECURITY DEFINER RPC)
DROP POLICY IF EXISTS order_logs_tenant_select ON public.order_logs;
DROP POLICY IF EXISTS order_logs_tenant_insert ON public.order_logs;
CREATE POLICY order_logs_tenant_select
  ON public.order_logs FOR SELECT TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY order_logs_tenant_insert
  ON public.order_logs FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));

-- order_payments: SELECT/INSERT/UPDATE for owner & admin; DELETE for owner only
DROP POLICY IF EXISTS order_payments_tenant_select ON public.order_payments;
DROP POLICY IF EXISTS order_payments_tenant_insert ON public.order_payments;
DROP POLICY IF EXISTS order_payments_tenant_update ON public.order_payments;
DROP POLICY IF EXISTS order_payments_tenant_delete ON public.order_payments;
CREATE POLICY order_payments_tenant_select
  ON public.order_payments FOR SELECT TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY order_payments_tenant_insert
  ON public.order_payments FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY order_payments_tenant_update
  ON public.order_payments FOR UPDATE TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])))
  WITH CHECK ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY order_payments_tenant_delete
  ON public.order_payments FOR DELETE TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner'])));

-- cash_transactions: SELECT/INSERT/UPDATE for owner & admin; DELETE for owner only
DROP POLICY IF EXISTS cash_transactions_tenant_select ON public.cash_transactions;
DROP POLICY IF EXISTS cash_transactions_tenant_insert ON public.cash_transactions;
DROP POLICY IF EXISTS cash_transactions_tenant_update ON public.cash_transactions;
DROP POLICY IF EXISTS cash_transactions_tenant_delete ON public.cash_transactions;
CREATE POLICY cash_transactions_tenant_select
  ON public.cash_transactions FOR SELECT TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY cash_transactions_tenant_insert
  ON public.cash_transactions FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY cash_transactions_tenant_update
  ON public.cash_transactions FOR UPDATE TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])))
  WITH CHECK ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY cash_transactions_tenant_delete
  ON public.cash_transactions FOR DELETE TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner'])));

-- measurement_templates & measurement_template_fields: owner & admin only
DROP POLICY IF EXISTS measurement_templates_tenant_select ON public.measurement_templates;
DROP POLICY IF EXISTS measurement_templates_tenant_insert ON public.measurement_templates;
DROP POLICY IF EXISTS measurement_templates_tenant_update ON public.measurement_templates;
DROP POLICY IF EXISTS measurement_templates_tenant_delete ON public.measurement_templates;
CREATE POLICY measurement_templates_tenant_select
  ON public.measurement_templates FOR SELECT TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY measurement_templates_tenant_insert
  ON public.measurement_templates FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY measurement_templates_tenant_update
  ON public.measurement_templates FOR UPDATE TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])))
  WITH CHECK ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY measurement_templates_tenant_delete
  ON public.measurement_templates FOR DELETE TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));

DROP POLICY IF EXISTS measurement_template_fields_tenant_select ON public.measurement_template_fields;
DROP POLICY IF EXISTS measurement_template_fields_tenant_insert ON public.measurement_template_fields;
DROP POLICY IF EXISTS measurement_template_fields_tenant_update ON public.measurement_template_fields;
DROP POLICY IF EXISTS measurement_template_fields_tenant_delete ON public.measurement_template_fields;
CREATE POLICY measurement_template_fields_tenant_select
  ON public.measurement_template_fields FOR SELECT TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY measurement_template_fields_tenant_insert
  ON public.measurement_template_fields FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY measurement_template_fields_tenant_update
  ON public.measurement_template_fields FOR UPDATE TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])))
  WITH CHECK ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY measurement_template_fields_tenant_delete
  ON public.measurement_template_fields FOR DELETE TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));

-- customer_measurements: owner & admin only (staff blocked)
DROP POLICY IF EXISTS customer_measurements_tenant_select ON public.customer_measurements;
DROP POLICY IF EXISTS customer_measurements_tenant_insert ON public.customer_measurements;
DROP POLICY IF EXISTS customer_measurements_tenant_update ON public.customer_measurements;
DROP POLICY IF EXISTS customer_measurements_tenant_delete ON public.customer_measurements;
CREATE POLICY customer_measurements_tenant_select
  ON public.customer_measurements FOR SELECT TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY customer_measurements_tenant_insert
  ON public.customer_measurements FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY customer_measurements_tenant_update
  ON public.customer_measurements FOR UPDATE TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])))
  WITH CHECK ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY customer_measurements_tenant_delete
  ON public.customer_measurements FOR DELETE TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));

-- quote_requests: owner & admin only (staff blocked)
DROP POLICY IF EXISTS "quote_requests_tenant_select" ON public.quote_requests;
DROP POLICY IF EXISTS "quote_requests_tenant_insert" ON public.quote_requests;
DROP POLICY IF EXISTS "quote_requests_tenant_update" ON public.quote_requests;
DROP POLICY IF EXISTS "quote_requests_tenant_delete" ON public.quote_requests;
CREATE POLICY "quote_requests_tenant_select"
  ON public.quote_requests FOR SELECT TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY "quote_requests_tenant_insert"
  ON public.quote_requests FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY "quote_requests_tenant_update"
  ON public.quote_requests FOR UPDATE TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])))
  WITH CHECK ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));
CREATE POLICY "quote_requests_tenant_delete"
  ON public.quote_requests FOR DELETE TO authenticated
  USING ((SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin'])));

-- Storage RLS (`garment-photos`): SELECT stays open to verified members (incl. staff);
-- INSERT/UPDATE/DELETE restricted to owner & admin.
DROP POLICY IF EXISTS "garment_photos_tenant_insert" ON storage.objects;
DROP POLICY IF EXISTS "garment_photos_tenant_update" ON storage.objects;
DROP POLICY IF EXISTS "garment_photos_tenant_delete" ON storage.objects;

CREATE POLICY "garment_photos_tenant_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'garment-photos'
    AND CASE
      WHEN (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (SELECT private.has_tenant_role(((storage.foldername(name))[1])::uuid, ARRAY['owner', 'admin']))
      ELSE false
    END
  );

CREATE POLICY "garment_photos_tenant_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'garment-photos'
    AND CASE
      WHEN (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (SELECT private.has_tenant_role(((storage.foldername(name))[1])::uuid, ARRAY['owner', 'admin']))
      ELSE false
    END
  )
  WITH CHECK (
    bucket_id = 'garment-photos'
    AND CASE
      WHEN (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (SELECT private.has_tenant_role(((storage.foldername(name))[1])::uuid, ARRAY['owner', 'admin']))
      ELSE false
    END
  );

CREATE POLICY "garment_photos_tenant_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'garment-photos'
    AND CASE
      WHEN (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (SELECT private.has_tenant_role(((storage.foldername(name))[1])::uuid, ARRAY['owner', 'admin']))
      ELSE false
    END
  );

-- 6. Role-Gated Operational RPCs (`SECURITY INVOKER`, locked search_path)
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
  IF p_tenant_id IS NULL OR NOT private.has_tenant_role(p_tenant_id, ARRAY['owner', 'admin']) THEN
    RAISE EXCEPTION 'Akses ditolak. Hanya Owner atau Admin yang dapat mencatat transaksi kas.';
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

CREATE OR REPLACE FUNCTION public.delete_manual_cash_transaction(
  p_tenant_id uuid,
  p_transaction_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_row public.cash_transactions%ROWTYPE;
BEGIN
  IF p_tenant_id IS NULL OR NOT private.has_tenant_role(p_tenant_id, ARRAY['owner']) THEN
    RAISE EXCEPTION 'Akses ditolak. Hanya Pemilik (Owner) yang dapat menghapus mutasi kas.';
  END IF;
  IF p_transaction_id IS NULL THEN
    RAISE EXCEPTION 'ID transaksi kas wajib diisi.';
  END IF;

  SELECT *
  INTO v_row
  FROM public.cash_transactions
  WHERE id = p_transaction_id
    AND tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaksi kas tidak ditemukan atau tidak dapat diakses.';
  END IF;

  IF v_row.source_type <> 'manual' OR v_row.order_id IS NOT NULL THEN
    RAISE EXCEPTION 'Transaksi kas dari pembayaran order tidak dapat dihapus terpisah dari order.';
  END IF;

  DELETE FROM public.cash_transactions
  WHERE id = p_transaction_id
    AND tenant_id = p_tenant_id;
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
  IF p_tenant_id IS NULL OR NOT private.has_tenant_role(p_tenant_id, ARRAY['owner', 'admin']) THEN
    RAISE EXCEPTION 'Akses ditolak. Hanya Owner atau Admin yang dapat mencatat pembayaran.';
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
  p_items jsonb,
  p_order_type text DEFAULT 'walk_in',
  p_inbound_courier text DEFAULT NULL,
  p_inbound_tracking text DEFAULT NULL,
  p_outbound_courier text DEFAULT NULL,
  p_outbound_tracking text DEFAULT NULL,
  p_initial_status text DEFAULT NULL
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
  v_order_type text;
  v_inbound_courier text;
  v_inbound_tracking text;
  v_outbound_courier text;
  v_outbound_tracking text;
  v_initial_status text;
  v_item jsonb;
  v_item_id uuid;
  v_keep_ids uuid[] := ARRAY[]::uuid[];
  v_is_new boolean := false;
  v_before_path text;
  v_after_path text;
BEGIN
  IF p_tenant_id IS NULL OR NOT private.has_tenant_role(p_tenant_id, ARRAY['owner', 'admin']) THEN
    RAISE EXCEPTION 'Akses ditolak. Hanya Owner atau Admin yang dapat membuat atau mengubah order.';
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

  v_order_type := lower(btrim(COALESCE(NULLIF(btrim(COALESCE(p_order_type, '')), ''), 'walk_in')));
  IF v_order_type NOT IN ('walk_in', 'mail_in') THEN
    RAISE EXCEPTION 'Tipe order tidak valid (%). Pilih walk_in atau mail_in.', v_order_type;
  END IF;

  IF v_order_type = 'mail_in' THEN
    v_inbound_courier := NULLIF(btrim(COALESCE(p_inbound_courier, '')), '');
    v_inbound_tracking := NULLIF(btrim(COALESCE(p_inbound_tracking, '')), '');
    v_outbound_courier := NULLIF(btrim(COALESCE(p_outbound_courier, '')), '');
    v_outbound_tracking := NULLIF(btrim(COALESCE(p_outbound_tracking, '')), '');
    v_initial_status := CASE lower(btrim(COALESCE(p_initial_status, '')))
      WHEN 'received' THEN 'received'
      ELSE 'awaiting_package'
    END;
  ELSE
    v_inbound_courier := NULL;
    v_inbound_tracking := NULL;
    v_outbound_courier := NULL;
    v_outbound_tracking := NULL;
    v_initial_status := 'received';
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
        notes = NULLIF(btrim(COALESCE(p_notes, '')), ''),
        order_type = v_order_type,
        inbound_courier = v_inbound_courier,
        inbound_tracking = v_inbound_tracking,
        outbound_courier = v_outbound_courier,
        outbound_tracking = v_outbound_tracking
    WHERE id = v_order_id
      AND tenant_id = p_tenant_id;
  ELSE
    v_is_new := true;
    INSERT INTO public.orders (
      id, tenant_id, ticket_code, customer_id, customer_name, customer_phone,
      status, estimated_done_date, notes, paid_amount, payment_status,
      order_type, inbound_courier, inbound_tracking, outbound_courier, outbound_tracking
    )
    VALUES (
      v_order_id, p_tenant_id, upper(btrim(p_ticket_code)), v_customer_id,
      btrim(p_customer_name), v_normalized_phone, v_initial_status,
      p_estimated_done_date, NULLIF(btrim(COALESCE(p_notes, '')), ''), 0, 'unpaid',
      v_order_type, v_inbound_courier, v_inbound_tracking, v_outbound_courier, v_outbound_tracking
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
  IF p_tenant_id IS NULL OR NOT private.has_tenant_role(p_tenant_id, ARRAY['owner']) THEN
    RAISE EXCEPTION 'Akses ditolak. Hanya Pemilik (Owner) yang dapat menghapus order.';
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

  DELETE FROM public.order_payments
  WHERE tenant_id = p_tenant_id
    AND order_id = p_order_id;

  DELETE FROM public.cash_transactions
  WHERE tenant_id = p_tenant_id
    AND (
      order_id = p_order_id
      OR id = ANY(v_cash_ids)
    );

  DELETE FROM public.orders
  WHERE id = p_order_id
    AND tenant_id = p_tenant_id;
END;
$$;

-- 7. Update `create_tenant_workspace` (11-arg) to Seed Starter Workstations & Display Name
CREATE OR REPLACE FUNCTION public.create_tenant_workspace(
  p_name text,
  p_slug text,
  p_admin_phone text DEFAULT '',
  p_address text DEFAULT '',
  p_opening_hours text DEFAULT '',
  p_tagline text DEFAULT '',
  p_daily_capacity_minutes integer DEFAULT 480,
  p_locale text DEFAULT 'id',
  p_currency text DEFAULT 'IDR',
  p_timezone text DEFAULT 'Asia/Jakarta',
  p_ticket_prefix text DEFAULT 'MND'
)
RETURNS public.tenants
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_confirmed_at timestamptz;
  v_user_display text;
  v_name text;
  v_slug text;
  v_phone text;
  v_capacity integer;
  v_locale text;
  v_currency text;
  v_timezone text;
  v_ticket_prefix text;
  v_tenant public.tenants%ROWTYPE;
  v_reserved CONSTANT text[] := ARRAY[
    'admin', 'api', 'app', 'auth', 'login', 'signup', 'register', 'onboarding',
    't', 'track', 'assets', 'css', 'js', 'icons', 'public', 'static',
    'support', 'help', 'docs', 'pricing', 'about', 'privacy', 'terms',
    'www', 'mail', 'status'
  ];
  v_supported_currencies CONSTANT text[] := ARRAY[
    'IDR', 'USD', 'SGD', 'MYR', 'EUR', 'GBP', 'AUD', 'JPY'
  ];
BEGIN
  v_user_id := (SELECT auth.uid());
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Autentikasi diperlukan untuk membuat workshop.';
  END IF;

  SELECT
    u.email_confirmed_at,
    COALESCE(
      NULLIF(btrim(u.raw_user_meta_data->>'full_name'), ''),
      NULLIF(btrim(u.raw_user_meta_data->>'name'), ''),
      NULLIF(split_part(COALESCE(u.email, ''), '@', 1), ''),
      'Owner'
    )
  INTO v_confirmed_at, v_user_display
  FROM auth.users u
  WHERE u.id = v_user_id;

  IF v_confirmed_at IS NULL THEN
    RAISE EXCEPTION 'Email Anda belum diverifikasi. Silakan verifikasi email terlebih dahulu.';
  END IF;

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

  v_locale := lower(btrim(COALESCE(p_locale, 'id')));
  IF v_locale NOT IN ('id', 'en') THEN
    RAISE EXCEPTION 'Bahasa tidak didukung (%). Pilih id atau en.', v_locale;
  END IF;

  v_currency := upper(btrim(COALESCE(p_currency, 'IDR')));
  IF NOT (v_currency = ANY(v_supported_currencies)) THEN
    RAISE EXCEPTION 'Mata uang tidak didukung (%).', v_currency;
  END IF;

  v_timezone := btrim(COALESCE(NULLIF(btrim(COALESCE(p_timezone, '')), ''), 'Asia/Jakarta'));
  IF length(v_timezone) = 0 OR length(v_timezone) > 64 THEN
    RAISE EXCEPTION 'Zona waktu tidak valid.';
  END IF;

  v_ticket_prefix := upper(btrim(COALESCE(NULLIF(btrim(COALESCE(p_ticket_prefix, '')), ''), 'MND')));
  IF v_ticket_prefix !~ '^[A-Z0-9]{2,8}$' THEN
    RAISE EXCEPTION 'Prefix kode tiket harus 2-8 karakter huruf kapital atau angka.';
  END IF;

  v_phone := CASE
    WHEN btrim(COALESCE(p_admin_phone, '')) = '' THEN ''
    ELSE public.normalize_customer_phone(p_admin_phone)
  END;

  INSERT INTO public.tenants (
    name, slug, admin_phone, address, opening_hours, tagline,
    daily_capacity_minutes, locale, currency, timezone, ticket_prefix
  )
  VALUES (
    v_name, v_slug, v_phone, btrim(COALESCE(p_address, '')),
    btrim(COALESCE(p_opening_hours, '')), btrim(COALESCE(p_tagline, '')),
    v_capacity, v_locale, v_currency, v_timezone, v_ticket_prefix
  )
  RETURNING * INTO v_tenant;

  INSERT INTO public.tenant_members (tenant_id, user_id, role, is_active, display_name)
  VALUES (v_tenant.id, v_user_id, 'owner', true, v_user_display);

  IF v_locale = 'en' THEN
    INSERT INTO public.measurement_templates (tenant_id, garment_type, description)
    VALUES
      (v_tenant.id, 'Trousers', 'Trouser and denim measurement template'),
      (v_tenant.id, 'Jacket', 'Jacket measurement template'),
      (v_tenant.id, 'Skirt', 'Skirt measurement template'),
      (v_tenant.id, 'Other', 'Flexible template; add custom measurement fields as needed')
    ON CONFLICT (tenant_id, garment_type) DO NOTHING;

    WITH seed_fields(field_key, field_label, sort_order) AS (
      VALUES
        ('waist_circumference', 'Waist', 1),
        ('hip_circumference', 'Hip', 2),
        ('thigh_circumference', 'Thigh', 3),
        ('trouser_length', 'Trouser length', 4),
        ('leg_opening', 'Leg opening', 5)
    )
    INSERT INTO public.measurement_template_fields (
      tenant_id, template_id, field_key, field_label, unit, is_required, sort_order
    )
    SELECT v_tenant.id, t.id, sf.field_key, sf.field_label, 'cm', true, sf.sort_order
    FROM public.measurement_templates t
    CROSS JOIN seed_fields sf
    WHERE t.tenant_id = v_tenant.id AND t.garment_type = 'Trousers'
    ON CONFLICT (template_id, field_key) DO NOTHING;

    WITH seed_fields(field_key, field_label, sort_order) AS (
      VALUES
        ('shoulder_width', 'Shoulder width', 1),
        ('chest_circumference', 'Chest', 2),
        ('body_length', 'Body length', 3),
        ('sleeve_length', 'Sleeve length', 4),
        ('upper_arm_circumference', 'Upper arm', 5),
        ('bottom_circumference', 'Hem width', 6)
    )
    INSERT INTO public.measurement_template_fields (
      tenant_id, template_id, field_key, field_label, unit, is_required, sort_order
    )
    SELECT v_tenant.id, t.id, sf.field_key, sf.field_label, 'cm', true, sf.sort_order
    FROM public.measurement_templates t
    CROSS JOIN seed_fields sf
    WHERE t.tenant_id = v_tenant.id AND t.garment_type = 'Jacket'
    ON CONFLICT (template_id, field_key) DO NOTHING;

    WITH seed_fields(field_key, field_label, sort_order) AS (
      VALUES
        ('waist_circumference', 'Waist', 1),
        ('hip_circumference', 'Hip', 2),
        ('skirt_length', 'Skirt length', 3),
        ('bottom_width', 'Bottom width', 4)
    )
    INSERT INTO public.measurement_template_fields (
      tenant_id, template_id, field_key, field_label, unit, is_required, sort_order
    )
    SELECT v_tenant.id, t.id, sf.field_key, sf.field_label, 'cm', true, sf.sort_order
    FROM public.measurement_templates t
    CROSS JOIN seed_fields sf
    WHERE t.tenant_id = v_tenant.id AND t.garment_type = 'Skirt'
    ON CONFLICT (template_id, field_key) DO NOTHING;
  ELSE
    INSERT INTO public.measurement_templates (tenant_id, garment_type, description)
    VALUES
      (v_tenant.id, 'Celana', 'Template ukuran celana'),
      (v_tenant.id, 'Jaket', 'Template ukuran jaket'),
      (v_tenant.id, 'Rok', 'Template ukuran rok'),
      (v_tenant.id, 'Lainnya', 'Template fleksibel; komponen dapat ditambahkan sendiri')
    ON CONFLICT (tenant_id, garment_type) DO NOTHING;

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
    SELECT v_tenant.id, t.id, sf.field_key, sf.field_label, 'cm', true, sf.sort_order
    FROM public.measurement_templates t
    CROSS JOIN seed_fields sf
    WHERE t.tenant_id = v_tenant.id AND t.garment_type = 'Celana'
    ON CONFLICT (template_id, field_key) DO NOTHING;

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
    SELECT v_tenant.id, t.id, sf.field_key, sf.field_label, 'cm', true, sf.sort_order
    FROM public.measurement_templates t
    CROSS JOIN seed_fields sf
    WHERE t.tenant_id = v_tenant.id AND t.garment_type = 'Jaket'
    ON CONFLICT (template_id, field_key) DO NOTHING;

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
    SELECT v_tenant.id, t.id, sf.field_key, sf.field_label, 'cm', true, sf.sort_order
    FROM public.measurement_templates t
    CROSS JOIN seed_fields sf
    WHERE t.tenant_id = v_tenant.id AND t.garment_type = 'Rok'
    ON CONFLICT (template_id, field_key) DO NOTHING;
  END IF;

  -- Seed starter production workstations in the workshop's locale.
  PERFORM private.seed_default_workstations(v_tenant.id, v_locale);

  RETURN v_tenant;
END;
$$;

-- 8. Team & Invitation Management RPCs (`SECURITY DEFINER`, locked search_path)
CREATE OR REPLACE FUNCTION public.create_tenant_invitation(
  p_tenant_id uuid,
  p_email text,
  p_role text,
  p_expires_days integer DEFAULT 7
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_role text;
  v_email text;
  v_role text;
  v_days integer;
  v_token text;
  v_inv public.tenant_invitations%ROWTYPE;
BEGIN
  v_caller_role := private.get_tenant_role(p_tenant_id);
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Akses ditolak. Hanya Owner atau Admin yang dapat membuat undangan.';
  END IF;

  v_role := lower(btrim(COALESCE(p_role, '')));
  IF v_role NOT IN ('admin', 'staff') THEN
    RAISE EXCEPTION 'Peran undangan harus admin atau staff.';
  END IF;

  IF v_caller_role = 'admin' AND v_role <> 'staff' THEN
    RAISE EXCEPTION 'Admin hanya dapat mengundang anggota dengan peran Staff.';
  END IF;

  v_email := lower(btrim(COALESCE(p_email, '')));
  IF v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'Format alamat email undangan tidak valid.';
  END IF;

  v_days := GREATEST(1, LEAST(30, COALESCE(p_expires_days, 7)));

  -- Reject if email already belongs to an active member of this workshop.
  IF EXISTS (
    SELECT 1
    FROM public.tenant_members tm
    JOIN auth.users u ON u.id = tm.user_id
    WHERE tm.tenant_id = p_tenant_id
      AND tm.is_active = true
      AND lower(btrim(COALESCE(u.email, ''))) = v_email
  ) THEN
    RAISE EXCEPTION 'Email tersebut sudah terdaftar sebagai anggota aktif di workshop ini.';
  END IF;

  -- Auto-revoke any expired pending invitation for the same email so re-invite works cleanly.
  UPDATE public.tenant_invitations
  SET status = 'revoked',
      revoked_at = now()
  WHERE tenant_id = p_tenant_id
    AND email = v_email
    AND status = 'pending'
    AND expires_at <= now();

  IF EXISTS (
    SELECT 1
    FROM public.tenant_invitations
    WHERE tenant_id = p_tenant_id
      AND email = v_email
      AND status = 'pending'
      AND expires_at > now()
  ) THEN
    RAISE EXCEPTION 'Undangan aktif untuk email tersebut sudah ada. Salin tautan atau batalkan terlebih dahulu.';
  END IF;

  v_token := encode(extensions.gen_random_bytes(24), 'hex');

  INSERT INTO public.tenant_invitations (
    tenant_id, email, role, token, status, invited_by, expires_at
  )
  VALUES (
    p_tenant_id, v_email, v_role, v_token, 'pending', (SELECT auth.uid()), now() + make_interval(days => v_days)
  )
  RETURNING * INTO v_inv;

  RETURN jsonb_build_object(
    'id', v_inv.id,
    'tenant_id', v_inv.tenant_id,
    'email', v_inv.email,
    'role', v_inv.role,
    'token', v_inv.token,
    'status', v_inv.status,
    'expires_at', v_inv.expires_at,
    'created_at', v_inv.created_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_tenant_invitation(
  p_tenant_id uuid,
  p_invitation_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_role text;
  v_inv public.tenant_invitations%ROWTYPE;
BEGIN
  v_caller_role := private.get_tenant_role(p_tenant_id);
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Akses ditolak.';
  END IF;
  IF p_invitation_id IS NULL THEN
    RAISE EXCEPTION 'ID undangan wajib diisi.';
  END IF;

  SELECT *
  INTO v_inv
  FROM public.tenant_invitations
  WHERE id = p_invitation_id
    AND tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Undangan tidak ditemukan.';
  END IF;

  IF v_caller_role = 'admin' AND v_inv.role <> 'staff' THEN
    RAISE EXCEPTION 'Admin hanya dapat membatalkan undangan Staff.';
  END IF;

  IF v_inv.status <> 'pending' THEN
    RAISE EXCEPTION 'Hanya undangan berstatus pending yang dapat dibatalkan.';
  END IF;

  UPDATE public.tenant_invitations
  SET status = 'revoked',
      revoked_at = now()
  WHERE id = p_invitation_id
    AND tenant_id = p_tenant_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_tenant_invitation(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_user_email text;
  v_confirmed_at timestamptz;
  v_display_name text;
  v_clean_token text;
  v_inv public.tenant_invitations%ROWTYPE;
  v_tenant public.tenants%ROWTYPE;
BEGIN
  v_user_id := (SELECT auth.uid());
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: Masuk terlebih dahulu untuk menerima undangan.';
  END IF;

  SELECT
    lower(btrim(COALESCE(u.email, ''))),
    u.email_confirmed_at,
    COALESCE(
      NULLIF(btrim(u.raw_user_meta_data->>'full_name'), ''),
      NULLIF(btrim(u.raw_user_meta_data->>'name'), ''),
      NULLIF(split_part(COALESCE(u.email, ''), '@', 1), ''),
      'Member'
    )
  INTO v_user_email, v_confirmed_at, v_display_name
  FROM auth.users u
  WHERE u.id = v_user_id;

  IF v_confirmed_at IS NULL THEN
    RAISE EXCEPTION 'EMAIL_UNVERIFIED: Verifikasi email Anda terlebih dahulu sebelum menerima undangan.';
  END IF;

  v_clean_token := btrim(COALESCE(p_token, ''));
  IF length(v_clean_token) < 32 THEN
    RAISE EXCEPTION 'INVITE_INVALID: Tautan undangan tidak valid.';
  END IF;

  SELECT *
  INTO v_inv
  FROM public.tenant_invitations
  WHERE token = v_clean_token
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_INVALID: Tautan undangan tidak ditemukan.';
  END IF;

  IF v_inv.status = 'revoked' THEN
    RAISE EXCEPTION 'INVITE_REVOKED: Undangan ini telah dibatalkan oleh workshop.';
  END IF;

  IF v_inv.status = 'accepted' THEN
    RAISE EXCEPTION 'INVITE_ACCEPTED: Undangan ini sudah pernah digunakan.';
  END IF;

  IF v_inv.expires_at <= now() THEN
    UPDATE public.tenant_invitations
    SET status = 'revoked',
        revoked_at = now()
    WHERE id = v_inv.id;
    RAISE EXCEPTION 'INVITE_EXPIRED: Masa berlaku undangan telah habis. Minta pemilik workshop mengirim tautan baru.';
  END IF;

  IF v_user_email <> lower(btrim(v_inv.email)) THEN
    RAISE EXCEPTION 'EMAIL_MISMATCH: Undangan ditujukan untuk % namun Anda masuk sebagai %.', v_inv.email, v_user_email;
  END IF;

  SELECT *
  INTO v_tenant
  FROM public.tenants
  WHERE id = v_inv.tenant_id
    AND is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TENANT_INACTIVE: Workshop tujuan tidak aktif.';
  END IF;

  INSERT INTO public.tenant_members (tenant_id, user_id, role, is_active, display_name)
  VALUES (v_inv.tenant_id, v_user_id, v_inv.role, true, v_display_name)
  ON CONFLICT (tenant_id, user_id) DO UPDATE
  SET role = EXCLUDED.role,
      is_active = true,
      display_name = COALESCE(NULLIF(btrim(public.tenant_members.display_name), ''), EXCLUDED.display_name);

  UPDATE public.tenant_invitations
  SET status = 'accepted',
      accepted_by = v_user_id,
      accepted_at = now()
  WHERE id = v_inv.id;

  RETURN jsonb_build_object(
    'tenant_id', v_tenant.id,
    'tenant_name', v_tenant.name,
    'tenant_slug', v_tenant.slug,
    'role', v_inv.role
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_tenant_team_data(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_role text;
  v_members jsonb;
  v_invitations jsonb;
BEGIN
  v_caller_role := private.get_tenant_role(p_tenant_id);
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Akses ditolak. Hanya Owner atau Admin yang dapat melihat data tim.';
  END IF;

  SELECT COALESCE(jsonb_agg(row_obj ORDER BY role_rank ASC, created_at ASC), '[]'::jsonb)
  INTO v_members
  FROM (
    SELECT
      CASE tm.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END AS role_rank,
      tm.created_at,
      jsonb_build_object(
        'id', tm.id,
        'user_id', tm.user_id,
        'role', tm.role,
        'is_active', tm.is_active,
        'display_name', COALESCE(
          NULLIF(btrim(tm.display_name), ''),
          NULLIF(btrim(u.raw_user_meta_data->>'full_name'), ''),
          NULLIF(split_part(COALESCE(u.email, ''), '@', 1), ''),
          'Member'
        ),
        'email', COALESCE(u.email, ''),
        'created_at', tm.created_at
      ) AS row_obj
    FROM public.tenant_members tm
    LEFT JOIN auth.users u ON u.id = tm.user_id
    WHERE tm.tenant_id = p_tenant_id
  ) m;

  SELECT COALESCE(jsonb_agg(row_obj ORDER BY created_at DESC), '[]'::jsonb)
  INTO v_invitations
  FROM (
    SELECT
      ti.created_at,
      jsonb_build_object(
        'id', ti.id,
        'email', ti.email,
        'role', ti.role,
        'token', ti.token,
        'status', CASE
          WHEN ti.status = 'pending' AND ti.expires_at <= now() THEN 'expired'
          ELSE ti.status
        END,
        'expires_at', ti.expires_at,
        'accepted_at', ti.accepted_at,
        'revoked_at', ti.revoked_at,
        'created_at', ti.created_at
      ) AS row_obj
    FROM public.tenant_invitations ti
    WHERE ti.tenant_id = p_tenant_id
      AND (v_caller_role = 'owner' OR ti.role = 'staff')
    ORDER BY ti.created_at DESC
    LIMIT 50
  ) inv;

  RETURN jsonb_build_object(
    'caller_role', v_caller_role,
    'members', v_members,
    'invitations', v_invitations
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_tenant_staff_labels(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_labels jsonb;
BEGIN
  IF p_tenant_id IS NULL OR NOT private.is_verified_tenant_member(p_tenant_id) THEN
    RAISE EXCEPTION 'Akses tenant tidak valid.';
  END IF;

  SELECT COALESCE(jsonb_agg(row_obj ORDER BY role_rank ASC, label_name ASC), '[]'::jsonb)
  INTO v_labels
  FROM (
    SELECT
      CASE tm.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END AS role_rank,
      COALESCE(
        NULLIF(btrim(tm.display_name), ''),
        NULLIF(btrim(u.raw_user_meta_data->>'full_name'), ''),
        NULLIF(split_part(COALESCE(u.email, ''), '@', 1), ''),
        'Staff'
      ) AS label_name,
      jsonb_build_object(
        'user_id', tm.user_id,
        'display_name', COALESCE(
          NULLIF(btrim(tm.display_name), ''),
          NULLIF(btrim(u.raw_user_meta_data->>'full_name'), ''),
          NULLIF(split_part(COALESCE(u.email, ''), '@', 1), ''),
          'Staff'
        ),
        'role', tm.role,
        'is_active', tm.is_active
      ) AS row_obj
    FROM public.tenant_members tm
    LEFT JOIN auth.users u ON u.id = tm.user_id
    WHERE tm.tenant_id = p_tenant_id
  ) s;

  RETURN v_labels;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_tenant_member(
  p_tenant_id uuid,
  p_member_id uuid,
  p_role text DEFAULT NULL,
  p_is_active boolean DEFAULT NULL,
  p_display_name text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_target public.tenant_members%ROWTYPE;
  v_new_role text;
  v_new_active boolean;
  v_new_name text;
  v_other_active_owners integer;
BEGIN
  IF p_tenant_id IS NULL OR NOT private.has_tenant_role(p_tenant_id, ARRAY['owner']) THEN
    RAISE EXCEPTION 'Akses ditolak. Hanya Pemilik (Owner) yang dapat mengubah peran atau status anggota.';
  END IF;
  IF p_member_id IS NULL THEN
    RAISE EXCEPTION 'ID anggota wajib diisi.';
  END IF;

  -- Serialize concurrent owner demotion/deactivation checks per tenant.
  PERFORM pg_advisory_xact_lock(hashtextextended('tenant_owners:' || p_tenant_id::text, 0));

  SELECT *
  INTO v_target
  FROM public.tenant_members
  WHERE id = p_member_id
    AND tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Anggota tim tidak ditemukan pada workshop ini.';
  END IF;

  v_new_role := COALESCE(NULLIF(lower(btrim(COALESCE(p_role, ''))), ''), v_target.role);
  IF v_new_role NOT IN ('owner', 'admin', 'staff') THEN
    RAISE EXCEPTION 'Peran tidak valid. Pilih owner, admin, atau staff.';
  END IF;

  v_new_active := COALESCE(p_is_active, v_target.is_active);
  v_new_name := CASE
    WHEN p_display_name IS NULL THEN v_target.display_name
    ELSE NULLIF(btrim(p_display_name), '')
  END;

  -- Protect the last active owner from being demoted or deactivated.
  IF v_target.role = 'owner' AND v_target.is_active = true AND (v_new_role <> 'owner' OR v_new_active = false) THEN
    SELECT count(*)::integer
    INTO v_other_active_owners
    FROM public.tenant_members tm
    WHERE tm.tenant_id = p_tenant_id
      AND tm.role = 'owner'
      AND tm.is_active = true
      AND tm.id <> v_target.id;

    IF v_other_active_owners < 1 THEN
      RAISE EXCEPTION 'LAST_OWNER_PROTECTED: Workshop harus memiliki minimal satu Pemilik (Owner) aktif.';
    END IF;
  END IF;

  UPDATE public.tenant_members
  SET role = v_new_role,
      is_active = v_new_active,
      display_name = COALESCE(v_new_name, display_name)
  WHERE id = v_target.id
    AND tenant_id = p_tenant_id
  RETURNING * INTO v_target;

  RETURN jsonb_build_object(
    'id', v_target.id,
    'user_id', v_target.user_id,
    'role', v_target.role,
    'is_active', v_target.is_active,
    'display_name', v_target.display_name
  );
END;
$$;

-- 9. Staff Production & Workstation RPCs (`SECURITY DEFINER`, locked search_path)
CREATE OR REPLACE FUNCTION public.get_staff_production_orders(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_tenant_id IS NULL OR NOT private.is_verified_tenant_member(p_tenant_id) THEN
    RAISE EXCEPTION 'Akses tenant tidak valid.';
  END IF;

  SELECT COALESCE(jsonb_agg(order_obj ORDER BY created_at DESC), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT
      o.created_at,
      jsonb_build_object(
        'id', o.id,
        'tenant_id', o.tenant_id,
        'ticket_code', o.ticket_code,
        'customer_name', o.customer_name,
        'status', o.status,
        'order_type', o.order_type,
        'estimated_done_date', o.estimated_done_date,
        'notes', o.notes,
        'inbound_courier', o.inbound_courier,
        'inbound_tracking', o.inbound_tracking,
        'outbound_courier', o.outbound_courier,
        'outbound_tracking', o.outbound_tracking,
        'created_at', o.created_at,
        'updated_at', o.updated_at,
        'order_items', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', oi.id,
              'order_id', oi.order_id,
              'garment_name', oi.garment_name,
              'service_type', oi.service_type,
              'measurement_specs', oi.measurement_specs,
              'before_photo_path', oi.before_photo_path,
              'after_photo_path', oi.after_photo_path,
              'created_at', oi.created_at,
              'order_item_workstations', COALESCE((
                SELECT jsonb_agg(
                  jsonb_build_object(
                    'id', oiw.id,
                    'order_item_id', oiw.order_item_id,
                    'workstation_id', oiw.workstation_id,
                    'station_name', oiw.station_name,
                    'sort_order', oiw.sort_order,
                    'is_done', oiw.is_done,
                    'assigned_to', oiw.assigned_to,
                    'completed_by', oiw.completed_by,
                    'completed_at', oiw.completed_at
                  ) ORDER BY oiw.sort_order ASC, oiw.created_at ASC
                )
                FROM public.order_item_workstations oiw
                WHERE oiw.tenant_id = oi.tenant_id
                  AND oiw.order_item_id = oi.id
              ), '[]'::jsonb)
            ) ORDER BY oi.created_at ASC
          )
          FROM public.order_items oi
          WHERE oi.tenant_id = o.tenant_id
            AND oi.order_id = o.id
        ), '[]'::jsonb)
      ) AS order_obj
    FROM public.orders o
    WHERE o.tenant_id = p_tenant_id
      AND o.status <> 'completed'
  ) prod;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_staff_workload_services(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_tenant_id IS NULL OR NOT private.is_verified_tenant_member(p_tenant_id) THEN
    RAISE EXCEPTION 'Akses tenant tidak valid.';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', s.id,
      'name', s.name,
      'estimated_minutes', s.estimated_minutes,
      'is_active', s.is_active
    ) ORDER BY s.sort_order ASC, s.name ASC
  ), '[]'::jsonb)
  INTO v_result
  FROM public.services s
  WHERE s.tenant_id = p_tenant_id;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.advance_order_production_status(
  p_tenant_id uuid,
  p_order_id uuid,
  p_next_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_next text;
BEGIN
  IF p_tenant_id IS NULL OR NOT private.is_verified_tenant_member(p_tenant_id) THEN
    RAISE EXCEPTION 'Akses tenant tidak valid.';
  END IF;
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'Order ID wajib diisi.';
  END IF;

  v_next := lower(btrim(COALESCE(p_next_status, '')));

  SELECT *
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
    AND tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order tidak ditemukan atau tidak dapat diakses.';
  END IF;

  IF NOT (
    (v_order.status = 'queued' AND v_next = 'in_progress')
    OR (v_order.status = 'in_progress' AND v_next = 'qc')
    OR (v_order.status = 'qc' AND v_next = 'ready')
  ) THEN
    RAISE EXCEPTION 'Transisi status tidak diizinkan untuk peran Staff (% -> %).', v_order.status, v_next;
  END IF;

  UPDATE public.orders
  SET status = v_next,
      updated_at = now()
  WHERE id = v_order.id
    AND tenant_id = p_tenant_id;

  RETURN jsonb_build_object(
    'id', v_order.id,
    'previous_status', v_order.status,
    'status', v_next
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.update_order_item_workstation(
  p_tenant_id uuid,
  p_step_id uuid,
  p_is_done boolean DEFAULT NULL,
  p_assigned_to uuid DEFAULT NULL,
  p_clear_assignee boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_role text;
  v_caller_id uuid;
  v_step public.order_item_workstations%ROWTYPE;
  v_order_status text;
  v_new_done boolean;
  v_new_assigned uuid;
  v_new_completed_by uuid;
  v_new_completed_at timestamptz;
BEGIN
  v_caller_role := private.get_tenant_role(p_tenant_id);
  v_caller_id := (SELECT auth.uid());

  IF v_caller_role IS NULL OR v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Akses tenant tidak valid.';
  END IF;
  IF p_step_id IS NULL THEN
    RAISE EXCEPTION 'ID tahapan stasiun wajib diisi.';
  END IF;

  SELECT oiw.*
  INTO v_step
  FROM public.order_item_workstations oiw
  WHERE oiw.id = p_step_id
    AND oiw.tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tahapan stasiun mesin tidak ditemukan.';
  END IF;

  SELECT o.status
  INTO v_order_status
  FROM public.order_items oi
  JOIN public.orders o
    ON o.tenant_id = oi.tenant_id
   AND o.id = oi.order_id
  WHERE oi.tenant_id = p_tenant_id
    AND oi.id = v_step.order_item_id;

  IF v_caller_role = 'staff' AND v_order_status = 'completed' THEN
    RAISE EXCEPTION 'Staff tidak dapat mengubah stasiun pada order yang sudah selesai.';
  END IF;

  IF v_caller_role = 'staff' AND (p_assigned_to IS NOT NULL OR COALESCE(p_clear_assignee, false) = true) THEN
    RAISE EXCEPTION 'Hanya Owner atau Admin yang dapat menetapkan penanggung jawab stasiun.';
  END IF;

  IF p_assigned_to IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.tenant_members tm
      WHERE tm.tenant_id = p_tenant_id
        AND tm.user_id = p_assigned_to
        AND tm.is_active = true
    ) THEN
      RAISE EXCEPTION 'Penanggung jawab bukan anggota aktif workshop ini.';
    END IF;
  END IF;

  v_new_done := COALESCE(p_is_done, v_step.is_done);
  v_new_assigned := CASE
    WHEN COALESCE(p_clear_assignee, false) = true THEN NULL
    WHEN p_assigned_to IS NOT NULL THEN p_assigned_to
    WHEN v_new_done = true AND v_step.assigned_to IS NULL THEN v_caller_id
    ELSE v_step.assigned_to
  END;

  IF p_is_done IS NOT NULL THEN
    IF v_new_done = true THEN
      v_new_completed_by := v_caller_id;
      v_new_completed_at := now();
    ELSE
      v_new_completed_by := NULL;
      v_new_completed_at := NULL;
    END IF;
  ELSE
    v_new_completed_by := v_step.completed_by;
    v_new_completed_at := v_step.completed_at;
  END IF;

  UPDATE public.order_item_workstations
  SET is_done = v_new_done,
      assigned_to = v_new_assigned,
      completed_by = v_new_completed_by,
      completed_at = v_new_completed_at,
      updated_at = now()
  WHERE id = v_step.id
    AND tenant_id = p_tenant_id
  RETURNING * INTO v_step;

  RETURN jsonb_build_object(
    'id', v_step.id,
    'order_item_id', v_step.order_item_id,
    'workstation_id', v_step.workstation_id,
    'station_name', v_step.station_name,
    'sort_order', v_step.sort_order,
    'is_done', v_step.is_done,
    'assigned_to', v_step.assigned_to,
    'completed_by', v_step.completed_by,
    'completed_at', v_step.completed_at
  );
END;
$$;

-- 10. Lock Function Execution Privileges (Zero `anon` / `PUBLIC` Execution)
REVOKE ALL ON FUNCTION public.delete_manual_cash_transaction(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_manual_cash_transaction(uuid, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.create_tenant_invitation(uuid, text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_tenant_invitation(uuid, text, text, integer) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.revoke_tenant_invitation(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_tenant_invitation(uuid, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.accept_tenant_invitation(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_tenant_invitation(text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_tenant_team_data(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_tenant_team_data(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_tenant_staff_labels(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_tenant_staff_labels(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.update_tenant_member(uuid, uuid, text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_tenant_member(uuid, uuid, text, boolean, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_staff_production_orders(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_staff_production_orders(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_staff_workload_services(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_staff_workload_services(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.advance_order_production_status(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.advance_order_production_status(uuid, uuid, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.update_order_item_workstation(uuid, uuid, boolean, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_order_item_workstation(uuid, uuid, boolean, uuid, boolean) TO authenticated, service_role;

COMMIT;
