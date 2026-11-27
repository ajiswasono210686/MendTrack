-- Workflow Simplification & Unified Filter Migration (Additive, Backward-Compatible)
-- Target Supabase project: mendtrack_dev (ncobbhceczfpxosgszwz)
--
-- Summary:
--   1. Standardize active orders onto the 4-stage universal workflow:
--        received -> in_progress (with optional customizable sub-tasks in public.workstations) -> ready -> completed
--      while preserving existing CHECK constraints so historical rows and order_logs never break.
--   2. Migrate any active legacy orders in 'awaiting_package'/'queued' -> 'received' and 'qc' -> 'in_progress'.
--   3. Update public.save_order_with_items (15-arg) and public.approve_quote_to_order (4-arg) so all new
--      walk-in and mail-in orders start at 'received'.
--   4. Update public.advance_order_production_status so Staff transitions forward cleanly:
--        received -> in_progress -> ready (with backward-compatible fallbacks for legacy queued/qc rows).

BEGIN;

-- 1. Safely migrate any active orders still sitting in legacy intermediate statuses
UPDATE public.orders
SET status = 'received',
    updated_at = now()
WHERE status IN ('awaiting_package', 'queued');

UPDATE public.orders
SET status = 'in_progress',
    updated_at = now()
WHERE status = 'qc';

-- 2. Update public.save_order_with_items (keep exact 15-arg signature; all new orders start at 'received')
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

-- 3. Update public.approve_quote_to_order (service_role only; converted orders start at 'received')
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

  INSERT INTO public.customers (tenant_id, name, phone)
  VALUES (p_tenant_id, btrim(v_quote.customer_name), btrim(v_quote.customer_phone))
  ON CONFLICT (tenant_id, phone) DO NOTHING
  RETURNING id INTO v_customer_id;

  IF v_customer_id IS NULL THEN
    SELECT c.id
    INTO v_customer_id
    FROM public.customers c
    WHERE c.tenant_id = p_tenant_id
      AND c.phone = btrim(v_quote.customer_phone);
  END IF;

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

-- 4. Update public.advance_order_production_status (Staff moves received -> in_progress -> ready)
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
    (v_order.status IN ('received', 'queued', 'awaiting_package') AND v_next = 'in_progress')
    OR (v_order.status IN ('in_progress', 'qc') AND v_next = 'ready')
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

REVOKE ALL ON FUNCTION public.advance_order_production_status(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.advance_order_production_status(uuid, uuid, text) TO authenticated, service_role;

COMMIT;
