-- MendTrack Stage 3: Mail-In Logistics & Denim Fit Passport (Additive Migration)
-- Target project : mendtrack_dev (ncobbhceczfpxosgszwz)
-- DO NOT RUN on legacy production project mendtrack (zurtrvuyigwtmyfvrelb).
--
-- Includes:
--   1. Additive mail-in columns on public.orders (order_type, inbound_courier,
--      inbound_tracking, outbound_courier, outbound_tracking) + check constraints
--      and targeted tenant-scoped indexes.
--   2. Extended status checks on public.orders and public.order_logs adding
--      'awaiting_package' and 'shipped' while keeping all walk-in statuses intact.
--   3. Additive Denim Fit Passport columns on public.customer_measurements
--      (denim_fabric_type, shrinkage_notes, hem_taper_preference, fit_notes).
--   4. Updated order status/header audit triggers (locked SET search_path = '').
--   5. 15-arg SECURITY INVOKER public.save_order_with_items replacing 9-arg
--      signature with locked grants (authenticated, service_role).

BEGIN;

-- 1. Mail-In Logistics columns, constraints, and indexes on public.orders
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS order_type text NOT NULL DEFAULT 'walk_in',
  ADD COLUMN IF NOT EXISTS inbound_courier text,
  ADD COLUMN IF NOT EXISTS inbound_tracking text,
  ADD COLUMN IF NOT EXISTS outbound_courier text,
  ADD COLUMN IF NOT EXISTS outbound_tracking text;

UPDATE public.orders
SET order_type = 'walk_in'
WHERE order_type IS NULL OR btrim(order_type) = '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'orders_order_type_check'
      AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_order_type_check
      CHECK (order_type IN ('walk_in', 'mail_in'));
  END IF;
END;
$$;

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_status_check;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_status_check
  CHECK (
    status IN (
      'awaiting_package',
      'received',
      'queued',
      'in_progress',
      'qc',
      'ready',
      'shipped',
      'completed'
    )
  );

ALTER TABLE public.order_logs
  DROP CONSTRAINT IF EXISTS order_logs_status_check;

ALTER TABLE public.order_logs
  ADD CONSTRAINT order_logs_status_check
  CHECK (
    status IN (
      'awaiting_package',
      'received',
      'queued',
      'in_progress',
      'qc',
      'ready',
      'shipped',
      'completed'
    )
  );

CREATE INDEX IF NOT EXISTS idx_orders_tenant_order_type
  ON public.orders (tenant_id, order_type);

CREATE INDEX IF NOT EXISTS idx_orders_tenant_inbound_tracking
  ON public.orders (tenant_id, inbound_tracking)
  WHERE inbound_tracking IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_tenant_outbound_tracking
  ON public.orders (tenant_id, outbound_tracking)
  WHERE outbound_tracking IS NOT NULL;

COMMENT ON COLUMN public.orders.order_type IS
  'Jenis penerimaan order: walk_in (default) atau mail_in (kiriman paket).';

-- 2. Denim Fit Passport columns on public.customer_measurements
ALTER TABLE public.customer_measurements
  ADD COLUMN IF NOT EXISTS denim_fabric_type text,
  ADD COLUMN IF NOT EXISTS shrinkage_notes text,
  ADD COLUMN IF NOT EXISTS hem_taper_preference text,
  ADD COLUMN IF NOT EXISTS fit_notes text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'customer_measurements_denim_fabric_type_check'
      AND conrelid = 'public.customer_measurements'::regclass
  ) THEN
    ALTER TABLE public.customer_measurements
      ADD CONSTRAINT customer_measurements_denim_fabric_type_check
      CHECK (
        denim_fabric_type IS NULL
        OR denim_fabric_type IN ('sanforized', 'unsanforized', 'raw')
      );
  END IF;
END;
$$;

COMMENT ON COLUMN public.customer_measurements.denim_fabric_type IS
  'Karakter kain denim opsional: sanforized, unsanforized, atau raw.';

