-- MendTrack Stage 2: Multi-Language & Multi-Currency Onboarding Migration
-- Target project : mendtrack_dev (ncobbhceczfpxosgszwz)
-- DO NOT RUN on legacy production project mendtrack (zurtrvuyigwtmyfvrelb).
--
-- Non-destructive additive migration:
--   1. Adds ISO-4217 3-letter uppercase format constraint on public.tenants.currency.
--   2. Replaces the 7-arg public.create_tenant_workspace with an 11-arg version
--      accepting optional p_locale, p_currency, p_timezone, and p_ticket_prefix
--      with safe defaults ('id', 'IDR', 'Asia/Jakarta', 'MND').
--   3. Seeds starter measurement templates in Indonesian ('id') or English ('en')
--      using identical canonical field_key identifiers.
--   4. Locks EXECUTE grants on the new 11-arg signature (authenticated, service_role).

BEGIN;

-- Normalize any lowercase currency codes before adding the ISO check constraint.
UPDATE public.tenants
SET currency = upper(btrim(currency))
WHERE currency IS DISTINCT FROM upper(btrim(currency));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tenants_currency_iso_check'
      AND conrelid = 'public.tenants'::regclass
  ) THEN
    ALTER TABLE public.tenants
      ADD CONSTRAINT tenants_currency_iso_check
      CHECK (currency ~ '^[A-Z]{3}$');
  END IF;
END;
$$;

-- Drop the previous 7-argument signature to avoid PostgREST overloaded-function ambiguity.
DROP FUNCTION IF EXISTS public.create_tenant_workspace(
  text, text, text, text, text, text, integer
);

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
    name,
    slug,
    admin_phone,
    address,
    opening_hours,
    tagline,
    daily_capacity_minutes,
    locale,
    currency,
    timezone,
    ticket_prefix
  )
  VALUES (
    v_name,
    v_slug,
    v_phone,
    btrim(COALESCE(p_address, '')),
    btrim(COALESCE(p_opening_hours, '')),
    btrim(COALESCE(p_tagline, '')),
    v_capacity,
    v_locale,
    v_currency,
    v_timezone,
    v_ticket_prefix
  )
  RETURNING * INTO v_tenant;

  INSERT INTO public.tenant_members (tenant_id, user_id, role, is_active)
  VALUES (v_tenant.id, v_user_id, 'owner', true);

  -- Idempotently seed starter measurement templates in the workshop's chosen locale.
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
    SELECT
      v_tenant.id, t.id, sf.field_key, sf.field_label, 'cm', true, sf.sort_order
    FROM public.measurement_templates t
    CROSS JOIN seed_fields sf
    WHERE t.tenant_id = v_tenant.id
      AND t.garment_type = 'Trousers'
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
    SELECT
      v_tenant.id, t.id, sf.field_key, sf.field_label, 'cm', true, sf.sort_order
    FROM public.measurement_templates t
    CROSS JOIN seed_fields sf
    WHERE t.tenant_id = v_tenant.id
      AND t.garment_type = 'Jacket'
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
    SELECT
      v_tenant.id, t.id, sf.field_key, sf.field_label, 'cm', true, sf.sort_order
    FROM public.measurement_templates t
    CROSS JOIN seed_fields sf
    WHERE t.tenant_id = v_tenant.id
      AND t.garment_type = 'Skirt'
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
    SELECT
      v_tenant.id, t.id, sf.field_key, sf.field_label, 'cm', true, sf.sort_order
    FROM public.measurement_templates t
    CROSS JOIN seed_fields sf
    WHERE t.tenant_id = v_tenant.id
      AND t.garment_type = 'Celana'
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
    SELECT
      v_tenant.id, t.id, sf.field_key, sf.field_label, 'cm', true, sf.sort_order
    FROM public.measurement_templates t
    CROSS JOIN seed_fields sf
    WHERE t.tenant_id = v_tenant.id
      AND t.garment_type = 'Jaket'
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
    SELECT
      v_tenant.id, t.id, sf.field_key, sf.field_label, 'cm', true, sf.sort_order
    FROM public.measurement_templates t
    CROSS JOIN seed_fields sf
    WHERE t.tenant_id = v_tenant.id
      AND t.garment_type = 'Rok'
    ON CONFLICT (template_id, field_key) DO NOTHING;
  END IF;

  RETURN v_tenant;
END;
$$;

REVOKE ALL ON FUNCTION public.create_tenant_workspace(
  text, text, text, text, text, text, integer, text, text, text, text
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.create_tenant_workspace(
  text, text, text, text, text, text, integer, text, text, text, text
) TO authenticated, service_role;

COMMIT;
