import { SUPABASE_CONFIG } from './config.js';
import { isSupabaseConfigured } from './supabase-client.js';
import {
  formatCurrency,
  formatDateID,
  buildWhatsAppLink,
  escapeHTML,
  getDeadlineStatus,
  normalizePhone,
  compressImage,
} from './utils.js';
import { initConnectionMonitor } from './storage-draft.js';
import { DEFAULT_STORE_SETTINGS, mapTenantToSettings, applyStoreIdentity } from './store-settings.js';
import {
  t,
  getLocale,
  setLocale,
  setCurrency,
  setTimezone,
  readStoredLocale,
  detectPreferredLocale,
  applyTranslations,
  getOrderSteps,
  getStatusMeta,
  getOrderTypeMeta,
  getQuoteStatusMeta,
  getPaymentStatusMeta,
  translateSystemLogNote,
} from './i18n.js';
import { createPinCanvas } from './pin-canvas.js';

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;

let activeSlug = '';
let isWorkshopValid = false;
let currentSearchedPhone = '';
let lastTicketList = [];
let lastDetailPayload = null;
let currentViewState = 'guide';
let lastEmptyDescriptor = null;
let lastNotFoundDescriptor = null;
let publicStoreSettings = { ...DEFAULT_STORE_SETTINGS };
let publicStoreServices = [];
let activePortalTab = 'track';
let activeQuoteToken = '';
let lastQuoteApprovalPayload = null;
let lastIntakeSuccess = null;
let intakeCompressedBlob = null;
let intakePreviewObjectUrl = '';
let intakePinCanvas = null;
let approvalPinCanvas = null;
let lastPhotoTrigger = null;

// Preview payload used only when Supabase credentials are not configured.
const MOCK_TRACKING_DATA = {
  found: true,
  isDemo: true,
  mode: 'detail',
  order: {
    ticket_code: 'MND-DEMO-001',
    customer_name: 'Pelanggan Contoh',
    customer_phone: '6281234567890',
    status: 'in_progress',
    total_amount: 165000,
    paid_amount: 50000,
    payment_status: 'partial',
    estimated_done_date: new Date(Date.now() + 2 * 86400000).toISOString().split('T')[0],
    notes: 'Contoh catatan: benang jahit rantai warna copper sesuai jahitan awal.',
    created_at: new Date(Date.now() - 86400000).toISOString(),
    updated_at: new Date().toISOString(),
  },
  items: [
    {
      id: 'mock-item-1',
      garment_name: 'Raw Selvedge Denim 15oz',
      service_type: 'Sashiko Crotch Repair',
      measurement_specs: { area: 'Selangkangan kiri', benang: 'Indigo Sashiko' },
      price: 115000,
      before_photo_url: '/assets/placeholder-garment.svg',
      after_photo_url: null,
    },
    {
      id: 'mock-item-2',
      garment_name: 'Raw Selvedge Denim 15oz',
      service_type: 'Chainstitch Hemming',
      measurement_specs: { inseam: '78 cm', benang: 'Copper Gold' },
      price: 50000,
      before_photo_url: null,
      after_photo_url: null,
    },
  ],
  logs: [
    {
      id: 'log-1',
      status: 'received',
      log_note: 'Order diterima oleh workshop',
      created_at: new Date(Date.now() - 86400000).toISOString(),
    },
    {
      id: 'log-2',
      status: 'in_progress',
      log_note: 'Sedang dalam proses pengerjaan',
      created_at: new Date(Date.now() - 7200000).toISOString(),
    },
  ],
};

const trackerHeroEl = document.getElementById('tracker-hero');
const trackerHeroHeadingEl = document.getElementById('tracker-hero-heading');
const portalTabsBarEl = document.getElementById('portal-tabs-bar');
const heroTrackPanelEl = document.getElementById('hero-track-panel');
const heroQuoteDescEl = document.getElementById('hero-quote-desc');
const trackerBrandLink = document.getElementById('tracker-brand-link');
const workshopNotFoundEl = document.getElementById('workshop-not-found');
const workshopNotFoundMsgEl = document.getElementById('workshop-not-found-message');
const footerTaglineWrap = document.getElementById('footer-tagline-wrap');

const quoteIntakeSectionEl = document.getElementById('quote-intake-section');
const intakeServicesCardEl = document.getElementById('intake-services-card');
const intakeServicesListEl = document.getElementById('intake-services-list');
const intakeFormCardEl = document.getElementById('intake-form-card');
const intakeFormEl = document.getElementById('quote-intake-form');
const intakeErrorBoxEl = document.getElementById('intake-error-box');
const intakePhotoInputEl = document.getElementById('intake-photo-input');
const intakePhotoBtnLabelEl = document.getElementById('intake-photo-btn-label');
const intakePhotoStatusEl = document.getElementById('intake-photo-status');
const intakePinCanvasEl = document.getElementById('intake-pin-canvas');
const intakeSuccessCardEl = document.getElementById('intake-success-card');
const quoteApprovalSectionEl = document.getElementById('quote-approval-section');

const trackForm = document.getElementById('track-form');
const trackInput = document.getElementById('track-input');
const clearInputBtn = document.getElementById('clear-input-btn');
const trackerExitBtn = document.getElementById('tracker-exit-btn');
const configWarning = document.getElementById('config-warning');
const demoTicketBtn = document.getElementById('demo-ticket-btn');

const loadingEl = document.getElementById('tracking-loading');
const emptyEl = document.getElementById('tracking-empty');
const emptyTitleEl = document.getElementById('empty-title');
const emptyMessageEl = document.getElementById('empty-message');
const emptyResetBtn = document.getElementById('empty-reset-btn');
const ticketListEl = document.getElementById('ticket-list-container');
const resultEl = document.getElementById('tracking-result');
const initialGuideEl = document.getElementById('initial-guide');

const photoModal = document.getElementById('photo-modal');
const photoModalImg = document.getElementById('photo-modal-img');
const photoModalCaption = document.getElementById('photo-modal-caption');
const closePhotoModalBtn = document.getElementById('close-photo-modal');

function getTrackerLocaleStorageKey() {
  return activeSlug ? `mendtrack-tracker-locale:${activeSlug}` : 'mendtrack-tracker-locale';
}

function resolveWorkshopSlug() {
  const pathMatch = window.location.pathname.match(/^\/t\/([^/]+)\/?$/i);
  if (pathMatch && pathMatch[1]) {
    try {
      const decoded = decodeURIComponent(pathMatch[1]).trim().toLowerCase();
      return SLUG_REGEX.test(decoded) ? decoded : '';
    } catch {
      return '';
    }
  }
  const params = new URLSearchParams(window.location.search);
  const querySlug = String(params.get('store') || '').trim().toLowerCase();
  return SLUG_REGEX.test(querySlug) ? querySlug : '';
}

async function callPublicTracker(payload) {
  const endpoint = `${SUPABASE_CONFIG.URL.replace(/\/+$/, '')}/functions/v1/public-tracker`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_CONFIG.ANON_KEY,
    },
    body: JSON.stringify(payload),
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(data?.error || data?.message || t('tracker.serverStatusError', { status: response.status }));
  }
  return data;
}

async function callPublicQuoteJson(payload) {
  const endpoint = `${SUPABASE_CONFIG.URL.replace(/\/+$/, '')}/functions/v1/public-quote`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_CONFIG.ANON_KEY,
    },
    body: JSON.stringify(payload),
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const err = new Error(data?.error || data?.message || t('tracker.serverStatusError', { status: response.status }));
    err.mode = data?.mode || '';
    err.status = response.status;
    throw err;
  }
  return data;
}

async function callPublicQuoteMultipart(formData) {
  const endpoint = `${SUPABASE_CONFIG.URL.replace(/\/+$/, '')}/functions/v1/public-quote`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_CONFIG.ANON_KEY,
    },
    body: formData,
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const err = new Error(data?.error || data?.message || t('tracker.serverStatusError', { status: response.status }));
    err.mode = data?.mode || '';
    err.status = response.status;
    throw err;
  }
  return data;
}

function showWorkshopNotFound(keyOrMessage, params = {}) {
  isWorkshopValid = false;
  currentViewState = 'not_found';
  lastNotFoundDescriptor = { keyOrMessage, params };
  trackerHeroEl?.classList.add('hidden');
  initialGuideEl?.classList.add('hidden');
  loadingEl?.classList.add('hidden');
  emptyEl?.classList.add('hidden');
  ticketListEl?.classList.add('hidden');
  resultEl?.classList.add('hidden');
  quoteIntakeSectionEl?.classList.add('hidden');
  quoteApprovalSectionEl?.classList.add('hidden');
  trackerExitBtn?.classList.add('hidden');
  if (workshopNotFoundMsgEl) {
    workshopNotFoundMsgEl.textContent = t(keyOrMessage, params);
  }
  workshopNotFoundEl?.classList.remove('hidden');
  document.title = t('tracker.titleNotFound');
  if (window.lucide) window.lucide.createIcons();
}

