// js/public-tracker.js
import {
  WORKSHOP_INFO,
  ORDER_STEPS,
  STATUS_META,
  PAYMENT_STATUS_META,
} from './config.js';
import { supabase, isSupabaseConfigured } from './supabase-client.js';
import {
  formatCurrency,
  formatDateID,
  buildWhatsAppLink,
  escapeHTML,
  getDeadlineStatus,
  normalizePhone,
} from './utils.js';
import { initConnectionMonitor } from './storage-draft.js';
import { DEFAULT_STORE_SETTINGS, fetchStoreSettings, applyStoreIdentity } from './store-settings.js';
let publicStoreSettings = { ...DEFAULT_STORE_SETTINGS };

// Data simulasi jika Supabase belum dihubungkan (untuk preview UI)
const MOCK_TRACKING_DATA = {
  found: true,
  mode: 'detail',
  order: {
    ticket_code: 'MND-2611-001',
    customer_name: 'Raka Pratama',
    customer_phone: '6281234567890',
    status: 'in_progress',
    total_amount: 165000,
    paid_amount: 50000,
    payment_status: 'partial',
    estimated_done_date: new Date(Date.now() + 2 * 86400000).toISOString().split('T')[0],
    notes: 'Benang jahit rantai warna gold/tobacco sesuai jahitan original.',
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
      before_photo_url: './assets/placeholder-garment.svg',
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
      log_note: 'Order diterima oleh workshop BRKH DENIM',
      created_at: new Date(Date.now() - 86400000).toISOString(),
    },
    {
      id: 'log-2',
      status: 'queued',
      log_note: 'Masuk antrean meja reparasi & mesin Union Special',
      created_at: new Date(Date.now() - 43200000).toISOString(),
    },
    {
      id: 'log-3',
      status: 'in_progress',
      log_note: 'Sedang proses reinforcement & darning bagian crotch',
      created_at: new Date(Date.now() - 7200000).toISOString(),
    },
  ],
};

// DOM Elements
const trackForm = document.getElementById('track-form');
const trackInput = document.getElementById('track-input');
const clearInputBtn = document.getElementById('clear-input-btn');
const configWarning = document.getElementById('config-warning');
const demoTicketBtn = document.getElementById('demo-ticket-btn');

const loadingEl = document.getElementById('tracking-loading');
const emptyEl = document.getElementById('tracking-empty');
const emptyTitleEl = document.getElementById('empty-title');
const emptyMessageEl = document.getElementById('empty-message');
const ticketListEl = document.getElementById('ticket-list-container');
const resultEl = document.getElementById('tracking-result');
const initialGuideEl = document.getElementById('initial-guide');

const photoModal = document.getElementById('photo-modal');
const photoModalImg = document.getElementById('photo-modal-img');
const photoModalCaption = document.getElementById('photo-modal-caption');
const closePhotoModalBtn = document.getElementById('close-photo-modal');

// ============================================================================
// INITIALIZATION
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  if (window.lucide) window.lucide.createIcons();
  initConnectionMonitor('connection-badge');
  applyStoreIdentity(document, publicStoreSettings);
  fetchStoreSettings().then(settings => { publicStoreSettings = settings; applyStoreIdentity(document, settings); }).catch(console.warn);

  if (!isSupabaseConfigured && configWarning) {
    configWarning.classList.remove('hidden');
  }

  // Event listeners form & input
  trackInput?.addEventListener('input', () => {
    if (trackInput.value.trim().length > 0) {
      clearInputBtn?.classList.remove('hidden');
    } else {
      clearInputBtn?.classList.add('hidden');
    }
  });

  clearInputBtn?.addEventListener('click', () => {
    trackInput.value = '';
    clearInputBtn.classList.add('hidden');
    trackInput.focus();
  });

  document.getElementById('tracker-exit-btn')?.addEventListener('click', () => {
    trackInput.value = '';
    clearInputBtn?.classList.add('hidden');
    resultEl?.classList.add('hidden');
    ticketListEl?.classList.add('hidden');
    emptyEl?.classList.add('hidden');
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete('phone');
    nextUrl.searchParams.delete('ticket');
    nextUrl.searchParams.delete('q');
    window.history.replaceState({}, '', nextUrl);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    trackInput.focus();
  });

  demoTicketBtn?.addEventListener('click', () => {
    trackInput.value = '0812-3456-7890';
    clearInputBtn?.classList.remove('hidden');
    executeTrackingSearch('0812-3456-7890');
  });

  trackForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const query = trackInput.value.trim();
    if (!query) return;
    executeTrackingSearch(query);
  });

  // Lightbox Modal Listeners
  closePhotoModalBtn?.addEventListener('click', closeLightbox);
  photoModal?.addEventListener('click', (e) => {
    if (e.target === photoModal) closeLightbox();
  });

  // Auto-load hanya dari parameter nomor WhatsApp (bukan kode tiket).
  const params = new URLSearchParams(window.location.search);
  const initialPhone = params.get('phone');
  if (initialPhone) {
    trackInput.value = initialPhone;
    clearInputBtn?.classList.remove('hidden');
    executeTrackingSearch(initialPhone);
  }
});

