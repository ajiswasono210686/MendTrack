import { SUPABASE_CONFIG } from './config.js';
import { supabase, isSupabaseConfigured } from './supabase-client.js';
import {
  formatCurrency,
  formatDateID,
  normalizePhone,
  generateTicketCode,
  buildWhatsAppLink,
  escapeHTML,
  debounce,
  compressImage,
  getDeadlineStatus,
} from './utils.js';
import {
  initConnectionMonitor,
  saveOrderDraft,
  loadOrderDraft,
  clearOrderDraft,
} from './storage-draft.js';
import {
  DEFAULT_STORE_SETTINGS,
  mapTenantToSettings,
  fetchStoreSettings,
  persistStoreSettings,
  applyStoreIdentity,
  fetchServices,
  createService,
  updateService,
  deactivateService,
  activateService,
} from './store-settings.js';
import {
  t,
  getLocale,
  setLocale,
  getIntlLocale,
  setCurrency,
  setTimezone,
  getCurrencyMeta,
  roundCurrencyAmount,
  detectPreferredLocale,
  applyTranslations,
  SUPPORTED_CURRENCIES,
  SUPPORTED_TIMEZONES,
  LOCALE_STORAGE_KEY,
  getStatusMeta,
  getPaymentStatusMeta,
  getCashCategories,
  getCashCategoryLabel,
  getPaymentMethodLabel,
  getServiceCategoryLabel,
} from './i18n.js';

let activeTenant = null;
let pendingVerifyEmail = '';
let authResolutionSeq = 0;
let onboardingSlugTouched = false;
let onboardingHoursTouched = false;
let currentAppPage = 'orders';
let currentAuthMode = 'login';

let allOrders = [];
let workloadDateFilter = null;
let searchQuery = '';
let orderStatusFilter = 'all';
let currentReceiptOrder = null;
let workloadServices = [];
const workloadToday = new Date();
let workloadViewMonth = new Date(workloadToday.getFullYear(), workloadToday.getMonth(), 1);
let workloadSelectedDate = toLocalDateKey(workloadToday);

let workshopSettings = { ...DEFAULT_STORE_SETTINGS };
let activeServiceCatalog = [];
let lastModalTrigger = null;
let itemRowCounter = 0;

function detectBrowserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jakarta';
  } catch (_) {
    return 'Asia/Jakarta';
  }
}

function populateRegionalSelects(extraTimezone = '') {
  const currencyOptionsHTML = SUPPORTED_CURRENCIES.map(
    (c) => `<option value="${c.code}">${escapeHTML(c.label)}</option>`
  ).join('');

  ['onboard-currency', 'store-currency-input'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = currencyOptionsHTML;
  });

  const knownTz = new Set(SUPPORTED_TIMEZONES.map((tz) => tz.value));
  const tzList = [...SUPPORTED_TIMEZONES];
  [detectBrowserTimezone(), extraTimezone].forEach((tz) => {
    const cleaned = String(tz || '').trim();
    if (cleaned && !knownTz.has(cleaned)) {
      knownTz.add(cleaned);
      tzList.push({ value: cleaned, label: cleaned });
    }
  });

  const tzOptionsHTML = tzList
    .map((tz) => `<option value="${escapeHTML(tz.value)}">${escapeHTML(tz.label)}</option>`)
    .join('');

  ['onboard-timezone', 'store-timezone-input'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = tzOptionsHTML;
  });
}

function syncCurrencyInputs(root = document) {
  const meta = getCurrencyMeta();
  root.querySelectorAll('[data-currency-label]').forEach((el) => {
    el.textContent = meta.shortLabel;
  });
  root.querySelectorAll('[data-currency-input]').forEach((input) => {
    const mode = input.getAttribute('data-currency-input');
    input.setAttribute('inputmode', meta.decimals > 0 ? 'decimal' : 'numeric');
    if (mode === 'positive') {
      input.setAttribute('min', meta.minPositive);
      input.setAttribute('step', meta.decimals === 0 ? '1' : meta.step);
    } else {
      input.setAttribute('min', '0');
      input.setAttribute('step', meta.step);
    }
  });
}

function getPageHeading(page) {
  const key = ['orders', 'customers', 'schedule', 'cash', 'reports', 'services', 'measurements', 'archive'].includes(page)
    ? page
    : 'orders';
  return {
    title: t(`page.${key}.title`),
    subtitle: t(`page.${key}.subtitle`),
  };
}

function applyWorkspaceLocalization() {
  applyTranslations(document);
  syncCurrencyInputs(document);
  updateCashCategoryOptions();

  const heading = getPageHeading(currentAppPage);
  const titleEl = document.getElementById('workspace-page-title');
  const subtitleEl = document.getElementById('workspace-page-subtitle');
  if (titleEl) titleEl.textContent = heading.title;
  if (subtitleEl) subtitleEl.textContent = heading.subtitle;

  if (activeTenant) {
    if (adminDocHeading) adminDocHeading.textContent = t('admin.docHeadingWorkspace', { name: workshopSettings.NAME });
    updateDashboardMetrics();
    renderWorkloadCalendar();
    renderOrdersList();
    renderArchiveOrders();
    checkSavedDraftBanner();
    if (currentAppPage === 'customers') renderCustomersList();
    if (currentAppPage === 'cash') renderCash();
    if (currentAppPage === 'reports') renderReports();
    if (currentAppPage === 'services') renderServicesList();
    if (currentAppPage === 'measurements') renderMeasurementTemplateSettings();
  }
}

function getActiveTenantId() {
  return activeTenant?.id || null;
}

function getPublicTrackingUrl() {
  const slug = activeTenant?.slug || workshopSettings.SLUG || '';
  return slug ? `${window.location.origin}/t/${encodeURIComponent(slug)}` : `${window.location.origin}/`;
}

function getAdminRedirectUrl() {
  const path = window.location.pathname.endsWith('.html') ? '/admin.html' : '/admin';
  return `${window.location.origin}${path}`;
}

function slugifyWorkshopName(raw) {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 48)
    .replace(/-+$/g, '');
}

function isValidWorkshopSlug(slug) {
  return /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/.test(String(slug || ''));
}

function rememberTrigger() {
  if (document.activeElement instanceof HTMLElement) {
    lastModalTrigger = document.activeElement;
  }
}

function restoreTriggerFocus() {
  if (lastModalTrigger && document.contains(lastModalTrigger)) {
    lastModalTrigger.focus();
  }
  lastModalTrigger = null;
}

function applyStoreSettings() {
  const nameEl = document.getElementById('header-store-name');
  if (nameEl) nameEl.textContent = workshopSettings.NAME;
  const logoWrap = document.getElementById('header-store-logo-wrap');
  if (logoWrap) {
    logoWrap.innerHTML = workshopSettings.LOGO
      ? `<img src="${workshopSettings.LOGO}" width="40" height="40" alt="${escapeHTML(t('common.logoAlt', { name: workshopSettings.NAME }))}" class="w-full h-full object-contain">`
      : '<i data-lucide="scissors" class="w-5 h-5" aria-hidden="true"></i>';
  }
  applyStoreIdentity(document, workshopSettings);
  if (window.lucide) window.lucide.createIcons();
}

function openStoreSettings() {
  const modal = document.getElementById('store-settings-modal');
  if (!modal) return;
  rememberTrigger();
  delete modal.dataset.pendingLogo;
  populateRegionalSelects(workshopSettings.TIMEZONE);
  const trackUrlInput = document.getElementById('store-tracking-url-display');
  if (trackUrlInput) trackUrlInput.value = getPublicTrackingUrl();
  document.getElementById('store-logo-input').value = '';
  document.getElementById('store-name-input').value = workshopSettings.NAME;
  document.getElementById('store-address-input').value = workshopSettings.ADDRESS;
  document.getElementById('store-phone-input').value = workshopSettings.ADMIN_PHONE;
  document.getElementById('store-tagline-input').value = workshopSettings.TAGLINE;
  document.getElementById('store-hours-input').value = workshopSettings.OPENING_HOURS;
  const localeSelect = document.getElementById('store-locale-input');
  if (localeSelect) localeSelect.value = workshopSettings.LOCALE || 'id';
  const currencySelect = document.getElementById('store-currency-input');
  if (currencySelect) currencySelect.value = workshopSettings.CURRENCY || 'IDR';
  const timezoneSelect = document.getElementById('store-timezone-input');
  if (timezoneSelect) timezoneSelect.value = workshopSettings.TIMEZONE || 'Asia/Jakarta';
  const prefixInput = document.getElementById('store-ticket-prefix-input');
  if (prefixInput) prefixInput.value = workshopSettings.TICKET_PREFIX || 'MND';
  const capacity = workshopSettings.DAILY_CAPACITY_MINUTES || 480;
  document.getElementById('daily-capacity-hours').value = Math.floor(capacity / 60);
  document.getElementById('daily-capacity-minutes').value = capacity % 60;
  renderStoreLogoPreview(workshopSettings.LOGO);
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  document.getElementById('store-name-input')?.focus();
}

// Browsers may restore this page from bfcache after returning from WhatsApp Web without rerunning startup.
async function refreshVisibleStoreServices() {
  const tenantId = getActiveTenantId();
  if (!tenantId) return;
  const modal = document.getElementById('store-settings-modal');
  const servicesPage = document.getElementById('services-page');
  const isModalVisible = modal && !modal.classList.contains('hidden');
  const isServicesPageVisible = servicesPage && !servicesPage.classList.contains('hidden');
  if (!isModalVisible && !isServicesPageVisible) return;
  await renderServicesList();
  try {
    activeServiceCatalog = (await fetchServices(tenantId)).filter((service) => service.is_active);
  } catch (error) {
    console.warn('Katalog layanan gagal diperbarui saat halaman aktif:', error);
  }
}

window.addEventListener('pageshow', () => {
  refreshVisibleStoreServices();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshVisibleStoreServices();
});

async function renderServicesList() {
  const container = document.getElementById('services-list');
  const tenantId = getActiveTenantId();
  if (!container || !tenantId) return;
  try {
    const services = await fetchServices(tenantId);
    if (!services.length) {
      container.innerHTML = `<p class="text-xs mt-muted">${escapeHTML(t('services.empty'))}</p>`;
      return;
    }
    container.innerHTML = services
      .map((service) => {
        const duration = t('duration.hm', {
          hours: Math.floor(service.estimated_minutes / 60),
          minutes: service.estimated_minutes % 60,
        });
        const categoryLabel = getServiceCategoryLabel(service.service_category);
        return `<div class="mt-card p-3 flex flex-wrap items-center justify-between gap-2 ${service.is_active ? '' : 'opacity-65'}">
          <div class="min-w-0">
            <p class="text-sm font-semibold mt-text">${escapeHTML(service.name)}</p>
            <p class="text-xs mt-muted font-mono-code">${escapeHTML(categoryLabel)} · ${escapeHTML(duration)} · ${escapeHTML(service.is_active ? t('common.active') : t('common.inactive'))}</p>
          </div>
          <div class="flex gap-2 shrink-0">
            ${
              service.is_active
                ? `<button type="button" data-edit-service="${service.id}" class="mt-btn mt-btn-secondary text-xs">${escapeHTML(t('common.edit'))}</button>
                   <button type="button" data-disable-service="${service.id}" class="mt-btn mt-btn-danger-ghost text-xs">${escapeHTML(t('common.deactivate'))}</button>`
                : `<button type="button" data-activate-service="${service.id}" class="mt-btn mt-btn-success text-xs">${escapeHTML(t('common.activate'))}</button>`
            }
          </div>
        </div>`;
      })
      .join('');
  } catch (error) {
    container.innerHTML = `<p class="text-xs mt-danger-text">${escapeHTML(t('services.loadFailed', { message: error.message || '' }))}</p>`;
  }
}

function closeStoreSettings() {
  const modal = document.getElementById('store-settings-modal');
  modal?.classList.add('hidden');
  modal?.classList.remove('flex');
  restoreTriggerFocus();
}

function openServiceEditModal(service) {
  const modal = document.getElementById('service-edit-modal');
  if (!modal || !service) return;
  rememberTrigger();
  document.getElementById('edit-service-id').value = service.id;
  document.getElementById('edit-service-name').value = service.name || '';
  document.getElementById('edit-service-category').value =
    service.service_category === 'custom' ? 'custom' : 'reparasi';
  document.getElementById('edit-service-minutes').value = String(service.estimated_minutes || 1);
  modal.classList.remove('hidden');
  document.getElementById('edit-service-name')?.focus();
  if (window.lucide) window.lucide.createIcons();
}

function closeServiceEditModal() {
  const modal = document.getElementById('service-edit-modal');
  modal?.classList.add('hidden');
  restoreTriggerFocus();
}

async function handleServiceEditSubmit(event) {
  event.preventDefault();
  const id = document.getElementById('edit-service-id')?.value || '';
  const name = document.getElementById('edit-service-name')?.value.trim() || '';
  const category = document.getElementById('edit-service-category')?.value === 'custom' ? 'custom' : 'reparasi';
  const totalMinutes = Number(document.getElementById('edit-service-minutes')?.value || 0);

  if (!id) return;
  if (!name) {
    alert(t('services.editNameRequired'));
    document.getElementById('edit-service-name')?.focus();
    return;
  }
  if (!Number.isInteger(totalMinutes) || totalMinutes <= 0) {
    alert(t('services.editMinutesInvalid'));
    document.getElementById('edit-service-minutes')?.focus();
    return;
  }

  const submitBtn = document.getElementById('save-service-edit-btn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = t('common.saving');
  }
  try {
    const tenantId = getActiveTenantId();
    if (!tenantId) throw new Error(t('common.noActiveTenant'));
    await updateService(tenantId, id, name, totalMinutes, category);
    closeServiceEditModal();
    await renderServicesList();
    await loadWorkloadServices();
    renderWorkloadCalendar();
  } catch (error) {
    alert(t('services.editFailed', { message: error.message || t('common.genericError') }));
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = t('common.saveChanges');
    }
  }
}

function renderStoreLogoPreview(dataUrl) {
  const preview = document.getElementById('store-logo-preview-wrap');
  if (!preview) return;
  preview.innerHTML = dataUrl
    ? `<img src="${dataUrl}" width="80" height="80" alt="${escapeHTML(t('common.logoPreviewAlt'))}" class="w-full h-full object-contain">`
    : '<i data-lucide="image" class="w-7 h-7 mt-muted" aria-hidden="true"></i>';
  if (window.lucide) window.lucide.createIcons();
}

async function imageFileToDataUrl(file) {
  if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    throw new Error(t('settings.logoInvalidType'));
  }
  if (file.size > 8 * 1024 * 1024) throw new Error(t('settings.logoMaxSize'));
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 480 / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL('image/webp', 0.8);
}

const authLoadingScreen = document.getElementById('auth-loading-screen');
const authScreen = document.getElementById('auth-screen');
const onboardingScreen = document.getElementById('onboarding-screen');
const adminWorkspace = document.getElementById('admin-workspace');
const adminDocHeading = document.getElementById('admin-doc-heading');
const loginForm = document.getElementById('login-form');
const signupForm = document.getElementById('signup-form');
const verifyEmailPanel = document.getElementById('verify-email-panel');
const authModeTabs = document.getElementById('auth-mode-tabs');
const authTabLogin = document.getElementById('auth-tab-login');
const authTabSignup = document.getElementById('auth-tab-signup');
const authSsoSection = document.getElementById('auth-sso-section');
const googleSsoBtn = document.getElementById('google-sso-btn');
const googleSsoLabel = document.getElementById('google-sso-label');
const authErrorBox = document.getElementById('auth-error-box');
const authInfoBox = document.getElementById('auth-info-box');
const onboardingErrorBox = document.getElementById('onboarding-error-box');
const onboardingForm = document.getElementById('onboarding-form');
const logoutBtn = document.getElementById('logout-btn');
const openStoreSettingsBtn = document.getElementById('open-store-settings-btn');

const draftBanner = document.getElementById('draft-restore-banner');
const draftSavedTime = document.getElementById('draft-saved-time');
const restoreDraftBtn = document.getElementById('restore-draft-btn');
const discardDraftBtn = document.getElementById('discard-draft-btn');

const ordersListContainer = document.getElementById('orders-list-container');
const adminSearchInput = document.getElementById('admin-search-input');
const refreshOrdersBtn = document.getElementById('refresh-orders-btn');
const customersSection = document.getElementById('customers-section');
const customersList = document.getElementById('customers-list');
let customerRecords = [];

const orderFormModal = document.getElementById('order-form-modal');
const orderCrudForm = document.getElementById('order-crud-form');
const openNewOrderBtn = document.getElementById('open-new-order-btn');
const closeOrderModalBtn = document.getElementById('close-order-modal-btn');
const cancelOrderModalBtn = document.getElementById('cancel-order-modal-btn');
const addItemRowBtn = document.getElementById('add-item-row-btn');
const formItemsContainer = document.getElementById('form-items-container');
const formPaidAmountInput = document.getElementById('form-paid-amount');

const paymentModal = document.getElementById('payment-modal');
const paymentForm = document.getElementById('payment-form');
const closePaymentModalBtn = document.getElementById('close-payment-modal-btn');
const payFullQuickBtn = document.getElementById('pay-full-quick-btn');

const receiptModal = document.getElementById('receipt-modal');
const receiptContent = document.getElementById('receipt-content');
const closeReceiptModalBtn = document.getElementById('close-receipt-modal-btn');
const copyReceiptWaBtn = document.getElementById('copy-receipt-wa-btn');
const printReceiptBtn = document.getElementById('print-receipt-btn');

const waReadyToast = document.getElementById('wa-ready-toast');
const waToastDesc = document.getElementById('wa-toast-desc');
const waToastSendLink = document.getElementById('wa-toast-send-link');
const closeWaToastBtn = document.getElementById('close-wa-toast-btn');

function mountSeparatedManagementPages() {
  const workload = document.getElementById('daily-workload-section');
  const schedule = document.getElementById('schedule-page');
  if (workload && schedule) schedule.appendChild(workload);

  const servicePanel = document.querySelector('[data-settings-panel="services"]');
  const serviceTarget = document.getElementById('services-page-content');
  if (servicePanel && serviceTarget) {
    while (servicePanel.firstChild) serviceTarget.appendChild(servicePanel.firstChild);
    servicePanel.remove();
  }

  const measurementPanel = document.querySelector('[data-settings-panel="measurements"]');
  const measurementTarget = document.getElementById('measurements-page-content');
  if (measurementPanel && measurementTarget) {
    while (measurementPanel.firstChild) measurementTarget.appendChild(measurementPanel.firstChild);
    measurementPanel.remove();
  }

  document.querySelector('[data-settings-panel="store"]')?.classList.remove('hidden');
  document.querySelector('[data-store-save-btn]')?.classList.remove('hidden');
}