function rerenderActiveTrackerView() {
  applyTranslations(document);
  const metaDesc = document.querySelector('meta[name="description"]');
  if (metaDesc) {
    metaDesc.setAttribute('content', t('tracker.metaDescription'));
  }
  if (photoModalImg) {
    photoModalImg.alt = t('tracker.photoModalImgAlt');
  }
  if (currentViewState === 'not_found' && lastNotFoundDescriptor) {
    showWorkshopNotFound(lastNotFoundDescriptor.keyOrMessage, lastNotFoundDescriptor.params);
    return;
  }
  if (isWorkshopValid) {
    applyStoreIdentity(document, publicStoreSettings);
  } else {
    document.title = t('tracker.titleDefault');
  }

  renderIntakeServicesCatalog();
  if (intakePinCanvas) intakePinCanvas.rerender();
  if (lastIntakeSuccess) renderIntakeSuccessCard(lastIntakeSuccess);

  if (currentViewState === 'quote_approve') {
    if (trackerHeroHeadingEl) trackerHeroHeadingEl.textContent = t('quoteApprove.heading');
    if (lastQuoteApprovalPayload) renderQuoteApprovalView(lastQuoteApprovalPayload);
    return;
  }
  if (activePortalTab === 'quote') {
    if (trackerHeroHeadingEl) trackerHeroHeadingEl.textContent = t('intake.heroTitle');
    return;
  }
  if (trackerHeroHeadingEl) trackerHeroHeadingEl.textContent = t('tracker.heroTitle');

  if (currentViewState === 'list' && lastTicketList.length) {
    renderTicketSelectionList(lastTicketList);
  } else if (currentViewState === 'detail' && lastDetailPayload) {
    renderOrderDetail(lastDetailPayload);
  } else if (currentViewState === 'empty' && lastEmptyDescriptor) {
    showEmptyState(lastEmptyDescriptor.titleKey, lastEmptyDescriptor.messageKey, lastEmptyDescriptor.params);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  activeSlug = resolveWorkshopSlug();
  const initialSaved = readStoredLocale(getTrackerLocaleStorageKey());
  setLocale(initialSaved || detectPreferredLocale());
  applyTranslations(document);

  if (window.lucide) window.lucide.createIcons();
  initConnectionMonitor('connection-badge');
  applyStoreIdentity(document, publicStoreSettings);

  if (activeSlug && trackerBrandLink) {
    trackerBrandLink.href = `/t/${encodeURIComponent(activeSlug)}`;
  }

  document.addEventListener('click', (event) => {
    if (!event.target.closest('[data-mt-lang-toggle]')) return;
    const next = getLocale() === 'en' ? 'id' : 'en';
    // Customer language override never alters the workshop's billing currency.
    setLocale(next, { persist: true, storageKey: getTrackerLocaleStorageKey() });
    rerenderActiveTrackerView();
  });

  trackInput?.addEventListener('input', () => {
    clearInputBtn?.classList.toggle('hidden', trackInput.value.trim().length === 0);
  });

  clearInputBtn?.addEventListener('click', () => {
    trackInput.value = '';
    clearInputBtn.classList.add('hidden');
    trackInput.focus();
  });

  const resetToGuide = () => {
    trackInput.value = '';
    currentSearchedPhone = '';
    lastTicketList = [];
    lastDetailPayload = null;
    lastEmptyDescriptor = null;
    clearInputBtn?.classList.add('hidden');
    setViewState('guide');
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete('phone');
    nextUrl.searchParams.delete('ticket');
    nextUrl.searchParams.delete('q');
    window.history.replaceState({}, '', nextUrl);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    trackInput.focus();
  };

  trackerExitBtn?.addEventListener('click', resetToGuide);
  emptyResetBtn?.addEventListener('click', resetToGuide);

  demoTicketBtn?.addEventListener('click', () => {
    trackInput.value = '0812-3456-7890';
    clearInputBtn?.classList.remove('hidden');
    executeTrackingSearch('0812-3456-7890');
  });

  trackForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!isWorkshopValid) return;
    const query = trackInput.value.trim();
    if (!query) return;
    executeTrackingSearch(query);
  });

  closePhotoModalBtn?.addEventListener('click', closeLightbox);
  photoModal?.addEventListener('click', (e) => {
    if (e.target === photoModal) closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && photoModal && !photoModal.classList.contains('hidden')) {
      closeLightbox();
    }
  });

  bindPortalTabsAndIntakeEvents();

  if (!isSupabaseConfigured) {
    isWorkshopValid = true;
    configWarning?.classList.remove('hidden');
    return;
  }

  if (!activeSlug) {
    showWorkshopNotFound('tracker.notFoundNoSlug');
    return;
  }

  const initialParams = new URLSearchParams(window.location.search);
  const initialQuoteToken = String(initialParams.get('quote') || '').trim();
  const initialTabParam = String(initialParams.get('tab') || '').trim().toLowerCase();

  if (initialQuoteToken) {
    activeQuoteToken = initialQuoteToken;
    await loadQuoteApprovalView(initialQuoteToken);
    return;
  }

  setViewState('loading');
  try {
    const profileRes = await callPublicTracker({
      action: 'profile',
      slug: activeSlug,
    });

    if (!profileRes || !profileRes.found || !profileRes.store) {
      showWorkshopNotFound('tracker.notFoundSlug', { slug: activeSlug });
      return;
    }

    isWorkshopValid = true;
    publicStoreSettings = mapTenantToSettings(profileRes.store);
    publicStoreServices = Array.isArray(profileRes.services) ? profileRes.services : [];
    setCurrency(publicStoreSettings.CURRENCY);
    setTimezone(publicStoreSettings.TIMEZONE);

    // Default to the workshop's configured locale unless the customer explicitly toggled language for this slug.
    const customerOverride = readStoredLocale(getTrackerLocaleStorageKey());
    setLocale(customerOverride || publicStoreSettings.LOCALE || 'id');
    applyTranslations(document);
    applyStoreIdentity(document, publicStoreSettings);
    renderIntakeServicesCatalog();
    if (footerTaglineWrap) {
      footerTaglineWrap.classList.toggle('hidden', !publicStoreSettings.TAGLINE);
    }

    if (initialTabParam === 'quote') {
      setPortalTab('quote', false);
      return;
    }

    setPortalTab('track', false);

    // Auto-load only from the phone query parameter (ticket code links are not exposed).
    const initialPhone = initialParams.get('phone');
    if (initialPhone) {
      trackInput.value = initialPhone;
      clearInputBtn?.classList.remove('hidden');
      executeTrackingSearch(initialPhone);
    }
  } catch (err) {
    console.error('Gagal memuat profil workshop:', err);
    showWorkshopNotFound('tracker.notFoundLoadError');
  }
});

async function executeTrackingSearch(rawQuery) {
  const query = normalizePhone(rawQuery);
  if (!query || query.length < 10) {
    showEmptyState('tracker.invalidPhoneTitle', 'tracker.invalidPhoneMsg');
    return;
  }

  currentSearchedPhone = query;
  lastTicketList = [];
  lastDetailPayload = null;

  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.delete('ticket');
  nextUrl.searchParams.delete('q');
  nextUrl.searchParams.set('phone', query);
  window.history.replaceState({}, '', nextUrl);

  setViewState('loading');

  if (!isSupabaseConfigured) {
    setTimeout(() => {
      if (query === '6281234567890') {
        renderOrderDetail(MOCK_TRACKING_DATA);
      } else {
        showEmptyState('tracker.previewActiveTitle', 'tracker.previewActiveMsg');
      }
    }, 250);
    return;
  }

  try {
    const data = await callPublicTracker({
      action: 'lookup',
      slug: activeSlug,
      phone: query,
    });

    if (!data || !data.found) {
      if (data?.mode === 'tenant_not_found') {
        showWorkshopNotFound('tracker.notFoundSlug', { slug: activeSlug });
        return;
      }
      if (data?.mode === 'invalid_phone') {
        showEmptyState('tracker.invalidPhoneTitle', 'tracker.invalidPhoneMsg');
        return;
      }
      showEmptyState('tracker.emptyTitleDefault', 'tracker.emptyMessageDefault');
      return;
    }

    if (data.mode === 'list') {
      lastTicketList = data.tickets || [];
      renderTicketSelectionList(lastTicketList);
      return;
    }

    if (data.mode === 'detail') {
      renderOrderDetail(data);
    }
  } catch (err) {
    console.error('Tracking lookup error:', err);
    showEmptyState('tracker.loadFailedTitle', 'tracker.loadFailedMsg');
  }
}

async function executeSelectedTicket(ticketCode) {
  const code = String(ticketCode || '').trim().toUpperCase();
  if (!code || !currentSearchedPhone) return;

  setViewState('loading');

  try {
    const data = await callPublicTracker({
      action: 'detail',
      slug: activeSlug,
      phone: currentSearchedPhone,
      ticket_code: code,
    });

    if (!data || !data.found) {
      if (data?.mode === 'tenant_not_found') {
        showWorkshopNotFound('tracker.notFoundSlug', { slug: activeSlug });
        return;
      }
      showEmptyState('tracker.emptyTitleDefault', 'tracker.detailNotFoundMsg');
      return;
    }

    if (data.mode === 'detail') {
      renderOrderDetail(data);
      return;
    }

    showEmptyState('tracker.detailUnavailableTitle', 'tracker.detailUnavailableMsg');
  } catch (err) {
    console.error('Selected ticket tracking error:', err);
    showEmptyState('tracker.detailFailedTitle', 'tracker.detailFailedMsg');
  }
}

