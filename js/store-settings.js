// Shared store profile: public read, authenticated admin update via Supabase.
import { WORKSHOP_INFO } from './config.js';
import { supabase } from './supabase-client.js';

export const DEFAULT_STORE_SETTINGS = {
  NAME: WORKSHOP_INFO.NAME,
  ADDRESS: WORKSHOP_INFO.ADDRESS,
  ADMIN_PHONE: WORKSHOP_INFO.ADMIN_PHONE,
  TAGLINE: 'RAW AUTHENTIC DURABLE',
  OPENING_HOURS: 'Senin–Sabtu, 09.00–17.00',
  LOGO: '',
  DAILY_CAPACITY_MINUTES: 480,
};
const columns = 'name,address,admin_phone,tagline,opening_hours,logo_data_url,daily_capacity_minutes';
export async function fetchStoreSettings() {
  const { data, error } = await supabase.from('store_settings').select(columns).eq('id', 1).maybeSingle();
  if (error) throw error;
  if (!data) return { ...DEFAULT_STORE_SETTINGS };
  return {
    NAME: data.name || DEFAULT_STORE_SETTINGS.NAME,
    ADDRESS: data.address || '',
    ADMIN_PHONE: data.admin_phone || '',
    TAGLINE: data.tagline || '',
    OPENING_HOURS: data.opening_hours || '',
    LOGO: /^data:image\/(?:png|jpeg|webp);base64,/.test(data.logo_data_url || '') ? data.logo_data_url : '',
    DAILY_CAPACITY_MINUTES: Number.isInteger(data.daily_capacity_minutes) && data.daily_capacity_minutes > 0 ? data.daily_capacity_minutes : DEFAULT_STORE_SETTINGS.DAILY_CAPACITY_MINUTES,
  };
}
export async function persistStoreSettings(s) {
  const payload = {
    id: 1, name: s.NAME, address: s.ADDRESS, admin_phone: s.ADMIN_PHONE,
    tagline: s.TAGLINE, opening_hours: s.OPENING_HOURS,
    logo_data_url: s.LOGO || null, daily_capacity_minutes: s.DAILY_CAPACITY_MINUTES, updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('store_settings').upsert(payload, { onConflict: 'id' });
  if (error) throw error;
}
export function applyStoreIdentity(doc, settings) {
  doc.querySelectorAll('[data-store-name]').forEach(el => { el.textContent = settings.NAME; });
  doc.querySelectorAll('[data-store-address]').forEach(el => { el.textContent = settings.ADDRESS; });
  doc.querySelectorAll('[data-store-tagline]').forEach(el => { el.textContent = settings.TAGLINE; });
  doc.querySelectorAll('[data-store-hours]').forEach(el => { el.textContent = settings.OPENING_HOURS; });
  doc.querySelectorAll('[data-store-phone]').forEach(el => { el.textContent = settings.ADMIN_PHONE; });
  doc.querySelectorAll('[data-store-logo]').forEach(el => {
    if (settings.LOGO) {
      el.innerHTML = '';
      const img = doc.createElement('img');
      img.src = settings.LOGO; img.alt = 'Logo toko';
      img.className = 'w-full h-full object-contain'; el.appendChild(img);
    } else {
      el.innerHTML = '<i data-lucide="scissors" class="w-5 h-5"></i>';
    }
  });
  doc.title = settings.NAME + ' — MendTrack';
  if (window.lucide) window.lucide.createIcons();
}

// Service catalog: soft-disable only; historical orders keep their copied values.
export async function fetchServices() {
  const { data, error } = await supabase.from('services').select('id,name,estimated_minutes,is_active,sort_order').order('sort_order').order('name');
  if (error) throw error;
  return data || [];
}
export async function createService(name, estimatedMinutes) {
  const { data, error } = await supabase.from('services').insert({ name, estimated_minutes: estimatedMinutes, is_active: true }).select().single();
  if (error) throw error; return data;
}
export async function updateService(id, name, estimatedMinutes) {
  const { error } = await supabase.from('services').update({ name, estimated_minutes: estimatedMinutes, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}
export async function deactivateService(id) {
  const { error } = await supabase.from('services').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

export async function activateService(id) {
  const { error } = await supabase.from('services')
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}