function showAppPage(page) {
  currentAppPage = page || 'orders';
  const heading = getPageHeading(currentAppPage);
  const titleEl = document.getElementById('workspace-page-title');
  const subtitleEl = document.getElementById('workspace-page-subtitle');
  if (titleEl) titleEl.textContent = heading.title;
  if (subtitleEl) subtitleEl.textContent = heading.subtitle;

  const ids = ['reports-page', 'schedule-page', 'services-page', 'measurements-page', 'cash-page', 'archive-page'];
  ids.forEach((id) => document.getElementById(id)?.classList.add('hidden'));

  document.getElementById('dashboard-metrics-section')?.classList.toggle('hidden', page !== 'orders');
  document.getElementById('orders-filter-section')?.classList.toggle('hidden', page !== 'orders');
  ordersListContainer?.classList.toggle('hidden', page !== 'orders');
  customersSection?.classList.toggle('hidden', page !== 'customers');
  document.getElementById('daily-workload-section')?.classList.toggle('hidden', page !== 'schedule');

  const pageMap = {
    reports: 'reports-page',
    schedule: 'schedule-page',
    services: 'services-page',
    measurements: 'measurements-page',
    cash: 'cash-page',
    archive: 'archive-page',
  };
  if (pageMap[page]) document.getElementById(pageMap[page])?.classList.remove('hidden');

  document.querySelectorAll('[data-app-page], #bottom-nav-orders, #bottom-nav-customers').forEach((btn) => {
    const key =
      btn.dataset.appPage ||
      (btn.id === 'bottom-nav-orders' ? 'orders' : btn.id === 'bottom-nav-customers' ? 'customers' : '');
    btn.classList.toggle('is-active', key === page);
    if (key === page) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });

  if (page === 'customers') fetchCustomers();
  if (page === 'services') {
    renderServicesList();
    loadWorkloadServices();
  }
  if (page === 'measurements') renderMeasurementTemplateSettings();
  if (page === 'reports') renderReports();
  if (page === 'cash') renderCash();
  if (page === 'archive') renderArchiveOrders();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderArchiveOrders() {
  const target = document.getElementById('archive-orders-list');
  if (!target) return;
  const archived = allOrders.filter((order) => order.status === 'completed');
  target.innerHTML = archived.length
    ? archived
        .map(
          (order) => `<article class="mt-card p-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p class="font-mono-code font-bold mt-text">${escapeHTML(order.ticket_code || '')}</p>
              <p class="text-sm mt-text">${escapeHTML(order.customer_name || '')}</p>
              <p class="text-xs mt-muted">${escapeHTML(t('archive.completedMeta', { date: formatDateID(order.updated_at || order.created_at) }))}</p>
            </div>
            <div class="text-right flex flex-col items-end gap-1">
              <p class="font-mono-code font-bold mt-text">${escapeHTML(formatCurrency(order.total_amount))}</p>
              <button type="button" data-edit-order="${order.id}" class="mt-btn mt-btn-secondary text-xs">${escapeHTML(t('archive.viewOrder'))}</button>
            </div>
          </article>`
        )
        .join('')
    : `<div class="mt-card p-8 text-center text-sm mt-muted">${escapeHTML(t('archive.empty'))}</div>`;
}

async function renderReports() {
  const target = document.getElementById('reports-content');
  if (!target) return;
  const period = document.getElementById('report-period')?.value || 'week';
  const now = new Date();
  now.setHours(23, 59, 59, 999);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (period === 'week') start.setDate(start.getDate() - 6);
  else if (period === 'month') start.setDate(1);
  else if (period === 'all') start.setTime(0);

  const inRange = allOrders.filter((o) => {
    const d = new Date(o.created_at);
    return period === 'all' || (d >= start && d <= now);
  });
  const totalSales = inRange.reduce((s, o) => s + Number(o.total_amount || 0), 0);
  const paidNow = inRange.reduce((s, o) => s + Number(o.paid_amount || 0), 0);
  const receivable = inRange.reduce((s, o) => s + Math.max(0, Number(o.total_amount || 0) - Number(o.paid_amount || 0)), 0);
  const unpaidOrders = inRange.filter((o) => Number(o.total_amount || 0) > Number(o.paid_amount || 0));

  const services = {};
  inRange.forEach((o) =>
    (o.order_items || []).forEach((it) => {
      const name = it.service_type || t('cashCategory.lain_lain');
      services[name] = (services[name] || 0) + 1;
    })
  );
  const top = Object.entries(services)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  let cashRows = [];
  let cashFetchError = null;
  try {
    const tenantId = getActiveTenantId();
    if (!tenantId) throw new Error(t('common.noActiveTenant'));
    let q = supabase
      .from('cash_transactions')
      .select('transaction_type,category,amount,occurred_at')
      .eq('tenant_id', tenantId);
    if (period !== 'all') q = q.gte('occurred_at', start.toISOString()).lte('occurred_at', now.toISOString());
    const { data, error } = await q;
    if (error) throw error;
    cashRows = data || [];
  } catch (err) {
    console.warn('Data diagram kas gagal dimuat:', err);
    cashFetchError = err.message || t('reports.cashLoadError');
  }

  const incomeRows = cashRows.filter((x) => x.transaction_type === 'income');
  const expenseRows = cashRows.filter((x) => x.transaction_type === 'expense');
  const sumRows = (rows) => rows.reduce((a, x) => a + Number(x.amount || 0), 0);
  const incomeTotal = sumRows(incomeRows);
  const expenseTotal = sumRows(expenseRows);

  const pie = (rows, title, requiredKeys = []) => {
    const totals = {};
    requiredKeys.forEach((key) => {
      totals[key] = 0;
    });
    rows.forEach((x) => {
      const k = x.category || 'lain_lain';
      totals[k] = (totals[k] || 0) + Number(x.amount || 0);
    });
    const hasTransactions = rows.length > 0;
    const entries = hasTransactions
      ? Object.entries(totals).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      : [];
    const fixedColors = {
      reparasi: '#18253E',
      custom: '#9E4316',
      lain_lain: '#4A5568',
    };
    const palette = ['#18253E', '#9E4316', '#166534', '#B45309', '#9F1239', '#4A5568'];
    const colorFor = (key, idx) => fixedColors[key] || palette[idx % palette.length];
    let acc = 0;
    const total = sumRows(rows);
    const stops = entries
      .filter(([, v]) => v > 0)
      .map(([k, v], i) => {
        const a = acc;
        acc += total ? (v / total) * 100 : 0;
        return `${colorFor(k, i)} ${a}% ${acc}%`;
      })
      .join(',');
    return `<section class="mt-card p-4 min-w-0">
      <h3 class="font-bold text-sm mt-text mb-3">${escapeHTML(title)}</h3>
      ${
        entries.length
          ? `<div class="flex items-center gap-3">
              <div class="w-24 h-24 rounded-full shrink-0 border" style="background:conic-gradient(${stops}); border-color: var(--mt-border);" aria-hidden="true"></div>
              <div class="space-y-2 min-w-0 flex-1">
                ${entries
                  .map(
                    ([k, v], i) => `<div class="flex items-center gap-2 text-xs min-w-0">
                      <i class="w-2.5 h-2.5 rounded-sm shrink-0" style="background:${colorFor(k, i)}" aria-hidden="true"></i>
                      <span class="truncate mt-text">${escapeHTML(getCashCategoryLabel(k))}</span>
                      <b class="ml-auto font-mono-code mt-text">${Math.round((v / (total || 1)) * 100)}%</b>
                    </div>`
                  )
                  .join('')}
              </div>
            </div>`
          : `<p class="text-xs mt-muted">${escapeHTML(t('reports.noTransactions'))}</p>`
      }
    </section>`;
  };

  // Day/week/month group by day; all-time groups by month so long histories remain legible.
  const bucketMap = new Map();
  const keyFor = (d) =>
    period === 'all'
      ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  cashRows.forEach((row) => {
    const d = new Date(row.occurred_at);
    if (Number.isNaN(d.getTime())) return;
    const key = keyFor(d);
    if (!bucketMap.has(key)) bucketMap.set(key, { income: 0, expense: 0 });
    const bucket = bucketMap.get(key);
    if (row.transaction_type === 'income') bucket.income += Number(row.amount || 0);
    else if (row.transaction_type === 'expense') bucket.expense += Number(row.amount || 0);
  });

  const intlLoc = getIntlLocale();
  const chartData = [...bucketMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const labelFor = (key) => {
    const d =
      period === 'all'
        ? new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1)
        : new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));
    return period === 'all'
      ? new Intl.DateTimeFormat(intlLoc, { month: 'short', year: '2-digit' }).format(d)
      : new Intl.DateTimeFormat(intlLoc, { day: 'numeric', month: 'short' }).format(d);
  };
  const maxValue = Math.max(1, ...chartData.flatMap(([, v]) => [v.income, v.expense]));
  const barWidth = period === 'day' ? 44 : period === 'week' ? 32 : period === 'month' ? 22 : 28;
  const chartWidth = Math.max(300, chartData.length * (barWidth * 2 + 18) + 24);
  const bars = chartData.length
    ? chartData
        .map(([key, v]) => {
          const h1 = Math.max(v.income ? 2 : 0, (v.income / maxValue) * 112);
          const h2 = Math.max(v.expense ? 2 : 0, (v.expense / maxValue) * 112);
          return `<div class="flex flex-col items-center justify-end shrink-0" style="width:${barWidth * 2 + 14}px;height:158px">
            <div class="flex items-end justify-center gap-1 h-[124px] w-full">
              <div title="${escapeHTML(t('reports.income'))} ${escapeHTML(formatCurrency(v.income))}" class="rounded-t" style="background:#166534;width:${barWidth}px;height:${h1}px"></div>
              <div title="${escapeHTML(t('reports.expense'))} ${escapeHTML(formatCurrency(v.expense))}" class="rounded-t" style="background:#9F1239;width:${barWidth}px;height:${h2}px"></div>
            </div>
            <span class="text-xs mt-muted mt-2 whitespace-nowrap">${escapeHTML(labelFor(key))}</span>
          </div>`;
        })
        .join('')
    : `<p class="text-xs mt-muted p-4">${escapeHTML(t('reports.noTransactions'))}</p>`;

  const cashErrorBanner = cashFetchError
    ? `<div role="alert" class="mt-notice-error p-4 text-xs flex flex-wrap items-center justify-between gap-2">
        <span>${escapeHTML(t('reports.cashBannerError', { message: cashFetchError }))}</span>
        <button type="button" data-retry-reports class="mt-btn mt-btn-secondary text-xs">${escapeHTML(t('common.reload'))}</button>
      </div>`
    : '';

  const chart = `<section class="mt-card p-4 min-w-0">
    <h3 class="font-bold text-sm mt-text mb-2">${escapeHTML(t('reports.incomeVsExpense'))}</h3>
    <div class="flex gap-4 text-xs mb-2">
      <span class="mt-success-text font-semibold">${escapeHTML(t('reports.income'))}</span>
      <span class="mt-danger-text font-semibold">${escapeHTML(t('reports.expense'))}</span>
    </div>
    <div class="overflow-x-auto">
      <div class="flex items-end gap-1 min-w-full" style="width:${chartWidth}px;min-height:166px">${bars}</div>
    </div>
    <div class="flex justify-between text-xs mt-2 font-mono-code">
      <b class="mt-success-text">${escapeHTML(t('reports.inShort', { amount: formatCurrency(incomeTotal) }))}</b>
      <b class="mt-danger-text">${escapeHTML(t('reports.outShort', { amount: formatCurrency(expenseTotal) }))}</b>
    </div>
    <p class="text-xs mt-muted mt-2">${escapeHTML(period === 'all' ? t('reports.groupedByMonth') : t('reports.groupedByDay'))}</p>
  </section>`;

  const cashCharts = `<div class="grid grid-cols-1 md:grid-cols-3 gap-3 items-stretch">${chart}${pie(incomeRows, t('reports.incomeCategories'), ['reparasi', 'custom'])}${pie(expenseRows, t('reports.expenseCategories'))}</div>`;
  const moneyCard = (label, value, sub) =>
    `<article class="mt-card p-4">
      <p class="text-xs font-semibold mt-muted">${escapeHTML(label)}</p>
      <p class="font-mono-code text-xl font-bold mt-text mt-1">${escapeHTML(formatCurrency(value))}</p>
      <p class="text-xs mt-muted mt-1">${escapeHTML(sub)}</p>
    </article>`;

  target.innerHTML = `
    ${cashErrorBanner}
    ${cashCharts}
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
      ${moneyCard(t('reports.orderValue'), totalSales, t('reports.orderValueSub', { count: inRange.length }))}
      ${moneyCard(t('reports.recordedPayments'), paidNow, t('reports.recordedPaymentsSub'))}
      ${moneyCard(t('reports.unpaidReceivables'), receivable, t('reports.unpaidOrdersSub', { count: unpaidOrders.length }))}
    </div>
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
      <section class="mt-card p-4">
        <h3 class="font-bold mt-text mb-3">${escapeHTML(t('reports.unpaidOrdersTitle'))}</h3>
        ${
          unpaidOrders.length
            ? unpaidOrders
                .sort((a, b) => Number(b.total_amount || 0) - Number(a.total_amount || 0))
                .slice(0, 20)
                .map(
                  (o) => `<div class="py-2.5 border-b flex justify-between gap-3 text-sm" style="border-color: var(--mt-border);">
                    <div>
                      <b class="font-mono-code mt-text">${escapeHTML(o.ticket_code || '')}</b>
                      <p class="text-xs mt-muted">${escapeHTML(o.customer_name || '')}</p>
                    </div>
                    <b class="font-mono-code mt-danger-text">${escapeHTML(formatCurrency(Math.max(0, Number(o.total_amount || 0) - Number(o.paid_amount || 0))))}</b>
                  </div>`
                )
                .join('')
            : `<p class="text-sm mt-muted">${escapeHTML(t('reports.noReceivables'))}</p>`
        }
      </section>
      <section class="mt-card p-4">
        <h3 class="font-bold mt-text mb-3">${escapeHTML(t('reports.topServicesTitle'))}</h3>
        ${
          top.length
            ? top
                .map(
                  ([name, count], i) => `<div class="py-2.5 border-b flex justify-between text-sm" style="border-color: var(--mt-border);">
                    <span class="mt-text">${i + 1}. ${escapeHTML(name)}</span>
                    <b class="font-mono-code mt-text">${escapeHTML(t('common.itemCount', { count }))}</b>
                  </div>`
                )
                .join('')
            : `<p class="text-sm mt-muted">${escapeHTML(t('reports.noServiceData'))}</p>`
        }
      </section>
    </div>
    <p class="text-xs mt-muted">${escapeHTML(t('reports.footnote'))}</p>
  `;

  target.querySelector('[data-retry-reports]')?.addEventListener('click', renderReports);
}

// Workload assigns all estimated minutes to estimated_done_date; ready/completed orders are excluded immediately.
function toLocalDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseLocalDateKey(key) {
  if (!key) return null;
  const parts = key.split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

function getOrderEstimatedMinutes(order) {
  const items = order.order_items || [];
  return items.reduce((sum, item) => {
    const serviceName = String(item.service_type || '').trim().toLocaleLowerCase();
    const service = workloadServices.find(
      (entry) => String(entry.name || '').trim().toLocaleLowerCase() === serviceName
    );
    return sum + (service ? Number(service.estimated_minutes || 0) : 0);
  }, 0);
}

function getWorkloadForDate(dateKey) {
  const orders = allOrders.filter(
    (order) => order.estimated_done_date === dateKey && !['ready', 'completed'].includes(order.status)
  );
  const minutes = orders.reduce((sum, order) => sum + getOrderEstimatedMinutes(order), 0);
  const unknownItems = orders.reduce((sum, order) => {
    const items = order.order_items || [];
    return (
      sum +
      items.filter(
        (item) =>
          !workloadServices.some(
            (service) =>
              String(service.name || '').trim().toLocaleLowerCase() ===
              String(item.service_type || '').trim().toLocaleLowerCase()
          )
      ).length
    );
  }, 0);
  const capacity = Number(workshopSettings.DAILY_CAPACITY_MINUTES || 480);
  return { orders, minutes, capacity, percent: capacity > 0 ? (minutes / capacity) * 100 : 0, unknownItems };
}

function workloadLevel(percent, orderCount) {
  if (!orderCount) return 'workload-empty';
  if (percent > 100) return 'workload-over';
  if (percent >= 80) return 'workload-high';
  if (percent >= 40) return 'workload-medium';
  return 'workload-low';
}

function formatWorkloadDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours && mins) return t('duration.hm', { hours, minutes: mins });
  if (hours) return t('duration.h', { hours });
  return t('duration.m', { minutes: mins });
}