function setViewState(state) {
  currentViewState = state;
  workshopNotFoundEl?.classList.add('hidden');
  initialGuideEl?.classList.toggle('hidden', state !== 'guide');
  loadingEl?.classList.toggle('hidden', state !== 'loading');
  emptyEl?.classList.toggle('hidden', state !== 'empty');
  ticketListEl?.classList.toggle('hidden', state !== 'list');
  resultEl?.classList.toggle('hidden', state !== 'detail');
  quoteIntakeSectionEl?.classList.toggle('hidden', state !== 'quote_intake');
  quoteApprovalSectionEl?.classList.toggle('hidden', state !== 'quote_approve');
  trackerExitBtn?.classList.toggle(
    'hidden',
    state === 'guide' || state === 'quote_intake' || state === 'quote_approve'
  );
}

function showEmptyState(titleKey, messageKey, params = {}) {
  lastEmptyDescriptor = { titleKey, messageKey, params };
  if (emptyTitleEl) emptyTitleEl.textContent = t(titleKey, params);
  if (emptyMessageEl) emptyMessageEl.textContent = t(messageKey, params);
  setViewState('empty');
  if (window.lucide) window.lucide.createIcons();
}

function renderTicketSelectionList(tickets) {
  if (!ticketListEl) return;

  const cardsHTML = tickets
    .map((ticket) => {
      const orderType = ticket.order_type === 'mail_in' ? 'mail_in' : 'walk_in';
      const statusInfo = getStatusMeta(ticket.status, null, orderType);
      const typeInfo = orderType === 'mail_in' ? getOrderTypeMeta(orderType) : null;
      return `
        <button
          type="button"
          data-select-ticket="${escapeHTML(ticket.ticket_code)}"
          class="w-full text-left mt-card p-4 transition flex items-center justify-between gap-3 hover:border-[var(--mt-accent)]"
        >
          <div class="min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-mono-code font-bold text-sm mt-text">${escapeHTML(ticket.ticket_code)}</span>
              ${typeInfo ? `<span class="${typeInfo.badgeClass}">${escapeHTML(typeInfo.label)}</span>` : ''}
              <span class="${statusInfo.badgeClass}">
                <span class="${statusInfo.dotClass}" aria-hidden="true"></span>
                <span>${escapeHTML(statusInfo.label)}</span>
              </span>
            </div>
            <p class="text-xs mt-muted mt-1.5">
              ${escapeHTML(t('common.itemCount', { count: ticket.item_count || 0 }))} · ${escapeHTML(t('tracker.ticketReceivedMeta', { date: formatDateID(ticket.created_at) }))}
              ${ticket.estimated_done_date ? ` · ${escapeHTML(t('tracker.ticketEstMeta'))} <strong class="mt-text">${escapeHTML(formatDateID(ticket.estimated_done_date))}</strong>` : ''}
            </p>
          </div>
          <span class="w-9 h-9 rounded-lg mt-card-muted flex items-center justify-center shrink-0" aria-hidden="true">
            <i data-lucide="chevron-right" class="w-4 h-4 mt-text"></i>
          </span>
        </button>
      `;
    })
    .join('');

  ticketListEl.innerHTML = `
    <div class="mt-card p-4">
      <h2 class="text-sm font-bold mt-text">${escapeHTML(t('tracker.foundTicketsHeading', { count: tickets.length }))}</h2>
      <p class="text-xs mt-muted mt-0.5">${escapeHTML(t('tracker.foundTicketsDesc'))}</p>
    </div>
    <div class="space-y-2.5">${cardsHTML}</div>
  `;

  ticketListEl.querySelectorAll('[data-select-ticket]').forEach((btn) => {
    btn.addEventListener('click', () => {
      executeSelectedTicket(btn.getAttribute('data-select-ticket'));
    });
  });

  setViewState('list');
  if (window.lucide) window.lucide.createIcons();
}

