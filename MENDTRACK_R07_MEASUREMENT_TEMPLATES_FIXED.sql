-- MendTrack R0.7 - Customer Measurement Templates
-- Basis: MendTrack R0.6 Customer Directory
-- Assumptions from R0.6 source:
--   public.customers exists; JS reads id, name, phone, created_at, updated_at.
--   Customer IDs are UUIDs.
--   R0.6 is not yet multi-tenant; policies below follow its authenticated-user access model.
-- This migration does not alter orders, order_items, or existing measurement_specs.

begin;

-- 1) Template master: one template per garment type (e.g. Celana, Jaket, Rok).
create table if not exists public.measurement_templates (
  id uuid primary key default gen_random_uuid(),
  garment_type text not null,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint measurement_templates_garment_type_key unique (garment_type),
  constraint measurement_templates_garment_type_not_blank check (length(btrim(garment_type)) > 0)
);

-- 2) Configurable fields for each template.
create table if not exists public.measurement_template_fields (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.measurement_templates(id) on delete cascade,
  field_key text not null,
  field_label text not null,
  unit text not null default 'cm',
  is_required boolean not null default false,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint measurement_template_fields_key_unique unique (template_id, field_key),
  constraint measurement_template_fields_key_not_blank check (length(btrim(field_key)) > 0),
  constraint measurement_template_fields_label_not_blank check (length(btrim(field_label)) > 0)
);

create index if not exists idx_measurement_template_fields_template_sort
  on public.measurement_template_fields (template_id, sort_order);

-- 3) Customer's saved measurement collections.
-- measurement_data stores different keys for each garment type as JSONB.
-- template_snapshot preserves the field definitions used when this record was saved,
-- so later template edits do not change the meaning of old measurements.
create table if not exists public.customer_measurements (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  template_id uuid references public.measurement_templates(id) on delete set null,
  garment_type text not null,
  model text,
  description text,
  measurement_data jsonb not null default '{}'::jsonb,
  template_snapshot jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_measurements_garment_type_not_blank check (length(btrim(garment_type)) > 0),
  constraint customer_measurements_data_object check (jsonb_typeof(measurement_data) = 'object'),
  constraint customer_measurements_snapshot_array check (jsonb_typeof(template_snapshot) = 'array')
);

create index if not exists idx_customer_measurements_customer_created
  on public.customer_measurements (customer_id, created_at desc);
create index if not exists idx_customer_measurements_type
  on public.customer_measurements (customer_id, garment_type);

-- 4) updated_at helper trigger.
create or replace function public.set_measurement_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_measurement_templates_updated_at on public.measurement_templates;
create trigger trg_measurement_templates_updated_at
before update on public.measurement_templates
for each row execute function public.set_measurement_updated_at();

drop trigger if exists trg_customer_measurements_updated_at on public.customer_measurements;
create trigger trg_customer_measurements_updated_at
before update on public.customer_measurements
for each row execute function public.set_measurement_updated_at();

-- 5) Enable RLS. This matches R0.6's authenticated access model.
-- NOTE: R0.6 README explicitly says multi-tenant isolation is not implemented.
alter table public.measurement_templates enable row level security;
alter table public.measurement_template_fields enable row level security;
alter table public.customer_measurements enable row level security;

drop policy if exists "Authenticated users can manage measurement templates" on public.measurement_templates;
create policy "Authenticated users can manage measurement templates"
  on public.measurement_templates for all to authenticated
  using (auth.uid() is not null)
  with check (auth.uid() is not null);

drop policy if exists "Authenticated users can manage measurement template fields" on public.measurement_template_fields;
create policy "Authenticated users can manage measurement template fields"
  on public.measurement_template_fields for all to authenticated
  using (auth.uid() is not null)
  with check (auth.uid() is not null);

drop policy if exists "Authenticated users can manage customer measurements" on public.customer_measurements;
create policy "Authenticated users can manage customer measurements"
  on public.customer_measurements for all to authenticated
  using (auth.uid() is not null)
  with check (auth.uid() is not null);

grant select, insert, update, delete on public.measurement_templates to authenticated;
grant select, insert, update, delete on public.measurement_template_fields to authenticated;
grant select, insert, update, delete on public.customer_measurements to authenticated;

-- 6) Seed starter templates. Safe to run again.
insert into public.measurement_templates (garment_type, description)
values
  ('Celana', 'Template ukuran celana'),
  ('Jaket', 'Template ukuran jaket'),
  ('Rok', 'Template ukuran rok'),
  ('Lainnya', 'Template fleksibel; komponen dapat ditambahkan sendiri')
on conflict (garment_type) do nothing;

-- Celana starter fields
with seed_fields(field_key, field_label, sort_order) as (
  values
    ('waist_circumference', 'Lingkar pinggang', 1),
    ('hip_circumference', 'Lingkar pinggul', 2),
    ('thigh_circumference', 'Lingkar paha', 3),
    ('trouser_length', 'Panjang celana', 4),
    ('leg_opening', 'Bukaan kaki', 5)
)
insert into public.measurement_template_fields
  (template_id, field_key, field_label, unit, is_required, sort_order)
select
  t.id,
  seed_fields.field_key,
  seed_fields.field_label,
  'cm',
  true,
  seed_fields.sort_order
from public.measurement_templates as t
cross join seed_fields
where t.garment_type = 'Celana'
on conflict (template_id, field_key) do nothing;

-- Jaket starter fields
with seed_fields(field_key, field_label, sort_order) as (
  values
    ('shoulder_width', 'Lebar bahu', 1),
    ('chest_circumference', 'Lingkar dada', 2),
    ('body_length', 'Panjang badan', 3),
    ('sleeve_length', 'Panjang lengan', 4),
    ('upper_arm_circumference', 'Lingkar lengan', 5),
    ('bottom_circumference', 'Lingkar bawah', 6)
)
insert into public.measurement_template_fields
  (template_id, field_key, field_label, unit, is_required, sort_order)
select
  t.id,
  seed_fields.field_key,
  seed_fields.field_label,
  'cm',
  true,
  seed_fields.sort_order
from public.measurement_templates as t
cross join seed_fields
where t.garment_type = 'Jaket'
on conflict (template_id, field_key) do nothing;

-- Rok starter fields
with seed_fields(field_key, field_label, sort_order) as (
  values
    ('waist_circumference', 'Lingkar pinggang', 1),
    ('hip_circumference', 'Lingkar pinggul', 2),
    ('skirt_length', 'Panjang rok', 3),
    ('bottom_width', 'Lebar bawah', 4)
)
insert into public.measurement_template_fields
  (template_id, field_key, field_label, unit, is_required, sort_order)
select
  t.id,
  seed_fields.field_key,
  seed_fields.field_label,
  'cm',
  true,
  seed_fields.sort_order
from public.measurement_templates as t
cross join seed_fields
where t.garment_type = 'Rok'
on conflict (template_id, field_key) do nothing;

commit;

-- Example read queries:
-- List templates and their fields:
-- select t.garment_type, f.field_key, f.field_label, f.unit, f.is_required, f.sort_order
-- from public.measurement_templates t
-- left join public.measurement_template_fields f on f.template_id = t.id and f.is_active
-- where t.is_active
-- order by t.garment_type, f.sort_order;
--
-- Example saved measurement_data for a pair of trousers:
-- {"waist_circumference":82,"hip_circumference":98,"thigh_circumference":58,"trouser_length":102,"leg_opening":18}
