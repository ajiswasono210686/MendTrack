-- MendTrack Stage 4: Visual Repair Intake, Quote Approval & Hybrid Service Pricing
-- Target project : mendtrack_dev (ncobbhceczfpxosgszwz)
-- DO NOT RUN on legacy production project mendtrack (zurtrvuyigwtmyfvrelb).
--
-- Purely additive & idempotent (zero DROP/DELETE):
--   1. Optional public.services.base_price (numeric(14, 2) NOT NULL DEFAULT 0).
--   2. Tenant-isolated public.quote_requests table with composite keys, indexes,
--      updated_at trigger, and strict RLS (zero anon policies).
--   3. Nullable public.orders.source_quote_id composite FK (ON DELETE SET NULL).
--   4. service_role-only atomic idempotent RPC public.approve_quote_to_order.

BEGIN;

-- 1. Hybrid Service Pricing: optional base_price on public.services
ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS base_price numeric(14, 2) NOT NULL DEFAULT 0;

UPDATE public.services
SET base_price = 0
WHERE base_price IS NULL OR base_price < 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'services_base_price_non_negative'
      AND conrelid = 'public.services'::regclass
  ) THEN
    ALTER TABLE public.services
      ADD CONSTRAINT services_base_price_non_negative
      CHECK (base_price >= 0);
  END IF;
END;
$$;

COMMENT ON COLUMN public.services.base_price IS
  'Harga patokan / mulai dari opsional dalam mata uang aktif workshop (0 = harga dinamis).';

-- 2. Visual Repair Intake & Quote Requests (`public.quote_requests`)
CREATE TABLE IF NOT EXISTS public.quote_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  quote_code text NOT NULL,
  approval_token text NOT NULL,
  status text NOT NULL DEFAULT 'new',
  customer_name text NOT NULL,
  customer_phone text NOT NULL,
  order_type text NOT NULL DEFAULT 'walk_in',
  garment_name text NOT NULL,
  requested_service text,
  customer_notes text,
  intake_photo_path text NOT NULL,
  damage_pins jsonb NOT NULL DEFAULT '[]'::jsonb,
  quoted_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  quoted_total numeric(14, 2) NOT NULL DEFAULT 0,
  estimated_days integer,
  estimated_done_date date,
  workshop_notes text,
  customer_decision_note text,
  quoted_at timestamptz,
  decided_at timestamptz,
  converted_order_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quote_requests_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT quote_requests_tenant_code_key UNIQUE (tenant_id, quote_code),
  CONSTRAINT quote_requests_token_key UNIQUE (approval_token),
  CONSTRAINT quote_requests_tenant_order_fkey
    FOREIGN KEY (tenant_id, converted_order_id)
    REFERENCES public.orders(tenant_id, id)
    ON DELETE SET NULL (converted_order_id),
  CONSTRAINT quote_requests_code_not_blank CHECK (length(btrim(quote_code)) > 0),
  CONSTRAINT quote_requests_token_length CHECK (length(btrim(approval_token)) >= 32),
  CONSTRAINT quote_requests_status_check CHECK (
    status IN ('new', 'quoted', 'revision_requested', 'approved', 'rejected')
  ),
  CONSTRAINT quote_requests_customer_name_not_blank CHECK (length(btrim(customer_name)) > 0),
  CONSTRAINT quote_requests_customer_phone_len CHECK (length(btrim(customer_phone)) >= 10),
  CONSTRAINT quote_requests_order_type_check CHECK (order_type IN ('walk_in', 'mail_in')),
  CONSTRAINT quote_requests_garment_name_not_blank CHECK (length(btrim(garment_name)) > 0),
  CONSTRAINT quote_requests_intake_photo_prefix_check CHECK (
    left(intake_photo_path, length(tenant_id::text || '/quotes/' || id::text || '/'))
      = (tenant_id::text || '/quotes/' || id::text || '/')
  ),
  CONSTRAINT quote_requests_damage_pins_array CHECK (jsonb_typeof(damage_pins) = 'array'),
  CONSTRAINT quote_requests_quoted_items_array CHECK (jsonb_typeof(quoted_items) = 'array'),
  CONSTRAINT quote_requests_quoted_total_non_negative CHECK (quoted_total >= 0),
  CONSTRAINT quote_requests_estimated_days_positive CHECK (
    estimated_days IS NULL OR estimated_days > 0
  )
);

COMMENT ON TABLE public.quote_requests IS
  'Permintaan estimasi visual (Visual Repair Intake) dan persetujuan quote online per tenant.';