function renderOrderDetail(payload) {
  if (!resultEl) return;
  lastDetailPayload = payload;
  const { order, items = [], logs = [], isDemo = false } = payload;

  const orderType = order.order_type === 'mail_in' ? 'mail_in' : 'walk_in';
  const isMailIn = orderType === 'mail_in';
  const orderSteps = getOrderSteps(null, orderType);
  const statusInfo = getStatusMeta(order.status, null, orderType);
  const typeInfo = getOrderTypeMeta(orderType);
  const payInfo = getPaymentStatusMeta(order.payment_status);
  const remainingAmount = Math.max(0, Number(order.total_amount) - Number(order.paid_amount));
  const deadlineInfo = getDeadlineStatus(order.estimated_done_date);
  const isDoneStage = ['ready', 'shipped', 'completed'].includes(order.status);

  const normalizeStepKey = (rawStatus) => {
    if (rawStatus === 'awaiting_package' || rawStatus === 'queued') return 'received';
    if (rawStatus === 'qc') return 'in_progress';
    if (rawStatus === 'shipped') return 'completed';
    return rawStatus;
  };

  const isCompletedOrder = order.status === 'completed' || order.status === 'shipped';
  const effectiveStatus = normalizeStepKey(order.status);
  const currentStepIdx = Math.max(
    0,
    orderSteps.findIndex((s) => s.key === effectiveStatus)
  );

  const statusTimestamps = {};
  logs.forEach((log) => {
    const normalized = normalizeStepKey(log.status);
    statusTimestamps[log.status] = log.created_at;
    if (!statusTimestamps[normalized]) statusTimestamps[normalized] = log.created_at;
  });

  const stepperHTML = orderSteps
    .map((step, idx) => {
      const isCompleted = isCompletedOrder || idx < currentStepIdx;
      const isCurrent = !isCompletedOrder && idx === currentStepIdx;
      const stepTime = statusTimestamps[step.key];

      const dotState = isCompleted ? 'is-done' : isCurrent ? 'is-current' : '';
      const titleClass = isCurrent ? 'mt-text font-bold' : isCompleted ? 'mt-text font-semibold' : 'mt-muted';

      return `
        <div class="relative flex gap-3.5 pb-6 last:pb-0">
          ${
            idx < orderSteps.length - 1
              ? `<div class="absolute left-4 top-8 bottom-0 w-0.5 mt-step-line ${isCompleted ? 'is-done' : ''}" aria-hidden="true"></div>`
              : ''
          }
          <div class="relative z-10 mt-step-dot ${dotState}" aria-hidden="true">
            <i data-lucide="${isCompleted ? 'check' : step.icon}" class="w-4 h-4"></i>
          </div>
          <div class="flex-1 pt-0.5 min-w-0">
            <div class="flex items-center justify-between gap-2 flex-wrap">
              <p class="text-sm ${titleClass}">
                ${escapeHTML(step.label)}${isCurrent ? escapeHTML(t('tracker.currentStageTag')) : ''}
              </p>
              ${
                stepTime
                  ? `<span class="text-xs font-mono-code mt-muted">${escapeHTML(formatDateID(stepTime, true))}</span>`
                  : ''
              }
            </div>
            <p class="text-xs mt-muted mt-0.5">${escapeHTML(step.description)}</p>
          </div>
        </div>
      `;
    })
    .join('');

  const logsHTML =
    logs.length > 0
      ? logs
          .slice()
          .reverse()
          .map((log) => {
            const meta = getStatusMeta(log.status, null, orderType);
            const localizedNote = translateSystemLogNote(log.log_note, log.status);
            return `
              <div class="flex items-start gap-2.5 text-xs py-2.5 border-b last:border-none" style="border-color: var(--mt-border);">
                <span class="${meta.badgeClass} shrink-0">${escapeHTML(meta.label)}</span>
                <div class="flex-1 min-w-0">
                  <p class="mt-text font-medium">${escapeHTML(localizedNote)}</p>
                  <p class="text-xs mt-muted mt-0.5 font-mono-code">${escapeHTML(formatDateID(log.created_at, true))}</p>
                </div>
              </div>
            `;
          })
          .join('')
      : `<p class="text-xs mt-muted">${escapeHTML(t('tracker.activityLogEmpty'))}</p>`;

  const renderTrackingRow = (courierLabel, trackingLabel, courier, tracking) => {
    const hasTracking = Boolean(tracking);
    return `
      <div class="mt-card-muted p-3.5 space-y-1.5">
        <div class="flex items-center justify-between gap-2 text-xs">
          <span class="mt-muted font-semibold">${escapeHTML(courierLabel)}</span>
          <span class="font-semibold mt-text">${escapeHTML(courier || t('tracker.trackingPending'))}</span>
        </div>
        <div class="flex items-center justify-between gap-2 pt-1.5 mt-seam-t">
          <div class="min-w-0">
            <p class="text-xs mt-muted">${escapeHTML(trackingLabel)}</p>
            <p class="font-mono-code text-sm font-bold ${hasTracking ? 'mt-text' : 'mt-muted'} mt-tracking-code">
              ${escapeHTML(hasTracking ? tracking : t('tracker.trackingPending'))}
            </p>
          </div>
          ${
            hasTracking
              ? `<button
                  type="button"
                  data-copy-tracking="${escapeHTML(tracking)}"
                  aria-label="${escapeHTML(t('tracker.copyTrackingAria', { tracking }))}"
                  title="${escapeHTML(t('common.copy'))}"
                  class="mt-btn-icon mt-btn-secondary shrink-0"
                >
                  <i data-lucide="copy" class="w-4 h-4" aria-hidden="true"></i>
                </button>`
              : ''
          }
        </div>
      </div>
    `;
  };

  const mailInCardHTML = isMailIn
    ? `<section class="mt-card p-5 sm:p-6 space-y-3">
        <h3 class="text-sm font-bold mt-text flex items-center gap-2">
          <i data-lucide="truck" class="w-4 h-4 mt-accent" aria-hidden="true"></i>
          <span>${escapeHTML(t('tracker.mailInHeading'))}</span>
        </h3>
        ${
          (order.status === 'awaiting_package' || (order.status === 'received' && !order.inbound_tracking)) &&
          publicStoreSettings.ADDRESS
            ? `<div class="mt-notice-warn p-3 text-xs space-y-1">
                <p class="font-semibold">${escapeHTML(t('tracker.shipToWorkshopHint', { ticket: order.ticket_code }))}</p>
                <p class="font-medium">${escapeHTML(publicStoreSettings.NAME)} · ${escapeHTML(publicStoreSettings.ADDRESS)}</p>
              </div>`
            : ''
        }
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          ${renderTrackingRow(
            t('tracker.inboundCourier'),
            t('tracker.inboundTracking'),
            order.inbound_courier,
            order.inbound_tracking
          )}
          ${renderTrackingRow(
            t('tracker.outboundCourier'),
            t('tracker.outboundTracking'),
            order.outbound_courier,
            order.outbound_tracking
          )}
        </div>
      </section>`
    : '';

  const itemsHTML = items
    .map((item, index) => {
      const specs = item.measurement_specs || {};
      const specEntries = Object.entries(specs).filter(([_, v]) => v !== '' && v !== null);

      const specsBadges =
        specEntries.length > 0
          ? `<div class="flex flex-wrap gap-1.5 mt-2">
              ${specEntries
                .map(
                  ([k, v]) => `
                  <span class="inline-flex items-center px-2 py-1 rounded text-xs font-medium mt-card">
                    ${escapeHTML(k)}: <strong class="ml-1">${escapeHTML(v)}</strong>
                  </span>`
                )
                .join('')}
            </div>`
          : '';

      const hasBefore = Boolean(item.before_photo_url);
      const hasAfter = Boolean(item.after_photo_url);
      const photosHTML =
        hasBefore || hasAfter
          ? `<div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mt-3 pt-3 mt-seam-t">
              ${
                hasBefore
                  ? `<button type="button" data-photo-url="${escapeHTML(item.before_photo_url)}" data-photo-title="${escapeHTML(t('tracker.beforeTitle', { name: item.garment_name }))}" class="group relative rounded-lg overflow-hidden border bg-black aspect-[4/3] w-full text-left" style="border-color: var(--mt-border);">
                      <img src="${escapeHTML(item.before_photo_url)}" width="640" height="480" onerror="this.src='/assets/placeholder-garment.svg'" alt="${escapeHTML(t('tracker.beforeAlt', { name: item.garment_name }))}" class="w-full h-full object-cover" />
                      <span class="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/80 text-white text-xs font-semibold">${escapeHTML(t('tracker.beforeBadge'))}</span>
                    </button>`
                  : ''
              }
              ${
                hasAfter
                  ? `<button type="button" data-photo-url="${escapeHTML(item.after_photo_url)}" data-photo-title="${escapeHTML(t('tracker.afterTitle', { name: item.garment_name }))}" class="group relative rounded-lg overflow-hidden border bg-black aspect-[4/3] w-full text-left" style="border-color: var(--mt-border);">
                      <img src="${escapeHTML(item.after_photo_url)}" width="640" height="480" onerror="this.src='/assets/placeholder-garment.svg'" alt="${escapeHTML(t('tracker.afterAlt', { name: item.garment_name }))}" class="w-full h-full object-cover" />
                      <span class="absolute top-2 left-2 px-2 py-0.5 rounded mt-badge-ready text-xs font-semibold">${escapeHTML(t('tracker.afterBadge'))}</span>
                    </button>`
                  : ''
              }
            </div>`
          : '';

      return `
        <article class="mt-card-muted p-4">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <span class="text-xs font-mono-code font-semibold mt-accent">${escapeHTML(t('common.itemLabel', { number: index + 1 }))}</span>
              <h4 class="font-bold mt-text text-sm sm:text-base">${escapeHTML(item.garment_name)}</h4>
              <p class="text-xs sm:text-sm mt-muted font-medium mt-0.5">${escapeHTML(item.service_type)}</p>
            </div>
            <span class="font-mono-code font-bold text-sm mt-text shrink-0">
              ${escapeHTML(formatCurrency(item.price))}
            </span>
          </div>
          ${specsBadges}
          ${photosHTML}
        </article>
      `;
    })
    .join('');

  const waMessage = t('tracker.waInquiryMessage', {
    store: publicStoreSettings.NAME,
    customer: order.customer_name,
    ticket: order.ticket_code,
  });
  const waAdminLink = publicStoreSettings.ADMIN_PHONE
    ? buildWhatsAppLink(publicStoreSettings.ADMIN_PHONE, waMessage)
    : '';

  const backToListHTML =
    lastTicketList.length > 1
      ? `<div>
          <button type="button" id="back-to-ticket-list-btn" class="mt-btn mt-btn-secondary text-xs">
            <i data-lucide="arrow-left" class="w-4 h-4" aria-hidden="true"></i>
            <span>${escapeHTML(t('tracker.backToList', { count: lastTicketList.length }))}</span>
          </button>
        </div>`
      : '';

  resultEl.innerHTML = `
    ${backToListHTML}
    ${
      isDemo
        ? `<div class="mt-notice-warn px-4 py-3 text-xs font-semibold">${escapeHTML(t('tracker.demoBanner'))}</div>`
        : ''
    }

    <section class="mt-card p-5 sm:p-6">
      <div class="flex items-start justify-between gap-3 flex-wrap pb-4 mt-seam-b">
        <div>
          <span class="text-xs mt-muted font-semibold">${escapeHTML(t('tracker.ticketCodeLabel'))}</span>
          <div class="flex items-center gap-2 mt-0.5">
            <h2 class="font-mono-code text-xl sm:text-2xl font-bold mt-text">${escapeHTML(order.ticket_code)}</h2>
            <button type="button" id="copy-ticket-btn" aria-label="${escapeHTML(t('tracker.copyTicketAria', { code: order.ticket_code }))}" title="${escapeHTML(t('tracker.copyTicketTitle'))}" class="mt-btn-icon mt-btn-secondary">
              <i data-lucide="copy" class="w-4 h-4" aria-hidden="true"></i>
            </button>
          </div>
          <p class="text-sm mt-muted mt-1">${escapeHTML(t('tracker.customerLabel'))} <strong class="mt-text">${escapeHTML(order.customer_name)}</strong></p>
        </div>

        <div class="flex flex-col items-start sm:items-end gap-1.5">
          <div class="flex items-center gap-1.5 flex-wrap">
            ${isMailIn ? `<span class="${typeInfo.badgeClass}">${escapeHTML(typeInfo.label)}</span>` : ''}
            <span class="${statusInfo.badgeClass}">
              <span class="${statusInfo.dotClass}" aria-hidden="true"></span>
              <span>${escapeHTML(statusInfo.label)}</span>
            </span>
          </div>
          <span class="text-xs mt-muted">
            ${escapeHTML(t('tracker.targetDoneLabel'))} <strong class="${deadlineInfo.isOverdue && !isDoneStage ? 'mt-danger-text' : 'mt-text'}">${escapeHTML(formatDateID(order.estimated_done_date))}</strong>
          </span>
        </div>
      </div>

      ${
        order.notes
          ? `<div class="mt-notice-warn mt-4 p-3 text-xs flex items-start gap-2">
              <i data-lucide="sticky-note" class="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true"></i>
              <div><span class="font-semibold">${escapeHTML(t('tracker.workshopNotesLabel'))}</span> ${escapeHTML(order.notes)}</div>
            </div>`
          : ''
      }
    </section>

    ${mailInCardHTML}

    <section class="mt-card p-5 sm:p-6">
      <h3 class="text-sm font-bold mt-text mb-5 flex items-center gap-2">
        <i data-lucide="git-commit-horizontal" class="w-4 h-4 mt-accent" aria-hidden="true"></i>
        <span>${escapeHTML(t('tracker.stagesHeading'))}</span>
      </h3>

      <div>${stepperHTML}</div>

      <details class="mt-5 pt-4 mt-seam-t group">
        <summary class="text-xs font-semibold mt-text min-h-11 flex items-center justify-between list-none">
          <span>${escapeHTML(t('tracker.activityLogSummary', { count: logs.length }))}</span>
          <i data-lucide="chevron-down" class="w-4 h-4 group-open:rotate-180 transition" aria-hidden="true"></i>
        </summary>
        <div class="mt-2">${logsHTML}</div>
      </details>
    </section>

    <section class="mt-card p-5 sm:p-6">
      <h3 class="text-sm font-bold mt-text mb-4 flex items-center gap-2">
        <i data-lucide="layers" class="w-4 h-4 mt-accent" aria-hidden="true"></i>
        <span>${escapeHTML(t('tracker.itemsHeading', { count: items.length }))}</span>
      </h3>
      <div class="space-y-3">${itemsHTML}</div>
    </section>

    <section class="mt-card p-5 sm:p-6">
      <div class="flex items-center justify-between gap-2 mb-4">
        <h3 class="text-sm font-bold mt-text flex items-center gap-2">
          <i data-lucide="receipt-text" class="w-4 h-4 mt-accent" aria-hidden="true"></i>
          <span>${escapeHTML(t('tracker.costHeading'))}</span>
        </h3>
        <span class="${payInfo.badgeClass}">
          ${escapeHTML(payInfo.label)}
        </span>
      </div>

      <div class="space-y-2 text-sm">
        <div class="flex justify-between mt-muted">
          <span>${escapeHTML(t('tracker.totalServiceCost'))}</span>
          <span class="font-mono-code font-semibold mt-text">${escapeHTML(formatCurrency(order.total_amount))}</span>
        </div>
        <div class="flex justify-between mt-muted">
          <span>${escapeHTML(t('tracker.alreadyPaidLabel'))}</span>
          <span class="font-mono-code font-medium mt-success-text">- ${escapeHTML(formatCurrency(order.paid_amount))}</span>
        </div>
        <div class="pt-3 mt-seam-t flex justify-between items-center">
          <span class="font-bold mt-text">${escapeHTML(t('tracker.remainingBalance'))}</span>
          <span class="font-mono-code text-lg font-bold ${remainingAmount > 0 ? 'mt-accent' : 'mt-success-text'}">
            ${escapeHTML(formatCurrency(remainingAmount))}
          </span>
        </div>
      </div>

      ${
        waAdminLink
          ? `<div class="mt-6 pt-4 mt-seam-t">
              <a
                href="${waAdminLink}"
                target="_blank"
                rel="noopener noreferrer"
                class="mt-btn mt-btn-success w-full"
              >
                <i data-lucide="message-circle" class="w-5 h-5" aria-hidden="true"></i>
                <span>${escapeHTML(t('tracker.contactAdminWa'))}</span>
              </a>
            </div>`
          : ''
      }
    </section>
  `;

  document.getElementById('back-to-ticket-list-btn')?.addEventListener('click', () => {
    renderTicketSelectionList(lastTicketList);
  });

  resultEl.querySelectorAll('[data-copy-tracking]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tracking = btn.getAttribute('data-copy-tracking') || '';
      if (!tracking) return;
      try {
        await navigator.clipboard.writeText(tracking);
        btn.innerHTML = '<i data-lucide="check" class="w-4 h-4 mt-success-text" aria-hidden="true"></i>';
        btn.setAttribute('aria-label', t('tracker.copyTrackingDoneAria'));
        if (window.lucide) window.lucide.createIcons();
        setTimeout(() => {
          btn.innerHTML = '<i data-lucide="copy" class="w-4 h-4" aria-hidden="true"></i>';
          btn.setAttribute('aria-label', t('tracker.copyTrackingAria', { tracking }));
          if (window.lucide) window.lucide.createIcons();
        }, 1800);
      } catch {
        alert(`${t('tracker.inboundTracking')}: ${tracking}`);
      }
    });
  });

  const copyBtn = document.getElementById('copy-ticket-btn');
  copyBtn?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(order.ticket_code);
      copyBtn.innerHTML = '<i data-lucide="check" class="w-4 h-4 mt-success-text" aria-hidden="true"></i>';
      copyBtn.setAttribute('aria-label', t('tracker.copyTicketDoneAria'));
      if (window.lucide) window.lucide.createIcons();
      setTimeout(() => {
        copyBtn.innerHTML = '<i data-lucide="copy" class="w-4 h-4" aria-hidden="true"></i>';
        copyBtn.setAttribute('aria-label', t('tracker.copyTicketAria', { code: order.ticket_code }));
        if (window.lucide) window.lucide.createIcons();
      }, 1500);
    } catch (_) {
      // Clipboard access may be denied in insecure contexts.
    }
  });

  resultEl.querySelectorAll('[data-photo-url]').forEach((btn) => {
    btn.addEventListener('click', () => {
      lastPhotoTrigger = btn;
      openLightbox(btn.getAttribute('data-photo-url'), btn.getAttribute('data-photo-title'));
    });
  });

  setViewState('detail');
  if (window.lucide) window.lucide.createIcons();
}