-- 3. Updated Order Status & Header Audit Triggers (SET search_path = '')
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
      WHEN 'awaiting_package' THEN 'Menunggu paket kiriman dari pelanggan'
      WHEN 'received' THEN CASE
        WHEN COALESCE(NEW.order_type, 'walk_in') = 'mail_in' THEN 'Paket kiriman diterima oleh workshop'
        ELSE 'Order diterima oleh workshop'
      END
      WHEN 'queued' THEN 'Order masuk dalam antrean pengerjaan'
      WHEN 'in_progress' THEN 'Sedang dalam proses pengerjaan'
      WHEN 'qc' THEN 'Tahap pemeriksaan kualitas (Quality Check)'
      WHEN 'ready' THEN CASE
        WHEN COALESCE(NEW.order_type, 'walk_in') = 'mail_in' THEN 'Pengerjaan selesai dan siap dikirim'
        ELSE 'Pengerjaan selesai dan siap diambil'
      END
      WHEN 'shipped' THEN 'Paket telah dikirim kembali ke pelanggan'
      WHEN 'completed' THEN CASE
        WHEN COALESCE(NEW.order_type, 'walk_in') = 'mail_in' THEN 'Order mail-in selesai'
        ELSE 'Order telah diambil / selesai'
      END
      ELSE 'Status diperbarui'
    END;

    INSERT INTO public.order_logs (tenant_id, order_id, status, log_note)
    VALUES (NEW.tenant_id, NEW.id, NEW.status, v_default_note);
  END IF;

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
  IF OLD.order_type IS DISTINCT FROM NEW.order_type THEN
    v_changes := array_append(
      v_changes,
      format('Tipe order: %s -> %s', COALESCE(OLD.order_type, 'walk_in'), COALESCE(NEW.order_type, 'walk_in'))
    );
  END IF;
  IF OLD.inbound_courier IS DISTINCT FROM NEW.inbound_courier THEN
    v_changes := array_append(
      v_changes,
      format('Kurir masuk: %s -> %s', COALESCE(OLD.inbound_courier, '(kosong)'), COALESCE(NEW.inbound_courier, '(kosong)'))
    );
  END IF;
  IF OLD.inbound_tracking IS DISTINCT FROM NEW.inbound_tracking THEN
    v_changes := array_append(
      v_changes,
      format('Resi masuk: %s -> %s', COALESCE(OLD.inbound_tracking, '(kosong)'), COALESCE(NEW.inbound_tracking, '(kosong)'))
    );
  END IF;
  IF OLD.outbound_courier IS DISTINCT FROM NEW.outbound_courier THEN
    v_changes := array_append(
      v_changes,
      format('Kurir keluar: %s -> %s', COALESCE(OLD.outbound_courier, '(kosong)'), COALESCE(NEW.outbound_courier, '(kosong)'))
    );
  END IF;
  IF OLD.outbound_tracking IS DISTINCT FROM NEW.outbound_tracking THEN
    v_changes := array_append(
      v_changes,
      format('Resi keluar: %s -> %s', COALESCE(OLD.outbound_tracking, '(kosong)'), COALESCE(NEW.outbound_tracking, '(kosong)'))
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

DROP TRIGGER IF EXISTS trg_sync_payment_status ON public.orders;
CREATE TRIGGER trg_sync_payment_status
  BEFORE INSERT OR UPDATE OF
    total_amount, paid_amount, status, customer_name, customer_phone,
    estimated_done_date, notes, order_type, inbound_courier, inbound_tracking,
    outbound_courier, outbound_tracking
  ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.fn_sync_payment_status();

DROP TRIGGER IF EXISTS trg_audit_order_header_changes ON public.orders;
CREATE TRIGGER trg_audit_order_header_changes
  AFTER UPDATE OF
    ticket_code, customer_name, customer_phone, estimated_done_date, notes,
    order_type, inbound_courier, inbound_tracking, outbound_courier, outbound_tracking
  ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.fn_audit_order_header_changes();

-- 4. Upgrade public.save_order_with_items to 15-arg Mail-In Aware RPC
DROP FUNCTION IF EXISTS public.save_order_with_items(
  uuid, uuid, text, text, text, date, text, numeric, jsonb
);

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

REVOKE ALL ON FUNCTION public.save_order_with_items(
  uuid, uuid, text, text, text, date, text, numeric, jsonb,
  text, text, text, text, text, text
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.save_order_with_items(
  uuid, uuid, text, text, text, date, text, numeric, jsonb,
  text, text, text, text, text, text
) TO authenticated, service_role;

COMMIT;