function renderWorkloadCalendar() {
  const grid = document.getElementById('workload-calendar-grid');
  if (!grid) return;
  const monthLabel = document.getElementById('workload-month-label');
  const selectedDateEl = document.getElementById('workload-selected-date');
  const selectedLoadEl = document.getElementById('workload-selected-load');
  const selectedProgress = document.getElementById('workload-selected-progress');
  const selectedNote = document.getElementById('workload-selected-note');

  const intlLoc = getIntlLocale();
  const year = workloadViewMonth.getFullYear();
  const month = workloadViewMonth.getMonth();
  monthLabel.textContent = new Intl.DateTimeFormat(intlLoc, { month: 'long', year: 'numeric' }).format(workloadViewMonth);

  const firstDay = new Date(year, month, 1);
  const mondayOffset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = Math.ceil((mondayOffset + daysInMonth) / 7) * 7;
  const todayKey = toLocalDateKey(new Date());

  let markup = '';
  for (let i = 0; i < cells; i++) {
    const dayNumber = i - mondayOffset + 1;
    const date = new Date(year, month, dayNumber);
    const key = toLocalDateKey(date);
    const inMonth = date.getMonth() === month;
    const workload = inMonth
      ? getWorkloadForDate(key)
      : { orders: [], minutes: 0, capacity: Number(workshopSettings.DAILY_CAPACITY_MINUTES || 480), percent: 0 };
    const level = workloadLevel(workload.percent, workload.orders.length);
    const selected = key === workloadSelectedDate;
    const orderCountLabel = t('common.orderCount', { count: workload.orders.length });
    markup += `
      <button type="button" class="mt-calendar-day ${inMonth ? '' : 'is-outside'} ${workload.orders.length ? level : 'workload-empty'} ${selected ? 'is-selected' : ''} ${key === todayKey ? 'is-today' : ''}"
        data-workload-date="${key}" ${inMonth ? '' : 'disabled'} aria-pressed="${selected}" aria-label="${escapeHTML(formatDateID(key))}, ${escapeHTML(orderCountLabel)}">
        <span class="mt-calendar-day-number">${date.getDate()}</span>
        ${
          inMonth && workload.orders.length
            ? `<span class="mt-calendar-day-count">${escapeHTML(orderCountLabel)}</span>
               <span class="mt-calendar-day-percent font-mono-code">${workload.percent > 100 ? escapeHTML(t('workload.overShort')) : `${Math.round(workload.percent)}%`}</span>`
            : `<span class="mt-calendar-day-empty">${inMonth ? '-' : ''}</span>`
        }
      </button>`;
  }
  grid.innerHTML = markup;

  const selected = getWorkloadForDate(workloadSelectedDate);
  const selectedDate = parseLocalDateKey(workloadSelectedDate);
  selectedDateEl.textContent = selectedDate
    ? new Intl.DateTimeFormat(intlLoc, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(selectedDate)
    : '-';
  selectedLoadEl.textContent = `${formatWorkloadDuration(selected.minutes)} / ${formatWorkloadDuration(selected.capacity)}`;
  selectedProgress.style.width = `${Math.min(100, Math.round(selected.percent))}%`;
  selectedProgress.className = `mt-calendar-progress-fill ${workloadLevel(selected.percent, selected.orders.length)}`;
  selectedNote.textContent = selected.unknownItems
    ? t('workload.noteUnknownItems', { orders: selected.orders.length, unknown: selected.unknownItems })
    : selected.orders.length
      ? t('workload.noteScheduled', { orders: selected.orders.length })
      : t('workload.noteEmpty');
}

async function loadWorkloadServices() {
  const tenantId = getActiveTenantId();
  if (!tenantId) {
    workloadServices = [];
    activeServiceCatalog = [];
    return;
  }
  try {
    workloadServices = await fetchServices(tenantId);
    activeServiceCatalog = workloadServices.filter((service) => service.is_active);
  } catch (error) {
    console.warn('Katalog estimasi beban kerja gagal dimuat:', error);
    workloadServices = [];
    activeServiceCatalog = [];
  }
}

function bindWorkloadCalendarEvents() {
  document.getElementById('workload-prev-month')?.addEventListener('click', () => {
    workloadViewMonth = new Date(workloadViewMonth.getFullYear(), workloadViewMonth.getMonth() - 1, 1);
    workloadSelectedDate = toLocalDateKey(workloadViewMonth);
    renderWorkloadCalendar();
  });
  document.getElementById('workload-next-month')?.addEventListener('click', () => {
    workloadViewMonth = new Date(workloadViewMonth.getFullYear(), workloadViewMonth.getMonth() + 1, 1);
    workloadSelectedDate = toLocalDateKey(workloadViewMonth);
    renderWorkloadCalendar();
  });
  document.getElementById('workload-today-btn')?.addEventListener('click', () => {
    const today = new Date();
    workloadViewMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    workloadSelectedDate = toLocalDateKey(today);
    renderWorkloadCalendar();
  });
  document.getElementById('workload-calendar-grid')?.addEventListener('click', (event) => {
    const day = event.target.closest('[data-workload-date]');
    if (!day || day.disabled) return;
    workloadSelectedDate = day.dataset.workloadDate;
    workloadDateFilter = workloadSelectedDate;
    renderWorkloadCalendar();
    renderOrdersList();
  });
}

function consumeAuthRedirectError() {
  const searchParams = new URLSearchParams(window.location.search);
  const hashRaw = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
  const hashParams = new URLSearchParams(hashRaw);

  const errCode = searchParams.get('error') || hashParams.get('error');
  const errDesc = searchParams.get('error_description') || hashParams.get('error_description');
  if (!errCode && !errDesc) return null;

  const cleanUrl = `${window.location.origin}${window.location.pathname}`;
  window.history.replaceState({}, '', cleanUrl);

  if (errCode === 'access_denied') {
    return t('admin.googleCancelled');
  }
  return errDesc || t('admin.googleAuthError');
}

document.addEventListener('DOMContentLoaded', async () => {
  setLocale(detectPreferredLocale());
  populateRegionalSelects();
  mountSeparatedManagementPages();
  applyTranslations(document);
  syncCurrencyInputs(document);
  document.title = t('admin.titleDefault');
  applyStoreSettings();
  if (window.lucide) window.lucide.createIcons();
  initConnectionMonitor('connection-badge');
  bindGlobalEvents();

  if (!isSupabaseConfigured) {
    showAuthScreen('login');
    showAuthError(t('admin.configMissingError'));
    return;
  }

  const oauthRedirectError = consumeAuthRedirectError();

  const {
    data: { session },
  } = await supabase.auth.getSession();

  await resolveAuthSession(session);
  if (!session && oauthRedirectError) {
    showAuthError(oauthRedirectError);
  }

  supabase.auth.onAuthStateChange((event, newSession) => {
    if (event === 'SIGNED_OUT') {
      resetTenantState();
      showAuthScreen('login');
      return;
    }
    resolveAuthSession(newSession);
  });
});

function clearAuthNotices() {
  authErrorBox?.classList.add('hidden');
  authInfoBox?.classList.add('hidden');
  if (authErrorBox) authErrorBox.textContent = '';
  if (authInfoBox) authInfoBox.textContent = '';
}

function setAuthMode(mode = 'login') {
  currentAuthMode = mode;
  clearAuthNotices();
  const isLogin = mode === 'login';
  const isSignup = mode === 'signup';
  const isVerify = mode === 'verify';

  authModeTabs?.classList.toggle('hidden', isVerify);
  loginForm?.classList.toggle('hidden', !isLogin);
  signupForm?.classList.toggle('hidden', !isSignup);
  authSsoSection?.classList.toggle('hidden', isVerify);
  verifyEmailPanel?.classList.toggle('hidden', !isVerify);

  if (googleSsoLabel) {
    googleSsoLabel.textContent = isSignup ? t('admin.googleSignup') : t('admin.googleContinue');
  }

  if (authTabLogin) {
    authTabLogin.setAttribute('aria-selected', String(isLogin));
    authTabLogin.tabIndex = isLogin ? 0 : -1;
    authTabLogin.className = `mt-btn text-xs ${isLogin ? 'mt-btn-primary' : 'mt-btn-secondary'}`;
  }
  if (authTabSignup) {
    authTabSignup.setAttribute('aria-selected', String(isSignup));
    authTabSignup.tabIndex = isSignup ? 0 : -1;
    authTabSignup.className = `mt-btn text-xs ${isSignup ? 'mt-btn-primary' : 'mt-btn-secondary'}`;
  }

  const subheading = document.getElementById('auth-subheading');
  if (subheading) {
    subheading.textContent = isVerify
      ? t('admin.authSubVerify')
      : isSignup
        ? t('admin.authSubSignup')
        : t('admin.authSubLogin');
  }
  if (adminDocHeading) {
    adminDocHeading.textContent = isVerify
      ? t('admin.docHeadingVerify')
      : isSignup
        ? t('admin.docHeadingSignup')
        : t('admin.docHeadingLogin');
  }
  if (window.lucide) window.lucide.createIcons();
}

function showAuthScreen(mode = 'login') {
  authLoadingScreen?.classList.add('hidden');
  authScreen?.classList.remove('hidden');
  onboardingScreen?.classList.add('hidden');
  adminWorkspace?.classList.add('hidden');
  document.title = t('admin.titleDefault');
  applyTranslations(document);
  setAuthMode(mode);
}

function showVerifyEmailPanel(email = '') {
  pendingVerifyEmail = email || pendingVerifyEmail;
  const emailEl = document.getElementById('verify-email-address');
  if (emailEl) emailEl.textContent = pendingVerifyEmail || '-';
  showAuthScreen('verify');
}

function updateOnboardingSlugPreview() {
  const slugInput = document.getElementById('onboard-slug');
  const previewEl = document.getElementById('onboard-slug-preview');
  if (!slugInput || !previewEl) return;
  const slug = slugInput.value.trim().toLowerCase();
  previewEl.textContent = `${window.location.origin}/t/${slug || t('landing.slugPlaceholder')}`;
}

function showOnboardingScreen(userEmail = '') {
  authLoadingScreen?.classList.add('hidden');
  authScreen?.classList.add('hidden');
  adminWorkspace?.classList.add('hidden');
  onboardingScreen?.classList.remove('hidden');
  onboardingErrorBox?.classList.add('hidden');
  onboardingSlugTouched = false;
  onboardingHoursTouched = false;
  populateRegionalSelects();

  const activeLoc = getLocale();
  const onboardLocale = document.getElementById('onboard-locale');
  if (onboardLocale) onboardLocale.value = activeLoc;
  const onboardCurrency = document.getElementById('onboard-currency');
  if (onboardCurrency) onboardCurrency.value = activeLoc === 'en' ? 'USD' : 'IDR';
  const onboardTimezone = document.getElementById('onboard-timezone');
  if (onboardTimezone) onboardTimezone.value = detectBrowserTimezone();
  const onboardPrefix = document.getElementById('onboard-ticket-prefix');
  if (onboardPrefix && !onboardPrefix.value) onboardPrefix.value = 'MND';
  const onboardHours = document.getElementById('onboard-hours');
  if (onboardHours) onboardHours.value = t('common.defaultHours');

  if (adminDocHeading) adminDocHeading.textContent = t('admin.docHeadingOnboarding');
  document.title = t('admin.titleDefault');
  const emailEl = document.getElementById('onboarding-user-email');
  if (emailEl) emailEl.textContent = userEmail || '-';
  applyTranslations(document);
  updateOnboardingSlugPreview();
  if (window.lucide) window.lucide.createIcons();
}

function showOnboardingError(msg) {
  if (!onboardingErrorBox) return;
  onboardingErrorBox.textContent = msg;
  onboardingErrorBox.classList.remove('hidden');
}

function resetTenantState() {
  activeTenant = null;
  allOrders = [];
  customerRecords = [];
  workloadServices = [];
  activeServiceCatalog = [];
  activeCustomerDetail = null;
  activeMeasurementTemplates = [];
  activeMeasurementTemplateFields = [];
  customerMeasurementRecords = [];
  currentReceiptOrder = null;
  workloadDateFilter = null;
  searchQuery = '';
  orderStatusFilter = 'all';
  workshopSettings = { ...DEFAULT_STORE_SETTINGS };
  setLocale(detectPreferredLocale());
  setCurrency('IDR');
  setTimezone('Asia/Jakarta');
  applyTranslations(document);
  syncCurrencyInputs(document);
  applyStoreSettings();
  document.title = t('admin.titleDefault');

  draftBanner?.classList.add('hidden');
  waReadyToast?.classList.add('hidden');
  orderFormModal?.classList.add('hidden');
  paymentModal?.classList.add('hidden');
  receiptModal?.classList.add('hidden');
  document.getElementById('store-settings-modal')?.classList.add('hidden');
  document.getElementById('service-edit-modal')?.classList.add('hidden');
  document.getElementById('cash-modal')?.classList.add('hidden');
  document.getElementById('customer-form-modal')?.classList.add('hidden');
  document.getElementById('customer-detail-modal')?.classList.add('hidden');

  if (ordersListContainer) ordersListContainer.innerHTML = '';
  if (customersList) customersList.innerHTML = '';
  const archiveEl = document.getElementById('archive-orders-list');
  if (archiveEl) archiveEl.innerHTML = '';
  const cashEl = document.getElementById('cash-transactions');
  if (cashEl) cashEl.innerHTML = '';
  const reportsEl = document.getElementById('reports-content');
  if (reportsEl) reportsEl.innerHTML = '';
}

async function resolveAuthSession(session) {
  const seq = ++authResolutionSeq;
  if (!session?.user) {
    resetTenantState();
    showAuthScreen('login');
    return;
  }

  if (!session.user.email_confirmed_at) {
    resetTenantState();
    showVerifyEmailPanel(session.user.email || '');
    return;
  }

  try {
    const { data: memberships, error } = await supabase
      .from('tenant_members')
      .select('tenant_id, role, is_active, tenants(*)')
      .eq('user_id', session.user.id)
      .eq('is_active', true)
      .limit(1);

    if (seq !== authResolutionSeq) return;
    if (error) throw error;

    const membership = (memberships || [])[0];
    const tenant = membership?.tenants || null;

    if (!tenant || !tenant.is_active) {
      resetTenantState();
      showOnboardingScreen(session.user.email || '');
      return;
    }

    await enterWorkspace(tenant);
  } catch (err) {
    if (seq !== authResolutionSeq) return;
    console.error('Gagal memeriksa keanggotaan workshop:', err);
    resetTenantState();
    showAuthScreen('login');
    showAuthError(t('admin.loadTenantFailed', { message: err.message || t('admin.retrySignIn') }));
  }
}

async function enterWorkspace(tenant) {
  if (!tenant?.id) return;
  const switchedTenant = activeTenant?.id !== tenant.id;
  activeTenant = tenant;
  workshopSettings = mapTenantToSettings(tenant);
  setLocale(workshopSettings.LOCALE);
  setCurrency(workshopSettings.CURRENCY);
  setTimezone(workshopSettings.TIMEZONE);
  applyTranslations(document);
  syncCurrencyInputs(document);
  applyStoreSettings();

  authLoadingScreen?.classList.add('hidden');
  authScreen?.classList.add('hidden');
  onboardingScreen?.classList.add('hidden');
  adminWorkspace?.classList.remove('hidden');
  if (adminDocHeading) adminDocHeading.textContent = t('admin.docHeadingWorkspace', { name: workshopSettings.NAME });

  if (switchedTenant) {
    allOrders = [];
    customerRecords = [];
    workloadServices = [];
    activeServiceCatalog = [];
    showAppPage('orders');
  } else {
    applyWorkspaceLocalization();
  }

  checkSavedDraftBanner();
  await loadWorkloadServices();
  await fetchOrders();
  await fetchCustomers();
}

function showAuthError(msg) {
  if (!authErrorBox) return;
  authInfoBox?.classList.add('hidden');
  authErrorBox.textContent = msg;
  authErrorBox.classList.remove('hidden');
}

function showAuthInfo(msg) {
  if (!authInfoBox) return;
  authErrorBox?.classList.add('hidden');
  authInfoBox.textContent = msg;
  authInfoBox.classList.remove('hidden');
}

let orderDatePickerMonth = new Date();
let orderDatePickerSelectedDate = '';

function renderOrderDatePicker() {
  const grid = document.getElementById('order-date-grid');
  if (!grid) return;
  const y = orderDatePickerMonth.getFullYear();
  const m = orderDatePickerMonth.getMonth();
  document.getElementById('order-date-month').textContent = new Intl.DateTimeFormat(getIntlLocale(), {
    month: 'long',
    year: 'numeric',
  }).format(orderDatePickerMonth);
  const offset = (new Date(y, m, 1).getDay() + 6) % 7;
  const count = new Date(y, m + 1, 0).getDate();
  const selected = orderDatePickerSelectedDate || toLocalDateKey(new Date());

  let html = '';
  for (let i = 0; i < offset; i++) html += '<span></span>';
  for (let d = 1; d <= count; d++) {
    const key = toLocalDateKey(new Date(y, m, d));
    const workload = getWorkloadForDate(key);
    const today = key === toLocalDateKey(new Date());
    const level = workloadLevel(workload.percent, workload.orders.length);
    const isSelected = selected === key;
    html += `<button type="button" data-order-date="${key}" aria-pressed="${isSelected}" aria-label="${escapeHTML(formatDateID(key))}" class="order-date-day ${level} ${isSelected ? 'is-selected' : ''} ${today ? 'is-today' : ''}"><span>${d}</span></button>`;
  }
  grid.innerHTML = html;

  const selectedWorkload = getWorkloadForDate(selected);
  const selectedPercent = Math.round(selectedWorkload.percent);
  const progress = document.getElementById('order-date-workload');
  if (progress) {
    const safeWidth = Math.max(0, Math.min(100, selectedWorkload.percent));
    const fillLevel = workloadLevel(selectedWorkload.percent, selectedWorkload.orders.length);
    progress.innerHTML = `
      <div class="flex items-center justify-between gap-2 mb-1.5">
        <span class="text-xs font-medium mt-muted">${escapeHTML(t('workload.capacityDate', { date: formatDateID(selected) }))}</span>
        <strong class="text-sm font-bold font-mono-code mt-text">${selectedPercent}%</strong>
      </div>
      <div class="mt-calendar-progress-track">
        <div class="mt-calendar-progress-fill ${fillLevel}" style="width:${safeWidth}%"></div>
      </div>`;
  }
}

function openOrderDatePicker() {
  const pop = document.getElementById('order-date-picker');
  const input = document.getElementById('form-estimated-date');
  if (!pop || !input) return;
  const current = parseLocalDateKey(input.value);
  orderDatePickerSelectedDate = input.value || toLocalDateKey(new Date());
  orderDatePickerMonth = new Date(current || new Date());
  orderDatePickerMonth.setDate(1);
  pop.classList.remove('hidden');
  input.setAttribute('aria-expanded', 'true');
  renderOrderDatePicker();
}

function closeOrderDatePicker() {
  document.getElementById('order-date-picker')?.classList.add('hidden');
  document.getElementById('form-estimated-date')?.setAttribute('aria-expanded', 'false');
}

function bindOrderDatePicker() {
  const input = document.getElementById('form-estimated-date');
  input?.addEventListener('click', () => {
    const pop = document.getElementById('order-date-picker');
    if (pop && !pop.classList.contains('hidden')) closeOrderDatePicker();
    else openOrderDatePicker();
  });
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openOrderDatePicker();
    }
  });
  document.getElementById('order-date-prev')?.addEventListener('click', () => {
    orderDatePickerMonth = new Date(orderDatePickerMonth.getFullYear(), orderDatePickerMonth.getMonth() - 1, 1);
    renderOrderDatePicker();
  });
  document.getElementById('order-date-next')?.addEventListener('click', () => {
    orderDatePickerMonth = new Date(orderDatePickerMonth.getFullYear(), orderDatePickerMonth.getMonth() + 1, 1);
    renderOrderDatePicker();
  });
  document.getElementById('order-date-today')?.addEventListener('click', () => {
    const d = new Date();
    orderDatePickerSelectedDate = toLocalDateKey(d);
    orderDatePickerMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    renderOrderDatePicker();
  });
  document.getElementById('order-date-grid')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-order-date]');
    if (!button) return;
    orderDatePickerSelectedDate = button.dataset.orderDate;
    renderOrderDatePicker();
  });
  document.getElementById('order-date-confirm')?.addEventListener('click', () => {
    if (!orderDatePickerSelectedDate) return;
    input.value = orderDatePickerSelectedDate;
    clearEstimatedDateError();
    input.dispatchEvent(new Event('change', { bubbles: true }));
    triggerAutoSaveDraft();
    closeOrderDatePicker();
    input.focus();
  });
  document.addEventListener('click', (e) => {
    const pop = document.getElementById('order-date-picker');
    if (!pop || pop.classList.contains('hidden')) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    const clickedInside = path.includes(pop) || pop.contains(e.target);
    if (!clickedInside && e.target !== input) closeOrderDatePicker();
  });
}

function closeActiveDialogOnEscape() {
  const datePicker = document.getElementById('order-date-picker');
  if (datePicker && !datePicker.classList.contains('hidden')) {
    closeOrderDatePicker();
    document.getElementById('form-estimated-date')?.focus();
    return;
  }
  const serviceEditModal = document.getElementById('service-edit-modal');
  if (serviceEditModal && !serviceEditModal.classList.contains('hidden')) {
    closeServiceEditModal();
    return;
  }
  const storeModal = document.getElementById('store-settings-modal');
  if (storeModal && !storeModal.classList.contains('hidden')) {
    closeStoreSettings();
    return;
  }
  const customerFormModal = document.getElementById('customer-form-modal');
  if (customerFormModal && !customerFormModal.classList.contains('hidden')) {
    closeCustomerCreateForm();
    return;
  }
  const customerDetailModal = document.getElementById('customer-detail-modal');
  if (customerDetailModal && !customerDetailModal.classList.contains('hidden')) {
    closeCustomerDetailModal();
    return;
  }
  const cashModal = document.getElementById('cash-modal');
  if (cashModal && !cashModal.classList.contains('hidden')) {
    closeCashModal();
    return;
  }
  if (receiptModal && !receiptModal.classList.contains('hidden')) {
    closeReceiptModal();
    return;
  }
  if (paymentModal && !paymentModal.classList.contains('hidden')) {
    closePaymentModal();
    return;
  }
  if (orderFormModal && !orderFormModal.classList.contains('hidden')) {
    closeOrderModal();
  }
}

function closeCashModal() {
  document.getElementById('cash-modal')?.classList.add('hidden');
  restoreTriggerFocus();
}

function closePaymentModal() {
  paymentModal?.classList.add('hidden');
  restoreTriggerFocus();
}

function closeReceiptModal() {
  receiptModal?.classList.add('hidden');
  restoreTriggerFocus();
}

function closeCustomerDetailModal() {
  document.getElementById('customer-detail-modal')?.classList.add('hidden');
  const heading = document.getElementById('customer-detail-title');
  if (heading) heading.textContent = t('customers.detailTitle');
  restoreTriggerFocus();
}

function resetOrderFilters() {
  searchQuery = '';
  orderStatusFilter = 'all';
  workloadDateFilter = null;
  if (adminSearchInput) adminSearchInput.value = '';
  const statusSelect = document.getElementById('order-status-filter');
  if (statusSelect) statusSelect.value = 'all';
  renderWorkloadCalendar();
  renderOrdersList();
}

