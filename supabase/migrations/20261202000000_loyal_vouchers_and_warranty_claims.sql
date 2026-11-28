-- Loyal Customers, Branded Vouchers & Warranty Claims (Strictly Additive, Zero DROP/DELETE DDL)
-- Target Supabase project: mendtrack_dev (ncobbhceczfpxosgszwz)
-- IMPORTANT: Never run on legacy mendtrack (zurtrvuyigwtmyfvrelb).
--
-- Summary:
--   1. Create tenant-isolated public.vouchers table with strict owner/admin RLS,
--      composite tenant FKs, email delivery status tracking, and covering indexes.
--   2. Add additive columns to public.orders:
--      - voucher_code text
--      - discount_amount numeric(14, 2) NOT NULL DEFAULT 0
--      - is_warranty boolean NOT NULL DEFAULT false
--      - warranty_source_order_id uuid (composite tenant FK to public.orders)
--   3. Update public.fn_sync_order_total() to subtract orders.discount_amount safely
--      and public.fn_sync_payment_status() so zero-total warranty or fully discounted
--      orders automatically synchronize to payment_status = 'paid'.
--   4. Add atomic public.apply_order_voucher_and_discount(...) RPC (keeping 15-arg
--      public.save_order_with_items intact) and update public.get_staff_production_orders(...)
--      to expose is_warranty (zero PII).

BEGIN;