function openLightbox(url, caption) {
  if (!photoModal || !photoModalImg) return;
  photoModalImg.src = url;
  if (photoModalCaption) photoModalCaption.textContent = caption || t('tracker.photoModalDefault');
  photoModal.classList.remove('hidden');
  closePhotoModalBtn?.focus();
}

function closeLightbox() {
  if (!photoModal) return;
  photoModal.classList.add('hidden');
  if (photoModalImg) photoModalImg.src = '';
  lastPhotoTrigger?.focus();
  lastPhotoTrigger = null;
}

// Stage 4: Portal Tabs, Visual Repair Intake Form, & Customer Quote Approval
function setPortalTab(tab, updateUrl = true) {
  activePortalTab = tab === 'quote' ? 'quote' : 'track';
  portalTabsBarEl?.classList.remove('hidden');

  document.querySelectorAll('[data-portal-tab]').forEach((btn) => {
    const isSelected = btn.getAttribute('data-portal-tab') === activePortalTab;
    btn.classList.toggle('is-active', isSelected);
    btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
  });

  if (activePortalTab === 'quote') {
    if (trackerHeroHeadingEl) trackerHeroHeadingEl.textContent = t('intake.heroTitle');
    heroTrackPanelEl?.classList.add('hidden');
    heroQuoteDescEl?.classList.remove('hidden');
    setViewState('quote_intake');
  } else {
    if (trackerHeroHeadingEl) trackerHeroHeadingEl.textContent = t('tracker.heroTitle');
    heroTrackPanelEl?.classList.remove('hidden');
    heroQuoteDescEl?.classList.add('hidden');
    if (lastDetailPayload) setViewState('detail');
    else if (lastTicketList.length) setViewState('list');
    else setViewState('guide');
  }

  if (updateUrl) {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete('quote');
    if (activePortalTab === 'quote') {
      nextUrl.searchParams.set('tab', 'quote');
    } else {
      nextUrl.searchParams.delete('tab');
    }
    window.history.replaceState({}, '', nextUrl);
  }
  if (window.lucide) window.lucide.createIcons();
}

function renderIntakeServicesCatalog() {
  const selectEl = document.getElementById('intake-service');
  const currentVal = selectEl?.value || '';

  if (selectEl) {
    const options = [
      `<option value="">${escapeHTML(t('intake.serviceUnsure'))}</option>`,
      ...publicStoreServices.map((svc) => {
        const bp = Number(svc.base_price || 0);
        const label =
          bp > 0
            ? `${svc.name} (${t('services.startingFrom', { price: formatCurrency(bp) })})`
            : svc.name;
        return `<option value="${escapeHTML(svc.name)}">${escapeHTML(label)}</option>`;
      }),
    ];
    selectEl.innerHTML = options.join('');
    selectEl.value = currentVal;
  }

  if (!intakeServicesCardEl || !intakeServicesListEl) return;
  if (!publicStoreServices.length) {
    intakeServicesCardEl.classList.add('hidden');
    intakeServicesListEl.innerHTML = '';
    return;
  }

  intakeServicesCardEl.classList.remove('hidden');
  intakeServicesListEl.innerHTML = publicStoreServices
    .map((svc) => {
      const bp = Number(svc.base_price || 0);
      return `<div class="mt-card-muted p-3 flex items-center justify-between gap-2">
        <span class="text-xs sm:text-sm font-semibold mt-text">${escapeHTML(svc.name)}</span>
        ${
          bp > 0
            ? `<span class="font-mono-code text-xs font-semibold mt-accent shrink-0">${escapeHTML(
                t('services.startingFrom', { price: formatCurrency(bp) })
              )}</span>`
            : ''
        }
      </div>`;
    })
    .join('');
}

