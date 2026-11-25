import {
  SUPABASE_CONFIG,
  ORDER_STEPS,
  STATUS_META,
  PAYMENT_STATUS_META,
} from './config.js';
import { isSupabaseConfigured } from './supabase-client.js';
import {
  formatCurrency,
  formatDateID,
  buildWhatsAppLink,
  escapeHTML,
  getDeadlineStatus,
  normalizePhone,
} from './utils.js';
import { initConnectionMonitor } from './storage-draft.js';
import { DEFAULT_STORE_SETTINGS, mapTenantToSettings, applyStoreIdentity } from './store-settings.js';

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;

let activeSlug = '';
let isWorkshopValid = false;
let currentSearchedPhone = '';
let lastTicketList = [];
let publicStoreSettings = { ...DEFAULT_STORE_SETTINGS };
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
      status: 'queued',
      log_note: 'Masuk antrean meja reparasi',
      created_at: new Date(Date.now() - 43200000).toISOString(),
    },
    {
      id: 'log-3',
      status: 'in_progress',
      log_note: 'Sedang proses darning bagian crotch',
      created_at: new Date(Date.now() - 7200000).toISOString(),
    },
  ],
};

const trackerHeroEl = document.getElementById('tracker-hero');
const trackerBrandLink = document.getElementById('tracker-brand-link');
const workshopNotFoundEl = document.getElementById('workshop-not-found');
const workshopNotFoundMsgEl = document.getElementById('workshop-not-found-message');
const footerTaglineWrap = document.getElementById('footer-tagline-wrap');

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
    throw new Error(data?.error || data?.message || `Server merespons status ${response.status}.`);
  }
  return data;
}

function showWorkshopNotFound(message) {
  isWorkshopValid = false;
  trackerHeroEl?.classList.add('hidden');
  initialGuideEl?.classList.add('hidden');
  loadingEl?.classList.add('hidden');
  emptyEl?.classList.add('hidden');
  ticketListEl?.classList.add('hidden');
  resultEl?.classList.add('hidden');
  trackerExitBtn?.classList.add('hidden');
  if (workshopNotFoundMsgEl && message) {
    workshopNotFoundMsgEl.textContent = message;
  }
  workshopNotFoundEl?.classList.remove('hidden');
  document.title = 'Workshop Tidak Ditemukan | MendTrack';
  if (window.lucide) window.lucide.createIcons();
}

document.addEventListener('DOMContentLoaded', async () => {
  if (window.lucide) window.lucide.createIcons();
  initConnectionMonitor('connection-badge');
  applyStoreIdentity(document, publicStoreSettings);

  activeSlug = resolveWorkshopSlug();
  if (activeSlug && trackerBrandLink) {
    trackerBrandLink.href = `/t/${encodeURIComponent(activeSlug)}`;
  }

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

  if (!isSupabaseConfigured) {
    isWorkshopValid = true;
    configWarning?.classList.remove('hidden');
    return;
  }

  if (!activeSlug) {
    showWorkshopNotFound('Alamat tautan workshop tidak menyertakan slug yang valid.');
    return;
  }

  setViewState('loading');
  try {
    const profileRes = await callPublicTracker({
      action: 'profile',
      slug: activeSlug,
    });

    if (!profileRes || !profileRes.found || !profileRes.store) {
      showWorkshopNotFound(
        profileRes?.message || `Workshop "${activeSlug}" tidak ditemukan atau sedang tidak aktif.`
      );
      return;
    }

    isWorkshopValid = true;
    publicStoreSettings = mapTenantToSettings(profileRes.store);
    applyStoreIdentity(document, publicStoreSettings);
    if (footerTaglineWrap) {
      footerTaglineWrap.classList.toggle('hidden', !publicStoreSettings.TAGLINE);
    }
    setViewState('guide');

    // Auto-load only from the phone query parameter (ticket code links are not exposed).
    const params = new URLSearchParams(window.location.search);
    const initialPhone = params.get('phone');
    if (initialPhone) {
      trackInput.value = initialPhone;
      clearInputBtn?.classList.remove('hidden');
      executeTrackingSearch(initialPhone);
    }
  } catch (err) {
    console.error('Gagal memuat profil workshop:', err);
    showWorkshopNotFound('Terjadi gangguan saat memuat data workshop. Silakan muat ulang halaman.');
  }
});

