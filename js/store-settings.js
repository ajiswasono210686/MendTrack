// Tenant-scoped workshop profile and service catalog helpers.
import { supabase } from './supabase-client.js';
import { t, normalizeLocale, normalizeCurrency } from './i18n.js';

export const DEFAULT_STORE_SETTINGS = {
  NAME: 'MendTrack',
  SLUG: '',
  ADDRESS: '',
  ADMIN_PHONE: '',
  TAGLINE: 'Reparasi, Vermak & Custom Pakaian',
  OPENING_HOURS: 'Senin - Sabtu, 09.00 - 17.00',
  LOGO: '',
  DAILY_CAPACITY_MINUTES: 480,
  LOCALE: 'id',
  CURRENCY: 'IDR',
  TIMEZONE: 'Asia/Jakarta',
  TICKET_PREFIX: 'MND',
};

const TENANT_COLUMNS =
  'id,slug,name,address,admin_phone,tagline,opening_hours,logo_data_url,daily_capacity_minutes,locale,currency,timezone,ticket_prefix';

export function mapTenantToSettings(data) {
  if (!data) return { ...DEFAULT_STORE_SETTINGS };
  return {
    NAME: data.name || DEFAULT_STORE_SETTINGS.NAME,
    SLUG: data.slug || '',
    ADDRESS: data.address || '',
    ADMIN_PHONE: data.admin_phone || '',
    TAGLINE: data.tagline || '',
    OPENING_HOURS: data.opening_hours || '',
    LOGO: /^data:image\/(?:png|jpeg|webp);base64,/.test(data.logo_data_url || '') ? data.logo_data_url : '',
    DAILY_CAPACITY_MINUTES:
      Number.isInteger(data.daily_capacity_minutes) && data.daily_capacity_minutes > 0
        ? data.daily_capacity_minutes
        : DEFAULT_STORE_SETTINGS.DAILY_CAPACITY_MINUTES,
    LOCALE: normalizeLocale(data.locale || DEFAULT_STORE_SETTINGS.LOCALE),
    CURRENCY: normalizeCurrency(data.currency || DEFAULT_STORE_SETTINGS.CURRENCY),
    TIMEZONE: String(data.timezone || DEFAULT_STORE_SETTINGS.TIMEZONE).trim() || DEFAULT_STORE_SETTINGS.TIMEZONE,
    TICKET_PREFIX:
      String(data.ticket_prefix || DEFAULT_STORE_SETTINGS.TICKET_PREFIX)
        .trim()
        .toUpperCase() || DEFAULT_STORE_SETTINGS.TICKET_PREFIX,
  };
}

export async function fetchStoreSettings(tenantId) {
  if (!tenantId) return { ...DEFAULT_STORE_SETTINGS };
  const { data, error } = await supabase
    .from('tenants')
    .select(TENANT_COLUMNS)
    .eq('id', tenantId)
    .maybeSingle();
  if (error) throw error;
  return mapTenantToSettings(data);
}

