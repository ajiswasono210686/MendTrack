-- Stage 6: Custom SMTP & Transactional Email Notifications (Additive, Backward-Compatible)
-- Target Supabase project: mendtrack_dev (ncobbhceczfpxosgszwz)
-- IMPORTANT: Never run on legacy mendtrack (zurtrvuyigwtmyfvrelb).
--
-- Summary:
--   1. Add optional lowercase-normalized email columns with format CHECK constraints:
--      - public.customers.email
--      - public.orders.customer_email
--      - public.quote_requests.customer_email
--      - public.tenants.notification_email
--   2. Create tenant-isolated public.email_logs with indexes and strict owner/admin SELECT-only RLS
--      (writes performed exclusively by Edge Functions via service_role).
--   3. Update public.save_order_with_items (exact 15-arg signature) and
--      public.approve_quote_to_order (exact 4-arg signature) in place so optional customer emails
--      propagate automatically while keeping staff production payloads zero-PII.

BEGIN;

-- 1. Optional email columns on customers, orders, quote_requests, and tenants
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS email text;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS customer_email text;

ALTER TABLE public.quote_requests
  ADD COLUMN IF NOT EXISTS customer_email text;

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS notification_email text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customers_email_format_check'
      AND conrelid = 'public.customers'::regclass
  ) THEN
    ALTER TABLE public.customers
      ADD CONSTRAINT customers_email_format_check
      CHECK (
        email IS NULL
        OR (
          email = lower(btrim(email))
          AND length(email) <= 254
          AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_customer_email_format_check'
      AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_customer_email_format_check
      CHECK (
        customer_email IS NULL
        OR (
          customer_email = lower(btrim(customer_email))
          AND length(customer_email) <= 254
          AND customer_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quote_requests_customer_email_format_check'
      AND conrelid = 'public.quote_requests'::regclass
  ) THEN
    ALTER TABLE public.quote_requests
      ADD CONSTRAINT quote_requests_customer_email_format_check
      CHECK (
        customer_email IS NULL
        OR (
          customer_email = lower(btrim(customer_email))
          AND length(customer_email) <= 254
          AND customer_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenants_notification_email_format_check'
      AND conrelid = 'public.tenants'::regclass
  ) THEN
    ALTER TABLE public.tenants
      ADD CONSTRAINT tenants_notification_email_format_check
      CHECK (
        notification_email IS NULL
        OR (
          notification_email = lower(btrim(notification_email))
          AND length(notification_email) <= 254
          AND notification_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
        )
      );
  END IF;
END
$$;

-- 2. Tenant-scoped transactional email delivery log table (17th RLS-protected public table)
CREATE TABLE IF NOT EXISTS public.email_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (
    event_type IN (
      'team_invite',
      'quote_received_customer',
      'quote_received_workshop',
      'quote_published',
      'order_ready',
      'order_completed'
    )
  ),
  recipient_email text NOT NULL CHECK (
    recipient_email = lower(btrim(recipient_email))
    AND length(recipient_email) <= 254
    AND recipient_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  subject text NOT NULL,
  locale text NOT NULL DEFAULT 'id' CHECK (locale IN ('id', 'en')),
  status text NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  provider text NOT NULL DEFAULT 'resend',
  provider_message_id text,
  error_message text,
  related_entity_type text CHECK (
    related_entity_type IS NULL
    OR related_entity_type IN ('invitation', 'quote', 'order')
  ),
  related_entity_id uuid,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_logs_tenant_created
  ON public.email_logs (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_logs_tenant_entity
  ON public.email_logs (tenant_id, related_entity_type, related_entity_id, created_at DESC)
  WHERE related_entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_email_logs_created_by
  ON public.email_logs (created_by)
  WHERE created_by IS NOT NULL;

ALTER TABLE public.email_logs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.email_logs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.email_logs TO authenticated;
GRANT ALL ON TABLE public.email_logs TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'email_logs'
      AND policyname = 'email_logs_select_owner_admin'
  ) THEN
    CREATE POLICY email_logs_select_owner_admin
      ON public.email_logs
      FOR SELECT
      TO authenticated
      USING (
        (SELECT private.has_tenant_role(tenant_id, ARRAY['owner', 'admin']))
      );
  END IF;
END
$$;

-- 3. Update public.save_order_with_items in place (exact 15-arg signature)
--    Auto-fills orders.customer_email from customers.email when present.
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
  v_customer_email text;
  v_normalized_phone text;
  v_order_type text;
  v_inbound_courier text;
  v_inbound_tracking text;
  v_outbound_courier text;
  v_outbound_tracking text;
  v_initial_status text := 'received';
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
  ELSE
    v_inbound_courier := NULL;
    v_inbound_tracking := NULL;
    v_outbound_courier := NULL;
    v_outbound_tracking := NULL;
  END IF;

  v_initial_status := 'received';

  v_normalized_phone := public.normalize_customer_phone(p_customer_phone);
  IF v_normalized_phone = '' THEN
    RAISE EXCEPTION 'Nomor pelanggan tidak valid.';
  END IF;

  INSERT INTO public.customers (tenant_id, name, phone)
  VALUES (p_tenant_id, btrim(p_customer_name), v_normalized_phone)
  ON CONFLICT (tenant_id, phone) DO NOTHING
  RETURNING id, email INTO v_customer_id, v_customer_email;

  IF v_customer_id IS NULL THEN
    SELECT id, email
    INTO v_customer_id, v_customer_email
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
        customer_email = COALESCE(public.orders.customer_email, v_customer_email),
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
      id, tenant_id, ticket_code, customer_id, customer_name, customer_phone, customer_email,
      status, estimated_done_date, notes, paid_amount, payment_status,
      order_type, inbound_courier, inbound_tracking, outbound_courier, outbound_tracking
    )
    VALUES (
      v_order_id, p_tenant_id, upper(btrim(p_ticket_code)), v_customer_id,
      btrim(p_customer_name), v_normalized_phone, v_customer_email, v_initial_status,
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

-- 4. Update public.approve_quote_to_order in place (exact 4-arg signature, service_role only)
--    Propagates quote_requests.customer_email into customers.email (when blank) and orders.customer_email.
CREATE OR REPLACE FUNCTION public.approve_quote_to_order(
  p_tenant_id uuid,
  p_approval_token text,
  p_new_order_id uuid,
  p_before_photo_path text DEFAULT NULL
)
RETURNS TABLE (
  order_id uuid,
  ticket_code text,
  order_type text,
  status text,
  already_approved boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_quote public.quote_requests%ROWTYPE;
  v_existing_order RECORD;
  v_tenant_prefix text;
  v_yymm text;
  v_seq integer;
  v_ticket_code text;
  v_customer_id uuid;
  v_customer_email text;
  v_effective_email text;
  v_order_id uuid;
  v_initial_status text := 'received';
  v_estimated_date date;
  v_pin_summary text;
  v_composed_notes text;
  v_notes_parts text[] := ARRAY[]::text[];
  v_item jsonb;
  v_item_idx integer := 0;
  v_safe_before_path text := NULL;
  v_expected_prefix text;
BEGIN
  IF p_tenant_id IS NULL OR p_approval_token IS NULL OR btrim(p_approval_token) = '' THEN
    RAISE EXCEPTION 'Token persetujuan quote tidak valid.';
  END IF;

  SELECT *
  INTO v_quote
  FROM public.quote_requests qr
  WHERE qr.tenant_id = p_tenant_id
    AND qr.approval_token = btrim(p_approval_token)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote tidak ditemukan.';
  END IF;

  IF v_quote.status = 'approved' AND v_quote.converted_order_id IS NOT NULL THEN
    SELECT o.id, o.ticket_code::text AS ticket_code, o.order_type::text AS order_type, o.status::text AS status
    INTO v_existing_order
    FROM public.orders o
    WHERE o.tenant_id = p_tenant_id
      AND o.id = v_quote.converted_order_id;

    IF FOUND THEN
      RETURN QUERY SELECT v_existing_order.id, v_existing_order.ticket_code, v_existing_order.order_type, v_existing_order.status, true;
      RETURN;
    END IF;
  END IF;

  IF v_quote.status <> 'quoted' THEN
    RAISE EXCEPTION 'Quote belum siap disetujui atau sudah diproses (status: %).', v_quote.status;
  END IF;

  IF v_quote.quoted_items IS NULL OR jsonb_typeof(v_quote.quoted_items) <> 'array' OR jsonb_array_length(v_quote.quoted_items) = 0 THEN
    RAISE EXCEPTION 'Rincian item estimasi belum tersedia.';
  END IF;

  v_order_id := COALESCE(p_new_order_id, gen_random_uuid());

  IF p_before_photo_path IS NOT NULL AND btrim(p_before_photo_path) <> '' THEN
    v_expected_prefix := p_tenant_id::text || '/' || v_order_id::text || '/';
    IF left(btrim(p_before_photo_path), length(v_expected_prefix)) = v_expected_prefix THEN
      v_safe_before_path := btrim(p_before_photo_path);
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('quote_ticket:' || p_tenant_id::text, 0));

  SELECT COALESCE(NULLIF(upper(btrim(t.ticket_prefix)), ''), 'MND')
  INTO v_tenant_prefix
  FROM public.tenants t
  WHERE t.id = p_tenant_id
    AND t.is_active = true;

  IF v_tenant_prefix IS NULL THEN
    RAISE EXCEPTION 'Workshop tidak aktif atau tidak ditemukan.';
  END IF;

  v_yymm := to_char(now(), 'YYMM');

  SELECT count(*)::integer + 1
  INTO v_seq
  FROM public.orders o
  WHERE o.tenant_id = p_tenant_id
    AND o.ticket_code LIKE (v_tenant_prefix || '-' || v_yymm || '-%');

  LOOP
    v_ticket_code := v_tenant_prefix || '-' || v_yymm || '-' || lpad(v_seq::text, 3, '0');
    EXIT WHEN NOT EXISTS (
      SELECT 1
      FROM public.orders o
      WHERE o.tenant_id = p_tenant_id
        AND o.ticket_code = v_ticket_code
    );
    v_seq := v_seq + 1;
  END LOOP;

  INSERT INTO public.customers (tenant_id, name, phone, email)
  VALUES (p_tenant_id, btrim(v_quote.customer_name), btrim(v_quote.customer_phone), v_quote.customer_email)
  ON CONFLICT (tenant_id, phone) DO NOTHING
  RETURNING id, email INTO v_customer_id, v_customer_email;

  IF v_customer_id IS NULL THEN
    SELECT c.id, c.email
    INTO v_customer_id, v_customer_email
    FROM public.customers c
    WHERE c.tenant_id = p_tenant_id
      AND c.phone = btrim(v_quote.customer_phone);

    IF v_customer_id IS NOT NULL AND v_customer_email IS NULL AND v_quote.customer_email IS NOT NULL THEN
      UPDATE public.customers
      SET email = v_quote.customer_email,
          updated_at = now()
      WHERE id = v_customer_id
        AND tenant_id = p_tenant_id
        AND email IS NULL;
      v_customer_email := v_quote.customer_email;
    END IF;
  END IF;

  v_effective_email := COALESCE(v_quote.customer_email, v_customer_email);
  v_initial_status := 'received';

  v_estimated_date := COALESCE(
    v_quote.estimated_done_date,
    CASE
      WHEN v_quote.estimated_days IS NOT NULL AND v_quote.estimated_days > 0
      THEN (CURRENT_DATE + v_quote.estimated_days)
      ELSE NULL
    END
  );

  v_notes_parts := array_append(v_notes_parts, '[Quote ' || v_quote.quote_code || ']');

  SELECT string_agg(
    'Pin #' || COALESCE(NULLIF(elem->>'id', ''), ordinality::text) || ': ' || btrim(COALESCE(elem->>'note', '')),
    '; '
    ORDER BY ordinality
  )
  INTO v_pin_summary
  FROM jsonb_array_elements(COALESCE(v_quote.damage_pins, '[]'::jsonb)) WITH ORDINALITY AS t(elem, ordinality)
  WHERE btrim(COALESCE(elem->>'note', '')) <> '';

  IF v_pin_summary IS NOT NULL AND btrim(v_pin_summary) <> '' THEN
    v_notes_parts := array_append(v_notes_parts, v_pin_summary);
  END IF;
  IF v_quote.customer_notes IS NOT NULL AND btrim(v_quote.customer_notes) <> '' THEN
    v_notes_parts := array_append(v_notes_parts, 'Catatan pelanggan: ' || btrim(v_quote.customer_notes));
  END IF;
  IF v_quote.workshop_notes IS NOT NULL AND btrim(v_quote.workshop_notes) <> '' THEN
    v_notes_parts := array_append(v_notes_parts, 'Catatan workshop: ' || btrim(v_quote.workshop_notes));
  END IF;
  v_composed_notes := array_to_string(v_notes_parts, ' | ');

  INSERT INTO public.orders (
    id,
    tenant_id,
    ticket_code,
    customer_id,
    customer_name,
    customer_phone,
    customer_email,
    status,
    estimated_done_date,
    notes,
    paid_amount,
    payment_status,
    order_type,
    source_quote_id
  )
  VALUES (
    v_order_id,
    p_tenant_id,
    v_ticket_code,
    v_customer_id,
    btrim(v_quote.customer_name),
    btrim(v_quote.customer_phone),
    v_effective_email,
    v_initial_status,
    v_estimated_date,
    NULLIF(btrim(v_composed_notes), ''),
    0,
    'unpaid',
    v_quote.order_type,
    v_quote.id
  );

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_quote.quoted_items) LOOP
    v_item_idx := v_item_idx + 1;
    INSERT INTO public.order_items (
      tenant_id,
      order_id,
      garment_name,
      service_type,
      measurement_specs,
      price,
      before_photo_path,
      after_photo_path
    )
    VALUES (
      p_tenant_id,
      v_order_id,
      COALESCE(NULLIF(btrim(COALESCE(v_item->>'garment_name', '')), ''), v_quote.garment_name),
      COALESCE(NULLIF(btrim(COALESCE(v_item->>'service_type', '')), ''), COALESCE(v_quote.requested_service, 'Reparasi')),
      CASE
        WHEN jsonb_typeof(v_item->'measurement_specs') = 'object' THEN v_item->'measurement_specs'
        ELSE '{}'::jsonb
      END,
      GREATEST(0, COALESCE(NULLIF(v_item->>'price', '')::numeric, 0)),
      CASE WHEN v_item_idx = 1 THEN v_safe_before_path ELSE NULL END,
      NULL
    );
  END LOOP;

  INSERT INTO public.order_logs (tenant_id, order_id, status, log_note)
  VALUES (
    p_tenant_id,
    v_order_id,
    v_initial_status,
    'Order dibuat otomatis dari persetujuan quote ' || v_quote.quote_code
  );

  UPDATE public.quote_requests
  SET status = 'approved',
      converted_order_id = v_order_id,
      decided_at = now(),
      updated_at = now()
  WHERE id = v_quote.id
    AND tenant_id = p_tenant_id;

  RETURN QUERY SELECT v_order_id, v_ticket_code, v_quote.order_type, v_initial_status, false;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_quote_to_order(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_quote_to_order(uuid, text, uuid, text) TO service_role;

COMMIT;