async function executeTrackingSearch(rawQuery) {
  const query = normalizePhone(rawQuery);
  if (!query || query.length < 10) {
    showEmptyState('Nomor WhatsApp tidak valid', 'Masukkan nomor HP yang terdaftar, minimal 10 digit.');
    return;
  }

  currentSearchedPhone = query;
  lastTicketList = [];

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
        showEmptyState(
          'Mode pratinjau aktif',
          'Supabase belum dikonfigurasi di js/config.js. Gunakan nomor contoh 0812-3456-7890 untuk melihat simulasi.'
        );
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
        showWorkshopNotFound(data.message);
        return;
      }
      showEmptyState(
        'Order tidak ditemukan',
        data?.message || 'Pastikan nomor WhatsApp yang dimasukkan sama dengan nomor saat order diterima.'
      );
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
    showEmptyState(
      'Gagal memuat data',
      'Terjadi gangguan koneksi ke server. Pastikan internet aktif lalu coba kembali.'
    );
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
      showEmptyState(
        'Order tidak ditemukan',
        data?.message || 'Detail order tidak dapat ditemukan. Silakan cari kembali menggunakan nomor WhatsApp.'
      );
      return;
    }

    if (data.mode === 'detail') {
      renderOrderDetail(data);
      return;
    }

    showEmptyState('Data tidak tersedia', 'Detail order belum dapat ditampilkan. Silakan coba lagi.');
  } catch (err) {
    console.error('Selected ticket tracking error:', err);
    showEmptyState(
      'Gagal memuat detail',
      'Terjadi gangguan saat mengambil detail order. Silakan kembali dan pilih order lagi.'
    );
  }
}

function setViewState(state) {
  workshopNotFoundEl?.classList.add('hidden');
  initialGuideEl?.classList.toggle('hidden', state !== 'guide');
  loadingEl?.classList.toggle('hidden', state !== 'loading');
  emptyEl?.classList.toggle('hidden', state !== 'empty');
  ticketListEl?.classList.toggle('hidden', state !== 'list');
  resultEl?.classList.toggle('hidden', state !== 'detail');
  trackerExitBtn?.classList.toggle('hidden', state === 'guide');
}

function showEmptyState(title, message) {
  if (emptyTitleEl) emptyTitleEl.textContent = title;
  if (emptyMessageEl) emptyMessageEl.textContent = message;
  setViewState('empty');
  if (window.lucide) window.lucide.createIcons();
}