// ============================================================================
// SEARCH & RPC EXECUTION
// ============================================================================
async function executeTrackingSearch(rawQuery) {
  const query = normalizePhone(rawQuery);
  if (!query || query.length < 10) {
    showEmptyState('Nomor WhatsApp Tidak Valid', 'Masukkan nomor HP yang terdaftar, minimal 10 digit.');
    return;
  }

  // Simpan nomor WhatsApp di URL agar dapat dibuka kembali.
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.delete('ticket');
  nextUrl.searchParams.delete('q');
  nextUrl.searchParams.set('phone', query);
  window.history.replaceState({}, '', nextUrl);

  setViewState('loading');

  // Fallback simulasi jika Supabase belum diset
  if (!isSupabaseConfigured) {
    setTimeout(() => {
      if (query === '6281234567890') {
        renderOrderDetail(MOCK_TRACKING_DATA);
      } else {
        showEmptyState(
          'Mode Pratinjau Aktif',
          'Supabase belum dikonfigurasi di js/config.js. Masukkan nomor WhatsApp yang terdaftar.'
        );
      }
    }, 350);
    return;
  }

  try {
    const { data, error } = await supabase.rpc('get_public_order_tracking', {
      p_query: query,
    });

    if (error) throw error;

    if (!data || !data.found) {
      showEmptyState(
        'Order Tidak Ditemukan',
        data?.message ||
          'Pastikan nomor WhatsApp yang dimasukkan sama dengan nomor saat order diterima.'
      );
      return;
    }

    if (data.mode === 'list') {
      renderTicketSelectionList(data.tickets || []);
      return;
    }

    if (data.mode === 'detail') {
      renderOrderDetail(data);
    }
  } catch (err) {
    console.error('Tracking RPC error:', err);
    showEmptyState(
      'Gagal Memuat Data',
      'Terjadi gangguan koneksi ke server. Pastikan internet aktif lalu coba kembali.'
    );
  }
}


// Ambil detail satu order setelah pelanggan memilih tiket dari hasil pencarian HP.
// Fungsi ini sengaja tidak melewati validasi nomor HP.
async function executeSelectedTicket(ticketCode) {
  const code = String(ticketCode || '').trim();
  if (!code) return;

  setViewState('loading');

  try {
    const { data, error } = await supabase.rpc('get_public_order_tracking', {
      p_query: code,
    });

    if (error) throw error;

    if (!data || !data.found) {
      showEmptyState(
        'Order Tidak Ditemukan',
        data?.message || 'Detail order tidak dapat ditemukan. Silakan cari kembali menggunakan nomor WhatsApp.'
      );
      return;
    }

    if (data.mode === 'detail') {
      renderOrderDetail(data);
      return;
    }

    if (data.mode === 'list') {
      renderTicketSelectionList(data.tickets || []);
      return;
    }

    showEmptyState('Data Tidak Tersedia', 'Detail order belum dapat ditampilkan. Silakan coba lagi.');
  } catch (err) {
    console.error('Selected ticket tracking error:', err);
    showEmptyState(
      'Gagal Memuat Detail',
      'Terjadi gangguan saat mengambil detail order. Silakan kembali dan pilih order lagi.'
    );
  }
}