function bindGlobalEvents() {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeActiveDialogOnEscape();
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('[data-mt-lang-toggle]')) return;
    if (activeTenant) return;
    const next = getLocale() === 'en' ? 'id' : 'en';
    setLocale(next, { persist: true, storageKey: LOCALE_STORAGE_KEY });
    applyTranslations(document);
    document.title = t('admin.titleDefault');
    if (authScreen && !authScreen.classList.contains('hidden')) {
      setAuthMode(currentAuthMode);
    }
    if (onboardingScreen && !onboardingScreen.classList.contains('hidden')) {
      const onboardLocale = document.getElementById('onboard-locale');
      if (onboardLocale) onboardLocale.value = next;
      const onboardHours = document.getElementById('onboard-hours');
      if (onboardHours && !onboardingHoursTouched) onboardHours.value = t('common.defaultHours');
      if (adminDocHeading) adminDocHeading.textContent = t('admin.docHeadingOnboarding');
      updateOnboardingSlugPreview();
    }
  });

  document.querySelectorAll('[data-app-page]').forEach((button) =>
    button.addEventListener('click', () => {
      const page = button.dataset.appPage;
      if (page === 'settings') {
        openStoreSettings();
        return;
      }
      showAppPage(page);
    })
  );

  document.getElementById('report-period')?.addEventListener('change', renderReports);
  bindOrderDatePicker();
  document.getElementById('cash-period')?.addEventListener('change', renderCash);
  document.getElementById('cash-add-btn')?.addEventListener('click', openCashModal);
  document.getElementById('cash-modal-close')?.addEventListener('click', closeCashModal);
  document.getElementById('cash-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'cash-modal') closeCashModal();
  });
  document.getElementById('cash-type')?.addEventListener('change', updateCashCategoryOptions);
  document.getElementById('cash-form')?.addEventListener('submit', submitCashForm);
  document.getElementById('sidebar-new-order-btn')?.addEventListener('click', () => openOrderModal(null));
  document.getElementById('archive-orders-list')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-edit-order]');
    if (!button) return;
    const order = allOrders.find((item) => item.id === button.dataset.editOrder);
    if (order) openOrderModal(order);
  });

  authTabLogin?.addEventListener('click', () => setAuthMode('login'));
  authTabSignup?.addEventListener('click', () => setAuthMode('signup'));
  authModeTabs?.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const goSignup =
      event.key === 'End' ||
      (event.key === 'ArrowRight' && document.activeElement === authTabLogin) ||
      (event.key === 'ArrowLeft' && document.activeElement === authTabLogin);
    const nextMode = event.key === 'Home' ? 'login' : goSignup ? 'signup' : 'login';
    setAuthMode(nextMode);
    (nextMode === 'signup' ? authTabSignup : authTabLogin)?.focus();
  });
  document.getElementById('back-to-login-btn')?.addEventListener('click', () => setAuthMode('login'));

  googleSsoBtn?.addEventListener('click', async () => {
    clearAuthNotices();
    const prevLabel = googleSsoLabel?.textContent || t('admin.googleContinue');
    googleSsoBtn.disabled = true;
    if (googleSsoLabel) googleSsoLabel.textContent = t('admin.googleRedirecting');

    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: getAdminRedirectUrl(),
          queryParams: {
            prompt: 'select_account',
          },
        },
      });
      if (error) throw error;
    } catch (err) {
      showAuthError(err.message || t('admin.googleFailed'));
      googleSsoBtn.disabled = false;
      if (googleSsoLabel) googleSsoLabel.textContent = prevLabel;
    }
  });

  document.getElementById('copy-store-track-url-btn')?.addEventListener('click', async () => {
    const url = getPublicTrackingUrl();
    try {
      await navigator.clipboard.writeText(url);
      const btn = document.getElementById('copy-store-track-url-btn');
      if (btn) {
        btn.textContent = t('common.copied');
        setTimeout(() => {
          btn.textContent = t('common.copy');
        }, 1500);
      }
    } catch (_) {
      alert(t('settings.copyUrlAlert', { url }));
    }
  });

  loginForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAuthNotices();
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const submitBtn = document.getElementById('login-submit-btn');

    submitBtn.disabled = true;
    submitBtn.innerHTML = `<span>${escapeHTML(t('admin.loginVerifying'))}</span>`;

    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        if (/email not confirmed/i.test(error.message || '')) {
          showVerifyEmailPanel(email);
          return;
        }
        throw error;
      }
    } catch (err) {
      showAuthError(err.message || t('admin.loginFailed'));
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = `<i data-lucide="log-in" class="w-4 h-4" aria-hidden="true"></i><span>${escapeHTML(t('admin.loginSubmitBtn'))}</span>`;
      if (window.lucide) window.lucide.createIcons();
    }
  });

  signupForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAuthNotices();
    const email = document.getElementById('signup-email')?.value.trim() || '';
    const password = document.getElementById('signup-password')?.value || '';
    const confirmPassword = document.getElementById('signup-password-confirm')?.value || '';
    const submitBtn = document.getElementById('signup-submit-btn');

    if (!email) return showAuthError(t('admin.signupEmailRequired'));
    if (password.length < 8) return showAuthError(t('admin.signupPasswordMin'));
    if (password !== confirmPassword) return showAuthError(t('admin.signupPasswordMismatch'));

    submitBtn.disabled = true;
    submitBtn.innerHTML = `<span>${escapeHTML(t('admin.signupSubmitting'))}</span>`;

    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: getAdminRedirectUrl(),
        },
      });
      if (error) throw error;
      if (data?.session && data?.user?.email_confirmed_at) {
        await resolveAuthSession(data.session);
        return;
      }
      signupForm.reset();
      showVerifyEmailPanel(email);
    } catch (err) {
      showAuthError(err.message || t('admin.signupFailed'));
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = `<i data-lucide="user-plus" class="w-4 h-4" aria-hidden="true"></i><span>${escapeHTML(t('admin.signupSubmitBtn'))}</span>`;
      if (window.lucide) window.lucide.createIcons();
    }
  });

  document.getElementById('resend-verify-email-btn')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    const targetEmail = pendingVerifyEmail || document.getElementById('login-email')?.value.trim() || '';
    if (!targetEmail) {
      showAuthError(t('admin.verifyResendMissing'));
      return;
    }
    btn.disabled = true;
    try {
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email: targetEmail,
        options: {
          emailRedirectTo: getAdminRedirectUrl(),
        },
      });
      if (error) throw error;
      showAuthInfo(t('admin.verifyResendSuccess', { email: targetEmail }));
    } catch (err) {
      showAuthError(err.message || t('admin.verifyResendFailed'));
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('onboard-name')?.addEventListener('input', (event) => {
    if (onboardingSlugTouched) return;
    const slugInput = document.getElementById('onboard-slug');
    if (slugInput) {
      slugInput.value = slugifyWorkshopName(event.target.value);
      updateOnboardingSlugPreview();
    }
  });

  document.getElementById('onboard-slug')?.addEventListener('input', (event) => {
    onboardingSlugTouched = true;
    event.target.value = event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    updateOnboardingSlugPreview();
  });

  document.getElementById('onboard-hours')?.addEventListener('input', () => {
    onboardingHoursTouched = true;
  });

  document.getElementById('onboard-locale')?.addEventListener('change', (event) => {
    const chosen = event.target.value === 'en' ? 'en' : 'id';
    setLocale(chosen, { persist: true, storageKey: LOCALE_STORAGE_KEY });
    applyTranslations(document);
    const hoursEl = document.getElementById('onboard-hours');
    if (hoursEl && !onboardingHoursTouched) hoursEl.value = t('common.defaultHours');
    updateOnboardingSlugPreview();
  });

  document.getElementById('onboard-ticket-prefix')?.addEventListener('input', (event) => {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  });

  document.getElementById('store-ticket-prefix-input')?.addEventListener('input', (event) => {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  });

  document.getElementById('onboarding-logout-btn')?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    resetTenantState();
    showAuthScreen('login');
  });

  onboardingForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    onboardingErrorBox?.classList.add('hidden');
    const name = document.getElementById('onboard-name')?.value.trim() || '';
    const slug = (document.getElementById('onboard-slug')?.value || '').trim().toLowerCase();
    const phone = normalizePhone(document.getElementById('onboard-phone')?.value || '');
    const address = document.getElementById('onboard-address')?.value.trim() || '';
    const openingHours = document.getElementById('onboard-hours')?.value.trim() || '';
    const tagline = document.getElementById('onboard-tagline')?.value.trim() || '';
    const locale = document.getElementById('onboard-locale')?.value === 'en' ? 'en' : 'id';
    const currency = (document.getElementById('onboard-currency')?.value || 'IDR').trim().toUpperCase();
    const timezone = (document.getElementById('onboard-timezone')?.value || 'Asia/Jakarta').trim();
    const ticketPrefix = (document.getElementById('onboard-ticket-prefix')?.value || 'MND').trim().toUpperCase();
    const submitBtn = document.getElementById('onboard-submit-btn');

    if (!name) return showOnboardingError(t('admin.onboardNameRequired'));
    if (!isValidWorkshopSlug(slug)) {
      return showOnboardingError(t('admin.onboardSlugInvalid'));
    }
    if (!/^[A-Z0-9]{2,8}$/.test(ticketPrefix)) {
      return showOnboardingError(t('admin.onboardPrefixInvalid'));
    }

    submitBtn.disabled = true;
    submitBtn.innerHTML = `<span>${escapeHTML(t('admin.onboardSubmitting'))}</span>`;

    try {
      const { data: createdTenant, error } = await supabase.rpc('create_tenant_workspace', {
        p_name: name,
        p_slug: slug,
        p_admin_phone: phone,
        p_address: address,
        p_opening_hours: openingHours,
        p_tagline: tagline,
        p_daily_capacity_minutes: 480,
        p_locale: locale,
        p_currency: currency,
        p_timezone: timezone,
        p_ticket_prefix: ticketPrefix,
      });
      if (error) throw error;
      if (!createdTenant?.id) throw new Error(t('admin.onboardNoTenantReturned'));
      onboardingForm.reset();
      await enterWorkspace(createdTenant);
    } catch (err) {
      showOnboardingError(err.message || t('admin.onboardCreateFailed'));
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = `<i data-lucide="store" class="w-4 h-4" aria-hidden="true"></i><span>${escapeHTML(t('admin.onboardSubmitBtn'))}</span>`;
      if (window.lucide) window.lucide.createIcons();
    }
  });

  openStoreSettingsBtn?.addEventListener('click', openStoreSettings);
  document.getElementById('close-store-settings-btn')?.addEventListener('click', closeStoreSettings);
  document.getElementById('cancel-store-settings-btn')?.addEventListener('click', closeStoreSettings);
  document.getElementById('store-settings-modal')?.addEventListener('click', (event) => {
    if (event.target.id === 'store-settings-modal') closeStoreSettings();
  });

  document.getElementById('store-logo-input')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await imageFileToDataUrl(file);
      document.getElementById('store-settings-modal').dataset.pendingLogo = dataUrl;
      renderStoreLogoPreview(dataUrl);
    } catch (error) {
      alert(error.message || t('settings.logoReadFailed'));
      event.target.value = '';
    }
  });

  document.getElementById('remove-store-logo-btn')?.addEventListener('click', () => {
    document.getElementById('store-settings-modal').dataset.pendingLogo = '';
    renderStoreLogoPreview('');
  });

  document.getElementById('store-settings-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const modal = document.getElementById('store-settings-modal');
    const ticketPrefix = (document.getElementById('store-ticket-prefix-input')?.value || '').trim().toUpperCase();
    const settings = {
      NAME: document.getElementById('store-name-input').value.trim(),
      ADDRESS: document.getElementById('store-address-input').value.trim(),
      ADMIN_PHONE: normalizePhone(document.getElementById('store-phone-input').value),
      TAGLINE: document.getElementById('store-tagline-input').value.trim(),
      OPENING_HOURS: document.getElementById('store-hours-input').value.trim(),
      LOCALE: document.getElementById('store-locale-input')?.value === 'en' ? 'en' : 'id',
      CURRENCY: (document.getElementById('store-currency-input')?.value || 'IDR').trim().toUpperCase(),
      TIMEZONE: (document.getElementById('store-timezone-input')?.value || 'Asia/Jakarta').trim(),
      TICKET_PREFIX: ticketPrefix,
      DAILY_CAPACITY_MINUTES:
        Number(document.getElementById('daily-capacity-hours').value || 0) * 60 +
        Number(document.getElementById('daily-capacity-minutes').value || 0),
      LOGO: Object.prototype.hasOwnProperty.call(modal.dataset, 'pendingLogo')
        ? modal.dataset.pendingLogo
        : workshopSettings.LOGO,
    };
    if (!settings.NAME) {
      alert(t('settings.nameRequired'));
      return;
    }
    if (!/^[A-Z0-9]{2,8}$/.test(settings.TICKET_PREFIX)) {
      alert(t('settings.prefixInvalid'));
      document.getElementById('store-ticket-prefix-input')?.focus();
      return;
    }
    if (!Number.isInteger(settings.DAILY_CAPACITY_MINUTES) || settings.DAILY_CAPACITY_MINUTES <= 0) {
      alert(t('settings.capacityInvalid'));
      return;
    }
    try {
      const tenantId = getActiveTenantId();
      if (!tenantId) throw new Error(t('common.noActiveTenant'));
      await persistStoreSettings(tenantId, settings);
      workshopSettings = await fetchStoreSettings(tenantId);
      if (activeTenant) {
        activeTenant = {
          ...activeTenant,
          name: workshopSettings.NAME,
          address: workshopSettings.ADDRESS,
          admin_phone: workshopSettings.ADMIN_PHONE,
          tagline: workshopSettings.TAGLINE,
          opening_hours: workshopSettings.OPENING_HOURS,
          logo_data_url: workshopSettings.LOGO || null,
          daily_capacity_minutes: workshopSettings.DAILY_CAPACITY_MINUTES,
          locale: workshopSettings.LOCALE,
          currency: workshopSettings.CURRENCY,
          timezone: workshopSettings.TIMEZONE,
          ticket_prefix: workshopSettings.TICKET_PREFIX,
        };
      }
      setLocale(workshopSettings.LOCALE);
      setCurrency(workshopSettings.CURRENCY);
      setTimezone(workshopSettings.TIMEZONE);
      applyStoreSettings();
      applyWorkspaceLocalization();
      delete modal.dataset.pendingLogo;
      closeStoreSettings();
      alert(t('settings.savedSuccess'));
    } catch (error) {
      alert(t('settings.saveFailed', { message: error.message || t('settings.saveFailedHint') }));
    }
  });

  document.getElementById('add-service-btn')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const nameInput = document.getElementById('service-name-input');
    const categoryInput = document.getElementById('service-category-input');
    const hoursInput = document.getElementById('service-hours-input');
    const minutesInput = document.getElementById('service-minutes-input');
    const hours = Number(hoursInput.value || 0);
    const minutes = Number(minutesInput.value || 0);
    const total = hours * 60 + minutes;
    const name = nameInput.value.trim();
    const category = categoryInput?.value === 'custom' ? 'custom' : 'reparasi';
    if (!name) {
      alert(t('services.nameRequired'));
      nameInput.focus();
      return;
    }
    if (!Number.isInteger(hours) || hours < 0 || !Number.isInteger(minutes) || minutes < 0 || minutes > 59 || total <= 0) {
      alert(t('services.durationInvalid'));
      return;
    }
    button.disabled = true;
    button.textContent = t('common.saving');
    try {
      const tenantId = getActiveTenantId();
      if (!tenantId) throw new Error(t('common.noActiveTenant'));
      await createService(tenantId, name, total, category);
      nameInput.value = '';
      if (categoryInput) categoryInput.value = 'reparasi';
      hoursInput.value = '1';
      minutesInput.value = '0';
      await renderServicesList();
      await loadWorkloadServices();
      renderWorkloadCalendar();
    } catch (error) {
      console.error('Gagal menambah layanan:', error);
      alert(t('services.addFailed', { message: error.message || t('services.addFailedHint') }));
    } finally {
      button.disabled = false;
      button.textContent = t('services.addBtn');
    }
  });

  document.getElementById('close-service-edit-btn')?.addEventListener('click', closeServiceEditModal);
  document.getElementById('cancel-service-edit-btn')?.addEventListener('click', closeServiceEditModal);
  document.getElementById('service-edit-modal')?.addEventListener('click', (event) => {
    if (event.target.id === 'service-edit-modal') closeServiceEditModal();
  });
  document.getElementById('service-edit-form')?.addEventListener('submit', handleServiceEditSubmit);

  document.getElementById('services-list')?.addEventListener('click', async (event) => {
    const tenantId = getActiveTenantId();
    if (!tenantId) return;
    const editButton = event.target.closest('[data-edit-service]');
    const disableButton = event.target.closest('[data-disable-service]');
    const activateButton = event.target.closest('[data-activate-service]');
    if (editButton) {
      const id = editButton.dataset.editService;
      const current = (await fetchServices(tenantId)).find((item) => item.id === id);
      if (current) openServiceEditModal(current);
    }
    if (disableButton && confirm(t('services.disableConfirm'))) {
      try {
        await deactivateService(tenantId, disableButton.dataset.disableService);
        await renderServicesList();
        await loadWorkloadServices();
        renderWorkloadCalendar();
      } catch (error) {
        alert(t('services.disableFailed', { message: error.message }));
      }
    }
    if (activateButton) {
      try {
        await activateService(tenantId, activateButton.dataset.activateService);
        await renderServicesList();
        await loadWorkloadServices();
        renderWorkloadCalendar();
      } catch (error) {
        alert(t('services.activateFailed', { message: error.message }));
      }
    }
  });

  logoutBtn?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    resetTenantState();
    showAuthScreen('login');
  });

  bindWorkloadCalendarEvents();

  adminSearchInput?.addEventListener(
    'input',
    debounce((e) => {
      searchQuery = e.target.value.trim().toLowerCase();
      renderOrdersList();
    }, 250)
  );

  document.getElementById('order-status-filter')?.addEventListener('change', (event) => {
    orderStatusFilter = event.target.value || 'all';
    renderOrdersList();
  });
  document.getElementById('clear-order-filters')?.addEventListener('click', resetOrderFilters);
  refreshOrdersBtn?.addEventListener('click', () => renderOrdersList());

  document.getElementById('bottom-nav-customers')?.addEventListener('click', () => showAppPage('customers'));
  document.getElementById('bottom-nav-orders')?.addEventListener('click', () => showAppPage('orders'));
  document.getElementById('customers-search-input')?.addEventListener('input', debounce(renderCustomersList, 200));
  document.getElementById('open-add-customer-from-list-btn')?.addEventListener('click', openCustomerCreateForm);
  document.getElementById('close-customer-form-btn')?.addEventListener('click', closeCustomerCreateForm);
  document.getElementById('cancel-customer-form-btn')?.addEventListener('click', closeCustomerCreateForm);
  document.getElementById('customer-form-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'customer-form-modal') closeCustomerCreateForm();
  });
  document.getElementById('customer-create-form')?.addEventListener('submit', handleCustomerCreateSubmit);
  customersList?.addEventListener('click', handleCustomerListAction);
  document.getElementById('close-customer-detail-btn')?.addEventListener('click', closeCustomerDetailModal);
  document.getElementById('customer-detail-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'customer-detail-modal') closeCustomerDetailModal();
  });
  document.getElementById('customer-detail-content')?.addEventListener('click', handleCustomerDetailAction);
  document.getElementById('customer-detail-content')?.addEventListener('change', handleMeasurementFormChange);
  document.getElementById('customer-detail-content')?.addEventListener('submit', handleCustomerEditSubmit);
  document.getElementById('measurement-templates-list')?.addEventListener('click', handleMeasurementTemplateAction);
  document.getElementById('add-measurement-template-btn')?.addEventListener('click', addMeasurementTemplate);

  restoreDraftBtn?.addEventListener('click', () => {
    const draft = loadOrderDraft(getActiveTenantId());
    if (draft && draft.data) {
      openOrderModal(null, draft.data);
      draftBanner?.classList.add('hidden');
    }
  });
  discardDraftBtn?.addEventListener('click', () => {
    clearOrderDraft(getActiveTenantId());
    draftBanner?.classList.add('hidden');
  });

  openNewOrderBtn?.addEventListener('click', () => {
    const selectedDate = workloadDateFilter || workloadSelectedDate;
    openOrderModal(null, { estimated_done_date: selectedDate });
  });
  closeOrderModalBtn?.addEventListener('click', closeOrderModal);
  cancelOrderModalBtn?.addEventListener('click', closeOrderModal);
  orderFormModal?.addEventListener('click', (e) => {
    if (e.target === orderFormModal) closeOrderModal();
  });

  addItemRowBtn?.addEventListener('click', () => {
    appendItemRow();
    recalculateFormTotals();
    triggerAutoSaveDraft();
  });

  formPaidAmountInput?.addEventListener('input', () => {
    recalculateFormTotals();
    triggerAutoSaveDraft();
  });

  orderCrudForm?.addEventListener('input', () => {
    triggerAutoSaveDraft();
  });

  const customerPhoneInput = document.getElementById('form-customer-phone');
  customerPhoneInput?.addEventListener(
    'input',
    debounce(() => {
      checkCustomerPhoneInForm();
    }, 450)
  );
  customerPhoneInput?.addEventListener('blur', checkCustomerPhoneInForm);
  orderCrudForm?.addEventListener('submit', handleSaveOrderSubmit);

  closePaymentModalBtn?.addEventListener('click', closePaymentModal);
  paymentModal?.addEventListener('click', (e) => {
    if (e.target === paymentModal) closePaymentModal();
  });
  payFullQuickBtn?.addEventListener('click', () => {
    const total = Number(payFullQuickBtn.dataset.totalAmount || 0);
    document.getElementById('pay-new-paid-input').value = total;
  });
  paymentForm?.addEventListener('submit', handlePaymentSubmit);

  closeReceiptModalBtn?.addEventListener('click', closeReceiptModal);
  receiptModal?.addEventListener('click', (e) => {
    if (e.target === receiptModal) closeReceiptModal();
  });
  printReceiptBtn?.addEventListener('click', () => window.print());
  copyReceiptWaBtn?.addEventListener('click', handleSendReceiptViaWA);
  closeWaToastBtn?.addEventListener('click', () => waReadyToast?.classList.add('hidden'));
}

async function fetchCustomers() {
  const tenantId = getActiveTenantId();
  if (!customersList || !tenantId) return;
  customersList.innerHTML = `<p class="py-5 text-center text-sm mt-muted" role="status">${escapeHTML(t('customers.loading'))}</p>`;
  const { data, error } = await supabase
    .from('customers')
    .select('id, name, phone, created_at, updated_at')
    .eq('tenant_id', tenantId)
    .order('name', { ascending: true });
  if (error) {
    customersList.innerHTML = `<div role="alert" class="py-4 text-sm mt-danger-text flex items-center justify-between gap-2">
      <span>${escapeHTML(t('customers.loadFailed', { message: error.message }))}</span>
      <button type="button" data-retry-customers class="mt-btn mt-btn-secondary text-xs">${escapeHTML(t('common.reload'))}</button>
    </div>`;
    customersList.querySelector('[data-retry-customers]')?.addEventListener('click', fetchCustomers);
    return;
  }
  customerRecords = data || [];
  renderCustomersList();
}

function renderCustomersList() {
  if (!customersList) return;
  const query = (document.getElementById('customers-search-input')?.value || '').trim().toLowerCase();
  const filtered = customerRecords.filter((customer) =>
    `${customer.name} ${customer.phone}`.toLowerCase().includes(query)
  );
  const count = document.getElementById('customers-count');
  if (count) count.textContent = t('customers.count', { count: customerRecords.length });
  if (!filtered.length) {
    customersList.innerHTML = query
      ? `<p class="py-6 text-center text-sm mt-muted">${escapeHTML(t('customers.emptySearch'))}</p>`
      : `<p class="py-6 text-center text-sm mt-muted">${escapeHTML(t('customers.emptyList'))}</p>`;
    return;
  }
  customersList.innerHTML = filtered
    .map(
      (customer) => `
    <div class="py-3 flex items-center gap-2 border-b last:border-0 min-w-0" style="border-color: var(--mt-border);">
      <div class="min-w-0 flex-1 text-left">
        <span class="block text-sm font-semibold mt-text truncate">${escapeHTML(customer.name)}</span>
        <span class="block text-xs mt-muted font-mono-code truncate">${escapeHTML(customer.phone)}</span>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <button type="button" data-customer-edit="${customer.id}" class="mt-btn-icon mt-btn-secondary" title="${escapeHTML(t('customers.editTitle'))}" aria-label="${escapeHTML(t('customers.editAria', { name: customer.name }))}">
          <i data-lucide="pencil" class="w-4 h-4" aria-hidden="true"></i>
        </button>
        <button type="button" data-customer-order="${customer.id}" class="mt-btn-icon mt-btn-primary" title="${escapeHTML(t('customers.addOrderTitle'))}" aria-label="${escapeHTML(t('customers.addOrderAria', { name: customer.name }))}">
          <i data-lucide="plus" class="w-5 h-5" aria-hidden="true"></i>
        </button>
      </div>
    </div>`
    )
    .join('');
  if (window.lucide) window.lucide.createIcons();
}

async function handleCustomerListAction(event) {
  const editButton = event.target.closest('[data-customer-edit]');
  const orderButton = event.target.closest('[data-customer-order]');
  const id = editButton?.dataset.customerEdit || orderButton?.dataset.customerOrder;
  if (!id) return;
  const customer = customerRecords.find((item) => item.id === id);
  if (!customer) return;
  if (orderButton) {
    showAppPage('orders');
    openOrderModal(null, { customer_name: customer.name, customer_phone: customer.phone });
    return;
  }
  if (editButton) openCustomerEdit(customer);
}

function openCustomerCreateForm() {
  const modal = document.getElementById('customer-form-modal');
  const form = document.getElementById('customer-create-form');
  rememberTrigger();
  form?.reset();
  modal?.classList.remove('hidden');
  document.getElementById('new-customer-name')?.focus();
  if (window.lucide) window.lucide.createIcons();
}

function closeCustomerCreateForm() {
  document.getElementById('customer-form-modal')?.classList.add('hidden');
  restoreTriggerFocus();
}

async function handleCustomerCreateSubmit(event) {
  event.preventDefault();
  const submit = document.getElementById('save-customer-btn');
  const name = document.getElementById('new-customer-name')?.value.trim() || '';
  const phone = normalizePhone(document.getElementById('new-customer-phone')?.value || '');

  if (!name) return alert(t('customers.nameRequired'));
  if (!phone || phone.length < 10) return alert(t('customers.phoneInvalid'));

  submit.disabled = true;
  submit.textContent = t('common.saving');
  try {
    const existing = await findCustomerByPhone(phone);
    if (existing) {
      throw new Error(t('customers.duplicatePhone', { name: existing.name }));
    }

    const tenantId = getActiveTenantId();
    if (!tenantId) throw new Error(t('common.noActiveTenant'));

    const { data, error } = await supabase
      .from('customers')
      .insert({ tenant_id: tenantId, name, phone })
      .select('id, name, phone, created_at, updated_at')
      .single();
    if (error) throw error;

    if (data) {
      customerRecords = [...customerRecords.filter((item) => item.id !== data.id), data].sort((a, b) =>
        a.name.localeCompare(b.name, getLocale())
      );
    }
    closeCustomerCreateForm();
    await fetchCustomers();
    alert(t('customers.createdSuccess'));
  } catch (error) {
    alert(t('customers.createFailed', { message: error.message || t('common.genericError') }));
  } finally {
    submit.disabled = false;
    submit.textContent = t('customers.saveBtn');
  }
}

let activeCustomerDetail = null;
let activeMeasurementTemplates = [];
let activeMeasurementTemplateFields = [];
let customerMeasurementRecords = [];