function renderTicketSelectionList(tickets) {
  if (!ticketListEl) return;

  const cardsHTML = tickets
    .map((t) => {
      const statusInfo = STATUS_META[t.status] || STATUS_META.received;
      return `
        <button
          type="button"
          data-select-ticket="${escapeHTML(t.ticket_code)}"
          class="w-full text-left mt-card p-4 transition flex items-center justify-between gap-3 hover:border-[var(--mt-accent)]"
        >
          <div class="min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-mono-code font-bold text-sm mt-text">${escapeHTML(t.ticket_code)}</span>
              <span class="${statusInfo.badgeClass}">
                <span class="${statusInfo.dotClass}" aria-hidden="true"></span>
                <span>${escapeHTML(statusInfo.label)}</span>
              </span>
            </div>
            <p class="text-xs mt-muted mt-1.5">
              ${t.item_count || 0} item · Masuk: ${formatDateID(t.created_at)}
              ${t.estimated_done_date ? ` · Estimasi: <strong class="mt-text">${formatDateID(t.estimated_done_date)}</strong>` : ''}
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
      <h2 class="text-sm font-bold mt-text">Ditemukan ${tickets.length} order terdaftar</h2>
      <p class="text-xs mt-muted mt-0.5">Pilih kode tiket di bawah untuk melihat detail progres.</p>
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
  const { order, items = [], logs = [], isDemo = false } = payload;

  const statusInfo = STATUS_META[order.status] || STATUS_META.received;
  const payInfo = PAYMENT_STATUS_META[order.payment_status] || PAYMENT_STATUS_META.unpaid;
  const remainingAmount = Math.max(0, Number(order.total_amount) - Number(order.paid_amount));
  const deadlineInfo = getDeadlineStatus(order.estimated_done_date);

  const effectiveStatus = order.status === 'completed' ? 'ready' : order.status;
  const currentStepIdx = Math.max(
    0,
    ORDER_STEPS.findIndex((s) => s.key === effectiveStatus)
  );

  const statusTimestamps = {};
  logs.forEach((log) => {
    statusTimestamps[log.status] = log.created_at;
  });

  const stepperHTML = ORDER_STEPS.map((step, idx) => {
    const isCompleted = order.status === 'completed' || idx < currentStepIdx;
    const isCurrent = order.status !== 'completed' && idx === currentStepIdx;
    const stepTime = statusTimestamps[step.key];

    const dotState = isCompleted ? 'is-done' : isCurrent ? 'is-current' : '';
    const titleClass = isCurrent ? 'mt-text font-bold' : isCompleted ? 'mt-text font-semibold' : 'mt-muted';

    return `
      <div class="relative flex gap-3.5 pb-6 last:pb-0">
        ${
          idx < ORDER_STEPS.length - 1
            ? `<div class="absolute left-4 top-8 bottom-0 w-0.5 mt-step-line ${isCompleted ? 'is-done' : ''}" aria-hidden="true"></div>`
            : ''
        }
        <div class="relative z-10 mt-step-dot ${dotState}" aria-hidden="true">
          <i data-lucide="${isCompleted ? 'check' : step.icon}" class="w-4 h-4"></i>
        </div>
        <div class="flex-1 pt-0.5 min-w-0">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <p class="text-sm ${titleClass}">
              ${escapeHTML(step.label)}${isCurrent ? ' (Tahap saat ini)' : ''}
            </p>
            ${
              stepTime
                ? `<span class="text-xs font-mono-code mt-muted">${formatDateID(stepTime, true)}</span>`
                : ''
            }
          </div>
          <p class="text-xs mt-muted mt-0.5">${escapeHTML(step.description)}</p>
        </div>
      </div>
    `;
  }).join('');

  const logsHTML =
    logs.length > 0
      ? logs
          .slice()
          .reverse()
          .map((log) => {
            const meta = STATUS_META[log.status] || STATUS_META.received;
            return `
              <div class="flex items-start gap-2.5 text-xs py-2.5 border-b last:border-none" style="border-color: var(--mt-border);">
                <span class="${meta.badgeClass} shrink-0">${escapeHTML(meta.label)}</span>
                <div class="flex-1 min-w-0">
                  <p class="mt-text font-medium">${escapeHTML(log.log_note || meta.label)}</p>
                  <p class="text-xs mt-muted mt-0.5 font-mono-code">${formatDateID(log.created_at, true)}</p>
                </div>
              </div>
            `;
          })
          .join('')
      : '<p class="text-xs mt-muted">Belum ada catatan aktivitas.</p>';

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
                  ? `<button type="button" data-photo-url="${escapeHTML(item.before_photo_url)}" data-photo-title="Sebelum: ${escapeHTML(item.garment_name)}" class="group relative rounded-lg overflow-hidden border bg-black aspect-[4/3] w-full text-left" style="border-color: var(--mt-border);">
                      <img src="${escapeHTML(item.before_photo_url)}" width="640" height="480" onerror="this.src='/assets/placeholder-garment.svg'" alt="Foto sebelum pengerjaan ${escapeHTML(item.garment_name)}" class="w-full h-full object-cover" />
                      <span class="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/80 text-white text-xs font-semibold">Sebelum</span>
                    </button>`
                  : ''
              }
              ${
                hasAfter
                  ? `<button type="button" data-photo-url="${escapeHTML(item.after_photo_url)}" data-photo-title="Sesudah: ${escapeHTML(item.garment_name)}" class="group relative rounded-lg overflow-hidden border bg-black aspect-[4/3] w-full text-left" style="border-color: var(--mt-border);">
                      <img src="${escapeHTML(item.after_photo_url)}" width="640" height="480" onerror="this.src='/assets/placeholder-garment.svg'" alt="Foto sesudah pengerjaan ${escapeHTML(item.garment_name)}" class="w-full h-full object-cover" />
                      <span class="absolute top-2 left-2 px-2 py-0.5 rounded mt-badge-ready text-xs font-semibold">Sesudah</span>
                    </button>`
                  : ''
              }
            </div>`
          : '';

      return `
        <article class="mt-card-muted p-4">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <span class="text-xs font-mono-code font-semibold mt-accent">Item #${index + 1}</span>
              <h4 class="font-bold mt-text text-sm sm:text-base">${escapeHTML(item.garment_name)}</h4>
              <p class="text-xs sm:text-sm mt-muted font-medium mt-0.5">${escapeHTML(item.service_type)}</p>
            </div>
            <span class="font-mono-code font-bold text-sm mt-text shrink-0">
              ${formatCurrency(item.price)}
            </span>
          </div>
          ${specsBadges}
          ${photosHTML}
        </article>
      `;
    })
    .join('');

  const waMessage = `Halo Admin ${publicStoreSettings.NAME}, saya *${order.customer_name}* ingin menanyakan progres order dengan kode tiket *${order.ticket_code}*. Terima kasih.`;
  const waAdminLink = publicStoreSettings.ADMIN_PHONE
    ? buildWhatsAppLink(publicStoreSettings.ADMIN_PHONE, waMessage)
    : '';

  const backToListHTML =
    lastTicketList.length > 1
      ? `<div>
          <button type="button" id="back-to-ticket-list-btn" class="mt-btn mt-btn-secondary text-xs">
            <i data-lucide="arrow-left" class="w-4 h-4" aria-hidden="true"></i>
            <span>Kembali ke daftar tiket (${lastTicketList.length})</span>
          </button>
        </div>`
      : '';

  resultEl.innerHTML = `
    ${backToListHTML}
    ${
      isDemo
        ? `<div class="mt-notice-warn px-4 py-3 text-xs font-semibold">[DATA SIMULASI] Tampilan ini menggunakan contoh order karena koneksi Supabase belum aktif.</div>`
        : ''
    }

    <section class="mt-card p-5 sm:p-6">
      <div class="flex items-start justify-between gap-3 flex-wrap pb-4 mt-seam-b">
        <div>
          <span class="text-xs mt-muted font-semibold">Kode tiket order</span>
          <div class="flex items-center gap-2 mt-0.5">
            <h2 class="font-mono-code text-xl sm:text-2xl font-bold mt-text">${escapeHTML(order.ticket_code)}</h2>
            <button type="button" id="copy-ticket-btn" aria-label="Salin kode tiket ${escapeHTML(order.ticket_code)}" title="Salin kode tiket" class="mt-btn-icon mt-btn-secondary">
              <i data-lucide="copy" class="w-4 h-4" aria-hidden="true"></i>
            </button>
          </div>
          <p class="text-sm mt-muted mt-1">Pelanggan: <strong class="mt-text">${escapeHTML(order.customer_name)}</strong></p>
        </div>

        <div class="flex flex-col items-start sm:items-end gap-1.5">
          <span class="${statusInfo.badgeClass}">
            <span class="${statusInfo.dotClass}" aria-hidden="true"></span>
            <span>${escapeHTML(statusInfo.label)}</span>
          </span>
          <span class="text-xs mt-muted">
            Target selesai: <strong class="${deadlineInfo.isOverdue ? 'mt-danger-text' : 'mt-text'}">${formatDateID(order.estimated_done_date)}</strong>
          </span>
        </div>
      </div>

      ${
        order.notes
          ? `<div class="mt-notice-warn mt-4 p-3 text-xs flex items-start gap-2">
              <i data-lucide="sticky-note" class="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true"></i>
              <div><span class="font-semibold">Catatan workshop:</span> ${escapeHTML(order.notes)}</div>
            </div>`
          : ''
      }
    </section>

    <section class="mt-card p-5 sm:p-6">
      <h3 class="text-sm font-bold mt-text mb-5 flex items-center gap-2">
        <i data-lucide="git-commit-horizontal" class="w-4 h-4 mt-accent" aria-hidden="true"></i>
        <span>Tahapan pengerjaan</span>
      </h3>

      <div>${stepperHTML}</div>

      <details class="mt-5 pt-4 mt-seam-t group">
        <summary class="text-xs font-semibold mt-text min-h-11 flex items-center justify-between list-none">
          <span>Lihat riwayat aktivitas lengkap (${logs.length})</span>
          <i data-lucide="chevron-down" class="w-4 h-4 group-open:rotate-180 transition" aria-hidden="true"></i>
        </summary>
        <div class="mt-2">${logsHTML}</div>
      </details>
    </section>

    <section class="mt-card p-5 sm:p-6">
      <h3 class="text-sm font-bold mt-text mb-4 flex items-center gap-2">
        <i data-lucide="layers" class="w-4 h-4 mt-accent" aria-hidden="true"></i>
        <span>Daftar item &amp; layanan (${items.length})</span>
      </h3>
      <div class="space-y-3">${itemsHTML}</div>
    </section>

    <section class="mt-card p-5 sm:p-6">
      <div class="flex items-center justify-between gap-2 mb-4">
        <h3 class="text-sm font-bold mt-text flex items-center gap-2">
          <i data-lucide="receipt-text" class="w-4 h-4 mt-accent" aria-hidden="true"></i>
          <span>Rincian biaya</span>
        </h3>
        <span class="${payInfo.badgeClass}">
          ${escapeHTML(payInfo.label)}
        </span>
      </div>

      <div class="space-y-2 text-sm">
        <div class="flex justify-between mt-muted">
          <span>Total biaya layanan</span>
          <span class="font-mono-code font-semibold mt-text">${formatCurrency(order.total_amount)}</span>
        </div>
        <div class="flex justify-between mt-muted">
          <span>Sudah dibayar (DP / cicilan)</span>
          <span class="font-mono-code font-medium mt-success-text">- ${formatCurrency(order.paid_amount)}</span>
        </div>
        <div class="pt-3 mt-seam-t flex justify-between items-center">
          <span class="font-bold mt-text">Sisa tagihan</span>
          <span class="font-mono-code text-lg font-bold ${remainingAmount > 0 ? 'mt-accent' : 'mt-success-text'}">
            ${formatCurrency(remainingAmount)}
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
                <span>Hubungi Admin via WhatsApp</span>
              </a>
            </div>`
          : ''
      }
    </section>
  `;

  document.getElementById('back-to-ticket-list-btn')?.addEventListener('click', () => {
    renderTicketSelectionList(lastTicketList);
  });

  const copyBtn = document.getElementById('copy-ticket-btn');
  copyBtn?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(order.ticket_code);
      copyBtn.innerHTML = '<i data-lucide="check" class="w-4 h-4 mt-success-text" aria-hidden="true"></i>';
      copyBtn.setAttribute('aria-label', 'Kode tiket disalin');
      if (window.lucide) window.lucide.createIcons();
      setTimeout(() => {
        copyBtn.innerHTML = '<i data-lucide="copy" class="w-4 h-4" aria-hidden="true"></i>';
        copyBtn.setAttribute('aria-label', `Salin kode tiket ${order.ticket_code}`);
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
  if (photoModalCaption) photoModalCaption.textContent = caption || 'Dokumentasi item';
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