// ============================================================================
// VIEW STATE CONTROLLER
// ============================================================================
function setViewState(state) {
  initialGuideEl?.classList.add('hidden');
  loadingEl?.classList.add('hidden');
  emptyEl?.classList.add('hidden');
  ticketListEl?.classList.add('hidden');
  resultEl?.classList.add('hidden');

  if (state === 'loading') loadingEl?.classList.remove('hidden');
  if (state === 'empty') emptyEl?.classList.remove('hidden');
  if (state === 'list') ticketListEl?.classList.remove('hidden');
  if (state === 'detail') resultEl?.classList.remove('hidden');
}

function showEmptyState(title, message) {
  if (emptyTitleEl) emptyTitleEl.textContent = title;
  if (emptyMessageEl) emptyMessageEl.textContent = message;
  setViewState('empty');
  if (window.lucide) window.lucide.createIcons();
}

// ============================================================================
// RENDER MULTI-TICKET LIST (Pencarian via Nomor WhatsApp)
// ============================================================================
function renderTicketSelectionList(tickets) {
  if (!ticketListEl) return;

  const cardsHTML = tickets
    .map((t) => {
      const statusInfo = STATUS_META[t.status] || STATUS_META.received;
      return `
        <button
          type="button"
          data-select-ticket="${escapeHTML(t.ticket_code)}"
          class="w-full text-left bg-white hover:bg-slate-50 border border-slate-200 hover:border-[#4F6BFF] rounded-2xl p-4 shadow-sm transition flex items-center justify-between gap-3 cursor-pointer"
        >
          <div>
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-mono-code font-bold text-sm text-[#0B1220]">${escapeHTML(t.ticket_code)}</span>
              <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${statusInfo.badgeClass}">
                ${escapeHTML(statusInfo.label)}
              </span>
            </div>
            <p class="text-xs text-slate-500 mt-1.5">
              ${t.item_count || 0} Item • Masuk: ${formatDateID(t.created_at)}
              ${t.estimated_done_date ? ` • Estimasi: <strong>${formatDateID(t.estimated_done_date)}</strong>` : ''}
            </p>
          </div>
          <div class="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-slate-600 shrink-0">
            <i data-lucide="chevron-right" class="w-4 h-4"></i>
          </div>
        </button>
      `;
    })
    .join('');

  ticketListEl.innerHTML = `
    <div class="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
      <p class="text-xs font-semibold uppercase tracking-wider text-slate-500">
        Ditemukan ${tickets.length} Order Terdaftar
      </p>
      <p class="text-sm text-slate-700 mt-0.5">Pilih kode tiket di bawah untuk melihat detail progres:</p>
    </div>
    <div class="space-y-2.5">${cardsHTML}</div>
  `;

  ticketListEl.querySelectorAll('[data-select-ticket]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const code = btn.getAttribute('data-select-ticket');
      // Nomor HP tetap menjadi identitas pencarian; kode tiket dipakai
      // hanya untuk mengambil detail order yang dipilih.
      executeSelectedTicket(code);
    });
  });

  setViewState('list');
  if (window.lucide) window.lucide.createIcons();
}