CREATE INDEX IF NOT EXISTS idx_quote_requests_tenant_status_created
  ON public.quote_requests (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_quote_requests_tenant_phone_created
  ON public.quote_requests (tenant_id, customer_phone, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_quote_requests_tenant_token
  ON public.quote_requests (tenant_id, approval_token);

CREATE UNIQUE INDEX IF NOT EXISTS uq_quote_requests_converted_order
  ON public.quote_requests (tenant_id, converted_order_id)
  WHERE converted_order_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.fn_set_quote_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_quote_requests_updated_at'
      AND tgrelid = 'public.quote_requests'::regclass
  ) THEN
    CREATE TRIGGER trg_quote_requests_updated_at
      BEFORE UPDATE ON public.quote_requests
      FOR EACH ROW EXECUTE FUNCTION public.fn_set_quote_updated_at();
  END IF;
END;
$$;

-- Strict RLS on public.quote_requests (zero anon access)
ALTER TABLE public.quote_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.quote_requests FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.quote_requests TO authenticated, service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'quote_requests' AND policyname = 'quote_requests_tenant_select'
  ) THEN
    CREATE POLICY "quote_requests_tenant_select"
      ON public.quote_requests
      FOR SELECT
      TO authenticated
      USING ((SELECT private.is_verified_tenant_member(tenant_id)));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'quote_requests' AND policyname = 'quote_requests_tenant_insert'
  ) THEN
    CREATE POLICY "quote_requests_tenant_insert"
      ON public.quote_requests
      FOR INSERT
      TO authenticated
      WITH CHECK ((SELECT private.is_verified_tenant_member(tenant_id)));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'quote_requests' AND policyname = 'quote_requests_tenant_update'
  ) THEN
    CREATE POLICY "quote_requests_tenant_update"
      ON public.quote_requests
      FOR UPDATE
      TO authenticated
      USING ((SELECT private.is_verified_tenant_member(tenant_id)))
      WITH CHECK ((SELECT private.is_verified_tenant_member(tenant_id)));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'quote_requests' AND policyname = 'quote_requests_tenant_delete'
  ) THEN
    CREATE POLICY "quote_requests_tenant_delete"
      ON public.quote_requests
      FOR DELETE
      TO authenticated
      USING ((SELECT private.is_verified_tenant_member(tenant_id)));
  END IF;
END;
$$;

-- 3. Link back from public.orders -> public.quote_requests (nullable, safe on delete)
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS source_quote_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'orders_tenant_source_quote_fkey'
      AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_tenant_source_quote_fkey
      FOREIGN KEY (tenant_id, source_quote_id)
      REFERENCES public.quote_requests(tenant_id, id)
      ON DELETE SET NULL (source_quote_id);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_orders_tenant_source_quote
  ON public.orders (tenant_id, source_quote_id)
  WHERE source_quote_id IS NOT NULL;

COMMENT ON COLUMN public.orders.source_quote_id IS
  'Referensi opsional ke public.quote_requests jika order berasal dari persetujuan quote online.';

-- 4. Atomic Idempotent Quote-to-Order RPC (service_role only)
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
  v_initial_status text;
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

  -- Idempotent return if this quote was already approved and converted.
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

  -- Validate optional promoted before photo path matches strict <tenant_id>/<order_id>/ prefix.
  IF p_before_photo_path IS NOT NULL AND btrim(p_before_photo_path) <> '' THEN
    v_expected_prefix := p_tenant_id::text || '/' || v_order_id::text || '/';
    IF left(btrim(p_before_photo_path), length(v_expected_prefix)) = v_expected_prefix THEN
      v_safe_before_path := btrim(p_before_photo_path);
    END IF;
  END IF;

  -- Serialize ticket sequence allocation per tenant to prevent collisions.
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

  -- Upsert customer by (tenant_id, normalized_phone).
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

  v_initial_status := CASE
    WHEN v_quote.order_type = 'mail_in' THEN 'awaiting_package'
    ELSE 'received'
  END;

  v_estimated_date := COALESCE(
    v_quote.estimated_done_date,
    CASE
      WHEN v_quote.estimated_days IS NOT NULL AND v_quote.estimated_days > 0
      THEN (CURRENT_DATE + v_quote.estimated_days)
      ELSE NULL
    END
  );

  -- Compose technician notes from quote reference, pins, customer notes, and workshop notes.
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

COMMIT;