function showIntakeError(message) {
  if (!intakeErrorBoxEl) return;
  if (!message) {
    intakeErrorBoxEl.classList.add('hidden');
    intakeErrorBoxEl.textContent = '';
    return;
  }
  intakeErrorBoxEl.textContent = message;
  intakeErrorBoxEl.classList.remove('hidden');
  intakeErrorBoxEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function resetIntakeForm() {
  lastIntakeSuccess = null;
  intakeCompressedBlob = null;
  if (intakePreviewObjectUrl) {
    URL.revokeObjectURL(intakePreviewObjectUrl);
    intakePreviewObjectUrl = '';
  }
  intakePinCanvas?.clear();
  intakePinCanvas = null;
  intakeFormEl?.reset();
  if (intakePhotoInputEl) intakePhotoInputEl.value = '';
  if (intakePhotoBtnLabelEl) intakePhotoBtnLabelEl.textContent = t('intake.photoChooseBtn');
  if (intakePhotoStatusEl) intakePhotoStatusEl.textContent = t('intake.photoHint');
  showIntakeError('');
  intakeSuccessCardEl?.classList.add('hidden');
  intakeFormCardEl?.classList.remove('hidden');
  if (publicStoreServices.length) intakeServicesCardEl?.classList.remove('hidden');
}

function renderIntakeSuccessCard(info) {
  if (!intakeSuccessCardEl || !info) return;
  const waMsg = t('intake.successWaText', {
    store: publicStoreSettings.NAME,
    customer: info.customerName,
    code: info.quoteCode,
  });
  const waLink = publicStoreSettings.ADMIN_PHONE
    ? buildWhatsAppLink(publicStoreSettings.ADMIN_PHONE, waMsg)
    : '';

  intakeFormCardEl?.classList.add('hidden');
  intakeServicesCardEl?.classList.add('hidden');
  intakeSuccessCardEl.classList.remove('hidden');
  intakeSuccessCardEl.innerHTML = `
    <div class="w-12 h-12 rounded-lg mt-card-muted flex items-center justify-center mx-auto">
      <i data-lucide="check-circle-2" class="w-6 h-6 mt-success-text" aria-hidden="true"></i>
    </div>
    <h2 class="text-lg font-bold mt-text">${escapeHTML(t('intake.successHeading'))}</h2>
    <div class="mt-card-muted p-4 mt-quote-code-box mx-auto space-y-1">
      <p class="text-xs mt-muted font-semibold">${escapeHTML(t('intake.successCodeLabel'))}</p>
      <p class="font-mono-code text-xl font-bold mt-text">${escapeHTML(info.quoteCode)}</p>
    </div>
    <p class="text-sm mt-muted max-w-md mx-auto">${escapeHTML(t('intake.successDesc'))}</p>
    <div class="flex flex-wrap justify-center gap-2.5 pt-2">
      ${
        waLink
          ? `<a href="${waLink}" target="_blank" rel="noopener noreferrer" class="mt-btn mt-btn-success text-xs">
              <i data-lucide="message-circle" class="w-4 h-4" aria-hidden="true"></i>
              <span>${escapeHTML(t('intake.successWaBtn'))}</span>
            </a>`
          : ''
      }
      <button type="button" id="intake-submit-another-btn" class="mt-btn mt-btn-secondary text-xs">
        ${escapeHTML(t('intake.successNewBtn'))}
      </button>
      <button type="button" id="intake-back-track-btn" class="mt-btn mt-btn-primary text-xs">
        ${escapeHTML(t('intake.successTrackBtn'))}
      </button>
    </div>
  `;

  document.getElementById('intake-submit-another-btn')?.addEventListener('click', resetIntakeForm);
  document.getElementById('intake-back-track-btn')?.addEventListener('click', () => {
    resetIntakeForm();
    setPortalTab('track', true);
  });
  if (window.lucide) window.lucide.createIcons();
}

function bindPortalTabsAndIntakeEvents() {
  const tabButtons = Array.from(document.querySelectorAll('[data-portal-tab]'));
  tabButtons.forEach((btn, idx) => {
    btn.addEventListener('click', () => {
      if (!isWorkshopValid) return;
      setPortalTab(btn.getAttribute('data-portal-tab'), true);
    });
    btn.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      const nextIdx = (idx + (event.key === 'ArrowRight' ? 1 : -1) + tabButtons.length) % tabButtons.length;
      tabButtons[nextIdx]?.focus();
      tabButtons[nextIdx]?.click();
    });
  });

  intakePhotoInputEl?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    showIntakeError('');

    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.type)) {
      showIntakeError(t('intake.photoInvalidType'));
      event.target.value = '';
      return;
    }

    if (intakePhotoStatusEl) intakePhotoStatusEl.textContent = t('intake.photoCompressing');
    try {
      const compressed = await compressImage(file, 1280, 0.82);
      if (compressed.size > 5 * 1024 * 1024) {
        showIntakeError(t('intake.photoTooLarge'));
        if (intakePhotoStatusEl) intakePhotoStatusEl.textContent = t('intake.photoHint');
        event.target.value = '';
        return;
      }

      intakeCompressedBlob = compressed;
      if (intakePreviewObjectUrl) URL.revokeObjectURL(intakePreviewObjectUrl);
      intakePreviewObjectUrl = URL.createObjectURL(compressed);

      if (intakePhotoBtnLabelEl) intakePhotoBtnLabelEl.textContent = t('intake.photoChangeBtn');
      const kb = Math.max(1, Math.round(compressed.size / 1024));
      if (intakePhotoStatusEl) intakePhotoStatusEl.textContent = `${file.name} (${kb} KB)`;

      if (!intakePinCanvas && intakePinCanvasEl) {
        intakePinCanvas = createPinCanvas(intakePinCanvasEl, {
          mode: 'edit',
          imageUrl: intakePreviewObjectUrl,
          imageAlt: file.name || t('tracker.photoModalImgAlt'),
          pins: [],
          maxPins: 10,
        });
      } else {
        intakePinCanvas?.setImage(intakePreviewObjectUrl, file.name || t('tracker.photoModalImgAlt'));
      }
    } catch (err) {
      showIntakeError(err.message || t('intake.photoInvalidType'));
      if (intakePhotoStatusEl) intakePhotoStatusEl.textContent = t('intake.photoHint');
    }
  });

  intakeFormEl?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!isWorkshopValid) return;
    showIntakeError('');

    const customerName = document.getElementById('intake-name')?.value.trim() || '';
    const rawPhone = document.getElementById('intake-phone')?.value.trim() || '';
    const customerPhone = normalizePhone(rawPhone);
    const orderType =
      document.querySelector('input[name="intake_order_type"]:checked')?.value === 'mail_in'
        ? 'mail_in'
        : 'walk_in';
    const garmentName = document.getElementById('intake-garment')?.value.trim() || '';
    const requestedService = document.getElementById('intake-service')?.value.trim() || '';
    const customerNotes = document.getElementById('intake-notes')?.value.trim() || '';
    const honeypot = document.getElementById('intake-website-hp')?.value || '';

    if (!customerName) {
      showIntakeError(t('intake.nameRequired'));
      document.getElementById('intake-name')?.focus();
      return;
    }
    if (customerPhone.length < 10) {
      showIntakeError(t('tracker.invalidPhoneMsg'));
      document.getElementById('intake-phone')?.focus();
      return;
    }
    if (!garmentName) {
      showIntakeError(t('intake.garmentRequired'));
      document.getElementById('intake-garment')?.focus();
      return;
    }
    if (!intakeCompressedBlob) {
      showIntakeError(t('intake.photoRequired'));
      return;
    }

    const pins = intakePinCanvas ? intakePinCanvas.getPins() : [];
    if (!pins.length) {
      showIntakeError(t('intake.pinsRequired'));
      return;
    }
    if (pins.some((p) => !p.note)) {
      showIntakeError(t('intake.pinNoteMissing'));
      return;
    }

    const submitBtn = document.getElementById('intake-submit-btn');
    if (submitBtn) {
      submitBtn.disabled = true;
      const span = submitBtn.querySelector('span');
      if (span) span.textContent = t('intake.submittingBtn');
    }

    try {
      const formData = new FormData();
      formData.append('slug', activeSlug);
      formData.append('website', honeypot);
      formData.append('customer_name', customerName);
      formData.append('customer_phone', customerPhone);
      formData.append('order_type', orderType);
      formData.append('garment_name', garmentName);
      formData.append('requested_service', requestedService);
      formData.append('customer_notes', customerNotes);
      formData.append('damage_pins', JSON.stringify(pins));
      formData.append('photo', intakeCompressedBlob, 'intake.jpg');

      const res = await callPublicQuoteMultipart(formData);
      if (!res?.ok) {
        throw new Error(res?.error || t('intake.submitFailed'));
      }

      lastIntakeSuccess = {
        quoteCode: res.quote_code,
        customerName,
      };
      renderIntakeSuccessCard(lastIntakeSuccess);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      if (err.mode === 'rate_limited' || err.status === 429) {
        showIntakeError(t('intake.rateLimited'));
      } else {
        showIntakeError(err.message || t('intake.submitFailed'));
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        const span = submitBtn.querySelector('span');
        if (span) span.textContent = t('intake.submitBtn');
      }
    }
  });
}