export async function persistStoreSettings(tenantId, s) {
  if (!tenantId) throw new Error(t('common.noActiveTenant'));
  const payload = {
    name: s.NAME,
    address: s.ADDRESS,
    admin_phone: s.ADMIN_PHONE,
    tagline: s.TAGLINE,
    opening_hours: s.OPENING_HOURS,
    logo_data_url: s.LOGO || null,
    daily_capacity_minutes: s.DAILY_CAPACITY_MINUTES,
    locale: normalizeLocale(s.LOCALE || DEFAULT_STORE_SETTINGS.LOCALE),
    currency: normalizeCurrency(s.CURRENCY || DEFAULT_STORE_SETTINGS.CURRENCY),
    timezone: String(s.TIMEZONE || DEFAULT_STORE_SETTINGS.TIMEZONE).trim() || DEFAULT_STORE_SETTINGS.TIMEZONE,
    ticket_prefix:
      String(s.TICKET_PREFIX || DEFAULT_STORE_SETTINGS.TICKET_PREFIX)
        .trim()
        .toUpperCase() || DEFAULT_STORE_SETTINGS.TICKET_PREFIX,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('tenants').update(payload).eq('id', tenantId);
  if (error) throw error;
}

export function applyStoreIdentity(doc, settings) {
  doc.querySelectorAll('[data-store-name]').forEach((el) => {
    el.textContent = settings.NAME;
  });
  doc.querySelectorAll('[data-store-address]').forEach((el) => {
    el.textContent = settings.ADDRESS;
  });
  doc.querySelectorAll('[data-store-tagline]').forEach((el) => {
    el.textContent = settings.TAGLINE;
  });
  doc.querySelectorAll('[data-store-hours]').forEach((el) => {
    el.textContent = settings.OPENING_HOURS;
  });
  doc.querySelectorAll('[data-store-phone]').forEach((el) => {
    el.textContent = settings.ADMIN_PHONE;
  });
  doc.querySelectorAll('[data-store-logo]').forEach((el) => {
    if (settings.LOGO) {
      el.innerHTML = '';
      const img = doc.createElement('img');
      img.src = settings.LOGO;
      img.alt = t('common.logoAlt', { name: settings.NAME });
      img.width = 40;
      img.height = 40;
      img.className = 'w-full h-full object-contain';
      el.appendChild(img);
    } else {
      el.innerHTML = '<i data-lucide="scissors" class="w-5 h-5" aria-hidden="true"></i>';
    }
  });
  doc.title = t('tracker.titleStore', { name: settings.NAME });
  if (window.lucide) window.lucide.createIcons();
}

// Soft-disable only; historical orders keep their copied service names.
export async function fetchServices(tenantId) {
  if (!tenantId) return [];
  const { data, error } = await supabase
    .from('services')
    .select('id,tenant_id,name,estimated_minutes,service_category,base_price,is_active,sort_order')
    .eq('tenant_id', tenantId)
    .order('sort_order')
    .order('name');
  if (error) throw error;
  return (data || []).map((svc) => ({
    ...svc,
    base_price: Math.max(0, Number(svc.base_price || 0)),
  }));
}

export async function createService(
  tenantId,
  name,
  estimatedMinutes,
  serviceCategory = 'reparasi',
  basePrice = 0
) {
  if (!tenantId) throw new Error(t('common.noActiveTenant'));
  const category = serviceCategory === 'custom' ? 'custom' : 'reparasi';
  const safePrice = Number.isFinite(Number(basePrice)) && Number(basePrice) > 0 ? Number(basePrice) : 0;
  const { data, error } = await supabase
    .from('services')
    .insert({
      tenant_id: tenantId,
      name,
      estimated_minutes: estimatedMinutes,
      service_category: category,
      base_price: safePrice,
      is_active: true,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateService(
  tenantId,
  id,
  name,
  estimatedMinutes,
  serviceCategory = 'reparasi',
  basePrice = 0
) {
  if (!tenantId) throw new Error(t('common.noActiveTenant'));
  const category = serviceCategory === 'custom' ? 'custom' : 'reparasi';
  const safePrice = Number.isFinite(Number(basePrice)) && Number(basePrice) > 0 ? Number(basePrice) : 0;
  const { error } = await supabase
    .from('services')
    .update({
      name,
      estimated_minutes: estimatedMinutes,
      service_category: category,
      base_price: safePrice,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('tenant_id', tenantId);
  if (error) throw error;
}

export async function deactivateService(tenantId, id) {
  if (!tenantId) throw new Error(t('common.noActiveTenant'));
  const { error } = await supabase
    .from('services')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenantId);
  if (error) throw error;
}

export async function activateService(tenantId, id) {
  if (!tenantId) throw new Error(t('common.noActiveTenant'));
  const { error } = await supabase
    .from('services')
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenantId);
  if (error) throw error;
}

export async function fetchWorkstations(tenantId) {
  if (!tenantId) return [];
  const { data, error } = await supabase
    .from('workstations')
    .select('id,tenant_id,name,sort_order,is_active')
    .eq('tenant_id', tenantId)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function createWorkstation(tenantId, name, sortOrder = 0) {
  if (!tenantId) throw new Error(t('common.noActiveTenant'));
  const { data, error } = await supabase
    .from('workstations')
    .insert({
      tenant_id: tenantId,
      name: String(name || '').trim(),
      sort_order: Number.isInteger(sortOrder) ? sortOrder : 0,
      is_active: true,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateWorkstation(tenantId, id, fields) {
  if (!tenantId) throw new Error(t('common.noActiveTenant'));
  const payload = {
    updated_at: new Date().toISOString(),
  };
  if (typeof fields.name === 'string') payload.name = fields.name.trim();
  if (typeof fields.is_active === 'boolean') payload.is_active = fields.is_active;
  if (Number.isInteger(fields.sort_order)) payload.sort_order = fields.sort_order;
  const { error } = await supabase
    .from('workstations')
    .update(payload)
    .eq('id', id)
    .eq('tenant_id', tenantId);
  if (error) throw error;
}