async function fetchMeasurementTemplates() {
  const tenantId = getActiveTenantId();
  if (!tenantId) return [];
  const { data: templates, error: templateError } = await supabase
    .from('measurement_templates')
    .select('id, garment_type, description, is_active, created_at')
    .eq('tenant_id', tenantId)
    .order('garment_type', { ascending: true });
  if (templateError) throw templateError;
  const { data: fields, error: fieldError } = await supabase
    .from('measurement_template_fields')
    .select('id, template_id, field_key, field_label, unit, is_required, sort_order, is_active')
    .eq('tenant_id', tenantId)
    .order('sort_order', { ascending: true });
  if (fieldError) throw fieldError;
  activeMeasurementTemplates = templates || [];
  activeMeasurementTemplateFields = fields || [];
  return activeMeasurementTemplates;
}

async function fetchCustomerMeasurements(customerId) {
  const tenantId = getActiveTenantId();
  if (!tenantId) return [];
  const { data, error } = await supabase
    .from('customer_measurements')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  customerMeasurementRecords = data || [];
  return customerMeasurementRecords;
}

function openCustomerEdit(customer = activeCustomerDetail) {
  if (!customer) return;
  const modal = document.getElementById('customer-detail-modal');
  if (modal?.classList.contains('hidden')) rememberTrigger();
  activeCustomerDetail = customer;
  const content = document.getElementById('customer-detail-content');
  const heading = document.getElementById('customer-detail-title');
  if (heading) heading.textContent = t('customers.editHeading');
  content.innerHTML = `
    <form id="customer-edit-form" class="space-y-4">
      <div>
        <label for="edit-customer-name" class="block text-xs font-semibold mt-text mb-1">${escapeHTML(t('customers.nameLabelOpt'))}</label>
        <input id="edit-customer-name" type="text" required maxlength="120" value="${escapeHTML(customer.name)}" class="mt-input" />
      </div>
      <div>
        <label for="edit-customer-phone" class="block text-xs font-semibold mt-text mb-1">${escapeHTML(t('customers.phoneLabelWa'))}</label>
        <input id="edit-customer-phone" type="tel" inputmode="tel" required value="${escapeHTML(customer.phone)}" class="mt-input font-mono-code" />
      </div>
      <div class="grid grid-cols-1 gap-3 pt-1">
        <button type="button" data-customer-detail-view="measurements" class="mt-card-muted min-h-16 p-3 text-left flex items-center gap-3 hover:border-[var(--mt-accent)]">
          <span class="w-10 h-10 rounded-lg mt-card flex items-center justify-center shrink-0" aria-hidden="true">
            <i data-lucide="ruler" class="w-5 h-5 mt-text"></i>
          </span>
          <span>
            <strong class="block text-sm mt-text">${escapeHTML(t('customers.measurementsBtnTitle'))}</strong>
            <small class="text-xs mt-muted">${escapeHTML(t('customers.measurementsBtnDesc'))}</small>
          </span>
          <i data-lucide="chevron-right" class="w-4 h-4 ml-auto mt-muted" aria-hidden="true"></i>
        </button>
        <button type="button" data-customer-detail-view="orders" class="mt-card-muted min-h-16 p-3 text-left flex items-center gap-3 hover:border-[var(--mt-accent)]">
          <span class="w-10 h-10 rounded-lg mt-card flex items-center justify-center shrink-0" aria-hidden="true">
            <i data-lucide="clipboard-list" class="w-5 h-5 mt-text"></i>
          </span>
          <span>
            <strong class="block text-sm mt-text">${escapeHTML(t('customers.ordersBtnTitle'))}</strong>
            <small class="text-xs mt-muted">${escapeHTML(t('customers.ordersBtnDesc'))}</small>
          </span>
          <i data-lucide="chevron-right" class="w-4 h-4 ml-auto mt-muted" aria-hidden="true"></i>
        </button>
      </div>
      <div class="flex gap-2 pt-2">
        <button type="button" data-customer-detail-close class="mt-btn mt-btn-secondary flex-1">${escapeHTML(t('common.close'))}</button>
        <button type="submit" class="mt-btn mt-btn-primary flex-1">${escapeHTML(t('common.saveChanges'))}</button>
      </div>
    </form>`;
  modal?.classList.remove('hidden');
  document.getElementById('edit-customer-name')?.focus();
  if (window.lucide) window.lucide.createIcons();
}

async function handleCustomerEditSubmit(event) {
  if (event.target.id !== 'customer-edit-form') return;
  event.preventDefault();
  const name = document.getElementById('edit-customer-name')?.value.trim() || '';
  const phone = normalizePhone(document.getElementById('edit-customer-phone')?.value || '');
  if (!name) return alert(t('customers.nameRequired'));
  if (!phone || phone.length < 10) return alert(t('customers.phoneInvalidWa'));
  const duplicate = customerRecords.find((item) => item.id !== activeCustomerDetail.id && item.phone === phone);
  if (duplicate) return alert(t('customers.duplicatePhoneShort', { name: duplicate.name }));
  const submit = event.target.querySelector('button[type="submit"]');
  if (submit) {
    submit.disabled = true;
    submit.textContent = t('common.saving');
  }
  const tenantId = getActiveTenantId();
  if (!tenantId) return alert(t('common.noActiveTenant'));
  const { data, error } = await supabase
    .from('customers')
    .update({ name, phone, updated_at: new Date().toISOString() })
    .eq('id', activeCustomerDetail.id)
    .eq('tenant_id', tenantId)
    .select('id, name, phone, created_at, updated_at')
    .single();
  if (error) {
    if (submit) {
      submit.disabled = false;
      submit.textContent = t('common.saveChanges');
    }
    return alert(t('customers.updateFailed', { message: error.message }));
  }
  activeCustomerDetail = data;
  await fetchCustomers();
  openCustomerEdit(data);
  alert(t('customers.updatedSuccess'));
}

async function handleCustomerDetailAction(event) {
  const viewButton = event.target.closest('[data-customer-detail-view]');
  const backButton = event.target.closest('[data-customer-detail-back]');
  const addButton = event.target.closest('[data-add-customer-measurement]');
  const editButton = event.target.closest('[data-edit-customer-measurement]');
  const deleteButton = event.target.closest('[data-delete-customer-measurement]');
  const closeButton = event.target.closest('[data-customer-detail-close]');
  if (closeButton) return closeCustomerDetailModal();
  if (backButton) return openCustomerEdit(activeCustomerDetail);
  if (viewButton?.dataset.customerDetailView === 'measurements') return renderCustomerMeasurements();
  if (viewButton?.dataset.customerDetailView === 'orders') return renderCustomerOrderHistory();
  if (addButton) return openCustomerMeasurementForm();
  if (editButton) {
    const record = customerMeasurementRecords.find((item) => item.id === editButton.dataset.editCustomerMeasurement);
    if (record) return openCustomerMeasurementForm(record);
  }
  if (deleteButton) {
    const tenantId = getActiveTenantId();
    if (!tenantId) return;
    const id = deleteButton.dataset.deleteCustomerMeasurement;
    if (!confirm(t('measure.deleteConfirm'))) return;
    const { error } = await supabase
      .from('customer_measurements')
      .delete()
      .eq('id', id)
      .eq('customer_id', activeCustomerDetail.id)
      .eq('tenant_id', tenantId);
    if (error) return alert(t('measure.deleteFailed', { message: error.message }));
    await renderCustomerMeasurements();
  }
  const orderButton = event.target.closest('[data-customer-open-order]');
  if (orderButton) {
    const order = allOrders.find((item) => item.id === orderButton.dataset.customerOpenOrder);
    if (order) {
      closeCustomerDetailModal();
      showAppPage('orders');
      openOrderModal(order);
    }
  }
}

async function renderCustomerMeasurements() {
  const content = document.getElementById('customer-detail-content');
  const modalHeading = document.getElementById('customer-detail-title');
  if (modalHeading) modalHeading.textContent = t('measure.listTitle');
  content.innerHTML = `<p class="py-6 text-center text-sm mt-muted" role="status">${escapeHTML(t('measure.loadingList'))}</p>`;
  try {
    await Promise.all([fetchCustomerMeasurements(activeCustomerDetail.id), fetchMeasurementTemplates()]);
    content.innerHTML = `
      <div class="flex items-center justify-between gap-2">
        <div>
          <h3 class="font-bold mt-text">${escapeHTML(t('measure.listTitle'))}</h3>
          <p class="text-xs mt-muted">${escapeHTML(activeCustomerDetail.name)}</p>
        </div>
        <button type="button" data-customer-detail-back class="mt-btn mt-btn-secondary text-xs">${escapeHTML(t('common.back'))}</button>
      </div>
      <button type="button" data-add-customer-measurement class="mt-btn mt-btn-primary w-full">
        <i data-lucide="plus" class="w-4 h-4" aria-hidden="true"></i>
        <span>${escapeHTML(t('measure.addBtn'))}</span>
      </button>
      <div class="space-y-2.5">
        ${
          customerMeasurementRecords.length
            ? customerMeasurementRecords
                .map((record) => {
                  const values = Object.entries(record.measurement_data || {})
                    .slice(0, 4)
                    .map(([key, value]) => {
                      const field = (record.template_snapshot || []).find((item) => item.field_key === key);
                      const displayUnit = getMeasurementDisplayUnit();
                      const storedUnit = field?.unit || 'cm';
                      const displayValue = convertMeasurementValue(value, storedUnit, displayUnit);
                      return `<span class="inline-block text-xs mt-text mt-card-muted px-2 py-1 mr-1 mb-1 font-mono-code">${escapeHTML(field?.field_label || key)}: ${escapeHTML(String(Number(displayValue.toFixed(2))))} ${displayUnit === 'inch' ? 'in' : 'cm'}</span>`;
                    })
                    .join('');
                  return `<article class="mt-card p-3.5">
                    <div class="flex items-start justify-between gap-2">
                      <div class="min-w-0">
                        <p class="text-sm font-bold mt-text">${escapeHTML(record.garment_type)}${record.model ? ` · ${escapeHTML(record.model)}` : ''}</p>
                        <p class="text-xs mt-muted mt-0.5">${escapeHTML(record.description || t('measure.noDesc'))}</p>
                      </div>
                      <div class="flex gap-1.5 shrink-0">
                        <button type="button" data-edit-customer-measurement="${record.id}" class="mt-btn-icon mt-btn-secondary" aria-label="${escapeHTML(t('measure.editAria', { type: record.garment_type }))}">
                          <i data-lucide="pencil" class="w-4 h-4" aria-hidden="true"></i>
                        </button>
                        <button type="button" data-delete-customer-measurement="${record.id}" class="mt-btn-icon mt-btn-danger-ghost" aria-label="${escapeHTML(t('measure.deleteAria', { type: record.garment_type }))}">
                          <i data-lucide="trash-2" class="w-4 h-4" aria-hidden="true"></i>
                        </button>
                      </div>
                    </div>
                    <div class="mt-2">${values || `<span class="text-xs mt-muted">${escapeHTML(t('measure.noValues'))}</span>`}</div>
                  </article>`;
                })
                .join('')
            : `<p class="py-6 text-center text-sm mt-muted mt-card-muted">${escapeHTML(t('measure.emptyList'))}</p>`
        }
      </div>`;
    if (window.lucide) window.lucide.createIcons();
  } catch (error) {
    content.innerHTML = `<p class="text-sm mt-danger-text">${escapeHTML(t('measure.loadFailed', { message: error.message || '' }))}</p><button type="button" data-customer-detail-back class="mt-btn mt-btn-secondary mt-3 text-xs">${escapeHTML(t('common.back'))}</button>`;
  }
}

function renderCustomerOrderHistory() {
  const modalHeading = document.getElementById('customer-detail-title');
  if (modalHeading) modalHeading.textContent = t('customers.ordersBtnTitle');
  const content = document.getElementById('customer-detail-content');
  const transactions = allOrders
    .filter((order) => order.customer_id === activeCustomerDetail.id || normalizePhone(order.customer_phone) === activeCustomerDetail.phone)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  content.innerHTML = `
    <div class="flex items-center justify-between gap-2">
      <div>
        <h3 class="font-bold mt-text">${escapeHTML(t('customers.ordersBtnTitle'))}</h3>
        <p class="text-xs mt-muted">${escapeHTML(t('customers.transactionsCount', { count: transactions.length }))}</p>
      </div>
      <button type="button" data-customer-detail-back class="mt-btn mt-btn-secondary text-xs">${escapeHTML(t('common.back'))}</button>
    </div>
    ${
      transactions.length
        ? `<div class="space-y-2">${transactions
            .map((order) => {
              const meta = getStatusMeta(order.status);
              return `<button type="button" data-customer-open-order="${order.id}" class="w-full text-left mt-card p-3.5 hover:border-[var(--mt-accent)]">
                <div class="flex items-center justify-between gap-2">
                  <span class="font-mono-code text-sm font-bold mt-text">${escapeHTML(order.ticket_code)}</span>
                  <span class="${meta.badgeClass}">${escapeHTML(meta.label)}</span>
                </div>
                <div class="flex items-center justify-between gap-2 mt-1.5">
                  <span class="text-xs mt-muted">${escapeHTML(formatDateID(order.created_at))}</span>
                  <span class="text-sm font-mono-code font-semibold mt-text">${escapeHTML(formatCurrency(order.total_amount))}</span>
                </div>
              </button>`;
            })
            .join('')}</div>`
        : `<p class="text-xs mt-muted py-6 text-center mt-card-muted">${escapeHTML(t('customers.noOrderHistory'))}</p>`
    }`;
}

function getActiveTemplateFields(templateId) {
  return activeMeasurementTemplateFields
    .filter((field) => field.template_id === templateId && field.is_active)
    .sort((a, b) => a.sort_order - b.sort_order);
}

function getMeasurementDisplayUnit() {
  return localStorage.getItem('mendtrack-measurement-unit') === 'inch' ? 'inch' : 'cm';
}

function convertMeasurementValue(value, fromUnit, toUnit) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  const from = String(fromUnit || 'cm').toLowerCase();
  const to = String(toUnit || 'cm').toLowerCase();
  if (from === to) return number;
  if (from === 'cm' && to === 'inch') return number / 2.54;
  if ((from === 'inch' || from === 'in' || from === 'inches') && to === 'cm') return number * 2.54;
  return number;
}

function renderMeasurementFields(fields, values = {}) {
  if (!fields.length) {
    return `<p class="text-xs mt-muted mt-card-muted p-3">${escapeHTML(t('measure.noFieldsInTemplate'))}</p>`;
  }
  const displayUnit = getMeasurementDisplayUnit();
  return fields
    .map((field, idx) => {
      const storedValue = values[field.field_key];
      const displayValue =
        storedValue === undefined || storedValue === null || storedValue === ''
          ? ''
          : Number(convertMeasurementValue(storedValue, field.unit || 'cm', displayUnit).toFixed(2));
      const inputId = `measure-field-${idx}-${escapeHTML(field.field_key)}`;
      return `<div>
        <label for="${inputId}" class="block text-xs font-semibold mt-text mb-1">${escapeHTML(field.field_label)}</label>
        <div class="flex items-center gap-2">
          <input id="${inputId}" type="number" inputmode="decimal" step="0.1" data-measurement-value="${escapeHTML(field.field_key)}" data-storage-unit="${escapeHTML(field.unit || 'cm')}" value="${displayValue}" class="mt-input font-mono-code" />
          <span class="text-xs mt-muted min-w-8 font-mono-code">${displayUnit === 'inch' ? 'in' : 'cm'}</span>
        </div>
      </div>`;
    })
    .join('');
}

async function openCustomerMeasurementForm(record = null) {
  const content = document.getElementById('customer-detail-content');
  try {
    await fetchMeasurementTemplates();
    const activeTemplates = activeMeasurementTemplates.filter((item) => item.is_active);
    const initialTemplate =
      activeTemplates.find((item) => item.id === record?.template_id) ||
      activeTemplates.find((item) => item.garment_type === record?.garment_type) ||
      activeTemplates[0];
    if (!initialTemplate) {
      throw new Error(t('measure.noTemplateError'));
    }
    const snapshotFields = record?.template_snapshot?.length ? record.template_snapshot : null;
    const fields = snapshotFields || getActiveTemplateFields(initialTemplate.id);
    content.innerHTML = `
      <div class="flex items-center justify-between gap-2">
        <div>
          <h3 class="font-bold mt-text">${escapeHTML(record ? t('measure.editTitle') : t('measure.addBtn'))}</h3>
          <p class="text-xs mt-muted">${escapeHTML(activeCustomerDetail.name)}</p>
        </div>
        <button type="button" data-customer-detail-back class="mt-btn mt-btn-secondary text-xs">${escapeHTML(t('common.cancel'))}</button>
      </div>
      <form id="customer-measurement-form" class="space-y-3" data-edit-id="${record?.id || ''}">
        <div>
          <label for="measurement-garment-type" class="block text-xs font-semibold mt-text mb-1">${escapeHTML(t('measure.garmentTypeLabel'))}</label>
          <select id="measurement-garment-type" required class="mt-select">
            ${activeTemplates
              .map((item) => `<option value="${item.id}" ${item.id === initialTemplate.id ? 'selected' : ''}>${escapeHTML(item.garment_type)}</option>`)
              .join('')}
          </select>
        </div>
        <div>
          <label for="measurement-model" class="block text-xs font-semibold mt-text mb-1">${escapeHTML(t('measure.modelLabel'))}</label>
          <input id="measurement-model" type="text" maxlength="100" value="${escapeHTML(record?.model || '')}" placeholder="${escapeHTML(t('measure.modelPlaceholder'))}" class="mt-input" />
        </div>
        <div>
          <label for="measurement-description" class="block text-xs font-semibold mt-text mb-1">${escapeHTML(t('measure.descLabel'))}</label>
          <input id="measurement-description" type="text" maxlength="160" value="${escapeHTML(record?.description || '')}" placeholder="${escapeHTML(t('measure.descPlaceholder'))}" class="mt-input" />
        </div>
        <div class="pt-3 mt-seam-t">
          <h4 class="text-sm font-bold mt-text mb-3">${escapeHTML(t('measure.dataHeading'))}</h4>
          <div id="measurement-fields-grid" class="grid grid-cols-1 sm:grid-cols-2 gap-3">${renderMeasurementFields(fields, record?.measurement_data || {})}</div>
        </div>
        <p id="measurement-form-error" class="hidden text-xs mt-danger-text"></p>
        <div class="flex gap-2">
          <button type="button" data-customer-detail-back class="mt-btn mt-btn-secondary flex-1">${escapeHTML(t('common.cancel'))}</button>
          <button type="submit" class="mt-btn mt-btn-primary flex-1">${escapeHTML(t('measure.saveBtn'))}</button>
        </div>
      </form>`;
    const form = document.getElementById('customer-measurement-form');
    form.dataset.snapshot = JSON.stringify(fields);
    form.addEventListener('submit', saveCustomerMeasurement);
  } catch (error) {
    content.innerHTML = `<p class="text-sm mt-danger-text">${escapeHTML(error.message || t('measure.openFormFailed'))}</p><button type="button" data-customer-detail-back class="mt-btn mt-btn-secondary mt-3 text-xs">${escapeHTML(t('common.back'))}</button>`;
  }
}

function handleMeasurementFormChange(event) {
  if (event.target.id !== 'measurement-garment-type') return;
  const template = activeMeasurementTemplates.find((item) => item.id === event.target.value);
  const grid = document.getElementById('measurement-fields-grid');
  const fields = template ? getActiveTemplateFields(template.id) : [];
  if (grid && template) {
    grid.innerHTML = renderMeasurementFields(fields);
    const form = document.getElementById('customer-measurement-form');
    if (form) {
      form.dataset.snapshot = JSON.stringify(
        fields.map((field) => ({
          field_key: field.field_key,
          field_label: field.field_label,
          unit: field.unit,
          is_required: field.is_required,
          sort_order: field.sort_order,
        }))
      );
    }
  }
}

async function saveCustomerMeasurement(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const template = activeMeasurementTemplates.find(
    (item) => item.id === document.getElementById('measurement-garment-type').value
  );
  if (!template) return alert(t('measure.templateNotFound'));
  const fields = JSON.parse(form.dataset.snapshot || '[]');
  const values = {};
  for (const input of form.querySelectorAll('[data-measurement-value]')) {
    const raw = input.value.trim();
    const field = fields.find((item) => item.field_key === input.dataset.measurementValue);
    if (raw !== '') {
      values[input.dataset.measurementValue] = Number(
        convertMeasurementValue(raw, getMeasurementDisplayUnit(), input.dataset.storageUnit || field?.unit || 'cm').toFixed(2)
      );
    }
  }
  const snapshot = fields.map((field) => ({
    field_key: field.field_key,
    field_label: field.field_label,
    unit: field.unit,
    is_required: false,
    sort_order: field.sort_order,
  }));
  const tenantId = getActiveTenantId();
  if (!tenantId) return alert(t('common.noActiveTenant'));
  const payload = {
    tenant_id: tenantId,
    customer_id: activeCustomerDetail.id,
    template_id: template.id,
    garment_type: template.garment_type,
    model: document.getElementById('measurement-model').value.trim() || null,
    description: document.getElementById('measurement-description').value.trim() || null,
    measurement_data: values,
    template_snapshot: snapshot,
    updated_at: new Date().toISOString(),
  };
  const editId = form.dataset.editId;
  const result = editId
    ? await supabase
        .from('customer_measurements')
        .update(payload)
        .eq('id', editId)
        .eq('customer_id', activeCustomerDetail.id)
        .eq('tenant_id', tenantId)
    : await supabase.from('customer_measurements').insert(payload);
  if (result.error) return alert(t('measure.saveFailed', { message: result.error.message }));
  await renderCustomerMeasurements();
}