// ============================================================================
// RENDER DETAIL ORDER & VISUAL TIMELINE STEPPER
// ============================================================================
function renderOrderDetail(payload) {
  if (!resultEl) return;
  const { order, items = [], logs = [] } = payload;

  const statusInfo = STATUS_META[order.status] || STATUS_META.received;
  const payInfo = PAYMENT_STATUS_META[order.payment_status] || PAYMENT_STATUS_META.unpaid;
  const remainingAmount = Math.max(0, Number(order.total_amount) - Number(order.paid_amount));
  const deadlineInfo = getDeadlineStatus(order.estimated_done_date);

  // Tentukan indeks step aktif (jika 'completed', anggap seluruh 5 tahap terlewati)
  const effectiveStatus = order.status === 'completed' ? 'ready' : order.status;
  const currentStepIdx = Math.max(
    0,
    ORDER_STEPS.findIndex((s) => s.key === effectiveStatus)
  );

  // Buat peta waktu penyelesaian per status dari logs
  const statusTimestamps = {};
  logs.forEach((log) => {
    statusTimestamps[log.status] = log.created_at;
  });

  // Render Stepper HTML
  const stepperHTML = ORDER_STEPS.map((step, idx) => {
    const isCompleted = order.status === 'completed' || idx < currentStepIdx;
    const isCurrent = order.status !== 'completed' && idx === currentStepIdx;
    const stepTime = statusTimestamps[step.key];

    let circleClass = 'bg-slate-100 text-slate-400 border-slate-300';
    let titleClass = 'text-slate-400';
    if (isCompleted) {
      circleClass = 'bg-emerald-600 text-white border-emerald-600';
      titleClass = 'text-slate-800 font-semibold';
    } else if (isCurrent) {
      circleClass = 'bg-[#4F6BFF] text-white border-[#4F6BFF] step-active-pulse';
      titleClass = 'text-[#0B1220] font-bold';
    }

    return `
      <div class="relative flex gap-3.5 pb-6 last:pb-0">
        ${
          idx < ORDER_STEPS.length - 1
            ? `<div class="absolute left-4 top-8 bottom-0 w-0.5 ${
                isCompleted ? 'bg-emerald-500' : 'bg-slate-200'
              }"></div>`
            : ''
        }
        <div class="relative z-10 w-8 h-8 rounded-full border-2 flex items-center justify-center shrink-0 transition ${circleClass}">
          <i data-lucide="${isCompleted ? 'check' : step.icon}" class="w-4 h-4"></i>
        </div>
        <div class="flex-1 pt-0.5">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <p class="text-sm ${titleClass}">${escapeHTML(step.label)}</p>
            ${
              stepTime
                ? `<span class="text-[11px] font-mono-code text-slate-400">${formatDateID(stepTime, true)}</span>`
                : ''
            }
          </div>
          <p class="text-xs text-slate-500 mt-0.5">${escapeHTML(step.description)}</p>
        </div>
      </div>
    `;
  }).join('');

  // Render Riwayat Log Catatan Artisan
  const logsHTML =
    logs.length > 0
      ? logs
          .slice()
          .reverse()
          .map((log) => {
            const meta = STATUS_META[log.status] || STATUS_META.received;
            return `
              <div class="flex items-start gap-2.5 text-xs py-2 border-b border-slate-100 last:border-none">
                <span class="w-2 h-2 rounded-full mt-1.5 shrink-0 ${meta.dotClass}"></span>
                <div class="flex-1">
                  <p class="text-slate-700 font-medium">${escapeHTML(log.log_note || meta.label)}</p>
                  <p class="text-[11px] text-slate-400 mt-0.5">${formatDateID(log.created_at, true)}</p>
                </div>
              </div>
            `;
          })
          .join('')
      : '<p class="text-xs text-slate-400">Belum ada catatan aktivitas.</p>';

  // Render Kartu Item Layanan
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
                  <span class="inline-flex items-center px-2 py-0.5 rounded bg-slate-100 text-slate-700 text-[11px] font-medium border border-slate-200">
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
          ? `<div class="grid grid-cols-2 gap-2.5 mt-3 pt-3 border-t border-slate-100">
              ${
                hasBefore
                  ? `<button type="button" data-photo-url="${escapeHTML(item.before_photo_url)}" data-photo-title="Before — ${escapeHTML(item.garment_name)}" class="group relative rounded-xl overflow-hidden border border-slate-200 bg-slate-900 aspect-4/3 cursor-pointer">
                      <img src="${escapeHTML(item.before_photo_url)}" onerror="this.src='./assets/placeholder-garment.svg'" alt="Before" class="w-full h-full object-cover group-hover:scale-105 transition" />
                      <span class="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/70 text-white text-[10px] font-semibold uppercase">Before</span>
                    </button>`
                  : ''
              }
              ${
                hasAfter
                  ? `<button type="button" data-photo-url="${escapeHTML(item.after_photo_url)}" data-photo-title="After — ${escapeHTML(item.garment_name)}" class="group relative rounded-xl overflow-hidden border border-slate-200 bg-slate-900 aspect-4/3 cursor-pointer">
                      <img src="${escapeHTML(item.after_photo_url)}" onerror="this.src='./assets/placeholder-garment.svg'" alt="After" class="w-full h-full object-cover group-hover:scale-105 transition" />
                      <span class="absolute top-2 left-2 px-2 py-0.5 rounded bg-emerald-600/90 text-white text-[10px] font-semibold uppercase">After</span>
                    </button>`
                  : ''
              }
            </div>`
          : '';

      return `
        <div class="tracker-item-card p-4 rounded-xl bg-slate-50/80 border border-slate-200/90">
          <div class="flex items-start justify-between gap-2">
            <div>
              <span class="text-[11px] font-semibold uppercase tracking-wider text-[#4F6BFF]">Item #${index + 1}</span>
              <h4 class="font-bold text-slate-900 text-sm sm:text-base">${escapeHTML(item.garment_name)}</h4>
              <p class="text-xs sm:text-sm text-slate-600 font-medium mt-0.5">${escapeHTML(item.service_type)}</p>
            </div>
            <span class="font-mono-code font-bold text-sm text-slate-800 shrink-0">
              ${formatCurrency(item.price)}
            </span>
          </div>
          ${specsBadges}
          ${photosHTML}
        </div>
      `;
    })
    .join('');

  // Susun pesan otomatis WhatsApp ke Admin
  const waMessage = `Halo Admin ${publicStoreSettings.NAME}, saya *${order.customer_name}* ingin menanyakan progres order dengan Kode Tiket *${order.ticket_code}*. Terima kasih.`;
  const waAdminLink = buildWhatsAppLink(publicStoreSettings.ADMIN_PHONE, waMessage);

  resultEl.innerHTML = `
    <!-- KARTU HEADER TIKET -->
    <div class="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 shadow-sm">
      <div class="flex items-start justify-between gap-3 flex-wrap border-b border-slate-100 pb-4">
        <div>
          <span class="text-xs text-slate-400 uppercase tracking-wider font-semibold">Kode Tiket Order</span>
          <div class="flex items-center gap-2 mt-0.5">
            <h2 class="font-mono-code text-xl sm:text-2xl font-bold text-[#0B1220]">${escapeHTML(order.ticket_code)}</h2>
            <button type="button" id="copy-ticket-btn" title="Salin Kode Tiket" class="p-1.5 rounded-lg text-slate-400 hover:text-[#0B1220] hover:bg-slate-100 transition cursor-pointer">
              <i data-lucide="copy" class="w-4 h-4"></i>
            </button>
          </div>
          <p class="text-sm text-slate-600 mt-1">Pelanggan: <strong class="text-slate-900">${escapeHTML(order.customer_name)}</strong></p>
        </div>

        <div class="flex flex-col items-start sm:items-end gap-1.5">
          <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border ${statusInfo.badgeClass}">
            <span class="w-2 h-2 rounded-full ${statusInfo.dotClass}"></span>
            ${escapeHTML(statusInfo.label)}
          </span>
          <span class="text-xs text-slate-500">
            Target Selesai: <strong class="${deadlineInfo.isOverdue ? 'text-rose-600' : 'text-slate-800'}">${formatDateID(order.estimated_done_date)}</strong>
          </span>
        </div>
      </div>

      ${
        order.notes
          ? `<div class="tracker-workshop-note mt-4 p-3 rounded-xl bg-amber-50/80 border border-amber-200/80 text-xs text-amber-950 flex items-start gap-2">
              <i data-lucide="sticky-note" class="w-4 h-4 text-amber-600 shrink-0 mt-0.5"></i>
              <div><span class="font-semibold">Catatan Workshop:</span> ${escapeHTML(order.notes)}</div>
            </div>`
          : ''
      }
    </div>

    <!-- KARTU VISUAL STEPPER & TIMELINE -->
    <div class="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 shadow-sm">
      <h3 class="text-sm font-bold uppercase tracking-wider text-slate-500 mb-5 flex items-center gap-2">
        <i data-lucide="git-commit-horizontal" class="w-4 h-4 text-[#4F6BFF]"></i>
        <span>Tahapan Pengerjaan</span>
      </h3>

      <div>${stepperHTML}</div>

      <details class="mt-5 pt-4 border-t border-slate-100 group">
        <summary class="text-xs font-semibold text-slate-600 hover:text-[#0B1220] cursor-pointer flex items-center justify-between list-none">
          <span>Lihat Riwayat Aktivitas Lengkap (${logs.length})</span>
          <i data-lucide="chevron-down" class="w-4 h-4 group-open:rotate-180 transition"></i>
        </summary>
        <div class="mt-3 pl-1">${logsHTML}</div>
      </details>
    </div>

    <!-- KARTU RINCIAN ITEM & LAYANAN -->
    <div class="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 shadow-sm">
      <h3 class="text-sm font-bold uppercase tracking-wider text-slate-500 mb-4 flex items-center gap-2">
        <i data-lucide="layers" class="w-4 h-4 text-[#4F6BFF]"></i>
        <span>Daftar Item & Layanan (${items.length})</span>
      </h3>
      <div class="space-y-3">${itemsHTML}</div>
    </div>

    <!-- KARTU RINCIAN BIAYA & PEMBAYARAN -->
    <div class="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 shadow-sm">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-sm font-bold uppercase tracking-wider text-slate-500 flex items-center gap-2">
          <i data-lucide="receipt-text" class="w-4 h-4 text-[#4F6BFF]"></i>
          <span>Rincian Biaya</span>
        </h3>
        <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${payInfo.badgeClass}">
          ${escapeHTML(payInfo.label)}
        </span>
      </div>

      <div class="space-y-2 text-sm">
        <div class="flex justify-between text-slate-600">
          <span>Total Biaya Layanan</span>
          <span class="font-mono-code font-semibold text-slate-900">${formatCurrency(order.total_amount)}</span>
        </div>
        <div class="flex justify-between text-slate-600">
          <span>Sudah Dibayar (DP / Cicilan)</span>
          <span class="font-mono-code font-medium text-emerald-700">- ${formatCurrency(order.paid_amount)}</span>
        </div>
        <div class="pt-2.5 border-t border-slate-200 flex justify-between items-center">
          <span class="font-bold text-slate-900">Sisa Tagihan</span>
          <span class="font-mono-code text-lg font-bold ${remainingAmount > 0 ? 'text-[#4F6BFF]' : 'text-emerald-600'}">
            ${formatCurrency(remainingAmount)}
          </span>
        </div>
      </div>

      <!-- Tombol Hubungi Admin via WhatsApp -->
      <div class="mt-6 pt-4 border-t border-slate-100">
        <a
          href="${waAdminLink}"
          target="_blank"
          rel="noopener noreferrer"
          class="w-full h-12 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-sm flex items-center justify-center gap-2 shadow-sm transition"
        >
          <i data-lucide="message-circle" class="w-5 h-5"></i>
          <span>Hubungi Admin via WhatsApp</span>
        </a>
      </div>
    </div>
  `;

  // Bind Copy Ticket Button
  const copyBtn = document.getElementById('copy-ticket-btn');
  copyBtn?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(order.ticket_code);
      copyBtn.innerHTML = '<i data-lucide="check" class="w-4 h-4 text-emerald-600"></i>';
      if (window.lucide) window.lucide.createIcons();
      setTimeout(() => {
        copyBtn.innerHTML = '<i data-lucide="copy" class="w-4 h-4"></i>';
        if (window.lucide) window.lucide.createIcons();
      }, 1500);
    } catch (_) {
      // Abaikan jika clipboard ditolak browser
    }
  });

  // Bind Photo Lightbox Buttons
  resultEl.querySelectorAll('[data-photo-url]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const url = btn.getAttribute('data-photo-url');
      const title = btn.getAttribute('data-photo-title');
      openLightbox(url, title);
    });
  });

  setViewState('detail');
  if (window.lucide) window.lucide.createIcons();
}

// ============================================================================
// LIGHTBOX HELPER
// ============================================================================
function openLightbox(url, caption) {
  if (!photoModal || !photoModalImg) return;
  photoModalImg.src = url;
  if (photoModalCaption) photoModalCaption.textContent = caption || 'Dokumentasi Item';
  photoModal.classList.remove('hidden');
}

function closeLightbox() {
  if (!photoModal) return;
  photoModal.classList.add('hidden');
  if (photoModalImg) photoModalImg.src = '';
}