async function loadQuoteApprovalView(token) {
  portalTabsBarEl?.classList.add('hidden');
  heroTrackPanelEl?.classList.add('hidden');
  heroQuoteDescEl?.classList.add('hidden');
  if (trackerHeroHeadingEl) trackerHeroHeadingEl.textContent = t('quoteApprove.heading');
  setViewState('quote_approve');

  if (quoteApprovalSectionEl) {
    quoteApprovalSectionEl.innerHTML = `<div class="mt-card p-6 text-sm mt-muted" role="status">${escapeHTML(
      t('quoteApprove.loading')
    )}</div>`;
  }

  try {
    const res = await callPublicQuoteJson({
      action: 'detail',
      slug: activeSlug,
      token,
    });

    if (!res || !res.found || !res.quote || !res.store) {
      if (res?.mode === 'tenant_not_found') {
        showWorkshopNotFound('tracker.notFoundSlug', { slug: activeSlug });
        return;
      }
      renderQuoteApprovalNotFound();
      return;
    }

    isWorkshopValid = true;
    publicStoreSettings = mapTenantToSettings(res.store);
    setCurrency(publicStoreSettings.CURRENCY);
    setTimezone(publicStoreSettings.TIMEZONE);

    const customerOverride = readStoredLocale(getTrackerLocaleStorageKey());
    setLocale(customerOverride || publicStoreSettings.LOCALE || 'id');
    applyTranslations(document);
    applyStoreIdentity(document, publicStoreSettings);
    if (footerTaglineWrap) {
      footerTaglineWrap.classList.toggle('hidden', !publicStoreSettings.TAGLINE);
    }
    if (trackerHeroHeadingEl) trackerHeroHeadingEl.textContent = t('quoteApprove.heading');

    lastQuoteApprovalPayload = res;
    renderQuoteApprovalView(res);
  } catch (err) {
    console.error('Gagal memuat detail persetujuan quote:', err);
    renderQuoteApprovalNotFound();
  }
}

function renderQuoteApprovalNotFound() {
  if (!quoteApprovalSectionEl) return;
  const portalUrl = `/t/${encodeURIComponent(activeSlug)}`;
  quoteApprovalSectionEl.innerHTML = `
    <div class="mt-card p-6 sm:p-8 text-center space-y-3">
      <div class="w-12 h-12 rounded-lg mt-card-muted flex items-center justify-center mx-auto">
        <i data-lucide="file-x" class="w-6 h-6 mt-muted" aria-hidden="true"></i>
      </div>
      <h2 class="text-base font-bold mt-text">${escapeHTML(t('quoteApprove.notFoundHeading'))}</h2>
      <p class="text-sm mt-muted max-w-md mx-auto">${escapeHTML(t('quoteApprove.notFoundDesc'))}</p>
      <div class="pt-2">
        <a href="${escapeHTML(portalUrl)}" class="mt-btn mt-btn-secondary text-xs">${escapeHTML(t('quoteApprove.backToPortal'))}</a>
      </div>
    </div>
  `;
  if (window.lucide) window.lucide.createIcons();
}