const measurementTemplateEditModes = new Set();

async function renderMeasurementTemplateSettings() {
  const container = document.getElementById('measurement-templates-list');
  if (!container) return;
  container.innerHTML = `<p class="text-xs mt-muted" role="status">${escapeHTML(t('templates.loading'))}</p>`;
  try {
    await fetchMeasurementTemplates();
    const unit = getMeasurementDisplayUnit();
    const header = `<div class="flex flex-wrap items-center justify-between gap-3 mb-3">
      <div>
        <p class="text-xs font-semibold mt-text">${escapeHTML(t('templates.unitLabel'))}</p>
        <p class="text-xs mt-muted">${escapeHTML(t('templates.unitDesc'))}</p>
      </div>
      <div class="inline-flex gap-1.5" role="group" aria-label="${escapeHTML(t('templates.unitLabel'))}">
        <button type="button" data-measurement-unit="cm" aria-pressed="${unit === 'cm'}" class="mt-btn text-xs ${unit === 'cm' ? 'mt-btn-primary' : 'mt-btn-secondary'}">CM</button>
        <button type="button" data-measurement-unit="inch" aria-pressed="${unit === 'inch'}" class="mt-btn text-xs ${unit === 'inch' ? 'mt-btn-primary' : 'mt-btn-secondary'}">INCH</button>
      </div>
    </div>`;

    const cards = activeMeasurementTemplates
      .map((template) => {
        const fields = activeMeasurementTemplateFields
          .filter((field) => field.template_id === template.id && field.is_active)
          .sort((a, b) => a.sort_order - b.sort_order);
        const isEditing = measurementTemplateEditModes.has(template.id);
        return `<section class="measurement-template-card mt-card p-3.5 ${template.is_active ? '' : 'opacity-65'}" data-template-card="${template.id}">
          <div class="flex items-center justify-between gap-2 mb-2.5">
            <div class="min-w-0">
              <p class="text-sm font-bold mt-text">${escapeHTML(template.garment_type)}</p>
              <p class="text-xs mt-muted">${escapeHTML(t('templates.fieldCount', { count: fields.length }))}</p>
            </div>
            ${!template.is_active ? `<span class="mt-badge mt-badge-received">${escapeHTML(t('common.inactive'))}</span>` : ''}
          </div>
          <div class="measurement-template-fields space-y-1.5" data-template-fields="${template.id}">
            ${fields
              .map(
                (field, idx) => `<div class="measurement-template-field flex items-center gap-2 min-h-11 rounded-lg px-1.5" data-field-row="${field.id}" data-template-id="${template.id}">
                  ${
                    isEditing
                      ? `<button type="button" data-field-move-up="${field.id}" data-template-id="${template.id}" ${idx === 0 ? 'disabled' : ''} aria-label="${escapeHTML(t('templates.moveUpAria', { label: field.field_label }))}" title="${escapeHTML(t('templates.moveUpTitle'))}" class="mt-btn-icon mt-btn-secondary shrink-0">
                           <i data-lucide="chevron-up" class="w-4 h-4" aria-hidden="true"></i>
                         </button>
                         <button type="button" data-field-move-down="${field.id}" data-template-id="${template.id}" ${idx === fields.length - 1 ? 'disabled' : ''} aria-label="${escapeHTML(t('templates.moveDownAria', { label: field.field_label }))}" title="${escapeHTML(t('templates.moveDownTitle'))}" class="mt-btn-icon mt-btn-secondary shrink-0">
                           <i data-lucide="chevron-down" class="w-4 h-4" aria-hidden="true"></i>
                         </button>
                         <input type="text" maxlength="100" aria-label="${escapeHTML(t('templates.fieldNameAria', { label: field.field_label }))}" data-field-label-input="${field.id}" value="${escapeHTML(field.field_label)}" class="mt-input min-w-0 flex-1" />
                         <button type="button" data-field-delete="${field.id}" title="${escapeHTML(t('templates.deleteFieldTitle'))}" aria-label="${escapeHTML(t('templates.deleteFieldAria', { label: field.field_label }))}" class="mt-btn-icon mt-btn-danger-ghost shrink-0">
                           <i data-lucide="trash-2" class="w-4 h-4" aria-hidden="true"></i>
                         </button>`
                      : `<span class="measurement-drag-handle mt-muted shrink-0 cursor-grab touch-none p-2" data-drag-handle="${field.id}" title="${escapeHTML(t('templates.dragHint'))}" aria-hidden="true">
                           <i data-lucide="grip-vertical" class="w-4 h-4"></i>
                         </span>
                         <span class="flex-1 text-sm mt-text">${escapeHTML(field.field_label)}</span>`
                  }
                </div>`
              )
              .join('')}
            ${fields.length ? '' : `<p class="text-xs mt-muted py-2">${escapeHTML(t('templates.emptyFields'))}</p>`}
          </div>
          <div class="flex items-center justify-end gap-2 mt-seam-t mt-3 pt-3">
            <button type="button" data-template-edit="${template.id}" aria-label="${escapeHTML(isEditing ? t('templates.finishEditAria') : t('templates.startEditAria'))}" class="mt-btn text-xs ${isEditing ? 'mt-btn-success' : 'mt-btn-secondary'}">
              <i data-lucide="${isEditing ? 'check' : 'pencil'}" class="w-4 h-4" aria-hidden="true"></i>
              <span>${escapeHTML(isEditing ? t('common.done') : t('templates.editOrderBtn'))}</span>
            </button>
            <button type="button" data-field-add="${template.id}" aria-label="${escapeHTML(t('templates.addFieldAria', { type: template.garment_type }))}" class="mt-btn mt-btn-primary text-xs">
              <i data-lucide="plus" class="w-4 h-4" aria-hidden="true"></i>
              <span>${escapeHTML(t('templates.addFieldBtn'))}</span>
            </button>
          </div>
        </section>`;
      })
      .join('');

    container.innerHTML = `${header}${cards}`;
    bindMeasurementTemplateReorder(container);
    if (window.lucide) window.lucide.createIcons();
  } catch (error) {
    container.innerHTML = `<p class="text-xs mt-danger-text">${escapeHTML(t('templates.loadFailed', { message: error.message || '' }))}</p>`;
  }
}

function bindMeasurementTemplateReorder(container) {
  if (container.dataset.reorderBound === 'true') return;
  container.dataset.reorderBound = 'true';
  let holdTimer = null;
  let activeRow = null;
  let pointerStartY = 0;
  let dragActivated = false;

  container.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest('[data-drag-handle]');
    if (!handle || event.button !== 0) return;
    activeRow = handle.closest('[data-field-row]');
    if (!activeRow) return;
    pointerStartY = event.clientY;
    dragActivated = false;
    holdTimer = setTimeout(() => {
      dragActivated = true;
      activeRow.classList.add('is-reordering');
      activeRow.style.opacity = '0.6';
      handle.setPointerCapture?.(event.pointerId);
    }, 350);
  });

  container.addEventListener('pointermove', (event) => {
    if (!activeRow) return;
    if (!dragActivated && Math.abs(event.clientY - pointerStartY) > 8) {
      clearTimeout(holdTimer);
      activeRow = null;
      return;
    }
    if (!dragActivated) return;
    const list = activeRow.parentElement;
    const pointTarget = document.elementFromPoint(event.clientX, event.clientY);
    const target = pointTarget?.closest('[data-field-row]');
    if (!target || target === activeRow || target.parentElement !== list) return;
    const rect = target.getBoundingClientRect();
    if (event.clientY < rect.top + rect.height / 2) list.insertBefore(activeRow, target);
    else list.insertBefore(activeRow, target.nextSibling);
  });

  const finishReorder = async () => {
    clearTimeout(holdTimer);
    if (activeRow && dragActivated) {
      const list = activeRow.parentElement;
      const rows = [...list.querySelectorAll('[data-field-row]')];
      activeRow.classList.remove('is-reordering');
      activeRow.style.opacity = '';
      const tenantId = getActiveTenantId();
      if (!tenantId) return;
      const updates = rows.map((row, index) =>
        supabase
          .from('measurement_template_fields')
          .update({ sort_order: index + 1 })
          .eq('id', row.dataset.fieldRow)
          .eq('tenant_id', tenantId)
      );
      const results = await Promise.all(updates);
      const failed = results.find((result) => result.error);
      if (failed) alert(t('templates.reorderFailed', { message: failed.error.message }));
      await renderMeasurementTemplateSettings();
    }
    activeRow = null;
    dragActivated = false;
  };

  container.addEventListener('pointerup', finishReorder);
  container.addEventListener('pointercancel', finishReorder);
  container.addEventListener('change', async (event) => {
    const input = event.target.closest('[data-field-label-input]');
    if (!input) return;
    const tenantId = getActiveTenantId();
    if (!tenantId) return;
    const label = input.value.trim();
    if (!label) return alert(t('templates.fieldNameRequired'));
    const { error } = await supabase
      .from('measurement_template_fields')
      .update({ field_label: label })
      .eq('id', input.dataset.fieldLabelInput)
      .eq('tenant_id', tenantId);
    if (error) return alert(t('templates.fieldUpdateFailed', { message: error.message }));
    await renderMeasurementTemplateSettings();
  });
}

function makeMeasurementFieldKey(label) {
  return label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60);
}

async function addMeasurementTemplate() {
  const tenantId = getActiveTenantId();
  if (!tenantId) return alert(t('common.noActiveTenant'));
  const name = prompt(t('templates.promptNewType'));
  if (name === null) return;
  if (!name.trim()) return alert(t('templates.typeNameRequired'));
  const { error } = await supabase
    .from('measurement_templates')
    .insert({ tenant_id: tenantId, garment_type: name.trim(), description: t('templates.typeDefaultDesc', { name: name.trim() }) });
  if (error) return alert(t('templates.typeAddFailed', { message: error.message }));
  await renderMeasurementTemplateSettings();
}

async function moveMeasurementField(templateId, fieldId, direction) {
  const tenantId = getActiveTenantId();
  if (!tenantId) return;
  const fields = getActiveTemplateFields(templateId);
  const idx = fields.findIndex((f) => f.id === fieldId);
  const swapIdx = idx + direction;
  if (idx === -1 || swapIdx < 0 || swapIdx >= fields.length) return;
  const reordered = [...fields];
  [reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]];
  const results = await Promise.all(
    reordered.map((field, orderIdx) =>
      supabase
        .from('measurement_template_fields')
        .update({ sort_order: orderIdx + 1 })
        .eq('id', field.id)
        .eq('tenant_id', tenantId)
    )
  );
  const failed = results.find((r) => r.error);
  if (failed) alert(t('templates.moveFailed', { message: failed.error.message }));
  await renderMeasurementTemplateSettings();
}

async function handleMeasurementTemplateAction(event) {
  const tenantId = getActiveTenantId();
  const unitButton = event.target.closest('[data-measurement-unit]');
  const editButton = event.target.closest('[data-template-edit]');
  const addField = event.target.closest('[data-field-add]');
  const deleteField = event.target.closest('[data-field-delete]');
  const moveUp = event.target.closest('[data-field-move-up]');
  const moveDown = event.target.closest('[data-field-move-down]');

  if (moveUp) {
    return moveMeasurementField(moveUp.dataset.templateId, moveUp.dataset.fieldMoveUp, -1);
  }
  if (moveDown) {
    return moveMeasurementField(moveDown.dataset.templateId, moveDown.dataset.fieldMoveDown, 1);
  }
  if (unitButton) {
    localStorage.setItem('mendtrack-measurement-unit', unitButton.dataset.measurementUnit);
    await renderMeasurementTemplateSettings();
    return;
  }
  if (editButton) {
    const id = editButton.dataset.templateEdit;
    if (measurementTemplateEditModes.has(id)) measurementTemplateEditModes.delete(id);
    else measurementTemplateEditModes.add(id);
    await renderMeasurementTemplateSettings();
    return;
  }
  if (deleteField) {
    if (!tenantId) return;
    const field = activeMeasurementTemplateFields.find((item) => item.id === deleteField.dataset.fieldDelete);
    if (!field) return;
    if (!confirm(t('templates.deleteFieldConfirm', { label: field.field_label }))) {
      return;
    }
    const { error } = await supabase
      .from('measurement_template_fields')
      .delete()
      .eq('id', field.id)
      .eq('tenant_id', tenantId);
    if (error) return alert(t('templates.deleteFieldFailed', { message: error.message }));
    await renderMeasurementTemplateSettings();
    return;
  }
  if (addField) {
    if (!tenantId) return;
    const template = activeMeasurementTemplates.find((item) => item.id === addField.dataset.fieldAdd);
    if (!template) return;
    const label = prompt(t('templates.promptNewField', { type: template.garment_type }));
    if (label === null) return;
    if (!label.trim()) return alert(t('templates.fieldNameRequired'));
    const key = makeMeasurementFieldKey(label);
    if (!key) return alert(t('templates.fieldNameInvalid'));
    const maxOrder = Math.max(
      0,
      ...activeMeasurementTemplateFields
        .filter((field) => field.template_id === template.id)
        .map((field) => field.sort_order)
    );
    const { error } = await supabase.from('measurement_template_fields').insert({
      tenant_id: tenantId,
      template_id: template.id,
      field_key: key,
      field_label: label.trim(),
      unit: 'cm',
      is_required: false,
      is_active: true,
      sort_order: maxOrder + 1,
    });
    if (error) return alert(t('templates.fieldAddFailed', { message: error.message }));
    await renderMeasurementTemplateSettings();
  }
}

async function fetchOrders() {
  const tenantId = getActiveTenantId();
  if (!ordersListContainer || !tenantId) return;
  ordersListContainer.innerHTML = `
    <div class="mt-card p-8 text-center text-sm mt-muted" role="status">
      ${escapeHTML(t('orders.loading'))}
    </div>
  `;

  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*, order_items(*)')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    allOrders = data || [];
    if (customerRecords.length) renderCustomersList();
    updateDashboardMetrics();
    renderWorkloadCalendar();
    renderOrdersList();
  } catch (err) {
    console.error('Fetch orders failed:', err);
    ordersListContainer.innerHTML = `
      <div role="alert" class="mt-notice-error p-5 text-sm flex flex-wrap items-center justify-between gap-3">
        <span>${escapeHTML(t('orders.loadFailed', { message: err.message }))}</span>
        <button type="button" id="retry-fetch-orders-btn" class="mt-btn mt-btn-secondary text-xs">${escapeHTML(t('common.reload'))}</button>
      </div>
    `;
    document.getElementById('retry-fetch-orders-btn')?.addEventListener('click', fetchOrders);
  }
}

function updateDashboardMetrics() {
  const activeOrders = allOrders.filter((o) => o.status !== 'completed');
  const activeCountEl = document.getElementById('metric-active-count');
  const nearestDeadlineEl = document.getElementById('metric-nearest-deadline');
  const nearestTicketEl = document.getElementById('metric-nearest-ticket');
  const unpaidTotalEl = document.getElementById('metric-unpaid-total');

  if (activeCountEl) activeCountEl.textContent = String(activeOrders.length);

  const totalPiutang = allOrders.reduce((acc, o) => {
    return acc + Math.max(0, Number(o.total_amount || 0) - Number(o.paid_amount || 0));
  }, 0);
  if (unpaidTotalEl) unpaidTotalEl.textContent = formatCurrency(totalPiutang);

  const ongoingWithDeadline = activeOrders
    .filter((o) => o.estimated_done_date && !['ready', 'completed'].includes(o.status))
    .sort((a, b) => new Date(a.estimated_done_date) - new Date(b.estimated_done_date));

  if (ongoingWithDeadline.length > 0) {
    const nearest = ongoingWithDeadline[0];
    const dStatus = getDeadlineStatus(nearest.estimated_done_date);
    if (nearestDeadlineEl) {
      nearestDeadlineEl.textContent = formatDateID(nearest.estimated_done_date);
      nearestDeadlineEl.className = `text-xl sm:text-2xl font-extrabold mt-1 ${
        dStatus.isUrgent ? 'mt-danger-text' : 'mt-text'
      }`;
    }
    if (nearestTicketEl) {
      nearestTicketEl.textContent = `${nearest.ticket_code} · ${dStatus.label}`;
    }
  } else {
    if (nearestDeadlineEl) {
      nearestDeadlineEl.textContent = '-';
      nearestDeadlineEl.className = 'text-xl sm:text-2xl font-extrabold mt-text mt-1';
    }
    if (nearestTicketEl) nearestTicketEl.textContent = t('metrics.noUrgentQueue');
  }
}

function renderOrdersList() {
  if (!ordersListContainer) return;

  const activePool = allOrders.filter((order) => order.status !== 'completed');
  const filtered = activePool.filter((order) => {
    if (workloadDateFilter && order.estimated_done_date !== workloadDateFilter) return false;
    if (orderStatusFilter !== 'all' && order.status !== orderStatusFilter) return false;
    if (searchQuery) {
      const hay = `${order.ticket_code} ${order.customer_name} ${order.customer_phone}`.toLowerCase();
      if (!hay.includes(searchQuery)) return false;
    }
    return true;
  });

  const filterCount = document.getElementById('order-filter-count');
  if (filterCount) filterCount.textContent = t('orders.shownCount', { count: filtered.length });

  if (filtered.length === 0) {
    if (activePool.length === 0) {
      ordersListContainer.innerHTML = `
        <div class="mt-card p-8 text-center space-y-3">
          <p class="font-bold mt-text text-sm">${escapeHTML(t('orders.emptyActiveTitle'))}</p>
          <p class="text-xs mt-muted">${escapeHTML(t('orders.emptyActiveDesc'))}</p>
          <button type="button" data-empty-new-order class="mt-btn mt-btn-primary text-xs">${escapeHTML(t('orders.addFirstBtn'))}</button>
        </div>
      `;
      ordersListContainer.querySelector('[data-empty-new-order]')?.addEventListener('click', () => openOrderModal(null));
    } else {
      ordersListContainer.innerHTML = `
        <div class="mt-card p-8 text-center space-y-3">
          <p class="font-bold mt-text text-sm">${escapeHTML(t('orders.emptyFilterTitle'))}</p>
          <p class="text-xs mt-muted">${escapeHTML(t('orders.emptyFilterDesc'))}</p>
          <button type="button" data-empty-reset-filter class="mt-btn mt-btn-secondary text-xs">${escapeHTML(t('orders.resetFilter'))}</button>
        </div>
      `;
      ordersListContainer.querySelector('[data-empty-reset-filter]')?.addEventListener('click', resetOrderFilters);
    }
    return;
  }

  const nextStatusMap = {
    received: { next: 'queued', label: t('orders.next.received') },
    queued: { next: 'in_progress', label: t('orders.next.queued') },
    in_progress: { next: 'qc', label: t('orders.next.in_progress') },
    qc: { next: 'ready', label: t('orders.next.qc') },
    ready: { next: 'completed', label: t('orders.next.ready') },
  };

  ordersListContainer.innerHTML = filtered
    .map((order) => {
      const statusMeta = getStatusMeta(order.status);
      const payMeta = getPaymentStatusMeta(order.payment_status);
      const items = order.order_items || [];
      const remaining = Math.max(0, Number(order.total_amount) - Number(order.paid_amount));
      const deadline = getDeadlineStatus(order.estimated_done_date);
      const nextStep = nextStatusMap[order.status];

      const itemSummary =
        items.length > 0
          ? items
              .map(
                (it) =>
                  `<span class="inline-flex items-center px-2 py-1 rounded text-xs mt-card-muted">${escapeHTML(
                    it.garment_name
                  )} · <strong class="ml-1">${escapeHTML(it.service_type)}</strong></span>`
              )
              .join(' ')
          : `<span class="text-xs mt-muted">${escapeHTML(t('orders.noItems'))}</span>`;

      return `
        <article class="mt-card p-4 sm:p-5 space-y-3.5">
          <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-2.5">
            <div class="min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-mono-code font-bold text-sm sm:text-base mt-text">${escapeHTML(order.ticket_code)}</span>
                <span class="${statusMeta.badgeClass}">
                  <span class="${statusMeta.dotClass}" aria-hidden="true"></span>
                  <span>${escapeHTML(statusMeta.label)}</span>
                </span>
                ${
                  deadline.isOverdue && !['ready', 'completed'].includes(order.status)
                    ? `<span class="mt-badge mt-badge-overdue"><i data-lucide="alert-circle" class="w-3.5 h-3.5" aria-hidden="true"></i><span>${escapeHTML(deadline.label)}</span></span>`
                    : ''
                }
                <span class="${payMeta.badgeClass}">${escapeHTML(payMeta.label)}</span>
              </div>

              <div class="mt-1.5 flex items-center gap-2 text-xs sm:text-sm mt-muted flex-wrap">
                <button type="button" data-edit-order="${escapeHTML(order.id)}" class="font-semibold mt-text hover:underline text-left">${escapeHTML(order.customer_name)}</button>
                <span aria-hidden="true">·</span>
                <a href="${buildWhatsAppLink(
                  order.customer_phone,
                  t('orders.waFollowUp', {
                    customer: order.customer_name,
                    ticket: order.ticket_code,
                    store: workshopSettings.NAME,
                  })
                )}" target="_blank" rel="noopener noreferrer" class="mt-success-text hover:underline font-mono-code text-xs">
                  +${escapeHTML(order.customer_phone)}
                </a>
              </div>
            </div>

            <div class="sm:text-right shrink-0">
              <p class="font-mono-code font-bold text-sm sm:text-base mt-text">${escapeHTML(formatCurrency(order.total_amount))}</p>
              ${
                remaining > 0
                  ? `<p class="text-xs font-mono-code font-semibold mt-accent">${escapeHTML(t('orders.remainingPrefix', { amount: formatCurrency(remaining) }))}</p>`
                  : `<p class="text-xs font-semibold mt-success-text">${escapeHTML(t('paymentStatus.paid'))}</p>`
              }
            </div>
          </div>

          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-2.5 mt-seam-t">
            <div class="flex flex-wrap gap-1.5">${itemSummary}</div>
            <div class="text-xs shrink-0 font-mono-code ${
              deadline.isUrgent && !['ready', 'completed'].includes(order.status) ? 'mt-danger-text font-semibold' : 'mt-muted'
            }">
              ${escapeHTML(deadline.isOverdue && !['ready', 'completed'].includes(order.status) ? t('orders.overduePrefix') : t('orders.targetPrefix'))}${escapeHTML(formatDateID(order.estimated_done_date))}
            </div>
          </div>

          <div class="pt-3 mt-seam-t flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-2 flex-wrap">
              ${
                nextStep
                  ? `<button type="button" data-quick-next="${order.id}" data-next-status="${nextStep.next}" class="mt-btn mt-btn-primary text-xs">
                      <i data-lucide="arrow-right-circle" class="w-4 h-4" aria-hidden="true"></i>
                      <span>${escapeHTML(nextStep.label)}</span>
                    </button>`
                  : ''
              }
            </div>

            <div class="flex flex-wrap items-center gap-2">
              ${
                remaining > 0
                  ? `<button type="button" data-open-payment="${order.id}" class="mt-btn mt-btn-success text-xs">
                      <i data-lucide="wallet" class="w-4 h-4" aria-hidden="true"></i>
                      <span>${escapeHTML(t('orders.settlementBtn'))}</span>
                    </button>`
                  : ''
              }
              <button type="button" data-open-receipt="${order.id}" title="${escapeHTML(t('orders.receiptTitle'))}" class="mt-btn mt-btn-secondary text-xs">
                <i data-lucide="receipt-text" class="w-4 h-4" aria-hidden="true"></i>
                <span>${escapeHTML(t('orders.receiptBtn'))}</span>
              </button>
              <button type="button" data-edit-order="${order.id}" title="${escapeHTML(t('orders.editTitle'))}" class="mt-btn mt-btn-secondary text-xs">
                <i data-lucide="pencil" class="w-4 h-4" aria-hidden="true"></i>
                <span>${escapeHTML(t('common.edit'))}</span>
              </button>
              <button type="button" data-delete-order="${order.id}" title="${escapeHTML(t('orders.deleteTitle'))}" aria-label="${escapeHTML(t('orders.deleteAria', { code: order.ticket_code }))}" class="mt-btn-icon mt-btn-danger-ghost">
                <i data-lucide="trash-2" class="w-4 h-4" aria-hidden="true"></i>
              </button>
            </div>
          </div>
        </article>
      `;
    })
    .join('');

  bindCardActionListeners();
  if (window.lucide) window.lucide.createIcons();
}