-- 1. Tenant-isolated vouchers table
CREATE TABLE IF NOT EXISTS public.vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (
    code = upper(btrim(code))
    AND length(code) BETWEEN 3 AND 32
    AND code ~ '^[A-Z0-9][A-Z0-9_-]*$'
  ),
  discount_type text NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
  discount_value numeric(14, 2) NOT NULL CHECK (
    discount_value > 0
    AND (discount_type <> 'percent' OR discount_value <= 100)
  ),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'used', 'expired', 'revoked')),
  expires_at date,
  customer_id uuid,
  customer_name text,
  customer_phone text,
  customer_email text CHECK (
    customer_email IS NULL
    OR (
      customer_email = lower(btrim(customer_email))
      AND length(customer_email) <= 254
      AND customer_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    )
  ),
  notes text,
  used_order_id uuid,
  used_at timestamptz,
  email_status text CHECK (email_status IS NULL OR email_status IN ('sent', 'failed', 'skipped')),
  email_sent_at timestamptz,
  email_error text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vouchers_tenant_customer_fkey
    FOREIGN KEY (tenant_id, customer_id)
    REFERENCES public.customers(tenant_id, id)
    ON DELETE SET NULL (customer_id),
  CONSTRAINT vouchers_tenant_used_order_fkey
    FOREIGN KEY (tenant_id, used_order_id)
    REFERENCES public.orders(tenant_id, id)
    ON DELETE SET NULL (used_order_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vouchers_tenant_code_upper
  ON public.vouchers (tenant_id, upper(btrim(code)));

CREATE INDEX IF NOT EXISTS idx_vouchers_tenant_status
  ON public.vouchers (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_vouchers_tenant_customer
  ON public.vouchers (tenant_id, customer_id)
  WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vouchers_tenant_used_order
  ON public.vouchers (tenant_id, used_order_id)
  WHERE used_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vouchers_created_by
  ON public.vouchers (created_by)
  WHERE created_by IS NOT NULL;

ALTER TABLE public.vouchers ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.vouchers FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vouchers TO authenticated;
GRANT ALL ON TABLE public.vouchers TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'vouchers'
      AND policyname = 'vouchers_select_owner_admin'
  ) THEN
    CREATE POLICY vouchers_select_owner_admin
      ON public.vouchers
      FOR SELECT
      TO authenticated
      USING (
        (SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin']))
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'vouchers'
      AND policyname = 'vouchers_insert_owner_admin'
  ) THEN
    CREATE POLICY vouchers_insert_owner_admin
      ON public.vouchers
      FOR INSERT
      TO authenticated
      WITH CHECK (
        (SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin']))
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'vouchers'
      AND policyname = 'vouchers_update_owner_admin'
  ) THEN
    CREATE POLICY vouchers_update_owner_admin
      ON public.vouchers
      FOR UPDATE
      TO authenticated
      USING (
        (SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin']))
      )
      WITH CHECK (
        (SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin']))
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'vouchers'
      AND policyname = 'vouchers_delete_owner'
  ) THEN
    CREATE POLICY vouchers_delete_owner
      ON public.vouchers
      FOR DELETE
      TO authenticated
      USING (
        (SELECT private.has_tenant_role(tenant_id, ARRAY['owner']))
      );
  END IF;
END
$$;

-- 2. Additive voucher, discount, and warranty columns on public.orders
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS voucher_code text;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS discount_amount numeric(14, 2) NOT NULL DEFAULT 0;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS is_warranty boolean NOT NULL DEFAULT false;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS warranty_source_order_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_discount_amount_non_negative_check'
      AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_discount_amount_non_negative_check
      CHECK (discount_amount >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_tenant_warranty_source_fkey'
      AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_tenant_warranty_source_fkey
      FOREIGN KEY (tenant_id, warranty_source_order_id)
      REFERENCES public.orders(tenant_id, id)
      ON DELETE SET NULL (warranty_source_order_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_warranty_source_not_self_check'
      AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_warranty_source_not_self_check
      CHECK (warranty_source_order_id IS NULL OR warranty_source_order_id <> id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_orders_tenant_warranty
  ON public.orders (tenant_id, is_warranty)
  WHERE is_warranty = true;

CREATE INDEX IF NOT EXISTS idx_orders_tenant_warranty_source
  ON public.orders (tenant_id, warranty_source_order_id)
  WHERE warranty_source_order_id IS NOT NULL;

-- 3. Update order total & payment status triggers for discounts and zero-total warranties
CREATE OR REPLACE FUNCTION public.fn_sync_order_total()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_tenant_id uuid;
  v_order_id uuid;
  v_items_subtotal numeric(14, 2);
BEGIN
  v_tenant_id := COALESCE(NEW.tenant_id, OLD.tenant_id);
  v_order_id := COALESCE(NEW.order_id, OLD.order_id);

  SELECT COALESCE(SUM(price), 0)
  INTO v_items_subtotal
  FROM public.order_items
  WHERE tenant_id = v_tenant_id
    AND order_id = v_order_id;

  UPDATE public.orders
  SET total_amount = GREATEST(
        0,
        v_items_subtotal - LEAST(v_items_subtotal, GREATEST(0, COALESCE(discount_amount, 0)))
      )
  WHERE id = v_order_id
    AND tenant_id = v_tenant_id;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_sync_payment_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF COALESCE(NEW.total_amount, 0) <= 0
     AND (COALESCE(NEW.is_warranty, false) = true OR COALESCE(NEW.discount_amount, 0) > 0) THEN
    NEW.payment_status := 'paid';
  ELSIF COALESCE(NEW.paid_amount, 0) <= 0 THEN
    NEW.payment_status := 'unpaid';
  ELSIF COALESCE(NEW.paid_amount, 0) < COALESCE(NEW.total_amount, 0) THEN
    NEW.payment_status := 'partial';
  ELSE
    NEW.payment_status := 'paid';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- 4. Atomic voucher redemption, manual discount, and warranty metadata RPC
CREATE OR REPLACE FUNCTION public.apply_order_voucher_and_discount(
  p_tenant_id uuid,
  p_order_id uuid,
  p_voucher_code text DEFAULT NULL,
  p_manual_discount numeric DEFAULT 0,
  p_is_warranty boolean DEFAULT false,
  p_warranty_source_order_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_tenant_tz text := 'Asia/Jakarta';
  v_tenant_currency text := 'IDR';
  v_decimals integer := 0;
  v_items_subtotal numeric(14, 2) := 0;
  v_clean_code text := NULLIF(upper(btrim(COALESCE(p_voucher_code, ''))), '');
  v_existing_code text;
  v_voucher public.vouchers%ROWTYPE;
  v_voucher_discount numeric(14, 2) := 0;
  v_manual_discount numeric(14, 2) := GREATEST(0, COALESCE(p_manual_discount, 0));
  v_final_discount numeric(14, 2) := 0;
  v_final_total numeric(14, 2) := 0;
  v_effective_code text := NULL;
  v_effective_warranty boolean := COALESCE(p_is_warranty, false);
  v_effective_source_id uuid := NULL;
  v_today date;
  v_final_payment_status text;
BEGIN
  IF p_tenant_id IS NULL OR NOT private.has_tenant_role(p_tenant_id, ARRAY['owner', 'admin']) THEN
    RAISE EXCEPTION 'Akses ditolak. Hanya Owner atau Admin yang dapat menerapkan voucher atau garansi.';
  END IF;

  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'Order ID wajib diisi.';
  END IF;

  IF COALESCE(p_manual_discount, 0) < 0 THEN
    RAISE EXCEPTION 'Nominal diskon tidak boleh negatif.';
  END IF;

  SELECT COALESCE(NULLIF(btrim(timezone), ''), 'Asia/Jakarta'),
         COALESCE(NULLIF(upper(btrim(currency)), ''), 'IDR')
  INTO v_tenant_tz, v_tenant_currency
  FROM public.tenants
  WHERE id = p_tenant_id
    AND is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Workshop tidak ditemukan atau tidak aktif.';
  END IF;

  v_decimals := CASE WHEN v_tenant_currency IN ('IDR', 'JPY') THEN 0 ELSE 2 END;

  BEGIN
    v_today := (now() AT TIME ZONE v_tenant_tz)::date;
  EXCEPTION WHEN OTHERS THEN
    v_today := (now() AT TIME ZONE 'UTC')::date;
  END;

  SELECT *
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
    AND tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order tidak ditemukan pada workshop ini.';
  END IF;

  SELECT COALESCE(SUM(price), 0)
  INTO v_items_subtotal
  FROM public.order_items
  WHERE tenant_id = p_tenant_id
    AND order_id = p_order_id;

  v_existing_code := NULLIF(upper(btrim(COALESCE(v_order.voucher_code, ''))), '');

  IF v_clean_code IS NOT NULL THEN
    IF v_existing_code IS NOT NULL AND v_clean_code = v_existing_code THEN
      SELECT *
      INTO v_voucher
      FROM public.vouchers
      WHERE tenant_id = p_tenant_id
        AND upper(btrim(code)) = v_clean_code
      FOR UPDATE;

      v_effective_code := v_existing_code;
      IF FOUND THEN
        IF v_voucher.discount_type = 'percent' THEN
          v_voucher_discount := ROUND(v_items_subtotal * v_voucher.discount_value / 100.0, v_decimals);
        ELSE
          v_voucher_discount := v_voucher.discount_value;
        END IF;
      ELSE
        v_voucher_discount := GREATEST(0, COALESCE(v_order.discount_amount, 0) - v_manual_discount);
      END IF;
    ELSE
      SELECT *
      INTO v_voucher
      FROM public.vouchers
      WHERE tenant_id = p_tenant_id
        AND upper(btrim(code)) = v_clean_code
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'VOUCHER_NOT_FOUND';
      END IF;

      IF v_voucher.status = 'used' THEN
        RAISE EXCEPTION 'VOUCHER_ALREADY_USED';
      END IF;

      IF v_voucher.status = 'expired' OR (v_voucher.expires_at IS NOT NULL AND v_voucher.expires_at < v_today) THEN
        IF v_voucher.status = 'active' THEN
          UPDATE public.vouchers
          SET status = 'expired',
              updated_at = now()
          WHERE id = v_voucher.id
            AND tenant_id = p_tenant_id;
        END IF;
        RAISE EXCEPTION 'VOUCHER_EXPIRED';
      END IF;

      IF v_voucher.status <> 'active' THEN
        RAISE EXCEPTION 'VOUCHER_INACTIVE';
      END IF;

      IF v_voucher.discount_type = 'percent' THEN
        v_voucher_discount := ROUND(v_items_subtotal * v_voucher.discount_value / 100.0, v_decimals);
      ELSE
        v_voucher_discount := v_voucher.discount_value;
      END IF;

      UPDATE public.vouchers
      SET status = 'used',
          used_order_id = p_order_id,
          used_at = now(),
          updated_at = now()
      WHERE id = v_voucher.id
        AND tenant_id = p_tenant_id;

      v_effective_code := v_voucher.code;
    END IF;
  END IF;

  IF v_effective_warranty AND p_warranty_source_order_id IS NOT NULL AND p_warranty_source_order_id <> p_order_id THEN
    IF EXISTS (
      SELECT 1
      FROM public.orders src
      WHERE src.id = p_warranty_source_order_id
        AND src.tenant_id = p_tenant_id
    ) THEN
      v_effective_source_id := p_warranty_source_order_id;
    END IF;
  END IF;

  v_final_discount := LEAST(v_items_subtotal, GREATEST(0, v_voucher_discount + v_manual_discount));
  v_final_total := GREATEST(0, v_items_subtotal - v_final_discount);

  UPDATE public.orders
  SET voucher_code = v_effective_code,
      discount_amount = v_final_discount,
      total_amount = v_final_total,
      is_warranty = v_effective_warranty,
      warranty_source_order_id = v_effective_source_id
  WHERE id = p_order_id
    AND tenant_id = p_tenant_id
  RETURNING payment_status INTO v_final_payment_status;

  RETURN jsonb_build_object(
    'order_id', p_order_id,
    'voucher_code', v_effective_code,
    'items_subtotal', v_items_subtotal,
    'discount_amount', v_final_discount,
    'total_amount', v_final_total,
    'payment_status', v_final_payment_status,
    'is_warranty', v_effective_warranty,
    'warranty_source_order_id', v_effective_source_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_order_voucher_and_discount(uuid, uuid, text, numeric, boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_order_voucher_and_discount(uuid, uuid, text, numeric, boolean, uuid) TO authenticated, service_role;

-- 5. Update public.get_staff_production_orders in place to include is_warranty (zero PII)
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
        'is_warranty', COALESCE(o.is_warranty, false),
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

COMMIT;