function renderQuoteApprovalView(payload) {
  if (!quoteApprovalSectionEl || !payload?.quote) return;
  const q = payload.quote;
  const statusMeta = getQuoteStatusMeta(q.status);
  const typeMeta = getOrderTypeMeta(q.order_type);
  const portalUrl = `/t/${encodeURIComponent(activeSlug)}`;
  const isMailIn = q.order_type === 'mail_in';
  const items = Array.isArray(q.quoted_items) ? q.quoted_items : [];

  const durationText = q.estimated_done_date
    ? t('quoteApprove.durationDate', { date: formatDateID(q.estimated_done_date) })
    : q.estimated_days
      ? t('quoteApprove.durationDays', { days: q.estimated_days })
      : '';

  const waAdminLink = publicStoreSettings.ADMIN_PHONE
    ? buildWhatsAppLink(
        publicStoreSettings.ADMIN_PHONE,
        t('intake.successWaText', {
          store: publicStoreSettings.NAME,
          customer: q.customer_name,
          code: q.quote_code,
        })
      )
    : '';

  let decisionBlockHTML = '';

  if (q.status === 'approved' && q.converted_order?.ticket_code) {
    const ticket = q.converted_order.ticket_code;
    const isOrderMailIn = q.converted_order.order_type === 'mail_in';
    decisionBlockHTML = `
      <section class="mt-card p-5 sm:p-6 space-y-4">
        <div class="flex items-start gap-3">
          <div class="w-10 h-10 rounded-lg mt-card-muted flex items-center justify-center shrink-0">
            <i data-lucide="check-circle-2" class="w-5 h-5 mt-success-text" aria-hidden="true"></i>
          </div>
          <div class="min-w-0">
            <h2 class="text-base font-bold mt-text">${escapeHTML(t('quoteApprove.approvedHeading'))}</h2>
            <p class="text-xs sm:text-sm mt-muted mt-0.5">${escapeHTML(t('quoteApprove.approvedDesc'))}</p>
          </div>
        </div>

        <div class="mt-card-muted p-4 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p class="text-xs mt-muted font-semibold">${escapeHTML(t('quoteApprove.ticketCodeLabel'))}</p>
            <p class="font-mono-code text-xl sm:text-2xl font-bold mt-text">${escapeHTML(ticket)}</p>
          </div>
          <button type="button" id="qa-copy-ticket-btn" class="mt-btn mt-btn-secondary text-xs">
            <i data-lucide="copy" class="w-4 h-4" aria-hidden="true"></i>
            <span>${escapeHTML(t('quoteApprove.copyTicketBtn'))}</span>
          </button>
        </div>

        ${
          isOrderMailIn
            ? `<div class="mt-notice-warn p-4 space-y-1.5 text-xs sm:text-sm">
                <p class="font-bold">${escapeHTML(t('quoteApprove.mailInShipHeading'))}</p>
                <p>${escapeHTML(t('quoteApprove.mailInShipDesc', { ticket }))}</p>
                <p class="font-semibold pt-1">${escapeHTML(publicStoreSettings.NAME)}${
                  publicStoreSettings.ADDRESS ? ` · ${escapeHTML(publicStoreSettings.ADDRESS)}` : ''
                }</p>
                ${
                  publicStoreSettings.ADMIN_PHONE
                    ? `<p class="font-mono-code text-xs">WhatsApp: +${escapeHTML(publicStoreSettings.ADMIN_PHONE)}</p>`
                    : ''
                }
              </div>`
            : `<div class="mt-card-muted p-4 space-y-1 text-xs sm:text-sm">
                <p class="font-bold mt-text">${escapeHTML(t('quoteApprove.walkInDropHeading'))}</p>
                <p class="mt-muted">${escapeHTML(t('quoteApprove.walkInDropDesc', { ticket }))}</p>
                ${
                  publicStoreSettings.ADDRESS
                    ? `<p class="font-semibold mt-text pt-1">${escapeHTML(publicStoreSettings.NAME)} · ${escapeHTML(publicStoreSettings.ADDRESS)}</p>`
                    : ''
                }
              </div>`
        }

        <div class="flex flex-wrap gap-2.5 pt-1">
          <a href="${escapeHTML(portalUrl)}" class="mt-btn mt-btn-primary text-xs">
            <i data-lucide="search" class="w-4 h-4" aria-hidden="true"></i>
            <span>${escapeHTML(t('quoteApprove.trackOrderBtn'))}</span>
          </a>
          ${
            waAdminLink
              ? `<a href="${waAdminLink}" target="_blank" rel="noopener noreferrer" class="mt-btn mt-btn-success text-xs">
                  <i data-lucide="message-circle" class="w-4 h-4" aria-hidden="true"></i>
                  <span>${escapeHTML(t('quoteApprove.contactWaBtn'))}</span>
                </a>`
              : ''
          }
        </div>
      </section>
    `;
  } else if (q.status === 'new') {
    decisionBlockHTML = `
      <div class="mt-notice-warn p-4 text-sm space-y-1">
        <p class="font-bold">${escapeHTML(t('quoteApprove.pendingReviewTitle'))}</p>
        <p class="text-xs">${escapeHTML(t('quoteApprove.pendingReviewDesc'))}</p>
      </div>
    `;
  } else if (q.status === 'revision_requested') {
    decisionBlockHTML = `
      <div class="mt-notice-warn p-4 text-sm space-y-1">
        <p class="font-bold">${escapeHTML(t('quoteApprove.revisionSentTitle'))}</p>
        <p class="text-xs">${escapeHTML(t('quoteApprove.revisionSentDesc'))}</p>
        ${q.customer_decision_note ? `<p class="text-xs font-medium pt-1">"${escapeHTML(q.customer_decision_note)}"</p>` : ''}
      </div>
    `;
  } else if (q.status === 'rejected') {
    decisionBlockHTML = `
      <div class="mt-notice-error p-4 text-sm space-y-1">
        <p class="font-bold">${escapeHTML(t('quoteApprove.rejectedTitle'))}</p>
        <p class="text-xs">${escapeHTML(t('quoteApprove.rejectedDesc'))}</p>
      </div>
    `;
  } else if (q.status === 'quoted') {
    decisionBlockHTML = `
      <section class="mt-card p-5 sm:p-6 space-y-3">
        <div id="qa-action-error" role="alert" class="hidden mt-notice-error p-3 text-xs font-medium"></div>
        <div class="flex flex-col sm:flex-row gap-2.5">
          <button type="button" id="qa-approve-btn" class="mt-btn mt-btn-primary flex-1">
            <i data-lucide="check" class="w-4 h-4" aria-hidden="true"></i>
            <span>${escapeHTML(t('quoteApprove.approveBtn'))}</span>
          </button>
          <button type="button" id="qa-decline-toggle-btn" class="mt-btn mt-btn-secondary flex-1">
            <span>${escapeHTML(t('quoteApprove.declineToggleBtn'))}</span>
          </button>
        </div>

        <form id="qa-decline-form" class="hidden mt-card-muted p-4 space-y-3">
          <h3 class="text-xs font-bold mt-text">${escapeHTML(t('quoteApprove.declinePanelHeading'))}</h3>
          <div class="space-y-2">
            <label class="flex items-center gap-2 text-xs font-medium mt-text min-h-11">
              <input type="radio" name="qa_decision" value="revision_requested" checked class="w-4 h-4 shrink-0" />
              <span>${escapeHTML(t('quoteApprove.decisionRevision'))}</span>
            </label>
            <label class="flex items-center gap-2 text-xs font-medium mt-text min-h-11">
              <input type="radio" name="qa_decision" value="rejected" class="w-4 h-4 shrink-0" />
              <span>${escapeHTML(t('quoteApprove.decisionReject'))}</span>
            </label>
          </div>
          <div>
            <label for="qa-decision-note" class="block text-xs font-semibold mt-text mb-1">${escapeHTML(t('quoteApprove.decisionNoteLabel'))}</label>
            <textarea id="qa-decision-note" rows="2" maxlength="800" placeholder="${escapeHTML(t('quoteApprove.decisionNotePlaceholder'))}" class="mt-textarea text-xs"></textarea>
          </div>
          <div class="flex gap-2 justify-end">
            <button type="button" id="qa-decline-cancel-btn" class="mt-btn mt-btn-secondary text-xs">${escapeHTML(t('quoteApprove.decisionCancelBtn'))}</button>
            <button type="submit" id="qa-decline-submit-btn" class="mt-btn mt-btn-danger-ghost text-xs">${escapeHTML(t('quoteApprove.decisionSubmitBtn'))}</button>
          </div>
        </form>
      </section>
    `;
  }

  const itemsBreakdownHTML =
    items.length > 0
      ? `<section class="mt-card p-5 sm:p-6 space-y-3">
          <h3 class="text-sm font-bold mt-text">${escapeHTML(t('quoteApprove.itemsHeading'))}</h3>
          <div class="space-y-2">
            ${items
              .map(
                (it, idx) => `<div class="mt-card-muted p-3 flex items-start justify-between gap-2">
                  <div class="min-w-0">
                    <p class="text-xs font-mono-code font-semibold mt-accent">${escapeHTML(t('common.itemLabel', { number: idx + 1 }))}</p>
                    <p class="text-sm font-bold mt-text">${escapeHTML(it.garment_name || q.garment_name)}</p>
                    <p class="text-xs mt-muted">${escapeHTML(it.service_type || '')}</p>
                  </div>
                  <span class="font-mono-code text-sm font-bold mt-text shrink-0">${escapeHTML(formatCurrency(it.price || 0))}</span>
                </div>`
              )
              .join('')}
          </div>
          <div class="pt-3 mt-seam-t flex items-center justify-between">
            <span class="text-sm font-bold mt-text">${escapeHTML(t('quoteApprove.totalLabel'))}</span>
            <span class="font-mono-code text-lg font-bold mt-accent">${escapeHTML(formatCurrency(q.quoted_total || 0))}</span>
          </div>
          ${durationText ? `<p class="text-xs font-semibold mt-text">${escapeHTML(durationText)}</p>` : ''}
          ${
            q.workshop_notes
              ? `<div class="mt-card-muted p-3 text-xs space-y-1">
                  <p class="font-bold mt-text">${escapeHTML(t('quoteApprove.workshopNotesHeading'))}</p>
                  <p class="mt-muted">${escapeHTML(q.workshop_notes)}</p>
                </div>`
              : ''
          }
        </section>`
      : '';

  quoteApprovalSectionEl.innerHTML = `
    ${decisionBlockHTML}

    <section class="mt-card p-5 sm:p-6 space-y-3">
      <div class="flex items-start justify-between gap-2 flex-wrap pb-3 mt-seam-b">
        <div>
          <span class="font-mono-code text-sm font-bold mt-text">${escapeHTML(q.quote_code)}</span>
          <h2 class="text-base font-bold mt-text mt-0.5">${escapeHTML(q.garment_name)}</h2>
          <p class="text-xs mt-muted">${escapeHTML(t('tracker.customerLabel'))} <strong class="mt-text">${escapeHTML(q.customer_name)}</strong></p>
        </div>
        <div class="flex items-center gap-1.5 flex-wrap">
          ${isMailIn ? `<span class="${typeMeta.badgeClass}">${escapeHTML(typeMeta.label)}</span>` : ''}
          <span class="${statusMeta.badgeClass}">
            <span class="${statusMeta.dotClass}" aria-hidden="true"></span>
            <span>${escapeHTML(statusMeta.label)}</span>
          </span>
        </div>
      </div>

      <div id="qa-pin-canvas"></div>
    </section>

    ${itemsBreakdownHTML}

    <div class="text-center pt-1">
      <a href="${escapeHTML(portalUrl)}" class="mt-btn mt-btn-secondary text-xs">
        <i data-lucide="arrow-left" class="w-4 h-4" aria-hidden="true"></i>
        <span>${escapeHTML(t('quoteApprove.backToPortal'))}</span>
      </a>
    </div>
  `;

  const pinWrap = document.getElementById('qa-pin-canvas');
  if (pinWrap && q.intake_photo_url) {
    approvalPinCanvas = createPinCanvas(pinWrap, {
      mode: 'readonly',
      imageUrl: q.intake_photo_url,
      imageAlt: q.garment_name,
      pins: Array.isArray(q.damage_pins) ? q.damage_pins : [],
      onZoom: (url) => openLightbox(url, `${q.quote_code} · ${q.garment_name}`),
    });
  } else if (pinWrap) {
    pinWrap.innerHTML = `<p class="text-xs mt-muted">${escapeHTML(t('quotes.photoUnavailable'))}</p>`;
  }

  document.getElementById('qa-copy-ticket-btn')?.addEventListener('click', async () => {
    const code = q.converted_order?.ticket_code || '';
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      const span = document.querySelector('#qa-copy-ticket-btn span');
      if (span) {
        span.textContent = t('common.copied');
        setTimeout(() => {
          span.textContent = t('quoteApprove.copyTicketBtn');
        }, 1600);
      }
    } catch {
      alert(code);
    }
  });

  document.getElementById('qa-approve-btn')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    const errBox = document.getElementById('qa-action-error');
    errBox?.classList.add('hidden');
    btn.disabled = true;
    const span = btn.querySelector('span');
    if (span) span.textContent = t('quoteApprove.approvingBtn');

    try {
      const res = await callPublicQuoteJson({
        action: 'approve',
        slug: activeSlug,
        token: activeQuoteToken,
      });
      if (!res?.ok || !res.order?.ticket_code) {
        throw new Error(res?.error || t('common.genericError'));
      }
      lastQuoteApprovalPayload = {
        ...lastQuoteApprovalPayload,
        quote: {
          ...lastQuoteApprovalPayload.quote,
          status: 'approved',
          converted_order: res.order,
        },
      };
      renderQuoteApprovalView(lastQuoteApprovalPayload);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      if (errBox) {
        errBox.textContent = err.message || t('common.genericError');
        errBox.classList.remove('hidden');
      }
      btn.disabled = false;
      if (span) span.textContent = t('quoteApprove.approveBtn');
    }
  });

  document.getElementById('qa-decline-toggle-btn')?.addEventListener('click', () => {
    document.getElementById('qa-decline-form')?.classList.toggle('hidden');
  });
  document.getElementById('qa-decline-cancel-btn')?.addEventListener('click', () => {
    document.getElementById('qa-decline-form')?.classList.add('hidden');
  });
  document.getElementById('qa-decline-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errBox = document.getElementById('qa-action-error');
    errBox?.classList.add('hidden');
    const decision =
      document.querySelector('input[name="qa_decision"]:checked')?.value === 'rejected'
        ? 'rejected'
        : 'revision_requested';
    const note = document.getElementById('qa-decision-note')?.value.trim() || '';
    const submitBtn = document.getElementById('qa-decline-submit-btn');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = t('quoteApprove.decisionSubmittingBtn');
    }
    try {
      const res = await callPublicQuoteJson({
        action: 'decline',
        slug: activeSlug,
        token: activeQuoteToken,
        decision,
        note,
      });
      if (!res?.ok) throw new Error(res?.error || t('common.genericError'));
      lastQuoteApprovalPayload = {
        ...lastQuoteApprovalPayload,
        quote: {
          ...lastQuoteApprovalPayload.quote,
          status: res.status || decision,
          customer_decision_note: note,
        },
      };
      renderQuoteApprovalView(lastQuoteApprovalPayload);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      if (errBox) {
        errBox.textContent = err.message || t('common.genericError');
        errBox.classList.remove('hidden');
      }
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = t('quoteApprove.decisionSubmitBtn');
      }
    }
  });

  if (window.lucide) window.lucide.createIcons();
}