function bindCardActionListeners() {
  ordersListContainer.querySelectorAll('[data-quick-next]').forEach((btn) => {
    btn.addEventListener('click', () => {
      updateOrderStatus(btn.getAttribute('data-quick-next'), btn.getAttribute('data-next-status'));
    });
  });

  ordersListContainer.querySelectorAll('[data-open-payment]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const order = allOrders.find((o) => o.id === btn.getAttribute('data-open-payment'));
      if (order) openPaymentModal(order);
    });
  });

  ordersListContainer.querySelectorAll('[data-open-receipt]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const order = allOrders.find((o) => o.id === btn.getAttribute('data-open-receipt'));
      if (order) openReceiptModal(order);
    });
  });

  ordersListContainer.querySelectorAll('[data-edit-order]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const order = allOrders.find((o) => o.id === btn.getAttribute('data-edit-order'));
      if (order) openOrderModal(order);
    });
  });

  ordersListContainer.querySelectorAll('[data-delete-order]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const orderId = btn.getAttribute('data-delete-order');
      const order = allOrders.find((o) => o.id === orderId);
      if (!order) return;
      const confirmed = confirm(
        t('orders.deleteConfirm', { code: order.ticket_code, customer: order.customer_name })
      );
      if (!confirmed) return;

      btn.disabled = true;
      try {
        const photoPaths = (order.order_items || [])
          .flatMap((it) => [it.before_photo_path, it.after_photo_path, extractStoragePath(it.before_photo_url), extractStoragePath(it.after_photo_url)])
          .filter(Boolean);

        await deleteOrderAndRelatedRecords(orderId);

        if (photoPaths.length > 0) {
          try {
            await supabase.storage.from(SUPABASE_CONFIG.STORAGE_BUCKET).remove(photoPaths);
          } catch (storageErr) {
            console.warn('Foto order gagal dibersihkan dari storage:', storageErr);
          }
        }

        await fetchOrders();
      } catch (err) {
        alert(t('orders.deleteFailed', { message: err.message || t('common.genericError') }));
      } finally {
        btn.disabled = false;
      }
    });
  });
}

async function deleteOrderAndRelatedRecords(orderId) {
  const tenantId = getActiveTenantId();
  if (!tenantId) throw new Error(t('common.noActiveTenant'));
  const { error: rpcError } = await supabase.rpc('delete_order_cascade', {
    p_tenant_id: tenantId,
    p_order_id: orderId,
  });
  if (!rpcError) return;
  throw rpcError;
}

function extractStoragePath(photoUrl) {
  if (!photoUrl || typeof photoUrl !== 'string') return null;
  const marker = `/storage/v1/object/public/${SUPABASE_CONFIG.STORAGE_BUCKET}/`;
  const idx = photoUrl.indexOf(marker);
  if (idx === -1) return null;
  return decodeURIComponent(photoUrl.slice(idx + marker.length).split('?')[0]);
}

async function updateOrderStatus(orderId, newStatus) {
  try {
    const targetOrder = allOrders.find((o) => o.id === orderId);
    if (newStatus === 'completed' && targetOrder) {
      const remaining = roundCurrencyAmount(
        Math.max(0, Number(targetOrder.total_amount || 0) - Number(targetOrder.paid_amount || 0))
      );
      if (remaining > 0) {
        alert(
          t('orders.unpaidCompleteAlert', {
            code: targetOrder.ticket_code,
            remaining: formatCurrency(remaining),
          })
        );
        return;
      }
    }

    // Marking an order completed never auto-settles unpaid balance.
    const tenantId = getActiveTenantId();
    if (!tenantId) throw new Error(t('common.noActiveTenant'));
    const { error } = await supabase
      .from('orders')
      .update({ status: newStatus })
      .eq('id', orderId)
      .eq('tenant_id', tenantId);
    if (error) throw error;
    await fetchOrders();
    if (newStatus === 'ready') {
      const updatedOrder = allOrders.find((o) => o.id === orderId);
      if (updatedOrder) showWhatsAppReadyToast(updatedOrder);
    }
  } catch (err) {
    alert(t('orders.statusUpdateFailed', { message: err.message }));
  }
}

function showWhatsAppReadyToast(order) {
  if (!waReadyToast || !waToastSendLink) return;

  const remaining = Math.max(0, Number(order.total_amount) - Number(order.paid_amount));
  const trackingUrl = getPublicTrackingUrl();

  const billingLine =
    remaining > 0
      ? t('wa.readyBillingUnpaid', { remaining: formatCurrency(remaining) })
      : t('wa.readyBillingPaid');

  const message = t('wa.readyMessage', {
    customer: order.customer_name,
    store: workshopSettings.NAME,
    ticket: order.ticket_code,
    billingLine,
    trackingUrl,
    address: workshopSettings.ADDRESS,
    hours: workshopSettings.OPENING_HOURS,
  });

  waToastDesc.textContent = t('wa.toastDesc', { customer: order.customer_name, ticket: order.ticket_code });
  waToastSendLink.href = buildWhatsAppLink(order.customer_phone, message);
  waReadyToast.classList.remove('hidden');
  if (window.lucide) window.lucide.createIcons();
}

let lockedOrderTicketCode = '';

function showEstimatedDateError(message) {
  const input = document.getElementById('form-estimated-date');
  const errEl = document.getElementById('estimated-date-error');
  if (input) {
    input.classList.add('mt-input-error');
    input.setAttribute('aria-invalid', 'true');
  }
  if (errEl) {
    errEl.textContent = message;
    errEl.classList.remove('hidden');
  }
}

function clearEstimatedDateError() {
  const input = document.getElementById('form-estimated-date');
  const errEl = document.getElementById('estimated-date-error');
  if (input) {
    input.classList.remove('mt-input-error');
    input.removeAttribute('aria-invalid');
  }
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.add('hidden');
  }
}

async function openOrderModal(existingOrder = null, draftOverride = null) {
  if (!orderFormModal) return;
  const tenantId = getActiveTenantId();
  if (!tenantId) return;
  rememberTrigger();
  try {
    activeServiceCatalog = (await fetchServices(tenantId)).filter((service) => service.is_active);
  } catch (error) {
    console.warn('Katalog layanan gagal dimuat:', error);
    activeServiceCatalog = [];
  }

  const isEdit = Boolean(existingOrder);
  document.getElementById('order-modal-title').textContent = isEdit
    ? t('orderForm.editTitle', { code: existingOrder.ticket_code })
    : t('orderForm.newTitle');
  document.getElementById('form-order-id').value = isEdit ? existingOrder.id : '';

  formItemsContainer.innerHTML = '';
  clearEstimatedDateError();

  const ticketPrefix = activeTenant?.ticket_prefix || workshopSettings.TICKET_PREFIX;
  const ticketInput = document.getElementById('form-ticket-code');
  if (draftOverride) {
    lockedOrderTicketCode =
      draftOverride.ticket_code || generateTicketCode(allOrders.length + 1, ticketPrefix);
    ticketInput.value = lockedOrderTicketCode;
    document.getElementById('form-customer-name').value = draftOverride.customer_name || '';
    document.getElementById('form-customer-phone').value = draftOverride.customer_phone || '';
    document.getElementById('form-estimated-date').value = draftOverride.estimated_done_date || '';
    document.getElementById('form-notes').value = draftOverride.notes || '';
    document.getElementById('form-paid-amount').value = draftOverride.paid_amount || 0;

    const items = draftOverride.items || [];
    if (items.length > 0) items.forEach((it) => appendItemRow(it));
    else appendItemRow();
  } else if (isEdit) {
    lockedOrderTicketCode = existingOrder.ticket_code || '';
    ticketInput.value = lockedOrderTicketCode;
    document.getElementById('form-customer-name').value = existingOrder.customer_name;
    document.getElementById('form-customer-phone').value = existingOrder.customer_phone;
    document.getElementById('form-estimated-date').value = existingOrder.estimated_done_date || '';
    document.getElementById('form-notes').value = existingOrder.notes || '';
    document.getElementById('form-paid-amount').value = Number(existingOrder.paid_amount || 0);

    const items = existingOrder.order_items || [];
    const signedUrlMap = await signGarmentPhotoPaths(
      items.flatMap((it) => [it.before_photo_path, it.after_photo_path]).filter(Boolean)
    );
    if (items.length > 0) items.forEach((it) => appendItemRow(it, signedUrlMap));
    else appendItemRow();
  } else {
    lockedOrderTicketCode = generateTicketCode(allOrders.length + 1, ticketPrefix);
    ticketInput.value = lockedOrderTicketCode;
    document.getElementById('form-customer-name').value = '';
    document.getElementById('form-customer-phone').value = '';
    document.getElementById('form-estimated-date').value = '';
    document.getElementById('form-notes').value = '';
    document.getElementById('form-paid-amount').value = 0;
    appendItemRow();
  }
  ticketInput.readOnly = true;
  ticketInput.disabled = true;

  syncCurrencyInputs(orderFormModal);
  recalculateFormTotals();
  const customerLookupStatus = document.getElementById('customer-lookup-status');
  if (customerLookupStatus) {
    customerLookupStatus.textContent = t('orderForm.lookupPrompt');
    customerLookupStatus.className = 'mt-1 text-xs mt-muted';
  }
  orderFormModal.classList.remove('hidden');
  document.getElementById('form-customer-name')?.focus();
  if (window.lucide) window.lucide.createIcons();
}

async function signGarmentPhotoPaths(paths) {
  const uniquePaths = Array.from(new Set((paths || []).filter((p) => typeof p === 'string' && p.length > 0)));
  if (!uniquePaths.length) return {};
  try {
    const { data, error } = await supabase.storage
      .from(SUPABASE_CONFIG.STORAGE_BUCKET)
      .createSignedUrls(uniquePaths, 1800);
    if (error || !Array.isArray(data)) return {};
    const map = {};
    data.forEach((entry) => {
      if (entry.path && entry.signedUrl) map[entry.path] = entry.signedUrl;
    });
    return map;
  } catch (err) {
    console.warn('Gagal membuat tautan pratinjau foto:', err);
    return {};
  }
}

function closeOrderModal() {
  closeOrderDatePicker();
  orderFormModal?.classList.add('hidden');
  restoreTriggerFocus();
}

function appendItemRow(itemData = {}, signedUrlMap = {}) {
  const rowIndex = formItemsContainer.children.length;
  const uid = ++itemRowCounter;
  const specsObj = itemData.measurement_specs || {};
  const specsString = Object.entries(specsObj)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');

  // Keep archived service names on historical edits while offering active catalog items for new orders.
  const serviceNames = [...activeServiceCatalog.map((service) => service.name)];
  if (itemData.service_type && !serviceNames.includes(itemData.service_type)) {
    serviceNames.push(itemData.service_type);
  }
  const presetOptions = serviceNames
    .map((serviceName) => `<option value="${escapeHTML(serviceName)}"></option>`)
    .join('');

  const beforePath = itemData.before_photo_path || '';
  const afterPath = itemData.after_photo_path || '';
  const beforePreviewUrl = beforePath ? signedUrlMap[beforePath] || '' : '';
  const afterPreviewUrl = afterPath ? signedUrlMap[afterPath] || '' : '';

  const currencyMeta = getCurrencyMeta();
  const card = document.createElement('div');
  card.className = 'item-row mt-card-muted p-4 space-y-3 relative';
  card.dataset.itemId = itemData.id || '';
  card.dataset.existingBeforePath = beforePath;
  card.dataset.existingAfterPath = afterPath;

  card.innerHTML = `
    <div class="flex items-center justify-between gap-2">
      <span class="text-xs font-mono-code font-bold mt-accent item-row-label">${escapeHTML(t('common.itemLabel', { number: rowIndex + 1 }))}</span>
      <button type="button" class="remove-item-btn mt-btn mt-btn-danger-ghost text-xs">
        ${escapeHTML(t('orderForm.removeItemBtn'))}
      </button>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
      <div>
        <label for="item-garment-${uid}" class="block text-xs font-semibold mt-text mb-1">${escapeHTML(t('orderForm.garmentLabel'))}</label>
        <input id="item-garment-${uid}" type="text" required data-field="garment_name" value="${escapeHTML(itemData.garment_name || '')}" placeholder="${escapeHTML(t('orderForm.garmentPlaceholder'))}" class="mt-input" />
      </div>

      <div>
        <label for="item-service-${uid}" class="block text-xs font-semibold mt-text mb-1">${escapeHTML(t('orderForm.serviceLabel'))}</label>
        <input id="item-service-${uid}" type="text" required list="service-presets-${uid}" data-field="service_type" value="${escapeHTML(itemData.service_type || '')}" placeholder="${escapeHTML(t('orderForm.servicePlaceholder'))}" class="mt-input" />
        <datalist id="service-presets-${uid}">${presetOptions}</datalist>
      </div>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
      <div>
        <label for="item-specs-${uid}" class="block text-xs font-semibold mt-text mb-1">${escapeHTML(t('orderForm.specsLabel'))}</label>
        <input id="item-specs-${uid}" type="text" data-field="measurement_specs" value="${escapeHTML(specsString)}" placeholder="${escapeHTML(t('orderForm.specsPlaceholder'))}" class="mt-input text-xs" />
      </div>

      <div>
        <label for="item-price-${uid}" class="block text-xs font-semibold mt-text mb-1">${escapeHTML(t('orderForm.itemPricePrefix'))}<span data-currency-label>${escapeHTML(currencyMeta.shortLabel)}</span>) *</label>
        <input id="item-price-${uid}" type="number" required data-currency-input="nonneg" inputmode="${currencyMeta.decimals > 0 ? 'decimal' : 'numeric'}" min="0" step="${escapeHTML(currencyMeta.step)}" data-field="price" value="${Number(itemData.price || 0)}" class="item-price-input mt-input font-mono-code text-right font-semibold" />
      </div>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
      <div>
        <label for="item-before-${uid}" class="block text-xs font-semibold mt-text mb-1">
          ${escapeHTML(t('orderForm.photoBefore'))} ${beforePath ? `<span class="mt-success-text">${escapeHTML(t('orderForm.photoSaved'))}</span>` : ''}
        </label>
        ${
          beforePreviewUrl
            ? `<a href="${escapeHTML(beforePreviewUrl)}" target="_blank" rel="noopener noreferrer" class="existing-photo-preview block mb-2">
                <img src="${escapeHTML(beforePreviewUrl)}" width="112" height="80" onerror="this.src='/assets/placeholder-garment.svg'" alt="${escapeHTML(t('orderForm.photoBeforeAlt'))}" class="w-28 h-20 object-cover rounded-lg border" style="border-color: var(--mt-border);" />
                <span class="text-xs mt-muted">${escapeHTML(t('orderForm.photoSavedHint'))}</span>
              </a>`
            : beforePath
              ? `<p class="text-xs mt-muted mb-2">${escapeHTML(t('orderForm.photoSavedHint'))}</p>`
              : ''
        }
        <input id="item-before-${uid}" type="file" accept="image/*" data-file="before" class="w-full text-xs mt-muted" />
      </div>
      <div>
        <label for="item-after-${uid}" class="block text-xs font-semibold mt-text mb-1">
          ${escapeHTML(t('orderForm.photoAfter'))} ${afterPath ? `<span class="mt-success-text">${escapeHTML(t('orderForm.photoSaved'))}</span>` : ''}
        </label>
        ${
          afterPreviewUrl
            ? `<a href="${escapeHTML(afterPreviewUrl)}" target="_blank" rel="noopener noreferrer" class="existing-photo-preview block mb-2">
                <img src="${escapeHTML(afterPreviewUrl)}" width="112" height="80" onerror="this.src='/assets/placeholder-garment.svg'" alt="${escapeHTML(t('orderForm.photoAfterAlt'))}" class="w-28 h-20 object-cover rounded-lg border" style="border-color: var(--mt-border);" />
                <span class="text-xs mt-muted">${escapeHTML(t('orderForm.photoSavedHint'))}</span>
              </a>`
            : afterPath
              ? `<p class="text-xs mt-muted mb-2">${escapeHTML(t('orderForm.photoSavedHint'))}</p>`
              : ''
        }
        <input id="item-after-${uid}" type="file" accept="image/*" data-file="after" class="w-full text-xs mt-muted" />
      </div>
    </div>
  `;

  card.querySelector('.remove-item-btn').addEventListener('click', () => {
    if (formItemsContainer.children.length <= 1) {
      alert(t('orderForm.minOneItem'));
      return;
    }
    card.remove();
    renumberItemLabels();
    recalculateFormTotals();
    triggerAutoSaveDraft();
  });

  card.querySelector('.item-price-input').addEventListener('input', () => {
    recalculateFormTotals();
    triggerAutoSaveDraft();
  });

  formItemsContainer.appendChild(card);
}

function renumberItemLabels() {
  formItemsContainer.querySelectorAll('.item-row-label').forEach((el, idx) => {
    el.textContent = t('common.itemLabel', { number: idx + 1 });
  });
}

function recalculateFormTotals() {
  let total = 0;
  formItemsContainer.querySelectorAll('.item-price-input').forEach((inp) => {
    total += Number(inp.value || 0);
  });

  const paid = Number(formPaidAmountInput?.value || 0);
  const remaining = Math.max(0, total - paid);

  document.getElementById('form-total-preview').textContent = formatCurrency(total);
  document.getElementById('form-remaining-preview').textContent = formatCurrency(remaining);
}

function parseMeasurementSpecs(rawStr) {
  const result = {};
  if (!rawStr || !rawStr.trim()) return result;

  rawStr.split(',').forEach((pair) => {
    const idx = pair.indexOf(':');
    if (idx > -1) {
      const key = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      if (key && val) result[key] = val;
    } else if (pair.trim()) {
      result[t('orderForm.specNoteKey')] = pair.trim();
    }
  });
  return result;
}

async function uploadGarmentPhoto(file, orderId, typeLabel) {
  const tenantId = getActiveTenantId();
  if (!tenantId) throw new Error(t('common.noActiveTenant'));
  const compressedBlob = await compressImage(file, 1080, 0.8);
  const filePath = `${tenantId}/${orderId}/${typeLabel}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.jpg`;

  const { error: uploadError } = await supabase.storage
    .from(SUPABASE_CONFIG.STORAGE_BUCKET)
    .upload(filePath, compressedBlob, {
      contentType: 'image/jpeg',
      upsert: true,
    });

  if (uploadError) throw uploadError;

  return filePath;
}

let customerLookupRequest = 0;

async function findCustomerByPhone(phone) {
  const tenantId = getActiveTenantId();
  const normalized = normalizePhone(phone);
  if (!normalized || !tenantId) return null;
  const { data, error } = await supabase
    .from('customers')
    .select('id, name, phone')
    .eq('tenant_id', tenantId)
    .eq('phone', normalized)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function checkCustomerPhoneInForm() {
  const phoneInput = document.getElementById('form-customer-phone');
  const status = document.getElementById('customer-lookup-status');
  if (!phoneInput || !status) return;

  const normalized = normalizePhone(phoneInput.value);
  const requestId = ++customerLookupRequest;
  if (!normalized || normalized.length < 10) {
    status.textContent = t('orderForm.lookupMinDigits');
    status.className = 'mt-1 text-xs mt-muted';
    return;
  }

  status.textContent = t('orderForm.lookupChecking');
  status.className = 'mt-1 text-xs mt-muted';
  try {
    const customer = await findCustomerByPhone(normalized);
    if (requestId !== customerLookupRequest) return;
    if (customer) {
      status.textContent = t('orderForm.lookupFound', { name: customer.name });
      status.className = 'mt-1 text-xs mt-accent font-medium';
    } else {
      status.textContent = t('orderForm.lookupNew');
      status.className = 'mt-1 text-xs mt-success-text font-medium';
    }
  } catch (error) {
    if (requestId !== customerLookupRequest) return;
    status.textContent = t('orderForm.lookupFailed', { message: error.message || t('orderForm.retryShort') });
    status.className = 'mt-1 text-xs mt-danger-text';
  }
}

async function handleSaveOrderSubmit(e) {
  e.preventDefault();
  const estimatedDateInput = document.getElementById('form-estimated-date');
  const estimatedDate = estimatedDateInput?.value.trim() || '';
  if (!estimatedDate || !parseLocalDateKey(estimatedDate)) {
    showEstimatedDateError(t('orderForm.deadlineRequired'));
    estimatedDateInput?.scrollIntoView({ block: 'center' });
    estimatedDateInput?.focus();
    return;
  }
  clearEstimatedDateError();

  const submitBtn = document.getElementById('save-order-submit-btn');
  submitBtn.disabled = true;
  submitBtn.innerHTML = `<span>${escapeHTML(t('common.saving'))}</span>`;
  try {
    const existingOrderId = document.getElementById('form-order-id').value.trim();
    const existingOrderRecord = existingOrderId ? allOrders.find((o) => o.id === existingOrderId) : null;
    const ticketCode = (
      existingOrderRecord?.ticket_code ||
      lockedOrderTicketCode ||
      document.getElementById('form-ticket-code').value
    )
      .trim()
      .toUpperCase();
    const customerName = document.getElementById('form-customer-name').value.trim();
    const customerPhone = normalizePhone(document.getElementById('form-customer-phone').value);
    const notes = document.getElementById('form-notes').value.trim();
    const paidAmount = roundCurrencyAmount(Number(document.getElementById('form-paid-amount').value || 0));

    if (!ticketCode) throw new Error(t('orderForm.ticketRequired'));
    if (!estimatedDate || !parseLocalDateKey(estimatedDate)) throw new Error(t('orderForm.deadlineRequired'));
    if (!customerName) throw new Error(t('customers.nameRequired'));
    if (!customerPhone || customerPhone.length < 10) throw new Error(t('orderForm.phoneInvalid'));
    if (!Number.isFinite(paidAmount) || paidAmount < 0) throw new Error(t('orderForm.dpInvalid'));

    await findCustomerByPhone(customerPhone);

    const itemRows = Array.from(formItemsContainer.querySelectorAll('.item-row'));
    if (!itemRows.length) throw new Error(t('orderForm.minOneItem'));

    const orderId = existingOrderId || crypto.randomUUID();

    // Photos upload before the DB RPC so existing order rows stay intact if storage fails.
    const itemsPayload = [];
    for (const row of itemRows) {
      const garmentName = row.querySelector('[data-field="garment_name"]').value.trim();
      const serviceType = row.querySelector('[data-field="service_type"]').value.trim();
      const specsRaw = row.querySelector('[data-field="measurement_specs"]').value;
      const price = roundCurrencyAmount(Number(row.querySelector('[data-field="price"]').value || 0));
      if (!garmentName) throw new Error(t('orderForm.garmentRequired'));
      if (!serviceType) throw new Error(t('orderForm.serviceRequired'));
      if (!Number.isFinite(price) || price < 0) throw new Error(t('orderForm.priceInvalid'));

      let beforePath = row.dataset.existingBeforePath || null;
      let afterPath = row.dataset.existingAfterPath || null;
      const beforeFile = row.querySelector('[data-file="before"]').files[0];
      const afterFile = row.querySelector('[data-file="after"]').files[0];
      if (beforeFile) beforePath = await uploadGarmentPhoto(beforeFile, orderId, 'before');
      if (afterFile) afterPath = await uploadGarmentPhoto(afterFile, orderId, 'after');

      itemsPayload.push({
        item_id: row.dataset.itemId || null,
        garment_name: garmentName,
        service_type: serviceType,
        measurement_specs: parseMeasurementSpecs(specsRaw),
        price,
        before_photo_path: beforePath,
        after_photo_path: afterPath,
      });
    }

    const tenantId = getActiveTenantId();
    if (!tenantId) throw new Error(t('common.noActiveTenant'));

    const { data: savedOrderId, error: saveError } = await supabase.rpc('save_order_with_items', {
      p_tenant_id: tenantId,
      p_order_id: orderId,
      p_ticket_code: ticketCode,
      p_customer_name: customerName,
      p_customer_phone: customerPhone,
      p_estimated_done_date: estimatedDate,
      p_notes: notes,
      p_paid_amount: paidAmount,
      p_items: itemsPayload,
    });
    if (saveError) throw saveError;
    if (!savedOrderId) throw new Error(t('orderForm.noIdReturned'));

    clearOrderDraft(tenantId);
    draftBanner?.classList.add('hidden');
    closeOrderModal();
    await fetchOrders();

    if (!existingOrderId) {
      const totalAmount = itemsPayload.reduce((sum, item) => sum + Number(item.price || 0), 0);
      const remaining = Math.max(0, totalAmount - paidAmount);
      const itemLines = itemsPayload
        .map((item, index) => `${index + 1}. ${item.garment_name} (${item.service_type}) - ${formatCurrency(item.price)}`)
        .join('\n');
      const trackingUrl = getPublicTrackingUrl();
      const receiptMessage = t('wa.newOrderMessage', {
        store: workshopSettings.NAME,
        ticket: ticketCode,
        customer: customerName,
        targetDate: formatDateID(estimatedDate),
        items: itemLines,
        total: formatCurrency(totalAmount),
        paid: formatCurrency(paidAmount),
        remaining: formatCurrency(remaining),
        trackingUrl,
        hours: workshopSettings.OPENING_HOURS,
      });
      window.location.href = buildWhatsAppLink(customerPhone, receiptMessage);
    }
  } catch (err) {
    alert(t('orderForm.saveFailed', { message: err.message }));
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = `<i data-lucide="check" class="w-4 h-4" aria-hidden="true"></i><span>${escapeHTML(t('orderForm.saveBtn'))}</span>`;
    if (window.lucide) window.lucide.createIcons();
  }
}

const triggerAutoSaveDraft = debounce(() => {
  // Never overwrite the new-order draft while editing an existing order.
  const existingId = document.getElementById('form-order-id')?.value;
  if (existingId) return;

  const items = Array.from(formItemsContainer.querySelectorAll('.item-row')).map((row) => ({
    garment_name: row.querySelector('[data-field="garment_name"]')?.value || '',
    service_type: row.querySelector('[data-field="service_type"]')?.value || '',
    measurement_specs: parseMeasurementSpecs(row.querySelector('[data-field="measurement_specs"]')?.value || ''),
    price: Number(row.querySelector('[data-field="price"]')?.value || 0),
  }));

  const tenantId = getActiveTenantId();
  if (!tenantId) return;

  saveOrderDraft(
    {
      ticket_code: lockedOrderTicketCode || document.getElementById('form-ticket-code')?.value || '',
      customer_name: document.getElementById('form-customer-name')?.value || '',
      customer_phone: document.getElementById('form-customer-phone')?.value || '',
      estimated_done_date: document.getElementById('form-estimated-date')?.value || '',
      notes: document.getElementById('form-notes')?.value || '',
      paid_amount: Number(document.getElementById('form-paid-amount')?.value || 0),
      items,
    },
    tenantId
  );
}, 500);

function checkSavedDraftBanner() {
  const tenantId = getActiveTenantId();
  const draft = loadOrderDraft(tenantId);
  if (draft && draft.data && (draft.data.customer_name || draft.data.items?.length)) {
    if (draftSavedTime) {
      draftSavedTime.textContent = t('draft.savedDetail', {
        name: draft.data.customer_name || draft.data.ticket_code,
        time: formatDateID(draft.savedAt, true),
      });
    }
    draftBanner?.classList.remove('hidden');
  } else {
    draftBanner?.classList.add('hidden');
  }
}

function openPaymentModal(order) {
  if (!paymentModal) return;
  rememberTrigger();
  const total = Number(order.total_amount || 0);
  const currentPaid = Number(order.paid_amount || 0);
  const remaining = roundCurrencyAmount(Math.max(0, total - currentPaid));

  document.getElementById('pay-order-id').value = order.id;
  document.getElementById('pay-modal-ticket').textContent = `${order.ticket_code} | ${order.customer_name}`;
  document.getElementById('pay-total-display').textContent = formatCurrency(total);
  document.getElementById('pay-current-display').textContent = formatCurrency(currentPaid);
  document.getElementById('pay-remaining-display').textContent = formatCurrency(remaining);

  syncCurrencyInputs(paymentModal);
  const paidInput = document.getElementById('pay-new-paid-input');
  paidInput.value = String(remaining);
  payFullQuickBtn.dataset.totalAmount = String(remaining);

  paymentModal.classList.remove('hidden');
  paidInput.focus();
  if (window.lucide) window.lucide.createIcons();
}

async function handlePaymentSubmit(e) {
  e.preventDefault();
  const orderId = document.getElementById('pay-order-id').value;
  const newPaidAmount = roundCurrencyAmount(Number(document.getElementById('pay-new-paid-input').value || 0));
  const payMethod = paymentForm.querySelector('input[name="pay_method"]:checked')?.value || 'Tunai';
  const targetOrder = allOrders.find((o) => o.id === orderId);
  if (!targetOrder) return;
  const remaining = roundCurrencyAmount(
    Math.max(0, Number(targetOrder.total_amount || 0) - Number(targetOrder.paid_amount || 0))
  );
  if (!Number.isFinite(newPaidAmount) || newPaidAmount <= 0 || Math.abs(newPaidAmount - remaining) > 0.0001) {
    alert(t('payment.exactAmountError', { amount: formatCurrency(remaining) }));
    return;
  }

  const submitBtn = paymentForm.querySelector('[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;
  try {
    const tenantId = getActiveTenantId();
    if (!tenantId) throw new Error(t('common.noActiveTenant'));
    const idempotencyKey = `settlement:${orderId}:${crypto.randomUUID()}`;
    const { error } = await supabase.rpc('record_order_payment_v3', {
      p_tenant_id: tenantId,
      p_order_id: orderId,
      p_amount: remaining,
      p_payment_type: 'pelunasan',
      p_pay_method: payMethod,
      p_note: 'Pelunasan dari daftar order',
      p_idempotency_key: idempotencyKey,
    });
    if (error) throw error;
    closePaymentModal();
    await fetchOrders();
  } catch (err) {
    alert(t('payment.saveFailed', { message: err.message }));
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

// Manual cash entries only; order payments post through record_order_payment_v3 RPC.
function updateCashCategoryOptions() {
  const type = document.getElementById('cash-type')?.value || 'income';
  const select = document.getElementById('cash-category');
  if (select) {
    const currentValue = select.value;
    const options = getCashCategories(type);
    select.innerHTML = options.map(([v, l]) => `<option value="${v}">${escapeHTML(l)}</option>`).join('');
    if (options.some(([v]) => v === currentValue)) {
      select.value = currentValue;
    }
  }
}

function cashPeriodStart(period) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === 'week') start.setDate(start.getDate() - 6);
  if (period === 'month') start.setDate(1);
  return period === 'all' ? null : start;
}

async function renderCash() {
  const target = document.getElementById('cash-transactions');
  const tenantId = getActiveTenantId();
  if (!target || !tenantId) return;
  target.innerHTML = `<p class="text-sm mt-muted" role="status">${escapeHTML(t('cash.loading'))}</p>`;
  try {
    const period = document.getElementById('cash-period')?.value || 'week';
    let query = supabase
      .from('cash_transactions')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('occurred_at', { ascending: false });
    const start = cashPeriodStart(period);
    if (start) query = query.gte('occurred_at', start.toISOString());
    const { data, error } = await query;
    if (error) throw error;
    const rows = data || [];
    const { data: allRows, error: allError } = await supabase
      .from('cash_transactions')
      .select('transaction_type,amount')
      .eq('tenant_id', tenantId);
    if (allError) throw allError;

    const periodIncome = rows
      .filter((x) => x.transaction_type === 'income')
      .reduce((a, x) => a + Number(x.amount || 0), 0);
    const periodExpense = rows
      .filter((x) => x.transaction_type === 'expense')
      .reduce((a, x) => a + Number(x.amount || 0), 0);
    const balance = (allRows || []).reduce(
      (a, x) => a + (x.transaction_type === 'income' ? 1 : -1) * Number(x.amount || 0),
      0
    );

    document.getElementById('cash-income').textContent = formatCurrency(periodIncome);
    document.getElementById('cash-expense').textContent = formatCurrency(periodExpense);
    document.getElementById('cash-balance').textContent = formatCurrency(balance);

    target.innerHTML = rows.length
      ? rows
          .map(
            (x) => `<div class="flex items-center justify-between gap-3 py-3 border-b last:border-0" style="border-color: var(--mt-border);">
              <div class="min-w-0">
                <p class="text-sm font-semibold mt-text">${escapeHTML(x.description || getCashCategoryLabel(x.category))}</p>
                <p class="text-xs mt-muted">${escapeHTML(formatDateID(x.occurred_at, true))} · ${escapeHTML(getCashCategoryLabel(x.category))} · ${escapeHTML(getPaymentMethodLabel(x.payment_method || 'Tunai'))} · ${escapeHTML(x.order_id ? t('cash.sourceOrder') : t('cash.sourceManual'))}</p>
              </div>
              <b class="text-sm font-mono-code whitespace-nowrap ${x.transaction_type === 'income' ? 'mt-success-text' : 'mt-danger-text'}">${x.transaction_type === 'income' ? '+' : '-'}${escapeHTML(formatCurrency(x.amount))}</b>
            </div>`
          )
          .join('')
      : `<p class="text-sm mt-muted py-5 text-center">${escapeHTML(t('reports.noTransactions'))}</p>`;
  } catch (err) {
    target.innerHTML = `<div role="alert" class="text-sm mt-danger-text flex items-center justify-between gap-2">
      <span>${escapeHTML(t('cash.loadFailed', { message: err.message || '' }))}</span>
      <button type="button" data-retry-cash class="mt-btn mt-btn-secondary text-xs">${escapeHTML(t('common.reload'))}</button>
    </div>`;
    target.querySelector('[data-retry-cash]')?.addEventListener('click', renderCash);
  }
}

function openCashModal() {
  rememberTrigger();
  updateCashCategoryOptions();
  document.getElementById('cash-form')?.reset();
  updateCashCategoryOptions();
  const modal = document.getElementById('cash-modal');
  if (modal) syncCurrencyInputs(modal);
  modal?.classList.remove('hidden');
  document.getElementById('cash-amount')?.focus();
}

async function submitCashForm(e) {
  e.preventDefault();
  const btn = e.submitter;
  if (btn) btn.disabled = true;
  try {
    const tenantId = getActiveTenantId();
    if (!tenantId) throw new Error(t('common.noActiveTenant'));
    const args = {
      p_tenant_id: tenantId,
      p_transaction_type: document.getElementById('cash-type').value,
      p_category: document.getElementById('cash-category').value,
      p_amount: roundCurrencyAmount(Number(document.getElementById('cash-amount').value)),
      p_payment_method: document.getElementById('cash-method').value,
      p_description: document.getElementById('cash-description').value.trim() || null,
      p_occurred_at: new Date().toISOString(),
    };
    const { error } = await supabase.rpc('add_manual_cash_transaction', args);
    if (error) throw error;
    closeCashModal();
    await renderCash();
  } catch (err) {
    alert(t('cash.saveFailed', { message: err.message }));
  } finally {
    if (btn) btn.disabled = false;
  }
}

function openReceiptModal(order) {
  if (!receiptModal || !receiptContent) return;
  rememberTrigger();
  currentReceiptOrder = order;

  const items = order.order_items || [];
  const total = Number(order.total_amount || 0);
  const paid = Number(order.paid_amount || 0);
  const remaining = Math.max(0, total - paid);
  const payMeta = getPaymentStatusMeta(order.payment_status);

  const itemsRowsHTML = items
    .map(
      (it, idx) => `
      <div class="flex justify-between items-start gap-2 py-2 mt-seam-b">
        <div>
          <p class="font-semibold mt-text">${idx + 1}. ${escapeHTML(it.garment_name)}</p>
          <p class="text-xs mt-muted">${escapeHTML(it.service_type)}</p>
        </div>
        <span class="font-mono-code text-xs font-semibold mt-text shrink-0">${escapeHTML(formatCurrency(it.price))}</span>
      </div>
    `
    )
    .join('');

  receiptContent.innerHTML = `
    <div class="text-center pb-3 mt-seam-b">
      ${workshopSettings.LOGO ? `<img src="${workshopSettings.LOGO}" width="56" height="56" alt="${escapeHTML(t('common.logoAlt', { name: workshopSettings.NAME }))}" class="w-14 h-14 object-contain mx-auto mb-2">` : ''}
      <h3 class="font-bold text-base mt-text">${escapeHTML(workshopSettings.NAME)}</h3>
      <p class="text-xs mt-muted">${escapeHTML(workshopSettings.TAGLINE)}</p>
      <p class="text-xs mt-muted">${escapeHTML(workshopSettings.ADDRESS)}</p>
      <p class="text-xs mt-muted">${escapeHTML(workshopSettings.OPENING_HOURS)}</p>
    </div>

    <div class="grid grid-cols-2 gap-y-1.5 text-xs">
      <span class="mt-muted">${escapeHTML(t('receipt.ticketNo'))}</span>
      <span class="font-mono-code font-bold text-right mt-text">${escapeHTML(order.ticket_code)}</span>

      <span class="mt-muted">${escapeHTML(t('receipt.customer'))}</span>
      <span class="font-semibold text-right mt-text">${escapeHTML(order.customer_name)}</span>

      <span class="mt-muted">${escapeHTML(t('receipt.receivedDate'))}</span>
      <span class="text-right mt-text">${escapeHTML(formatDateID(order.created_at))}</span>

      <span class="mt-muted">${escapeHTML(t('receipt.targetDone'))}</span>
      <span class="font-semibold text-right mt-text">${escapeHTML(formatDateID(order.estimated_done_date))}</span>
    </div>

    <div class="pt-3 mt-seam-t">
      <p class="text-xs font-bold mt-text mb-1">${escapeHTML(t('receipt.serviceDetails'))}</p>
      ${itemsRowsHTML}
    </div>

    <div class="space-y-1.5 text-xs pt-1">
      <div class="flex justify-between">
        <span class="mt-muted">${escapeHTML(t('receipt.totalBill'))}</span>
        <span class="font-mono-code font-bold mt-text">${escapeHTML(formatCurrency(total))}</span>
      </div>
      <div class="flex justify-between">
        <span class="mt-muted">${escapeHTML(t('receipt.paid'))}</span>
        <span class="font-mono-code mt-success-text font-semibold">${escapeHTML(formatCurrency(paid))}</span>
      </div>
      <div class="flex justify-between text-sm pt-2 mt-seam-t">
        <span class="font-bold mt-text">${escapeHTML(t('receipt.remaining'))}</span>
        <span class="font-mono-code font-bold mt-accent">${escapeHTML(formatCurrency(remaining))}</span>
      </div>
      <div class="pt-2 text-center">
        <span class="${payMeta.badgeClass}">${escapeHTML(t('receipt.statusBadge', { status: payMeta.label }))}</span>
      </div>
    </div>

    <p class="text-xs text-center mt-muted pt-3 mt-seam-t">
      ${escapeHTML(t('receipt.trackNote'))}<br />
      <span class="font-mono-code mt-text">${escapeHTML(getPublicTrackingUrl())}</span>
    </p>
    <p class="mt-4 pt-2 mt-seam-t text-center text-xs mt-muted">${escapeHTML(t('common.byMendTrack'))}</p>
  `;

  receiptModal.classList.remove('hidden');
  closeReceiptModalBtn?.focus();
  if (window.lucide) window.lucide.createIcons();
}

function handleSendReceiptViaWA() {
  if (!currentReceiptOrder) return;
  const o = currentReceiptOrder;
  const items = o.order_items || [];
  const total = Number(o.total_amount || 0);
  const paid = Number(o.paid_amount || 0);
  const remaining = Math.max(0, total - paid);
  const trackingUrl = getPublicTrackingUrl();

  const itemLines = items
    .map((it, idx) => `${idx + 1}. ${it.garment_name} (${it.service_type}) - ${formatCurrency(it.price)}`)
    .join('\n');

  const receiptText = t('wa.receiptMessage', {
    store: workshopSettings.NAME,
    ticket: o.ticket_code,
    customer: o.customer_name,
    targetDate: formatDateID(o.estimated_done_date),
    items: itemLines,
    total: formatCurrency(total),
    paid: formatCurrency(paid),
    remaining: formatCurrency(remaining),
    trackingUrl,
    address: workshopSettings.ADDRESS,
    hours: workshopSettings.OPENING_HOURS,
  });

  // Same-tab navigation lets Android Chrome hand wa.me links directly to the WhatsApp app.
  window.location.href = buildWhatsAppLink(o.customer_phone, receiptText);
}
