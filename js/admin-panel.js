// js/admin-panel.js
import {
  SUPABASE_CONFIG,
  WORKSHOP_INFO,
  ORDER_STEPS,
  STATUS_META,
  PAYMENT_STATUS_META,
} from './config.js';
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
import { DEFAULT_STORE_SETTINGS, fetchStoreSettings, persistStoreSettings, applyStoreIdentity, fetchServices, createService, updateService, deactivateService, activateService } from './store-settings.js';

// ============================================================================
// APPLICATION STATE
// ============================================================================
let allOrders = [];
let currentFilter = 'all';
let workloadDateFilter = null;
let searchQuery = '';
let orderStatusFilter = 'all';
let currentReceiptOrder = null;
let workloadServices = [];
const workloadToday = new Date();
let workloadViewMonth = new Date(workloadToday.getFullYear(), workloadToday.getMonth(), 1);
let workloadSelectedDate = toLocalDateKey(workloadToday);

// Store identity is shared with the public portal and persisted in Supabase.
let workshopSettings = { ...DEFAULT_STORE_SETTINGS };
let activeServiceCatalog = [];

function applyStoreSettings() {
  const nameEl = document.getElementById('header-store-name');
  if (nameEl) nameEl.textContent = workshopSettings.NAME;
  const logoWrap = document.getElementById('header-store-logo-wrap');
  if (logoWrap) logoWrap.innerHTML = workshopSettings.LOGO
    ? `<img src="${workshopSettings.LOGO}" alt="Logo toko" class="w-full h-full object-contain">`
    : '<i data-lucide="scissors" class="w-5 h-5"></i>';
  applyStoreIdentity(document, workshopSettings);
  if (window.lucide) window.lucide.createIcons();
}

function openStoreSettings() {
  const modal = document.getElementById('store-settings-modal');
  if (!modal) return;
  delete modal.dataset.pendingLogo;
  document.getElementById('store-logo-input').value = '';
  document.getElementById('store-name-input').value = workshopSettings.NAME;
  document.getElementById('store-address-input').value = workshopSettings.ADDRESS;
  document.getElementById('store-phone-input').value = workshopSettings.ADMIN_PHONE;
  document.getElementById('store-tagline-input').value = workshopSettings.TAGLINE;
  document.getElementById('store-hours-input').value = workshopSettings.OPENING_HOURS;
  const capacity = workshopSettings.DAILY_CAPACITY_MINUTES || 480;
  document.getElementById('daily-capacity-hours').value = Math.floor(capacity / 60);
  document.getElementById('daily-capacity-minutes').value = capacity % 60;
  renderStoreLogoPreview(workshopSettings.LOGO);
  modal.classList.remove('hidden'); modal.classList.add('flex');
  document.getElementById('header-menu-panel')?.classList.add('hidden');
}

// Refresh the service catalog when returning from an external page (e.g. WhatsApp Web).
// Browsers may restore this page from the back-forward cache without rerunning module startup.
async function refreshVisibleStoreServices() {
  const modal = document.getElementById('store-settings-modal');
  if (!modal || modal.classList.contains('hidden')) return;
  await renderServicesList();
  try {
    activeServiceCatalog = (await fetchServices()).filter(service => service.is_active);
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
  if (!container) return;
  try {
    const services = await fetchServices();
    if (!services.length) { container.innerHTML = '<p class="text-xs text-slate-500">Belum ada layanan. Tambahkan layanan pertama di bawah.</p>'; return; }
    container.innerHTML = services.map(service => {
      const duration = `${Math.floor(service.estimated_minutes / 60)}j ${service.estimated_minutes % 60}m`;
      return `<div class="flex items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 ${service.is_active ? '' : 'opacity-50'}"><div class="min-w-0"><p class="text-sm font-semibold text-slate-800">${escapeHTML(service.name)}</p><p class="text-xs text-slate-500">${duration} · ${service.is_active ? 'Aktif' : 'Nonaktif'}</p></div><div class="flex gap-1 shrink-0">${service.is_active ? `<button type="button" data-edit-service="${service.id}" class="px-2 py-1 text-xs rounded bg-slate-100">Edit</button><button type="button" data-disable-service="${service.id}" class="px-2 py-1 text-xs rounded bg-rose-50 text-rose-700">Nonaktifkan</button>` : `<button type="button" data-activate-service="${service.id}" class="px-2 py-1 text-xs rounded bg-emerald-50 text-emerald-700">Aktifkan</button>`}</div></div>`;
    }).join('');
  } catch (error) { container.innerHTML = `<p class="text-xs text-rose-600">Gagal memuat layanan: ${escapeHTML(error.message || '')}</p>`; }
}

function closeStoreSettings() {
  const modal = document.getElementById('store-settings-modal');
  modal?.classList.add('hidden'); modal?.classList.remove('flex');
}
function renderStoreLogoPreview(dataUrl) {
  const preview = document.getElementById('store-logo-preview-wrap');
  if (!preview) return;
  preview.innerHTML = dataUrl
    ? `<img src="${dataUrl}" alt="Preview logo toko" class="w-full h-full object-contain">`
    : '<i data-lucide="image" class="w-7 h-7 text-slate-400"></i>';
  if (window.lucide) window.lucide.createIcons();
}
async function imageFileToDataUrl(file) {
  if (!file || !['image/jpeg','image/png','image/webp'].includes(file.type))
    throw new Error('Logo harus berupa gambar JPG, PNG, atau WebP.');
  if (file.size > 8 * 1024 * 1024) throw new Error('Ukuran logo maksimal 8 MB.');
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 480 / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL('image/webp', 0.8);
}


// DOM References
const authScreen = document.getElementById('auth-screen');
const adminWorkspace = document.getElementById('admin-workspace');
const loginForm = document.getElementById('login-form');
const authErrorBox = document.getElementById('auth-error-box');
const logoutBtn = document.getElementById('logout-btn');
const headerMenuBtn = document.getElementById('header-menu-btn');
const headerMenuPanel = document.getElementById('header-menu-panel');

function mountSeparatedManagementPages() {
  const workload = document.getElementById('daily-workload-section');
  const schedule = document.getElementById('schedule-page');
  if (workload && schedule) schedule.appendChild(workload);
  const servicePanel = document.querySelector('[data-settings-panel="services"]');
  const serviceTarget = document.getElementById('services-page-content');
  if (servicePanel && serviceTarget) { while (servicePanel.firstChild) serviceTarget.appendChild(servicePanel.firstChild); servicePanel.remove(); }
  const measurementPanel = document.querySelector('[data-settings-panel="measurements"]');
  const measurementTarget = document.getElementById('measurements-page-content');
  if (measurementPanel && measurementTarget) { while (measurementPanel.firstChild) measurementTarget.appendChild(measurementPanel.firstChild); measurementPanel.remove(); }
  document.querySelector('[data-settings-panel="store"]')?.classList.remove('hidden');
  document.querySelector('[data-store-save-btn]')?.classList.remove('hidden');
}

function showAppPage(page) {
  const ids = ['reports-page','schedule-page','services-page','measurements-page','cash-page','archive-page'];
  ids.forEach(id => document.getElementById(id)?.classList.add('hidden'));
  const orderSections = ['dashboard-metrics-section'];
  orderSections.forEach(id => document.getElementById(id)?.classList.toggle('hidden', page !== 'orders'));
  const searchSection = document.querySelector('#admin-workspace main > section:has(#admin-search-input)');
  searchSection?.classList.toggle('hidden', page !== 'orders');
  ordersListContainer?.classList.toggle('hidden', page !== 'orders');
  customersSection?.classList.toggle('hidden', page !== 'customers');
  document.getElementById('daily-workload-section')?.classList.toggle('hidden', page !== 'schedule');
  const pageMap = { reports:'reports-page', schedule:'schedule-page', services:'services-page', measurements:'measurements-page', cash:'cash-page', archive:'archive-page' };
  if (pageMap[page]) document.getElementById(pageMap[page])?.classList.remove('hidden');
  document.querySelectorAll('[data-app-page], #bottom-nav-orders, #bottom-nav-customers').forEach(btn => {
    const key = btn.dataset.appPage || (btn.id === 'bottom-nav-orders' ? 'orders' : btn.id === 'bottom-nav-customers' ? 'customers' : '');
    btn.classList.toggle('is-active', key === page);
    if (key === page) btn.setAttribute('aria-current','page'); else btn.removeAttribute('aria-current');
  });
  if (page === 'customers') fetchCustomers();
  if (page === 'services') { renderServicesList(); loadWorkloadServices(); }
  if (page === 'measurements') renderMeasurementTemplateSettings();
  if (page === 'reports') renderReports();
  if (page === 'cash') renderCash();
  if (page === 'archive') renderArchiveOrders();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderArchiveOrders() {
  const target = document.getElementById('archive-orders-list');
  if (!target) return;
  const archived = allOrders.filter(order => ['completed'].includes(order.status));
  target.innerHTML = archived.length ? archived.map(order => `<article class="bg-white rounded-2xl border border-slate-200 p-4 flex flex-wrap justify-between gap-3"><div><p class="font-mono-code font-bold">${escapeHTML(order.ticket_code || '')}</p><p class="text-sm">${escapeHTML(order.customer_name || '')}</p><p class="text-xs text-slate-500">Selesai · ${formatDateID(order.updated_at || order.created_at)}</p></div><div class="text-right"><p class="font-semibold">${formatCurrency(order.total_amount)}</p><button type="button" data-edit-order="${order.id}" class="text-xs text-indigo-600 underline">Lihat order</button></div></article>`).join('') : '<div class="bg-white rounded-2xl border p-8 text-center text-sm text-slate-500">Belum ada order selesai/diambil.</div>';
}

async function renderReports() {
  const target = document.getElementById('reports-content'); if (!target) return;
  const period = document.getElementById('report-period')?.value || 'week';
  const now = new Date(); now.setHours(23,59,59,999);
  const start = new Date(); start.setHours(0,0,0,0);
  if (period === 'week') start.setDate(start.getDate()-6);
  else if (period === 'month') start.setDate(1);
  else if (period === 'all') start.setTime(0);
  const inRange = allOrders.filter(o => { const d = new Date(o.created_at); return period === 'all' || (d >= start && d <= now); });
  const totalSales = inRange.reduce((s,o)=>s+Number(o.total_amount||0),0);
  const paidNow = inRange.reduce((s,o)=>s+Number(o.paid_amount||0),0);
  const receivable = inRange.reduce((s,o)=>s+Math.max(0,Number(o.total_amount||0)-Number(o.paid_amount||0)),0);
  const unpaidOrders = inRange.filter(o=>Number(o.total_amount||0)>Number(o.paid_amount||0));
  const services = {}; inRange.forEach(o=>(o.order_items||[]).forEach(it=>{ const name=it.service_type||'Lainnya'; services[name]=(services[name]||0)+1; }));
  const top = Object.entries(services).sort((a,b)=>b[1]-a[1]).slice(0,5);
  let cashRows=[];
  try { let q=supabase.from('cash_transactions').select('transaction_type,category,amount,occurred_at'); if(period!=='all') q=q.gte('occurred_at',start.toISOString()).lte('occurred_at',now.toISOString()); const {data,error}=await q; if(error) throw error; cashRows=data||[]; }
  catch(err){ console.warn('Data diagram kas gagal dimuat:',err); }
  const incomeRows=cashRows.filter(x=>x.transaction_type==='income'), expenseRows=cashRows.filter(x=>x.transaction_type==='expense');
  const sumRows=rows=>rows.reduce((a,x)=>a+Number(x.amount||0),0);
  const incomeTotal=sumRows(incomeRows), expenseTotal=sumRows(expenseRows);
  const pie=(rows,title)=>{const totals={};rows.forEach(x=>{const k=x.category||'lain_lain';totals[k]=(totals[k]||0)+Number(x.amount||0)});const entries=Object.entries(totals).sort((a,b)=>b[1]-a[1]);const palette=['#4F6BFF','#16A36A','#E6A23C','#E56B6F','#8B5CF6','#0EA5A4'];let acc=0;const total=sumRows(rows);const stops=entries.map(([k,v],i)=>{const a=acc;acc+=total?v/total*100:0;return `${palette[i%palette.length]} ${a}% ${acc}%`}).join(',');const names={custom:'Custom',reparasi:'Reparasi',lain_lain:'Lain-lain',alat_bahan:'Alat dan Bahan',operasional:'Operasional',makan_minum:'Makan dan Minum',gaji:'Gaji'};return `<section class="bg-white rounded-2xl border border-slate-200 p-4 min-w-0"><h3 class="font-bold text-sm mb-3">${title}</h3>${entries.length?`<div class="flex items-center gap-3"><div class="w-24 h-24 rounded-full shrink-0" style="background:conic-gradient(${stops})"></div><div class="space-y-2 min-w-0 flex-1">${entries.map(([k,v],i)=>`<div class="flex items-center gap-2 text-xs min-w-0"><i class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${palette[i%palette.length]}"></i><span class="truncate">${names[k]||escapeHTML(k)}</span><b class="ml-auto">${Math.round(v/(total||1)*100)}%</b></div>`).join('')}</div></div>`:'<p class="text-xs text-slate-400">Belum ada transaksi pada periode ini.</p>'}</section>`;};
  // Day/week/month use daily buckets. All-time uses monthly buckets to keep the chart readable across years.
  const bucketMap=new Map();
  const keyFor=d=> period==='all' ? `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}` : `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  cashRows.forEach(row=>{const d=new Date(row.occurred_at);if(Number.isNaN(d.getTime()))return;const key=keyFor(d);if(!bucketMap.has(key))bucketMap.set(key,{income:0,expense:0});const bucket=bucketMap.get(key);if(row.transaction_type==='income')bucket.income+=Number(row.amount||0);else if(row.transaction_type==='expense')bucket.expense+=Number(row.amount||0);});
  const chartData=[...bucketMap.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
  const labelFor=key=>{const d=period==='all'?new Date(Number(key.slice(0,4)),Number(key.slice(5,7))-1,1):new Date(Number(key.slice(0,4)),Number(key.slice(5,7))-1,Number(key.slice(8,10)));return period==='all'?new Intl.DateTimeFormat('id-ID',{month:'short',year:'2-digit'}).format(d):new Intl.DateTimeFormat('id-ID',{day:'numeric',month:'short'}).format(d);};
  const maxValue=Math.max(1,...chartData.flatMap(([,v])=>[v.income,v.expense]));
  const barWidth=period==='day'?44:period==='week'?32:period==='month'?22:28;
  const chartWidth=Math.max(300,chartData.length*(barWidth*2+18)+24);
  const bars=chartData.length?chartData.map(([key,v])=>{const h1=Math.max(v.income?2:0,v.income/maxValue*112),h2=Math.max(v.expense?2:0,v.expense/maxValue*112);return `<div class="flex flex-col items-center justify-end shrink-0" style="width:${barWidth*2+14}px;height:158px"><div class="flex items-end justify-center gap-1 h-[124px] w-full"><div title="Pemasukan ${formatCurrency(v.income)}" class="rounded-t-md bg-emerald-500" style="width:${barWidth}px;height:${h1}px"></div><div title="Pengeluaran ${formatCurrency(v.expense)}" class="rounded-t-md bg-rose-500" style="width:${barWidth}px;height:${h2}px"></div></div><span class="text-[10px] text-slate-500 mt-2 whitespace-nowrap">${labelFor(key)}</span></div>`}).join(''):'<p class="text-xs text-slate-400 p-4">Belum ada transaksi pada periode ini.</p>';
  const chart=`<section class="bg-white rounded-2xl border border-slate-200 p-4 min-w-0"><h3 class="font-bold text-sm mb-2">Pemasukan vs Pengeluaran</h3><div class="flex gap-3 text-[11px] mb-2"><span class="text-emerald-700">● Pemasukan</span><span class="text-rose-600">● Pengeluaran</span></div><div class="overflow-x-auto"><div class="flex items-end gap-1 min-w-full" style="width:${chartWidth}px;min-height:166px">${bars}</div></div><div class="flex justify-between text-xs mt-2"><b class="text-emerald-700">Masuk ${formatCurrency(incomeTotal)}</b><b class="text-rose-600">Keluar ${formatCurrency(expenseTotal)}</b></div><p class="text-[10px] text-slate-400 mt-2">${period==='all'?'Dikelompokkan per bulan sepanjang riwayat transaksi.':'Dikelompokkan per hari pada periode terpilih.'}</p></section>`;
  const cashCharts=`<div class="grid grid-cols-1 md:grid-cols-3 gap-3 items-stretch">${chart}${pie(incomeRows,'Kategori Pemasukan')}${pie(expenseRows,'Kategori Pengeluaran')}</div>`;
  const moneyCard=(label,value,sub)=>`<div class="bg-white rounded-2xl border border-slate-200 p-4"><p class="text-xs text-slate-500">${label}</p><p class="text-xl font-bold mt-1">${formatCurrency(value)}</p><p class="text-xs text-slate-400 mt-1">${sub}</p></div>`;
  target.innerHTML = `${cashCharts}<div class="grid grid-cols-1 sm:grid-cols-3 gap-3">${moneyCard('Nilai order',totalSales,`${inRange.length} order dibuat pada periode ini`)}${moneyCard('Pembayaran tercatat',paidNow,'Akumulasi paid_amount saat ini')}${moneyCard('Sisa piutang',receivable,`${unpaidOrders.length} order belum lunas`)}</div><div class="grid grid-cols-1 lg:grid-cols-2 gap-3"><div class="bg-white rounded-2xl border border-slate-200 p-4"><h3 class="font-bold mb-3">Order belum lunas</h3>${unpaidOrders.length?unpaidOrders.sort((a,b)=>Number(b.total_amount||0)-Number(a.total_amount||0)).slice(0,20).map(o=>`<div class="py-2 border-b border-slate-100 flex justify-between gap-3 text-sm"><div><b>${escapeHTML(o.ticket_code||'')}</b><p class="text-xs text-slate-500">${escapeHTML(o.customer_name||'')}</p></div><b class="text-rose-600">${formatCurrency(Math.max(0,Number(o.total_amount||0)-Number(o.paid_amount||0)))}</b></div>`).join(''):'<p class="text-sm text-slate-500">Tidak ada piutang pada periode ini.</p>'}</div><div class="bg-white rounded-2xl border border-slate-200 p-4"><h3 class="font-bold mb-3">Layanan paling sering dipesan</h3>${top.length?top.map(([name,count],i)=>`<div class="py-2 border-b border-slate-100 flex justify-between text-sm"><span>${i+1}. ${escapeHTML(name)}</span><b>${count} item</b></div>`).join(''):'<p class="text-sm text-slate-500">Belum ada data layanan.</p>'}</div></div><p class="text-xs text-slate-400">Catatan: laporan mengelompokkan order berdasarkan tanggal dibuat. Pembayaran menampilkan akumulasi pembayaran terkini dari setiap order, bukan histori kas per tanggal.</p>`;
}

function initSettingsTabs() {
  const buttons = [...document.querySelectorAll('[data-settings-tab]')];
  const panels = [...document.querySelectorAll('[data-settings-panel]')];
  const saveButton = document.querySelector('[data-store-save-btn]');
  const note = document.querySelector('.settings-panel-note');
  const notes = { store: 'Pengaturan toko disimpan di Supabase dan digunakan di semua perangkat. Data order tidak diubah.', services: 'Layanan dan estimasi waktu dikelola terpisah dari profil toko.', measurements: 'Jenis pakaian dan komponen ukuran dikelola terpisah dari layanan.' };
  function activate(tab) {
    buttons.forEach(button => { const active = button.dataset.settingsTab === tab; button.classList.toggle('bg-[#EEF2FF]', active); button.classList.toggle('text-[#3D55E0]', active); button.classList.toggle('border-[#4F6BFF]', active); button.classList.toggle('font-bold', active); button.classList.toggle('border-slate-200', !active); button.classList.toggle('text-slate-600', !active); button.classList.toggle('font-semibold', !active); });
    panels.forEach(panel => panel.classList.toggle('hidden', panel.dataset.settingsPanel !== tab));
    if (saveButton) saveButton.classList.toggle('hidden', tab !== 'store');
    if (note) note.textContent = notes[tab] || notes.store;
  }
  buttons.forEach(button => button.addEventListener('click', () => activate(button.dataset.settingsTab)));
  activate('store');
}


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


// Order Form Modal DOM
const orderFormModal = document.getElementById('order-form-modal');
const orderCrudForm = document.getElementById('order-crud-form');
const openNewOrderBtn = document.getElementById('open-new-order-btn');
const closeOrderModalBtn = document.getElementById('close-order-modal-btn');
const cancelOrderModalBtn = document.getElementById('cancel-order-modal-btn');
const addItemRowBtn = document.getElementById('add-item-row-btn');
const formItemsContainer = document.getElementById('form-items-container');
const formPaidAmountInput = document.getElementById('form-paid-amount');

// Payment Modal DOM
const paymentModal = document.getElementById('payment-modal');
const paymentForm = document.getElementById('payment-form');
const closePaymentModalBtn = document.getElementById('close-payment-modal-btn');
const payFullQuickBtn = document.getElementById('pay-full-quick-btn');

// Receipt Modal DOM
const receiptModal = document.getElementById('receipt-modal');
const receiptContent = document.getElementById('receipt-content');
const closeReceiptModalBtn = document.getElementById('close-receipt-modal-btn');
const copyReceiptWaBtn = document.getElementById('copy-receipt-wa-btn');
const printReceiptBtn = document.getElementById('print-receipt-btn');

// WA Ready Toast DOM
const waReadyToast = document.getElementById('wa-ready-toast');
const waToastDesc = document.getElementById('wa-toast-desc');
const waToastSendLink = document.getElementById('wa-toast-send-link');
const closeWaToastBtn = document.getElementById('close-wa-toast-btn');


// ============================================================================
// DAILY WORKLOAD CALENDAR
// Workload follows the locked legacy model: all estimated minutes are assigned
// to the order's estimated_done_date (no distribution across production days).
// Ready/completed orders are excluded immediately.
// ============================================================================
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
    const service = workloadServices.find(entry =>
      String(entry.name || '').trim().toLocaleLowerCase() === serviceName
    );
    return sum + (service ? Number(service.estimated_minutes || 0) : 0);
  }, 0);
}

function getWorkloadForDate(dateKey) {
  const orders = allOrders.filter(order =>
    order.estimated_done_date === dateKey && !['ready', 'completed'].includes(order.status)
  );
  const minutes = orders.reduce((sum, order) => sum + getOrderEstimatedMinutes(order), 0);
  const unknownItems = orders.reduce((sum, order) => {
    const items = order.order_items || [];
    return sum + items.filter(item => !workloadServices.some(service =>
      String(service.name || '').trim().toLocaleLowerCase() === String(item.service_type || '').trim().toLocaleLowerCase()
    )).length;
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
  if (hours && mins) return `${hours}j ${mins}m`;
  if (hours) return `${hours} jam`;
  return `${mins} menit`;
}

function renderWorkloadCalendar() {
  const grid = document.getElementById('workload-calendar-grid');
  if (!grid) return;
  const monthLabel = document.getElementById('workload-month-label');
  const selectedDateEl = document.getElementById('workload-selected-date');
  const selectedLoadEl = document.getElementById('workload-selected-load');
  const selectedProgress = document.getElementById('workload-selected-progress');
  const selectedNote = document.getElementById('workload-selected-note');
  const selectedCount = document.getElementById('workload-selected-count');

  const year = workloadViewMonth.getFullYear();
  const month = workloadViewMonth.getMonth();
  monthLabel.textContent = new Intl.DateTimeFormat('id-ID', { month: 'long', year: 'numeric' }).format(workloadViewMonth);

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
    const workload = inMonth ? getWorkloadForDate(key) : { orders: [], minutes: 0, capacity: Number(workshopSettings.DAILY_CAPACITY_MINUTES || 480), percent: 0 };
    const level = workloadLevel(workload.percent, workload.orders.length);
    const selected = key === workloadSelectedDate;
    const percent = Math.min(100, Math.round(workload.percent));
    markup += `
      <button type="button" class="mt-calendar-day ${inMonth ? '' : 'is-outside'} ${workload.orders.length ? level : 'workload-empty'} ${selected ? 'is-selected' : ''} ${key === todayKey ? 'is-today' : ''}"
        data-workload-date="${key}" ${inMonth ? '' : 'disabled'} aria-pressed="${selected}">
        <span class="mt-calendar-day-number">${date.getDate()}</span>
        ${inMonth && workload.orders.length ? `
          <span class="mt-calendar-day-count">${workload.orders.length} order</span>
          <span class="mt-calendar-day-percent">${workload.percent > 100 ? 'Over 100%' : `${Math.round(workload.percent)}%`}</span>
        ` : `<span class="mt-calendar-day-empty">${inMonth ? '—' : ''}</span>`}
      </button>`;
  }
  grid.innerHTML = markup;

  const selected = getWorkloadForDate(workloadSelectedDate);
  const selectedDate = parseLocalDateKey(workloadSelectedDate);
  selectedDateEl.textContent = selectedDate
    ? new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(selectedDate)
    : '-';
  selectedLoadEl.textContent = `${formatWorkloadDuration(selected.minutes)} / ${formatWorkloadDuration(selected.capacity)}`;
  selectedProgress.style.width = `${Math.min(100, Math.round(selected.percent))}%`;
  selectedProgress.className = `mt-calendar-progress-fill ${workloadLevel(selected.percent, selected.orders.length)}`;
  selectedNote.textContent = selected.unknownItems
    ? `${selected.orders.length} order terjadwal. ${selected.unknownItems} item belum memiliki estimasi layanan yang cocok di Pengaturan Toko, sehingga belum masuk hitungan durasi.`
    : selected.orders.length
      ? `${selected.orders.length} order terjadwal pada tanggal ini. Order Siap Diambil dan Selesai tidak dihitung.`
      : 'Tidak ada order aktif yang dijadwalkan selesai pada tanggal ini.';
  if (selectedCount) selectedCount.textContent = `${selected.orders.length} order`;
  const dateFilterLabel = document.getElementById('workload-date-filter-label');
  if (dateFilterLabel) {
    dateFilterLabel.textContent = workloadDateFilter
      ? `Filter tanggal: ${new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }).format(parseLocalDateKey(workloadDateFilter))}`
      : 'Semua tanggal';
  }
  const clearDateFilterBtn = document.getElementById('clear-workload-date-filter');
  if (clearDateFilterBtn) clearDateFilterBtn.classList.toggle('hidden', !workloadDateFilter);
}

async function loadWorkloadServices() {
  try {
    workloadServices = await fetchServices();
    activeServiceCatalog = workloadServices.filter(service => service.is_active);
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
  document.getElementById('workload-calendar-grid')?.addEventListener('click', event => {
    const day = event.target.closest('[data-workload-date]');
    if (!day || day.disabled) return;
    workloadSelectedDate = day.dataset.workloadDate;
    workloadDateFilter = workloadSelectedDate;
    renderWorkloadCalendar();
    renderOrdersList();
    if (!document.getElementById('reports-page')?.classList.contains('hidden')) renderReports();
    if (!document.getElementById('archive-page')?.classList.contains('hidden')) renderArchiveOrders();
    document.getElementById('orders-list-container')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  document.getElementById('clear-workload-date-filter')?.addEventListener('click', () => {
    workloadDateFilter = null;
    renderWorkloadCalendar();
    renderOrdersList();
  });
}

// ============================================================================
// INITIALIZATION & AUTH GUARD
// ============================================================================
document.addEventListener('DOMContentLoaded', async () => {
  mountSeparatedManagementPages();
  applyStoreSettings();
  fetchStoreSettings().then(settings => { workshopSettings = settings; applyStoreSettings(); }).catch(console.warn);
  if (window.lucide) window.lucide.createIcons();
  initConnectionMonitor('connection-badge');
  bindGlobalEvents();

  if (!isSupabaseConfigured) {
    showAuthError(
      'Kredensial Supabase belum diisi di js/config.js. Silakan lengkapi URL dan Anon Key terlebih dahulu.'
    );
    return;
  }

  // Cek sesi login aktif
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (session) {
    enterWorkspace();
  } else {
    showAuthScreen();
  }

  supabase.auth.onAuthStateChange((_event, newSession) => {
    if (newSession) {
      enterWorkspace();
    } else {
      showAuthScreen();
    }
  });
});

function showAuthScreen() {
  authScreen?.classList.remove('hidden');
  adminWorkspace?.classList.add('hidden');
}

async function enterWorkspace() {
  authScreen?.classList.add('hidden');
  adminWorkspace?.classList.remove('hidden');
  checkSavedDraftBanner();
  await loadWorkloadServices();
  await fetchOrders();
  await fetchCustomers();
}

function showAuthError(msg) {
  if (!authErrorBox) return;
  authErrorBox.textContent = msg;
  authErrorBox.classList.remove('hidden');
}

// ============================================================================
// EVENT BINDINGS
// ============================================================================

let orderDatePickerMonth = new Date();
function renderOrderDatePicker() {
  const grid = document.getElementById('order-date-grid'); if (!grid) return;
  const y=orderDatePickerMonth.getFullYear(), m=orderDatePickerMonth.getMonth();
  document.getElementById('order-date-month').textContent=new Intl.DateTimeFormat('id-ID',{month:'long',year:'numeric'}).format(orderDatePickerMonth);
  const offset=(new Date(y,m,1).getDay()+6)%7, count=new Date(y,m+1,0).getDate();
  const selected=document.getElementById('form-estimated-date')?.value || '';
  let html='';
  for(let i=0;i<offset;i++) html+='<span></span>';
  for(let d=1;d<=count;d++){
    const key=toLocalDateKey(new Date(y,m,d)); const w=getWorkloadForDate(key); const pct=Math.round(w.percent); const today=key===toLocalDateKey(new Date());
    const color=!w.orders.length?'#94a3b8':pct>=100?'#dc2626':pct>=60?'#d97706':'#059669';
    html+=`<button type="button" data-order-date="${key}" class="order-date-day min-h-[42px] rounded-lg border ${selected===key?'is-selected':'border-slate-200 hover:bg-slate-50'} ${today?'is-today':''} flex flex-col items-center justify-center leading-tight"><span class="text-xs font-semibold">${d}</span><span class="text-[9px] font-bold" style="color:${color}">${pct}%</span></button>`;
  }
  grid.innerHTML=html;
}
function openOrderDatePicker(){
  const pop=document.getElementById('order-date-picker'), input=document.getElementById('form-estimated-date'); if(!pop||!input)return;
  const current=parseLocalDateKey(input.value); orderDatePickerMonth=new Date(current||new Date()); orderDatePickerMonth.setDate(1);
  pop.classList.remove('hidden'); input.setAttribute('aria-expanded','true'); renderOrderDatePicker();
}
function closeOrderDatePicker(){document.getElementById('order-date-picker')?.classList.add('hidden');document.getElementById('form-estimated-date')?.setAttribute('aria-expanded','false');}
function bindOrderDatePicker(){
  const input=document.getElementById('form-estimated-date');
  input?.addEventListener('click',openOrderDatePicker);
  document.getElementById('order-date-prev')?.addEventListener('click',()=>{orderDatePickerMonth=new Date(orderDatePickerMonth.getFullYear(),orderDatePickerMonth.getMonth()-1,1);renderOrderDatePicker();});
  document.getElementById('order-date-next')?.addEventListener('click',()=>{orderDatePickerMonth=new Date(orderDatePickerMonth.getFullYear(),orderDatePickerMonth.getMonth()+1,1);renderOrderDatePicker();});
  document.getElementById('order-date-today')?.addEventListener('click',()=>{const d=new Date();orderDatePickerMonth=new Date(d.getFullYear(),d.getMonth(),1);renderOrderDatePicker();});
  document.getElementById('order-date-grid')?.addEventListener('click',e=>{const b=e.target.closest('[data-order-date]');if(!b)return;input.value=b.dataset.orderDate;closeOrderDatePicker();});
  document.addEventListener('click',e=>{const pop=document.getElementById('order-date-picker');if(pop&&!pop.classList.contains('hidden')&&!pop.contains(e.target)&&e.target!==input)closeOrderDatePicker();});
}

function bindGlobalEvents() {
  document.querySelectorAll('[data-app-page]').forEach(button => button.addEventListener('click', () => {
    const page = button.dataset.appPage;
    if (page === 'settings') { openStoreSettings(); return; }
    showAppPage(page);
  }));
  document.getElementById('report-period')?.addEventListener('change', renderReports);
  bindOrderDatePicker();
  document.getElementById('cash-period')?.addEventListener('change', renderCash);
  document.getElementById('cash-add-btn')?.addEventListener('click', openCashModal);
  document.getElementById('cash-modal-close')?.addEventListener('click', () => document.getElementById('cash-modal')?.classList.add('hidden'));
  document.getElementById('cash-type')?.addEventListener('change', updateCashCategoryOptions);
  document.getElementById('cash-form')?.addEventListener('submit', submitCashForm);
  document.getElementById('sidebar-new-order-btn')?.addEventListener('click', () => openOrderModal(null));
  document.getElementById('archive-orders-list')?.addEventListener('click', event => { const button = event.target.closest('[data-edit-order]'); if (!button) return; const order = allOrders.find(item => item.id === button.dataset.editOrder); if (order) openOrderModal(order); });

  // Login Submit
  loginForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    authErrorBox?.classList.add('hidden');
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const submitBtn = document.getElementById('login-submit-btn');

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span>Memverifikasi...</span>';

    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } catch (err) {
      showAuthError(err.message || 'Gagal masuk. Periksa email dan password.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML =
        '<i data-lucide="log-in" class="w-4 h-4"></i><span>Masuk ke Workshop</span>';
      if (window.lucide) window.lucide.createIcons();
    }
  });

  // Header menu and store settings
  headerMenuBtn?.addEventListener('click', () => {
    const isOpen = !headerMenuPanel?.classList.contains('hidden');
    headerMenuPanel?.classList.toggle('hidden', isOpen);
    headerMenuBtn.setAttribute('aria-expanded', String(!isOpen));
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
      alert(error.message || 'Logo gagal dibaca.');
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
    const settings = {
      NAME: document.getElementById('store-name-input').value.trim(),
      ADDRESS: document.getElementById('store-address-input').value.trim(),
      ADMIN_PHONE: normalizePhone(document.getElementById('store-phone-input').value),
      TAGLINE: document.getElementById('store-tagline-input').value.trim(),
      OPENING_HOURS: document.getElementById('store-hours-input').value.trim(),
      DAILY_CAPACITY_MINUTES: Number(document.getElementById('daily-capacity-hours').value || 0) * 60 + Number(document.getElementById('daily-capacity-minutes').value || 0),
      LOGO: Object.prototype.hasOwnProperty.call(modal.dataset, 'pendingLogo')
        ? modal.dataset.pendingLogo
        : workshopSettings.LOGO,
    };
    if (!settings.NAME) {
      alert('Nama toko wajib diisi.');
      return;
    }
    if (!Number.isInteger(settings.DAILY_CAPACITY_MINUTES) || settings.DAILY_CAPACITY_MINUTES <= 0) { alert('Kapasitas harian harus lebih dari 0 menit.'); return; }
    try {
      await persistStoreSettings(settings);
      workshopSettings = await fetchStoreSettings();
      applyStoreSettings();
      renderWorkloadCalendar();
      delete modal.dataset.pendingLogo;
      closeStoreSettings();
      alert('Pengaturan toko berhasil disimpan di Supabase.');
    } catch (error) {
      alert('Gagal menyimpan ke Supabase: ' + (error.message || 'Periksa tabel, kebijakan akses, dan koneksi.'));
    }
  });

  document.getElementById('add-service-btn')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const nameInput = document.getElementById('service-name-input');
    const hoursInput = document.getElementById('service-hours-input');
    const minutesInput = document.getElementById('service-minutes-input');
    const hours = Number(hoursInput.value || 0);
    const minutes = Number(minutesInput.value || 0);
    const total = hours * 60 + minutes;
    const name = nameInput.value.trim();
    if (!name) { alert('Masukkan nama layanan.'); nameInput.focus(); return; }
    if (!Number.isInteger(hours) || hours < 0 || !Number.isInteger(minutes) || minutes < 0 || minutes > 59 || total <= 0) { alert('Estimasi layanan harus lebih dari 0 menit.'); return; }
    button.disabled = true;
    button.textContent = 'Menyimpan...';
    try {
      await createService(name, total);
      nameInput.value = '';
      hoursInput.value = '1';
      minutesInput.value = '0';
      await renderServicesList();
      await loadWorkloadServices();
      renderWorkloadCalendar();
    } catch (error) {
      console.error('Gagal menambah layanan:', error);
      alert('Gagal menambah layanan: ' + (error.message || 'Periksa hak akses tabel services dan policy RLS.'));
    } finally {
      button.disabled = false;
      button.textContent = 'Tambah Layanan';
    }
  });
  document.getElementById('services-list')?.addEventListener('click', async (event) => {
    const editButton = event.target.closest('[data-edit-service]');
    const disableButton = event.target.closest('[data-disable-service]');
    const activateButton = event.target.closest('[data-activate-service]');
    if (editButton) {
      const id = editButton.dataset.editService;
      const current = (await fetchServices()).find(item => item.id === id); if (!current) return;
      const name = prompt('Nama layanan:', current.name); if (name === null) return;
      const duration = prompt('Estimasi dalam menit:', String(current.estimated_minutes)); if (duration === null) return;
      const total = Number(duration); if (!name.trim() || !Number.isInteger(total) || total <= 0) return alert('Nama dan estimasi lebih dari 0 menit wajib diisi.');
      try { await updateService(id, name.trim(), total); await renderServicesList(); await loadWorkloadServices(); renderWorkloadCalendar(); } catch (error) { alert('Gagal mengubah layanan: ' + error.message); }
    }
    if (disableButton && confirm('Nonaktifkan layanan ini? Riwayat order tidak akan dihapus.')) {
      try {
        await deactivateService(disableButton.dataset.disableService);
        await renderServicesList();
        await loadWorkloadServices();
        renderWorkloadCalendar();
      } catch (error) { alert('Gagal menonaktifkan layanan: ' + error.message); }
    }
    if (activateButton) {
      try {
        await activateService(activateButton.dataset.activateService);
        await renderServicesList();
        await loadWorkloadServices();
        renderWorkloadCalendar();
      } catch (error) { alert('Gagal mengaktifkan layanan: ' + error.message); }
    }
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('#header-menu-btn') && !event.target.closest('#header-menu-panel')) {
      headerMenuPanel?.classList.add('hidden');
      headerMenuBtn?.setAttribute('aria-expanded', 'false');
    }
  });

  // Logout
  logoutBtn?.addEventListener('click', async () => {
    await supabase.auth.signOut();
  });

  bindWorkloadCalendarEvents();

  // Search & Filter
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
  document.getElementById('clear-order-filters')?.addEventListener('click', () => {
    searchQuery = '';
    orderStatusFilter = 'all';
    workloadDateFilter = null;
    if (adminSearchInput) adminSearchInput.value = '';
    const statusSelect = document.getElementById('order-status-filter');
    if (statusSelect) statusSelect.value = 'all';
    renderWorkloadCalendar();
    renderOrdersList();
  });
  refreshOrdersBtn?.addEventListener('click', () => renderOrdersList());
  document.getElementById('bottom-nav-customers')?.addEventListener('click', showCustomersPage);
  document.getElementById('bottom-nav-orders')?.addEventListener('click', showOrdersPage);
  document.getElementById('customers-search-input')?.addEventListener('input', debounce(renderCustomersList, 200));
  document.getElementById('open-add-customer-from-list-btn')?.addEventListener('click', openCustomerCreateForm);
  document.getElementById('close-customer-form-btn')?.addEventListener('click', closeCustomerCreateForm);
  document.getElementById('cancel-customer-form-btn')?.addEventListener('click', closeCustomerCreateForm);
  document.getElementById('customer-create-form')?.addEventListener('submit', handleCustomerCreateSubmit);
  customersList?.addEventListener('click', handleCustomerListAction);
  document.getElementById('close-customer-detail-btn')?.addEventListener('click', () => { document.getElementById('customer-detail-modal')?.classList.add('hidden'); const h = document.querySelector('#customer-detail-modal h3'); if (h) h.textContent = 'Detail Pelanggan'; });
  document.getElementById('customer-detail-content')?.addEventListener('click', handleCustomerDetailAction);
  document.getElementById('customer-detail-content')?.addEventListener('change', handleMeasurementFormChange);
  document.getElementById('customer-detail-content')?.addEventListener('submit', handleCustomerEditSubmit);
  document.getElementById('measurement-templates-list')?.addEventListener('click', handleMeasurementTemplateAction);
  document.getElementById('add-measurement-template-btn')?.addEventListener('click', addMeasurementTemplate);
  document.getElementById('measurement-templates-list')?.addEventListener('click', handleMeasurementTemplateToggle);

  // Draft Banner Actions
  restoreDraftBtn?.addEventListener('click', () => {
    const draft = loadOrderDraft();
    if (draft && draft.data) {
      openOrderModal(null, draft.data);
      draftBanner?.classList.add('hidden');
    }
  });

  discardDraftBtn?.addEventListener('click', () => {
    clearOrderDraft();
    draftBanner?.classList.add('hidden');
  });

  // Order Modal Triggers
  openNewOrderBtn?.addEventListener('click', () => {
    const selectedDate = workloadDateFilter || workloadSelectedDate;
    openOrderModal(null, { estimated_done_date: selectedDate });
  });
  closeOrderModalBtn?.addEventListener('click', closeOrderModal);
  cancelOrderModalBtn?.addEventListener('click', closeOrderModal);

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
  customerPhoneInput?.addEventListener('input', debounce(() => {
    checkCustomerPhoneInForm();
  }, 450));
  customerPhoneInput?.addEventListener('blur', checkCustomerPhoneInForm);

  orderCrudForm?.addEventListener('submit', handleSaveOrderSubmit);

  // Payment Modal Triggers
  closePaymentModalBtn?.addEventListener('click', () => paymentModal?.classList.add('hidden'));
  payFullQuickBtn?.addEventListener('click', () => {
    const total = Number(payFullQuickBtn.dataset.totalAmount || 0);
    document.getElementById('pay-new-paid-input').value = total;
  });
  paymentForm?.addEventListener('submit', handlePaymentSubmit);

  // Receipt Modal Triggers
  closeReceiptModalBtn?.addEventListener('click', () => receiptModal?.classList.add('hidden'));
  printReceiptBtn?.addEventListener('click', () => window.print());
  copyReceiptWaBtn?.addEventListener('click', handleSendReceiptViaWA);

  // WA Toast Close
  closeWaToastBtn?.addEventListener('click', () => waReadyToast?.classList.add('hidden'));
}

// ============================================================================
// CUSTOMER DIRECTORY
// ============================================================================
async function fetchCustomers() {
  if (!customersList) return;
  customersList.innerHTML = '<p class="py-5 text-center text-sm text-slate-500">Memuat pelanggan...</p>';
  const { data, error } = await supabase.from('customers').select('id, name, phone, created_at, updated_at').order('name', { ascending: true });
  if (error) {
    customersList.innerHTML = `<p class="py-5 text-sm text-rose-600">Gagal memuat pelanggan: ${escapeHTML(error.message)}</p>`;
    return;
  }
  customerRecords = data || [];
  renderCustomersList();
}

function renderCustomersList() {
  if (!customersList) return;
  const query = (document.getElementById('customers-search-input')?.value || '').trim().toLowerCase();
  const filtered = customerRecords.filter(customer => `${customer.name} ${customer.phone}`.toLowerCase().includes(query));
  const count = document.getElementById('customers-count');
  if (count) count.textContent = `${customerRecords.length} pelanggan`;
  if (!filtered.length) {
    customersList.innerHTML = '<p class="py-6 text-center text-sm text-slate-500">Belum ada pelanggan yang cocok.</p>';
    return;
  }
  customersList.innerHTML = filtered.map(customer => `
    <div class="py-3 flex items-center gap-2 border-b border-slate-100 last:border-0 min-w-0">
      <div class="min-w-0 flex-1 text-left">
        <span class="block text-sm font-semibold text-slate-900 truncate">${escapeHTML(customer.name)}</span>
        <span class="block text-xs text-slate-500 font-mono-code truncate">${escapeHTML(customer.phone)}</span>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <button type="button" data-customer-edit="${customer.id}" class="h-10 w-10 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 inline-flex items-center justify-center" title="Edit pelanggan" aria-label="Edit pelanggan"><i data-lucide="pencil" class="w-4 h-4"></i></button>
        <button type="button" data-customer-order="${customer.id}" class="h-10 w-10 rounded-lg bg-[#4F6BFF] text-white hover:bg-[#3D55E0] inline-flex items-center justify-center" title="Tambah order" aria-label="Tambah order"><i data-lucide="plus" class="w-5 h-5"></i></button>
      </div>
    </div>`).join('');
  if (window.lucide) window.lucide.createIcons();
}

async function handleCustomerListAction(event) {
  const editButton = event.target.closest('[data-customer-edit]');
  const orderButton = event.target.closest('[data-customer-order]');
  const id = editButton?.dataset.customerEdit || orderButton?.dataset.customerOrder;
  if (!id) return;
  const customer = customerRecords.find(item => item.id === id);
  if (!customer) return;
  if (orderButton) {
    showOrdersPage();
    openOrderModal(null, { customer_name: customer.name, customer_phone: customer.phone });
    return;
  }
  if (editButton) openCustomerEdit(customer);
}

function openCustomerCreateForm() {
  const modal = document.getElementById('customer-form-modal');
  const form = document.getElementById('customer-create-form');
  form?.reset();
  modal?.classList.remove('hidden');
  document.getElementById('new-customer-name')?.focus();
  if (window.lucide) window.lucide.createIcons();
}

function closeCustomerCreateForm() {
  document.getElementById('customer-form-modal')?.classList.add('hidden');
}

async function handleCustomerCreateSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = document.getElementById('save-customer-btn');
  const name = document.getElementById('new-customer-name')?.value.trim() || '';
  const phone = normalizePhone(document.getElementById('new-customer-phone')?.value || '');

  // Identitas pelanggan memang hanya membutuhkan nama dan nomor HP.
  if (!name) return alert('Nama pelanggan wajib diisi.');
  if (!phone || phone.length < 10) return alert('Nomor HP tidak valid. Masukkan minimal 10 digit.');

  submit.disabled = true;
  submit.textContent = 'Menyimpan...';
  try {
    const existing = await findCustomerByPhone(phone);
    if (existing) {
      throw new Error(`Nomor HP sudah terdaftar atas nama ${existing.name}. Gunakan data pelanggan yang sudah ada.`);
    }

    const { data, error } = await supabase
      .from('customers')
      .insert({ name, phone })
      .select('id, name, phone, created_at, updated_at')
      .single();
    if (error) throw error;

    if (data) {
      customerRecords = [...customerRecords.filter(item => item.id !== data.id), data]
        .sort((a, b) => a.name.localeCompare(b.name, 'id'));
    }
    closeCustomerCreateForm();
    await fetchCustomers();
    alert('Pelanggan berhasil ditambahkan.');
  } catch (error) {
    alert(`Gagal menambahkan pelanggan: ${error.message || 'Terjadi kesalahan.'}`);
  } finally {
    submit.disabled = false;
    submit.textContent = 'Simpan Pelanggan';
  }
}

let activeCustomerDetail = null;
let activeMeasurementTemplates = [];
let activeMeasurementTemplateFields = [];
let customerMeasurementRecords = [];

function setBottomNavActive(page) {
  const ordersButton = document.getElementById('bottom-nav-orders');
  const customersButton = document.getElementById('bottom-nav-customers');
  ordersButton?.classList.toggle('is-active', page === 'orders');
  customersButton?.classList.toggle('is-active', page === 'customers');
  if (page === 'orders') ordersButton?.setAttribute('aria-current', 'page');
  else ordersButton?.removeAttribute('aria-current');
  if (page === 'customers') customersButton?.setAttribute('aria-current', 'page');
  else customersButton?.removeAttribute('aria-current');
}

function showCustomersPage() { showAppPage('customers'); }

function showOrdersPage() { showAppPage('orders'); }

async function fetchMeasurementTemplates() {
  const { data: templates, error: templateError } = await supabase
    .from('measurement_templates')
    .select('id, garment_type, description, is_active, created_at')
    .order('garment_type', { ascending: true });
  if (templateError) throw templateError;
  const { data: fields, error: fieldError } = await supabase
    .from('measurement_template_fields')
    .select('id, template_id, field_key, field_label, unit, is_required, sort_order, is_active')
    .order('sort_order', { ascending: true });
  if (fieldError) throw fieldError;
  activeMeasurementTemplates = templates || [];
  activeMeasurementTemplateFields = fields || [];
  return activeMeasurementTemplates;
}

async function fetchCustomerMeasurements(customerId) {
  const { data, error } = await supabase
    .from('customer_measurements')
    .select('*')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  customerMeasurementRecords = data || [];
  return customerMeasurementRecords;
}

function openCustomerEdit(customer = activeCustomerDetail) {
  if (!customer) return;
  activeCustomerDetail = customer;
  const modal = document.getElementById('customer-detail-modal');
  const content = document.getElementById('customer-detail-content');
  const heading = modal?.querySelector('h3');
  if (heading) heading.textContent = 'Edit Pelanggan';
  content.innerHTML = `
    <form id="customer-edit-form" class="space-y-4">
      <label class="block"><span class="block text-xs font-semibold text-slate-700 mb-1">Nama Pelanggan</span><input id="edit-customer-name" type="text" required maxlength="120" value="${escapeHTML(customer.name)}" class="w-full h-11 px-3 rounded-xl border border-slate-300 text-sm"></label>
      <label class="block"><span class="block text-xs font-semibold text-slate-700 mb-1">Nomor WhatsApp</span><input id="edit-customer-phone" type="tel" inputmode="tel" required value="${escapeHTML(customer.phone)}" class="w-full h-11 px-3 rounded-xl border border-slate-300 text-sm"></label>
      <div class="grid grid-cols-1 gap-3 pt-1">
        <button type="button" data-customer-detail-view="measurements" class="min-h-16 rounded-xl border border-slate-200 hover:border-[#4F6BFF] p-3 text-left flex items-center gap-3"><span class="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center"><i data-lucide="ruler" class="w-5 h-5 text-slate-700"></i></span><span><strong class="block text-sm text-slate-900">List Ukuran</strong><small class="text-xs text-slate-500">Lihat, tambah, dan edit ukuran pelanggan</small></span><i data-lucide="chevron-right" class="w-4 h-4 ml-auto"></i></button>
        <button type="button" data-customer-detail-view="orders" class="min-h-16 rounded-xl border border-slate-200 hover:border-[#4F6BFF] p-3 text-left flex items-center gap-3"><span class="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center"><i data-lucide="clipboard-list" class="w-5 h-5 text-slate-700"></i></span><span><strong class="block text-sm text-slate-900">Riwayat Order</strong><small class="text-xs text-slate-500">Lihat semua pesanan pelanggan</small></span><i data-lucide="chevron-right" class="w-4 h-4 ml-auto"></i></button>
      </div>
      <div class="flex gap-2 pt-2"><button type="button" data-customer-detail-close class="flex-1 h-11 rounded-xl border border-slate-200 text-slate-700 text-sm font-semibold">Tutup</button><button type="submit" class="flex-1 h-11 rounded-xl bg-[#4F6BFF] text-white text-sm font-semibold">Simpan Perubahan</button></div>
    </form>`;
  modal?.classList.remove('hidden');
  if (window.lucide) window.lucide.createIcons();
}

async function handleCustomerEditSubmit(event) {
  if (event.target.id !== 'customer-edit-form') return;
  event.preventDefault();
  const name = document.getElementById('edit-customer-name')?.value.trim() || '';
  const phone = normalizePhone(document.getElementById('edit-customer-phone')?.value || '');
  if (!name) return alert('Nama pelanggan wajib diisi.');
  if (!phone || phone.length < 10) return alert('Nomor WhatsApp tidak valid.');
  const duplicate = customerRecords.find(item => item.id !== activeCustomerDetail.id && item.phone === phone);
  if (duplicate) return alert(`Nomor ini sudah terdaftar atas nama ${duplicate.name}.`);
  const submit = event.target.querySelector('button[type="submit"]');
  if (submit) { submit.disabled = true; submit.textContent = 'Menyimpan...'; }
  const { data, error } = await supabase.from('customers').update({ name, phone, updated_at: new Date().toISOString() }).eq('id', activeCustomerDetail.id).select('id, name, phone, created_at, updated_at').single();
  if (error) {
    if (submit) { submit.disabled = false; submit.textContent = 'Simpan Perubahan'; }
    return alert(`Gagal memperbarui pelanggan: ${error.message}`);
  }
  activeCustomerDetail = data;
  await fetchCustomers();
  openCustomerEdit(data);
  alert('Data pelanggan berhasil diperbarui.');
}

async function handleCustomerDetailAction(event) {
  const viewButton = event.target.closest('[data-customer-detail-view]');
  const backButton = event.target.closest('[data-customer-detail-back]');
  const addButton = event.target.closest('[data-add-customer-measurement]');
  const editButton = event.target.closest('[data-edit-customer-measurement]');
  const deleteButton = event.target.closest('[data-delete-customer-measurement]');
  const closeButton = event.target.closest('[data-customer-detail-close]');
  if (closeButton) { document.getElementById('customer-detail-modal')?.classList.add('hidden'); const heading = document.querySelector('#customer-detail-modal h3'); if (heading) heading.textContent = 'Detail Pelanggan'; return; }
  if (backButton) return openCustomerEdit(activeCustomerDetail);
  if (viewButton?.dataset.customerDetailView === 'measurements') return renderCustomerMeasurements();
  if (viewButton?.dataset.customerDetailView === 'orders') return renderCustomerOrderHistory();
  if (addButton) return openCustomerMeasurementForm();
  if (editButton) {
    const record = customerMeasurementRecords.find(item => item.id === editButton.dataset.editCustomerMeasurement);
    if (record) return openCustomerMeasurementForm(record);
  }
  if (deleteButton) {
    const id = deleteButton.dataset.deleteCustomerMeasurement;
    if (!confirm('Hapus koleksi ukuran ini?')) return;
    const { error } = await supabase.from('customer_measurements').delete().eq('id', id).eq('customer_id', activeCustomerDetail.id);
    if (error) return alert(`Gagal menghapus ukuran: ${error.message}`);
    await renderCustomerMeasurements();
  }
  const orderButton = event.target.closest('[data-customer-open-order]');
  if (orderButton) {
    const order = allOrders.find(item => item.id === orderButton.dataset.customerOpenOrder);
    if (order) {
      document.getElementById('customer-detail-modal')?.classList.add('hidden');
      showOrdersPage();
      openOrderModal(order);
    }
  }
}

async function renderCustomerMeasurements() {
  const content = document.getElementById('customer-detail-content');
  const modalHeading = document.querySelector('#customer-detail-modal h3'); if (modalHeading) modalHeading.textContent = 'List Ukuran';
  content.innerHTML = '<p class="py-6 text-center text-sm text-slate-500">Memuat daftar ukuran...</p>';
  try {
    await Promise.all([fetchCustomerMeasurements(activeCustomerDetail.id), fetchMeasurementTemplates()]);
    content.innerHTML = `
      <div class="flex items-center justify-between gap-2">
        <div><h4 class="font-bold text-[#0B1220]">List Ukuran</h4><p class="text-xs text-slate-500">${escapeHTML(activeCustomerDetail.name)}</p></div>
        <button type="button" data-customer-detail-back class="text-xs font-semibold text-slate-600 hover:text-[#4F6BFF]">Kembali</button>
      </div>
      <button type="button" data-add-customer-measurement class="w-full h-10 rounded-lg bg-[#4F6BFF] text-white text-sm font-semibold inline-flex items-center justify-center gap-2"><i data-lucide="plus" class="w-4 h-4"></i>Tambah Ukuran</button>
      <div class="space-y-2">
        ${customerMeasurementRecords.length ? customerMeasurementRecords.map(record => {
          const values = Object.entries(record.measurement_data || {}).slice(0, 4).map(([key, value]) => {
            const field = (record.template_snapshot || []).find(item => item.field_key === key);
            return `<span class="inline-block text-[11px] text-slate-600 bg-slate-100 rounded-md px-2 py-1 mr-1 mb-1">${escapeHTML(field?.field_label || key)}: ${escapeHTML(String(value))} ${escapeHTML(field?.unit || 'cm')}</span>`;
          }).join('');
          return `<article class="rounded-xl border border-slate-200 p-3">
            <div class="flex items-start justify-between gap-2"><div class="min-w-0"><p class="text-sm font-bold text-slate-900">${escapeHTML(record.garment_type)}${record.model ? ` · ${escapeHTML(record.model)}` : ''}</p><p class="text-xs text-slate-500 mt-0.5">${escapeHTML(record.description || 'Tanpa keterangan')}</p></div><div class="flex gap-1 shrink-0"><button type="button" data-edit-customer-measurement="${record.id}" class="h-8 w-8 rounded-lg border border-slate-200 text-slate-600" aria-label="Edit ukuran"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button><button type="button" data-delete-customer-measurement="${record.id}" class="h-8 w-8 rounded-lg border border-slate-200 text-rose-600" aria-label="Hapus ukuran"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button></div></div>
            <div class="mt-2">${values || '<span class="text-xs text-slate-400">Belum ada nilai ukuran.</span>'}</div>
          </article>`;
        }).join('') : '<p class="py-6 text-center text-sm text-slate-500 border border-dashed border-slate-300 rounded-xl">Belum ada ukuran tersimpan.</p>'}
      </div>`;
    if (window.lucide) window.lucide.createIcons();
  } catch (error) {
    content.innerHTML = `<p class="text-sm text-rose-600">Gagal memuat ukuran: ${escapeHTML(error.message || '')}</p><button type="button" data-customer-detail-back class="mt-3 text-sm underline">Kembali</button>`;
  }
}

function renderCustomerOrderHistory() {
  const modalHeading = document.querySelector('#customer-detail-modal h3'); if (modalHeading) modalHeading.textContent = 'Riwayat Order';
  const content = document.getElementById('customer-detail-content');
  const transactions = allOrders.filter(order => order.customer_id === activeCustomerDetail.id || normalizePhone(order.customer_phone) === activeCustomerDetail.phone).sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
  content.innerHTML = `
    <div class="flex items-center justify-between gap-2"><div><h4 class="font-bold text-[#0B1220]">Riwayat Order</h4><p class="text-xs text-slate-500">${transactions.length} transaksi</p></div><button type="button" data-customer-detail-back class="text-xs font-semibold text-slate-600 hover:text-[#4F6BFF]">Kembali</button></div>
    ${transactions.length ? `<div class="space-y-2">${transactions.map(order => { const meta = STATUS_META[order.status] || STATUS_META.received; return `<button type="button" data-customer-open-order="${order.id}" class="w-full text-left rounded-xl border border-slate-200 p-3 hover:border-slate-300"><div class="flex items-center justify-between gap-2"><span class="font-mono-code text-sm font-bold text-[#0B1220]">${escapeHTML(order.ticket_code)}</span><span class="text-xs font-semibold ${meta.textClass || 'text-slate-600'}">${escapeHTML(meta.label)}</span></div><div class="flex items-center justify-between gap-2 mt-1"><span class="text-xs text-slate-500">${formatDateID(order.created_at)}</span><span class="text-sm font-semibold">${formatCurrency(order.total_amount)}</span></div></button>`; }).join('')}</div>` : '<p class="text-xs text-slate-500 py-6 text-center border border-dashed border-slate-300 rounded-xl">Belum ada riwayat order.</p>'}`;
}

function getActiveTemplateFields(templateId) {
  return activeMeasurementTemplateFields.filter(field => field.template_id === templateId && field.is_active).sort((a,b) => a.sort_order - b.sort_order);
}

function renderMeasurementFields(fields, values = {}) {
  if (!fields.length) return '<p class="text-xs text-slate-500 rounded-lg bg-slate-50 p-3">Belum ada komponen ukuran pada template ini. Tambahkan melalui Pengaturan Toko → Template Ukuran.</p>';
  return fields.map(field => `<label class="block"><span class="block text-xs font-semibold text-slate-700 mb-1">${escapeHTML(field.field_label)}${field.is_required ? ' *' : ''}</span><div class="flex items-center gap-2"><input type="number" inputmode="decimal" step="0.1" data-measurement-value="${escapeHTML(field.field_key)}" ${field.is_required ? 'required' : ''} value="${values[field.field_key] ?? ''}" class="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm"><span class="text-xs text-slate-500 min-w-8">${escapeHTML(field.unit || 'cm')}</span></div></label>`).join('');
}

async function openCustomerMeasurementForm(record = null) {
  const content = document.getElementById('customer-detail-content');
  try {
    await fetchMeasurementTemplates();
    const activeTemplates = activeMeasurementTemplates.filter(item => item.is_active);
    const initialTemplate = activeTemplates.find(item => item.id === record?.template_id) || activeTemplates.find(item => item.garment_type === record?.garment_type) || activeTemplates[0];
    if (!initialTemplate) throw new Error('Template ukuran belum tersedia. Tambahkan melalui Pengaturan Toko.');
    const snapshotFields = record?.template_snapshot?.length ? record.template_snapshot : null;
    const fields = snapshotFields || getActiveTemplateFields(initialTemplate.id);
    content.innerHTML = `
      <div class="flex items-center justify-between"><div><h4 class="font-bold text-[#0B1220]">${record ? 'Edit Ukuran' : 'Tambah Ukuran'}</h4><p class="text-xs text-slate-500">${escapeHTML(activeCustomerDetail.name)}</p></div><button type="button" data-customer-detail-back class="text-xs font-semibold text-slate-600">Batal</button></div>
      <form id="customer-measurement-form" class="space-y-3" data-edit-id="${record?.id || ''}">
        <label class="block"><span class="block text-xs font-semibold text-slate-700 mb-1">Jenis Pakaian</span><select id="measurement-garment-type" required class="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm">${activeTemplates.map(item => `<option value="${item.id}" ${item.id === initialTemplate.id ? 'selected' : ''}>${escapeHTML(item.garment_type)}</option>`).join('')}</select></label>
        <label class="block"><span class="block text-xs font-semibold text-slate-700 mb-1">Model</span><input id="measurement-model" type="text" maxlength="100" value="${escapeHTML(record?.model || '')}" placeholder="Contoh: Slim Fit, Trucker" class="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm"></label>
        <label class="block"><span class="block text-xs font-semibold text-slate-700 mb-1">Keterangan / Pemakai</span><input id="measurement-description" type="text" maxlength="160" value="${escapeHTML(record?.description || '')}" placeholder="Contoh: Budi, Ani, Andi" class="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm"></label>
        <div class="border-t border-slate-200 pt-3"><h5 class="text-sm font-bold text-slate-800 mb-3">Data Ukuran</h5><div id="measurement-fields-grid" class="grid grid-cols-1 sm:grid-cols-2 gap-3">${renderMeasurementFields(fields, record?.measurement_data || {})}</div></div>
        <p id="measurement-form-error" class="hidden text-xs text-rose-600"></p>
        <div class="flex gap-2"><button type="button" data-customer-detail-back class="flex-1 h-10 rounded-lg border border-slate-300 text-sm font-semibold">Batal</button><button type="submit" class="flex-1 h-10 rounded-lg bg-[#4F6BFF] text-white text-sm font-semibold">Simpan Ukuran</button></div>
      </form>`;
    const form = document.getElementById('customer-measurement-form');
    form.dataset.snapshot = JSON.stringify(fields);
    form.addEventListener('submit', saveCustomerMeasurement);
  } catch (error) {
    content.innerHTML = `<p class="text-sm text-rose-600">${escapeHTML(error.message || 'Gagal membuka formulir ukuran.')}</p><button type="button" data-customer-detail-back class="mt-3 text-sm underline">Kembali</button>`;
  }
}

function handleMeasurementFormChange(event) {
  if (event.target.id !== 'measurement-garment-type') return;
  const template = activeMeasurementTemplates.find(item => item.id === event.target.value);
  const grid = document.getElementById('measurement-fields-grid');
  const fields = template ? getActiveTemplateFields(template.id) : [];
  if (grid && template) {
    grid.innerHTML = renderMeasurementFields(fields);
    const form = document.getElementById('customer-measurement-form');
    if (form) form.dataset.snapshot = JSON.stringify(fields.map(field => ({ field_key: field.field_key, field_label: field.field_label, unit: field.unit, is_required: field.is_required, sort_order: field.sort_order })));
  }
}

async function saveCustomerMeasurement(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const template = activeMeasurementTemplates.find(item => item.id === document.getElementById('measurement-garment-type').value);
  if (!template) return alert('Template ukuran tidak ditemukan.');
  const fields = JSON.parse(form.dataset.snapshot || '[]');
  const values = {};
  for (const input of form.querySelectorAll('[data-measurement-value]')) {
    const raw = input.value.trim();
    const field = fields.find(item => item.field_key === input.dataset.measurementValue);
    if (field?.is_required && raw === '') {
      input.focus();
      return alert(`Ukuran ${field.field_label} wajib diisi.`);
    }
    if (raw !== '') values[input.dataset.measurementValue] = Number(raw);
  }
  const snapshot = fields.map(field => ({ field_key: field.field_key, field_label: field.field_label, unit: field.unit, is_required: field.is_required, sort_order: field.sort_order }));
  const payload = {
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
    ? await supabase.from('customer_measurements').update(payload).eq('id', editId).eq('customer_id', activeCustomerDetail.id)
    : await supabase.from('customer_measurements').insert(payload);
  if (result.error) return alert(`Gagal menyimpan ukuran: ${result.error.message}`);
  await renderCustomerMeasurements();
}

async function renderMeasurementTemplateSettings() {
  const container = document.getElementById('measurement-templates-list');
  if (!container) return;
  container.innerHTML = '<p class="text-xs text-slate-500">Memuat template ukuran...</p>';
  try {
    await fetchMeasurementTemplates();
    container.innerHTML = activeMeasurementTemplates.map(template => {
      const fields = activeMeasurementTemplateFields.filter(field => field.template_id === template.id).sort((a,b) => a.sort_order-b.sort_order);
      return `<section class="rounded-xl border border-slate-200 p-3 ${template.is_active ? '' : 'opacity-60'}">
        <div class="flex items-center justify-between gap-2"><div class="min-w-0"><p class="text-sm font-bold text-slate-800">${escapeHTML(template.garment_type)}</p><p class="text-[11px] text-slate-500">${fields.filter(field => field.is_active).length} komponen aktif</p></div><button type="button" data-template-toggle="${template.id}" data-active="${template.is_active}" class="text-xs font-semibold ${template.is_active ? 'text-rose-600' : 'text-emerald-700'}">${template.is_active ? 'Nonaktifkan' : 'Aktifkan'}</button></div>
        <div class="mt-2 space-y-1">${fields.map(field => `<div class="flex items-center gap-2 text-xs ${field.is_active ? '' : 'opacity-50'}"><span class="flex-1">${escapeHTML(field.field_label)} <span class="text-slate-400">(${escapeHTML(field.unit)})</span></span><button type="button" data-field-move="${field.id}" data-direction="up" class="text-slate-500 px-1" title="Geser ke atas" ${fields[0]?.id === field.id ? 'disabled' : ''}>↑</button><button type="button" data-field-move="${field.id}" data-direction="down" class="text-slate-500 px-1" title="Geser ke bawah" ${fields[fields.length-1]?.id === field.id ? 'disabled' : ''}>↓</button><button type="button" data-field-edit="${field.id}" class="text-slate-600 underline">Edit</button><button type="button" data-field-required="${field.id}" data-required="${field.is_required}" class="text-slate-600 underline">${field.is_required ? 'Wajib' : 'Opsional'}</button>${field.is_active ? `<button type="button" data-field-toggle="${field.id}" data-active="true" class="text-rose-600">Nonaktifkan</button>` : `<button type="button" data-field-delete="${field.id}" class="text-rose-700 font-semibold">Hapus</button>`}</div>`).join('')}</div>
        <button type="button" data-field-add="${template.id}" class="mt-2 text-xs font-semibold text-[#3D55E0]">+ Tambah Komponen</button>
      </section>`;
    }).join('');
    if (window.lucide) window.lucide.createIcons();
  } catch (error) {
    container.innerHTML = `<p class="text-xs text-rose-600">Gagal memuat template: ${escapeHTML(error.message || '')}</p>`;
  }
}

function makeMeasurementFieldKey(label) {
  return label.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);
}

async function addMeasurementTemplate() {
  const name = prompt('Nama jenis pakaian baru:');
  if (name === null) return;
  if (!name.trim()) return alert('Nama jenis pakaian wajib diisi.');
  const { error } = await supabase.from('measurement_templates').insert({ garment_type: name.trim(), description: `Template ukuran ${name.trim()}` });
  if (error) return alert(`Gagal menambahkan jenis pakaian: ${error.message}`);
  await renderMeasurementTemplateSettings();
}

async function handleMeasurementTemplateAction(event) {
  const addField = event.target.closest('[data-field-add]');
  const editField = event.target.closest('[data-field-edit]');
  const moveField = event.target.closest('[data-field-move]');
  const deleteField = event.target.closest('[data-field-delete]');
  if (moveField) {
    const field = activeMeasurementTemplateFields.find(item => item.id === moveField.dataset.fieldMove);
    if (!field) return;
    const siblings = activeMeasurementTemplateFields.filter(item => item.template_id === field.template_id).sort((a,b) => a.sort_order-b.sort_order);
    const index = siblings.findIndex(item => item.id === field.id);
    const targetIndex = index + (moveField.dataset.direction === 'up' ? -1 : 1);
    if (targetIndex < 0 || targetIndex >= siblings.length) return;
    const other = siblings[targetIndex];
    const firstOrder = field.sort_order, secondOrder = other.sort_order;
    const firstUpdate = await supabase.from('measurement_template_fields').update({ sort_order: secondOrder }).eq('id', field.id);
    if (firstUpdate.error) return alert(`Gagal mengubah urutan: ${firstUpdate.error.message}`);
    const secondUpdate = await supabase.from('measurement_template_fields').update({ sort_order: firstOrder }).eq('id', other.id);
    if (secondUpdate.error) return alert(`Gagal menyimpan urutan komponen: ${secondUpdate.error.message}`);
    return renderMeasurementTemplateSettings();
  }
  if (deleteField) {
    const field = activeMeasurementTemplateFields.find(item => item.id === deleteField.dataset.fieldDelete);
    if (!field) return;
    if (!confirm(`Hapus komponen ukuran "${field.field_label}"? Data ukuran lama yang sudah tersimpan tidak diubah.`)) return;
    const { error } = await supabase.from('measurement_template_fields').delete().eq('id', field.id);
    if (error) return alert(`Gagal menghapus komponen: ${error.message}`);
    return renderMeasurementTemplateSettings();
  }
  if (addField) {
    const template = activeMeasurementTemplates.find(item => item.id === addField.dataset.fieldAdd);
    if (!template) return;
    const label = prompt(`Nama komponen ukuran untuk ${template.garment_type}:`);
    if (label === null) return;
    if (!label.trim()) return alert('Nama komponen wajib diisi.');
    const unit = prompt('Satuan ukuran:', 'cm');
    if (unit === null) return;
    const key = makeMeasurementFieldKey(label);
    if (!key) return alert('Nama komponen tidak valid.');
    const maxOrder = Math.max(0, ...activeMeasurementTemplateFields.filter(field => field.template_id === template.id).map(field => field.sort_order));
    const { error } = await supabase.from('measurement_template_fields').insert({ template_id: template.id, field_key: key, field_label: label.trim(), unit: unit.trim() || 'cm', is_required: true, sort_order: maxOrder + 1 });
    if (error) return alert(`Gagal menambahkan komponen: ${error.message}`);
    return renderMeasurementTemplateSettings();
  }
  if (editField) {
    const field = activeMeasurementTemplateFields.find(item => item.id === editField.dataset.fieldEdit);
    if (!field) return;
    const label = prompt('Ubah nama komponen ukuran:', field.field_label);
    if (label === null || !label.trim()) return;
    const unit = prompt('Satuan ukuran:', field.unit || 'cm');
    if (unit === null) return;
    const { error } = await supabase.from('measurement_template_fields').update({ field_label: label.trim(), unit: unit.trim() || 'cm' }).eq('id', field.id);
    if (error) return alert(`Gagal mengubah komponen: ${error.message}`);
    return renderMeasurementTemplateSettings();
  }
}

async function handleMeasurementTemplateToggle(event) {
  const templateToggle = event.target.closest('[data-template-toggle]');
  const fieldToggle = event.target.closest('[data-field-toggle]');
  const requiredToggle = event.target.closest('[data-field-required]');
  if (requiredToggle) {
    const field = activeMeasurementTemplateFields.find(item => item.id === requiredToggle.dataset.fieldRequired);
    if (!field) return;
    const { error } = await supabase.from('measurement_template_fields').update({ is_required: !(requiredToggle.dataset.required === 'true') }).eq('id', field.id);
    if (error) alert(`Gagal mengubah kewajiban komponen: ${error.message}`);
    return renderMeasurementTemplateSettings();
  }
  if (templateToggle) {
    const isActive = templateToggle.dataset.active === 'true';
    const { error } = await supabase.from('measurement_templates').update({ is_active: !isActive }).eq('id', templateToggle.dataset.templateToggle);
    if (error) alert(`Gagal memperbarui template: ${error.message}`);
    return renderMeasurementTemplateSettings();
  }
  if (fieldToggle) {
    const isActive = fieldToggle.dataset.active === 'true';
    const { error } = await supabase.from('measurement_template_fields').update({ is_active: !isActive }).eq('id', fieldToggle.dataset.fieldToggle);
    if (error) alert(`Gagal memperbarui komponen: ${error.message}`);
    return renderMeasurementTemplateSettings();
  }
}

// ============================================================================
// FETCH ORDERS & UPDATE METRICS
// ============================================================================
async function fetchOrders() {
  if (!ordersListContainer) return;
  ordersListContainer.innerHTML = `
    <div class="bg-white rounded-2xl border border-slate-200 p-8 text-center text-sm text-slate-500">
      Memuat daftar order workshop...
    </div>
  `;

  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*, order_items(*)')
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
      <div class="bg-rose-50 border border-rose-200 rounded-2xl p-5 text-sm text-rose-800">
        Gagal memuat order: ${escapeHTML(err.message)}
      </div>
    `;
  }
}

function updateDashboardMetrics() {
  const activeOrders = allOrders.filter((o) => o.status !== 'completed');
  const activeCountEl = document.getElementById('metric-active-count');
  const nearestDeadlineEl = document.getElementById('metric-nearest-deadline');
  const nearestTicketEl = document.getElementById('metric-nearest-ticket');
  const unpaidTotalEl = document.getElementById('metric-unpaid-total');

  if (activeCountEl) activeCountEl.textContent = String(activeOrders.length);

  // Hitung Total Sisa Piutang
  const totalPiutang = allOrders.reduce((acc, o) => {
    const sisa = Math.max(0, Number(o.total_amount || 0) - Number(o.paid_amount || 0));
    return acc + sisa;
  }, 0);
  if (unpaidTotalEl) unpaidTotalEl.textContent = formatCurrency(totalPiutang);

  // Cari Deadline Terdekat di antara order yang belum ready/completed
  const ongoingWithDeadline = activeOrders
    .filter((o) => o.estimated_done_date && !['ready', 'completed'].includes(o.status))
    .sort((a, b) => new Date(a.estimated_done_date) - new Date(b.estimated_done_date));

  if (ongoingWithDeadline.length > 0) {
    const nearest = ongoingWithDeadline[0];
    const dStatus = getDeadlineStatus(nearest.estimated_done_date);
    if (nearestDeadlineEl) {
      nearestDeadlineEl.textContent = formatDateID(nearest.estimated_done_date);
      nearestDeadlineEl.className = `text-base sm:text-lg font-bold mt-1 ${
        dStatus.isUrgent ? 'text-rose-600' : 'text-[#0B1220]'
      }`;
    }
    if (nearestTicketEl) {
      nearestTicketEl.textContent = `${nearest.ticket_code} • ${dStatus.label}`;
    }
  } else {
    if (nearestDeadlineEl) {
      nearestDeadlineEl.textContent = '-';
      nearestDeadlineEl.className = 'text-base sm:text-lg font-bold text-[#0B1220] mt-1';
    }
    if (nearestTicketEl) nearestTicketEl.textContent = 'Tidak ada antrean mendesak';
  }
}

// ============================================================================
// RENDER ORDERS LIST & QUICK STATUS SWITCHER (T-3.2)
// ============================================================================
function renderOrdersList() {
  if (!ordersListContainer) return;

  const filtered = allOrders.filter((order) => {
    // Daftar Order hanya menampilkan order aktif; order completed dikelola di menu Arsip.
    if (order.status === 'completed') return false;

    // Filter by selected calendar date
    if (workloadDateFilter && order.estimated_done_date !== workloadDateFilter) return false;

    // Filter by workflow status
    if (orderStatusFilter !== 'all' && order.status !== orderStatusFilter) return false;

    // Filter search query
    if (searchQuery) {
      const hay = `${order.ticket_code} ${order.customer_name} ${order.customer_phone}`.toLowerCase();
      if (!hay.includes(searchQuery)) return false;
    }

    return true;
  });

  const filterCount = document.getElementById('order-filter-count');
  if (filterCount) filterCount.textContent = `${filtered.length} order ditampilkan`;

  if (filtered.length === 0) {
    ordersListContainer.innerHTML = `
      <div class="bg-white rounded-2xl border border-slate-200 p-10 text-center">
        <p class="font-semibold text-slate-700 text-sm">Tidak ada order pada filter ini</p>
        <p class="text-xs text-slate-400 mt-1">Klik tombol "+ Order Baru" di kanan atas untuk mencatat pesanan baru.</p>
      </div>
    `;
    return;
  }

  const nextStatusMap = {
    received: { next: 'queued', label: 'Masuk Antrean' },
    queued: { next: 'in_progress', label: 'Mulai Kerjakan' },
    in_progress: { next: 'qc', label: 'Lanjut QC' },
    qc: { next: 'ready', label: 'Tandai Siap Diambil' },
    ready: { next: 'completed', label: 'Selesai / Diambil' },
  };

  ordersListContainer.innerHTML = filtered
    .map((order) => {
      const statusMeta = STATUS_META[order.status] || STATUS_META.received;
      const payMeta = PAYMENT_STATUS_META[order.payment_status] || PAYMENT_STATUS_META.unpaid;
      const items = order.order_items || [];
      const remaining = Math.max(0, Number(order.total_amount) - Number(order.paid_amount));
      const deadline = getDeadlineStatus(order.estimated_done_date);
      const nextStep = nextStatusMap[order.status];

      const itemSummary =
        items.length > 0
          ? items
              .map(
                (it) =>
                  `<span class="inline-flex items-center px-2 py-0.5 rounded bg-slate-100 text-slate-700 text-xs">${escapeHTML(
                    it.garment_name
                  )} • <strong>${escapeHTML(it.service_type)}</strong></span>`
              )
              .join(' ')
          : '<span class="text-xs text-slate-400">Belum ada item</span>';

      return `
        <article class="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 shadow-sm hover:border-slate-300 transition space-y-3.5">
          <!-- Baris Atas: Tiket, Pelanggan, Status & Biaya -->
          <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-2.5">
            <div>
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-mono-code font-bold text-sm sm:text-base text-[#0B1220]">${escapeHTML(
                  order.ticket_code
                )}</span>
                <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
                  statusMeta.badgeClass
                }">
                  <span class="w-1.5 h-1.5 rounded-full ${statusMeta.dotClass}"></span>
                  ${escapeHTML(statusMeta.label)}
                </span>
                ${deadline.isOverdue && !['ready','completed'].includes(order.status) ? `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-rose-100 text-rose-700 border border-rose-200"><i data-lucide="alert-circle" class="w-3 h-3 mr-1"></i>${escapeHTML(deadline.label)}</span>` : ''}
                <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ${
                  payMeta.badgeClass
                }">
                  ${escapeHTML(payMeta.label)}
                </span>
              </div>

              <div class="mt-1 flex items-center gap-2 text-xs sm:text-sm text-slate-600 flex-wrap">
                <button type="button" data-edit-order="${escapeHTML(order.id)}" class="font-semibold text-slate-900 hover:text-[#4F6BFF] hover:underline text-left">${escapeHTML(order.customer_name)}</button>
                <span>•</span>
                <a href="${buildWhatsAppLink(
                  order.customer_phone,
                  `Halo ${order.customer_name}, update order ${order.ticket_code} dari ${workshopSettings.NAME}:`
                )}" target="_blank" rel="noopener noreferrer" class="text-emerald-700 hover:underline font-mono-code text-xs">
                  +${escapeHTML(order.customer_phone)}
                </a>
              </div>
            </div>

            <div class="sm:text-right">
              <p class="font-mono-code font-bold text-sm sm:text-base text-[#0B1220]">
                ${formatCurrency(order.total_amount)}
              </p>
              ${
                remaining > 0
                  ? `<p class="text-xs font-medium text-[#4F6BFF]">Sisa: ${formatCurrency(
                      remaining
                    )}</p>`
                  : `<p class="text-xs font-medium text-emerald-600">Lunas</p>`
              }
            </div>
          </div>

          <!-- Ringkasan Item & Deadline -->
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-2 border-t border-slate-100">
            <div class="flex flex-wrap gap-1.5">${itemSummary}</div>
            <div class="text-xs shrink-0 ${
              deadline.isUrgent && !['ready', 'completed'].includes(order.status)
                ? 'text-rose-600 font-semibold'
                : 'text-slate-500'
            }">
              ${deadline.isOverdue && !['ready','completed'].includes(order.status) ? 'Terlambat: ' : 'Target: '}${formatDateID(order.estimated_done_date)}
            </div>
          </div>

          <!-- Action Toolbar: Quick Status Switcher, Kasir, Nota, Edit -->
          <div class="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-2 flex-wrap">
              ${
                nextStep
                  ? `<button type="button" data-quick-next="${order.id}" data-next-status="${
                      nextStep.next
                    }" class="h-9 px-3 rounded-xl bg-[#4F6BFF] hover:bg-[#3D55E0] text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer transition">
                      <i data-lucide="arrow-right-circle" class="w-3.5 h-3.5"></i>
                      <span>${escapeHTML(nextStep.label)}</span>
                    </button>`
                  : ''
              }

            </div>

            <div class="flex items-center gap-1.5">
              ${remaining > 0 ? `<button type="button" data-open-payment="${order.id}" class="h-9 px-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold inline-flex items-center gap-1"><i data-lucide="wallet" class="w-3.5 h-3.5"></i>Pelunasan</button>` : ''}
              <button
                type="button"
                data-open-receipt="${order.id}"
                title="Nota Digital"
                class="h-9 px-2.5 rounded-xl border border-slate-200 hover:bg-slate-100 text-slate-700 text-xs font-semibold inline-flex items-center gap-1 cursor-pointer"
              >
                <i data-lucide="receipt-text" class="w-3.5 h-3.5"></i>
                <span>Nota</span>
              </button>

              <button
                type="button"
                data-edit-order="${order.id}"
                title="Edit Order & Foto"
                class="h-9 px-2.5 rounded-xl border border-slate-200 hover:bg-slate-100 text-slate-700 text-xs font-semibold inline-flex items-center gap-1 cursor-pointer"
              >
                <i data-lucide="pencil" class="w-3.5 h-3.5"></i>
                <span>Edit</span>
              </button>

              <button
                type="button"
                data-delete-order="${order.id}"
                title="Hapus Order"
                class="h-9 w-9 rounded-xl border border-slate-200 hover:bg-rose-50 hover:border-rose-200 text-slate-400 hover:text-rose-600 inline-flex items-center justify-center cursor-pointer"
              >
                <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
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
  // Quick Next Status Button
  ordersListContainer.querySelectorAll('[data-quick-next]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const orderId = btn.getAttribute('data-quick-next');
      const nextStatus = btn.getAttribute('data-next-status');
      updateOrderStatus(orderId, nextStatus);
    });
  });

  // Open final-payment modal (no installments).
  ordersListContainer.querySelectorAll('[data-open-payment]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const order = allOrders.find((o) => o.id === btn.getAttribute('data-open-payment'));
      if (order) openPaymentModal(order);
    });
  });

  // Open Receipt Modal
  ordersListContainer.querySelectorAll('[data-open-receipt]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const order = allOrders.find((o) => o.id === btn.getAttribute('data-open-receipt'));
      if (order) openReceiptModal(order);
    });
  });

  // Edit Order
  ordersListContainer.querySelectorAll('[data-edit-order]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const order = allOrders.find((o) => o.id === btn.getAttribute('data-edit-order'));
      if (order) openOrderModal(order);
    });
  });

  // Delete Order
  ordersListContainer.querySelectorAll('[data-delete-order]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const orderId = btn.getAttribute('data-delete-order');
      const order = allOrders.find((o) => o.id === orderId);
      if (!order) return;
      if (!confirm(`Hapus permanen order ${order.ticket_code} (${order.customer_name})?`)) return;

      const { error } = await supabase.from('orders').delete().eq('id', orderId);
      if (error) {
        alert('Gagal menghapus order: ' + error.message);
        return;
      }
      await fetchOrders();
    });
  });
}

// ============================================================================
// UPDATE STATUS & AUTO WHATSAPP TRIGGER (T-4.2)
// ============================================================================
async function updateOrderStatus(orderId, newStatus) {
  try {
    const orderToUpdate = allOrders.find((o) => o.id === orderId);
    const statusUpdate = { status: newStatus };

    // Status selesai/diambil tidak pernah otomatis melunasi pembayaran.
    const { error } = await supabase
      .from('orders')
      .update(statusUpdate)
      .eq('id', orderId);

    if (error) throw error;

    await fetchOrders();

    // Jika status diubah menjadi 'ready' (Siap Diambil), munculkan Toast WA otomatis
    if (newStatus === 'ready') {
      const updatedOrder = allOrders.find((o) => o.id === orderId);
      if (updatedOrder) showWhatsAppReadyToast(updatedOrder);
    }
  } catch (err) {
    alert('Gagal memperbarui status: ' + err.message);
  }
}

function showWhatsAppReadyToast(order) {
  if (!waReadyToast || !waToastSendLink) return;

  const remaining = Math.max(0, Number(order.total_amount) - Number(order.paid_amount));
  const trackingUrl = `${window.location.origin}/`;

  const billingLine =
    remaining > 0
      ? `Sisa tagihan: *${formatCurrency(remaining)}* (pembayaran saat pengambilan).`
      : `Status pembayaran: *LUNAS*.`;

  const message =
    `Halo Kak *${order.customer_name}*, pengerjaan order Anda di *${workshopSettings.NAME}* dengan kode tiket *${order.ticket_code}* telah *SELESAI & SIAP DIAMBIL*.\n\n` +
    `${billingLine}\n` +
    `Detail & foto hasil pengerjaan dapat dilihat di:\n${trackingUrl}\n\n` +
    `Alamat Workshop: ${workshopSettings.ADDRESS}\nJam buka: ${workshopSettings.OPENING_HOURS}\nTerima kasih!\n\nby MendTrack`;

  waToastDesc.textContent = `Kirim info siap ambil ke ${order.customer_name} (${order.ticket_code})`;
  waToastSendLink.href = buildWhatsAppLink(order.customer_phone, message);
  waReadyToast.classList.remove('hidden');
  if (window.lucide) window.lucide.createIcons();
}

// ============================================================================
// ORDER CRUD MODAL & MULTI-ITEM REPEATER (T-3.3)
// ============================================================================
async function openOrderModal(existingOrder = null, draftOverride = null) {
  if (!orderFormModal) return;
  try {
    activeServiceCatalog = (await fetchServices()).filter(service => service.is_active);
  } catch (error) {
    console.warn('Katalog layanan gagal dimuat:', error);
    activeServiceCatalog = [];
  }

  const isEdit = Boolean(existingOrder);
  document.getElementById('order-modal-title').textContent = isEdit
    ? `Edit Order ${existingOrder.ticket_code}`
    : 'Input Order Baru';
  document.getElementById('form-order-id').value = isEdit ? existingOrder.id : '';

  formItemsContainer.innerHTML = '';

  if (draftOverride) {
    document.getElementById('form-ticket-code').value =
      draftOverride.ticket_code || generateTicketCode(allOrders.length + 1);
    document.getElementById('form-customer-name').value = draftOverride.customer_name || '';
    document.getElementById('form-customer-phone').value = draftOverride.customer_phone || '';
    document.getElementById('form-estimated-date').value = draftOverride.estimated_done_date || '';
    document.getElementById('form-notes').value = draftOverride.notes || '';
    document.getElementById('form-paid-amount').value = draftOverride.paid_amount || 0;

    const items = draftOverride.items || [];
    if (items.length > 0) {
      items.forEach((it) => appendItemRow(it));
    } else {
      appendItemRow();
    }
  } else if (isEdit) {
    document.getElementById('form-ticket-code').value = existingOrder.ticket_code;
    document.getElementById('form-customer-name').value = existingOrder.customer_name;
    document.getElementById('form-customer-phone').value = existingOrder.customer_phone;
    document.getElementById('form-estimated-date').value = existingOrder.estimated_done_date || '';
    document.getElementById('form-notes').value = existingOrder.notes || '';
    document.getElementById('form-paid-amount').value = Number(existingOrder.paid_amount || 0);

    const items = existingOrder.order_items || [];
    if (items.length > 0) {
      items.forEach((it) => appendItemRow(it));
    } else {
      appendItemRow();
    }
  } else {
    // Order Baru
    document.getElementById('form-ticket-code').value = generateTicketCode(allOrders.length + 1);
    document.getElementById('form-customer-name').value = '';
    document.getElementById('form-customer-phone').value = '';
    document.getElementById('form-estimated-date').value = '';
    document.getElementById('form-notes').value = '';
    document.getElementById('form-paid-amount').value = 0;
    appendItemRow();
  }

  recalculateFormTotals();
  const customerLookupStatus = document.getElementById('customer-lookup-status');
  if (customerLookupStatus) {
    customerLookupStatus.textContent = 'Masukkan nomor HP untuk memeriksa data pelanggan.';
    customerLookupStatus.className = 'mt-1 text-xs text-slate-500';
  }
  orderFormModal.classList.remove('hidden');
  if (window.lucide) window.lucide.createIcons();
}

function closeOrderModal() {
  orderFormModal?.classList.add('hidden');
}

function appendItemRow(itemData = {}) {
  const rowIndex = formItemsContainer.children.length;
  const specsObj = itemData.measurement_specs || {};
  const specsString = Object.entries(specsObj)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');

  // Hanya layanan aktif dari katalog Supabase yang ditawarkan untuk order baru.
  // Nilai lama tetap ditambahkan agar order historis dapat diedit tanpa kehilangan layanan.
  const serviceNames = [...activeServiceCatalog.map(service => service.name)];
  if (itemData.service_type && !serviceNames.includes(itemData.service_type)) {
    serviceNames.push(itemData.service_type);
  }
  const presetOptions = serviceNames.map(
    (serviceName) => `<option value="${escapeHTML(serviceName)}"></option>`
  ).join('');

  const card = document.createElement('div');
  card.className = 'item-row p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3 relative';
  card.dataset.itemId = itemData.id || '';
  card.dataset.existingBeforeUrl = itemData.before_photo_url || '';
  card.dataset.existingAfterUrl = itemData.after_photo_url || '';

  card.innerHTML = `
    <div class="flex items-center justify-between">
      <span class="text-xs font-bold text-[#4F6BFF] uppercase tracking-wider item-row-label">Item #${
        rowIndex + 1
      }</span>
      <button type="button" class="remove-item-btn text-xs text-rose-600 hover:underline font-medium cursor-pointer">
        Hapus Item
      </button>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
      <div>
        <label class="block text-[11px] font-semibold text-slate-600 mb-1">Nama Pakaian / Artikel *</label>
        <input
          type="text"
          required
          data-field="garment_name"
          value="${escapeHTML(itemData.garment_name || '')}"
          placeholder="Contoh: Raw Denim 15oz"
          class="w-full h-10 px-3 rounded-lg bg-white border border-slate-300 text-sm focus:outline-none focus:border-[#4F6BFF]"
        />
      </div>

      <div>
        <label class="block text-[11px] font-semibold text-slate-600 mb-1">Jenis Layanan *</label>
        <input
          type="text"
          required
          list="service-presets-${rowIndex}"
          data-field="service_type"
          value="${escapeHTML(itemData.service_type || '')}"
          placeholder="Pilih atau ketik layanan..."
          class="w-full h-10 px-3 rounded-lg bg-white border border-slate-300 text-sm focus:outline-none focus:border-[#4F6BFF]"
        />
        <datalist id="service-presets-${rowIndex}">${presetOptions}</datalist>
      </div>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
      <div>
        <label class="block text-[11px] font-semibold text-slate-600 mb-1">Spesifikasi Ukuran (opsional)</label>
        <input
          type="text"
          data-field="measurement_specs"
          value="${escapeHTML(specsString)}"
          placeholder="Contoh: Inseam: 78cm, Leg Opening: 18cm"
          class="w-full h-10 px-3 rounded-lg bg-white border border-slate-300 text-xs focus:outline-none focus:border-[#4F6BFF]"
        />
      </div>

      <div>
        <label class="block text-[11px] font-semibold text-slate-600 mb-1">Biaya Item (Rp) *</label>
        <input
          type="number"
          required
          min="0"
          step="1000"
          data-field="price"
          value="${Number(itemData.price || 0)}"
          class="item-price-input w-full h-10 px-3 rounded-lg bg-white border border-slate-300 font-mono-code text-sm text-right font-semibold focus:outline-none focus:border-[#4F6BFF]"
        />
      </div>
    </div>

    <!-- Upload Foto Before & After -->
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
      <div>
        <label class="block text-[11px] font-semibold text-slate-600 mb-1">
          Foto Before ${itemData.before_photo_url ? '<span class="text-emerald-600">(Sudah tersimpan)</span>' : ''}
        </label>
        ${itemData.before_photo_url ? `<a href="${escapeHTML(itemData.before_photo_url)}" target="_blank" rel="noopener noreferrer" class="existing-photo-preview block mb-2"><img src="${escapeHTML(itemData.before_photo_url)}" alt="Foto Before tersimpan" class="w-28 h-20 object-cover rounded-lg border border-slate-200" /><span class="text-[11px] text-slate-500">Foto tersimpan · pilih file baru jika ingin mengganti</span></a>` : ''}
        <input
          type="file"
          accept="image/*"
          data-file="before"
          class="w-full text-xs text-slate-600 file:mr-2.5 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-slate-200 file:text-slate-800 hover:file:bg-slate-300"
        />
      </div>
      <div>
        <label class="block text-[11px] font-semibold text-slate-600 mb-1">
          Foto After ${itemData.after_photo_url ? '<span class="text-emerald-600">(Sudah tersimpan)</span>' : ''}
        </label>
        ${itemData.after_photo_url ? `<a href="${escapeHTML(itemData.after_photo_url)}" target="_blank" rel="noopener noreferrer" class="existing-photo-preview block mb-2"><img src="${escapeHTML(itemData.after_photo_url)}" alt="Foto After tersimpan" class="w-28 h-20 object-cover rounded-lg border border-slate-200" /><span class="text-[11px] text-slate-500">Foto tersimpan · pilih file baru jika ingin mengganti</span></a>` : ''}
        <input
          type="file"
          accept="image/*"
          data-file="after"
          class="w-full text-xs text-slate-600 file:mr-2.5 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-slate-200 file:text-slate-800 hover:file:bg-slate-300"
        />
      </div>
    </div>
  `;

  card.querySelector('.remove-item-btn').addEventListener('click', () => {
    if (formItemsContainer.children.length <= 1) {
      alert('Minimal harus terdapat 1 item pakaian dalam satu order.');
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
    el.textContent = `Item #${idx + 1}`;
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
      result['Catatan'] = pair.trim();
    }
  });
  return result;
}

async function uploadGarmentPhoto(file, orderId, typeLabel) {
  const compressedBlob = await compressImage(file, 1080, 0.8);
  const filePath = `${orderId}/${typeLabel}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 7)}.jpg`;

  const { error: uploadError } = await supabase.storage
    .from(SUPABASE_CONFIG.STORAGE_BUCKET)
    .upload(filePath, compressedBlob, {
      contentType: 'image/jpeg',
      upsert: true,
    });

  if (uploadError) throw uploadError;

  const { data } = supabase.storage
    .from(SUPABASE_CONFIG.STORAGE_BUCKET)
    .getPublicUrl(filePath);

  return data.publicUrl;
}

let customerLookupRequest = 0;

async function findCustomerByPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const { data, error } = await supabase
    .from('customers')
    .select('id, name, phone')
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
    status.textContent = 'Masukkan nomor HP minimal 10 digit.';
    status.className = 'mt-1 text-xs text-slate-500';
    return;
  }

  status.textContent = 'Memeriksa nomor pelanggan...';
  status.className = 'mt-1 text-xs text-slate-500';
  try {
    const customer = await findCustomerByPhone(normalized);
    if (requestId !== customerLookupRequest) return;
    if (customer) {
      status.textContent = `Nomor ini sudah terdaftar dengan nama ${customer.name}.`;
      status.className = 'mt-1 text-xs text-amber-700';
    } else {
      status.textContent = 'Nomor belum terdaftar. Pelanggan baru akan otomatis ditambahkan saat order disimpan.';
      status.className = 'mt-1 text-xs text-emerald-700';
    }
  } catch (error) {
    if (requestId !== customerLookupRequest) return;
    status.textContent = `Pemeriksaan pelanggan gagal: ${error.message || 'Coba lagi.'}`;
    status.className = 'mt-1 text-xs text-rose-600';
  }
}

async function handleSaveOrderSubmit(e) {
  e.preventDefault();
  const submitBtn = document.getElementById('save-order-submit-btn');
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<span>Menyimpan...</span>';
  try {
    const existingOrderId = document.getElementById('form-order-id').value.trim();
    const ticketCode = document.getElementById('form-ticket-code').value.trim().toUpperCase();
    const customerName = document.getElementById('form-customer-name').value.trim();
    const customerPhone = normalizePhone(document.getElementById('form-customer-phone').value);
    const estimatedDate = document.getElementById('form-estimated-date').value || null;
    const notes = document.getElementById('form-notes').value.trim();
    const paidAmount = Number(document.getElementById('form-paid-amount').value || 0);

    if (!ticketCode) throw new Error('Kode tiket wajib diisi.');
    if (!customerName) throw new Error('Nama pelanggan wajib diisi.');
    if (!customerPhone || customerPhone.length < 10) throw new Error('Nomor WhatsApp tidak valid (minimal 10 digit).');
    if (!Number.isFinite(paidAmount) || paidAmount < 0) throw new Error('Nominal pembayaran tidak valid.');

    // Identifikasi pelanggan berdasarkan nomor HP.
    // Jika sudah terdaftar, RPC order akan mengaitkan order ke pelanggan tersebut.
    // Jika belum, RPC order akan membuat record pelanggan baru saat order disimpan.
    const matchedCustomer = await findCustomerByPhone(customerPhone);

    const itemRows = Array.from(formItemsContainer.querySelectorAll('.item-row'));
    if (!itemRows.length) throw new Error('Minimal harus terdapat 1 item pakaian dalam satu order.');

    const orderId = existingOrderId || crypto.randomUUID();

    // Upload foto dilakukan sebelum transaksi DB. URL foto lama dipertahankan bila tidak diganti.
    // Jika transaksi DB gagal, file yang baru diunggah mungkin menjadi file yatim di Storage,
    // tetapi data order dan item lama tidak akan terhapus/berubah sebagian.
    const itemsPayload = [];
    for (const row of itemRows) {
      const garmentName = row.querySelector('[data-field="garment_name"]').value.trim();
      const serviceType = row.querySelector('[data-field="service_type"]').value.trim();
      const specsRaw = row.querySelector('[data-field="measurement_specs"]').value;
      const price = Number(row.querySelector('[data-field="price"]').value || 0);
      if (!garmentName) throw new Error('Nama pakaian pada setiap item wajib diisi.');
      if (!serviceType) throw new Error('Jenis layanan pada setiap item wajib diisi.');
      if (!Number.isFinite(price) || price < 0) throw new Error('Biaya item tidak valid.');

      let beforeUrl = row.dataset.existingBeforeUrl || null;
      let afterUrl = row.dataset.existingAfterUrl || null;
      const beforeFile = row.querySelector('[data-file="before"]').files[0];
      const afterFile = row.querySelector('[data-file="after"]').files[0];
      if (beforeFile) beforeUrl = await uploadGarmentPhoto(beforeFile, orderId, 'before');
      if (afterFile) afterUrl = await uploadGarmentPhoto(afterFile, orderId, 'after');

      itemsPayload.push({
        item_id: row.dataset.itemId || null,
        garment_name: garmentName,
        service_type: serviceType,
        measurement_specs: parseMeasurementSpecs(specsRaw),
        price,
        before_photo_url: beforeUrl,
        after_photo_url: afterUrl,
      });
    }

    const { data: savedOrderId, error: saveError } = await supabase.rpc('save_order_with_items', {
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
    if (!savedOrderId) throw new Error('Database tidak mengembalikan ID order yang tersimpan.');

    clearOrderDraft();
    draftBanner?.classList.add('hidden');
    closeOrderModal();
    await fetchOrders();

    if (!existingOrderId) {
      const totalAmount = itemsPayload.reduce((sum, item) => sum + Number(item.price || 0), 0);
      const remaining = Math.max(0, totalAmount - paidAmount);
      const itemLines = itemsPayload
        .map((item, index) => `${index + 1}. ${item.garment_name} (${item.service_type}) - ${formatCurrency(item.price)}`)
        .join('\n');
      const trackingUrl = `${window.location.origin}/`;
      const receiptMessage =
        `*STRUK DIGITAL — ${workshopSettings.NAME}*\n` +
        `No. Tiket: *${ticketCode}*\n` +
        `Pelanggan: ${customerName}\n` +
        `Target Selesai: ${formatDateID(estimatedDate)}\n\n` +
        `*Detail Layanan:*\n${itemLines}\n\n` +
        `Total: *${formatCurrency(totalAmount)}*\n` +
        `Dibayar: ${formatCurrency(paidAmount)}\n` +
        `Sisa Tagihan: *${formatCurrency(remaining)}*\n\n` +
        `Pantau progres dengan nomor WhatsApp yang terdaftar: ${trackingUrl}\n\n` +
        `Jam Operasional: ${workshopSettings.OPENING_HOURS}\n` +
        `Terima kasih telah mempercayakan perawatan pakaian Anda kepada ${workshopSettings.NAME}.\n\nby MendTrack`;
      const waUrl = buildWhatsAppLink(customerPhone, receiptMessage);
      // Gunakan navigasi langsung yang sama seperti tombol Kirim Nota.
      // Data order sudah tersimpan sebelum browser dialihkan ke WhatsApp.
      window.location.href = waUrl;
    }
  } catch (err) {
    alert('Gagal menyimpan order: ' + err.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<i data-lucide="check" class="w-4 h-4"></i><span>Simpan Order</span>';
    if (window.lucide) window.lucide.createIcons();
  }
}

// ============================================================================
// AUTO-SAVE DRAFT HANDLER (OFFLINE RESILIENCE)
// ============================================================================
const triggerAutoSaveDraft = debounce(() => {
  // Jangan timpa draf jika sedang mode edit order yang sudah ada di DB
  const existingId = document.getElementById('form-order-id')?.value;
  if (existingId) return;

  const items = Array.from(formItemsContainer.querySelectorAll('.item-row')).map((row) => ({
    garment_name: row.querySelector('[data-field="garment_name"]')?.value || '',
    service_type: row.querySelector('[data-field="service_type"]')?.value || '',
    measurement_specs: parseMeasurementSpecs(
      row.querySelector('[data-field="measurement_specs"]')?.value || ''
    ),
    price: Number(row.querySelector('[data-field="price"]')?.value || 0),
  }));

  saveOrderDraft({
    ticket_code: document.getElementById('form-ticket-code')?.value || '',
    customer_name: document.getElementById('form-customer-name')?.value || '',
    customer_phone: document.getElementById('form-customer-phone')?.value || '',
    estimated_done_date: document.getElementById('form-estimated-date')?.value || '',
    notes: document.getElementById('form-notes')?.value || '',
    paid_amount: Number(document.getElementById('form-paid-amount')?.value || 0),
    items,
  });
}, 500);

function checkSavedDraftBanner() {
  const draft = loadOrderDraft();
  if (draft && draft.data && (draft.data.customer_name || draft.data.items?.length)) {
    if (draftSavedTime) {
      draftSavedTime.textContent = `Draf untuk "${
        draft.data.customer_name || draft.data.ticket_code
      }" disimpan pada ${formatDateID(draft.savedAt, true)}`;
    }
    draftBanner?.classList.remove('hidden');
  }
}

// ============================================================================
// KASIR & PELUNASAN PEMBAYARAN (T-4.1)
// ============================================================================
function openPaymentModal(order) {
  if (!paymentModal) return;
  const total = Number(order.total_amount || 0);
  const currentPaid = Number(order.paid_amount || 0);
  const remaining = Math.max(0, total - currentPaid);

  document.getElementById('pay-order-id').value = order.id;
  document.getElementById('pay-modal-ticket').textContent = `${order.ticket_code} — ${order.customer_name}`;
  document.getElementById('pay-total-display').textContent = formatCurrency(total);
  document.getElementById('pay-current-display').textContent = formatCurrency(currentPaid);
  document.getElementById('pay-remaining-display').textContent = formatCurrency(remaining);

  const paidInput = document.getElementById('pay-new-paid-input');
  paidInput.value = remaining;
  payFullQuickBtn.dataset.totalAmount = String(remaining);

  paymentModal.classList.remove('hidden');
  if (window.lucide) window.lucide.createIcons();
}

async function handlePaymentSubmit(e) {
  e.preventDefault();
  const orderId = document.getElementById('pay-order-id').value;
  const newPaidAmount = Number(document.getElementById('pay-new-paid-input').value || 0);
  const payMethod = paymentForm.querySelector('input[name="pay_method"]:checked')?.value || 'Tunai';
  const targetOrder = allOrders.find((o) => o.id === orderId);
  if (!targetOrder) return;
  const remaining = Math.max(0, Number(targetOrder.total_amount || 0) - Number(targetOrder.paid_amount || 0));
  if (!Number.isFinite(newPaidAmount) || newPaidAmount <= 0 || newPaidAmount !== remaining) {
    alert('Nominal pelunasan harus sama persis dengan sisa tagihan: ' + formatCurrency(remaining));
    return;
  }

  const submitBtn = paymentForm.querySelector('[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;
  try {
    const idempotencyKey = `settlement:${orderId}:${crypto.randomUUID()}`;
    const { error } = await supabase.rpc('record_order_payment_v3', {
      p_order_id: orderId,
      p_amount: newPaidAmount,
      p_payment_type: 'pelunasan',
      p_pay_method: payMethod,
      p_note: 'Pelunasan dari daftar order',
      p_idempotency_key: idempotencyKey,
    });
    if (error) throw error;
    paymentModal.classList.add('hidden');
    await fetchOrders();
  } catch (err) {
    alert('Gagal menyimpan pembayaran: ' + err.message);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

// ============================================================================
// CASH MANAGEMENT — manual entries only; order payments are posted by RPC.
// ============================================================================
const cashCategories = {
  income: [['custom','Custom'],['reparasi','Reparasi'],['lain_lain','Lain-lain']],
  expense: [['alat_bahan','Alat dan Bahan'],['operasional','Operasional'],['makan_minum','Makan dan Minum'],['gaji','Gaji'],['lain_lain','Lain-lain']],
};
function updateCashCategoryOptions() {
  const type = document.getElementById('cash-type')?.value || 'income';
  const select = document.getElementById('cash-category');
  if (select) select.innerHTML = cashCategories[type].map(([v,l]) => `<option value="${v}">${l}</option>`).join('');
}
function cashPeriodStart(period) {
  const now = new Date(); const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === 'week') start.setDate(start.getDate() - 6);
  if (period === 'month') start.setDate(1);
  return period === 'all' ? null : start;
}
async function renderCash() {
  const target = document.getElementById('cash-transactions'); if (!target) return;
  target.innerHTML = '<p class="text-sm text-slate-500">Memuat transaksi kas...</p>';
  try {
    const period = document.getElementById('cash-period')?.value || 'week';
    let query = supabase.from('cash_transactions').select('*').order('occurred_at', {ascending:false});
    const start = cashPeriodStart(period);
    if (start) query = query.gte('occurred_at', start.toISOString());
    const {data, error} = await query;
    if (error) throw error;
    const rows = data || [];
    const [{data: allRows, error: allError}] = await Promise.all([supabase.from('cash_transactions').select('transaction_type,amount')]);
    if (allError) throw allError;
    const periodIncome = rows.filter(x=>x.transaction_type==='income').reduce((a,x)=>a+Number(x.amount||0),0);
    const periodExpense = rows.filter(x=>x.transaction_type==='expense').reduce((a,x)=>a+Number(x.amount||0),0);
    const balance = (allRows||[]).reduce((a,x)=>a+(x.transaction_type==='income'?1:-1)*Number(x.amount||0),0);
    document.getElementById('cash-income').textContent = formatCurrency(periodIncome);
    document.getElementById('cash-expense').textContent = formatCurrency(periodExpense);
    document.getElementById('cash-balance').textContent = formatCurrency(balance);
    const labels = Object.fromEntries([...cashCategories.income,...cashCategories.expense]);
    target.innerHTML = rows.length ? rows.map(x=>`<div class="flex items-center justify-between gap-3 py-3 border-b border-slate-100"><div class="min-w-0"><p class="text-sm font-semibold text-slate-800">${escapeHTML(x.description || labels[x.category] || x.category)}</p><p class="text-xs text-slate-500">${formatDateID(x.occurred_at,true)} · ${labels[x.category] || x.category} · ${escapeHTML(x.payment_method || 'Tunai')}${x.order_id ? ' · Order' : ' · Manual'}</p></div><b class="text-sm whitespace-nowrap ${x.transaction_type==='income'?'text-emerald-600':'text-rose-600'}">${x.transaction_type==='income'?'+':'−'}${formatCurrency(x.amount)}</b></div>`).join('') : '<p class="text-sm text-slate-500 py-5 text-center">Belum ada transaksi pada periode ini.</p>';
  } catch(err) { target.innerHTML = `<p class="text-sm text-rose-600">Gagal memuat kas: ${escapeHTML(err.message||'')}</p>`; }
}
function openCashModal() { updateCashCategoryOptions(); document.getElementById('cash-form')?.reset(); updateCashCategoryOptions(); document.getElementById('cash-modal')?.classList.remove('hidden'); }
async function submitCashForm(e) {
  e.preventDefault(); const btn=e.submitter; if(btn) btn.disabled=true;
  try {
    const args = {p_transaction_type:document.getElementById('cash-type').value,p_category:document.getElementById('cash-category').value,p_amount:Number(document.getElementById('cash-amount').value),p_payment_method:document.getElementById('cash-method').value,p_description:document.getElementById('cash-description').value.trim()||null,p_occurred_at:new Date().toISOString()};
    const {error}=await supabase.rpc('add_manual_cash_transaction',args); if(error) throw error;
    document.getElementById('cash-modal').classList.add('hidden'); await renderCash();
  } catch(err) { alert('Gagal menyimpan transaksi kas: '+err.message); }
  finally { if(btn) btn.disabled=false; }
}

// ============================================================================
// DIGITAL RECEIPT / NOTA DIGITAL & KIRIM WA (T-4.3)
// ============================================================================
function openReceiptModal(order) {
  if (!receiptModal || !receiptContent) return;
  currentReceiptOrder = order;

  const items = order.order_items || [];
  const total = Number(order.total_amount || 0);
  const paid = Number(order.paid_amount || 0);
  const remaining = Math.max(0, total - paid);
  const payMeta = PAYMENT_STATUS_META[order.payment_status] || PAYMENT_STATUS_META.unpaid;

  const itemsRowsHTML = items
    .map(
      (it, idx) => `
      <div class="flex justify-between items-start gap-2 py-2 border-b border-dashed border-slate-200">
        <div>
          <p class="font-semibold text-slate-900">${idx + 1}. ${escapeHTML(it.garment_name)}</p>
          <p class="text-xs text-slate-500">${escapeHTML(it.service_type)}</p>
        </div>
        <span class="font-mono-code text-xs font-semibold text-slate-800 shrink-0">${formatCurrency(
          it.price
        )}</span>
      </div>
    `
    )
    .join('');

  receiptContent.innerHTML = `
    <div class="text-center border-b border-slate-200 pb-3">
      ${workshopSettings.LOGO ? `<img src="${workshopSettings.LOGO}" alt="Logo toko" class="w-14 h-14 object-contain mx-auto mb-2">` : ''}
      <h4 class="font-bold text-base tracking-wide text-[#0B1220]">${escapeHTML(workshopSettings.NAME)}</h4>
      <p class="text-[11px] text-slate-500">${escapeHTML(workshopSettings.TAGLINE)}</p>
      <p class="text-[11px] text-slate-500">${escapeHTML(workshopSettings.ADDRESS)}</p>
      <p class="text-[11px] text-slate-500">${escapeHTML(workshopSettings.OPENING_HOURS)}</p>
    </div>

    <div class="grid grid-cols-2 gap-y-1 text-xs">
      <span class="text-slate-500">No. Tiket:</span>
      <span class="font-mono-code font-bold text-right">${escapeHTML(order.ticket_code)}</span>

      <span class="text-slate-500">Pelanggan:</span>
      <span class="font-semibold text-right">${escapeHTML(order.customer_name)}</span>

      <span class="text-slate-500">Tanggal Masuk:</span>
      <span class="text-right">${formatDateID(order.created_at)}</span>

      <span class="text-slate-500">Target Selesai:</span>
      <span class="font-semibold text-right">${formatDateID(order.estimated_done_date)}</span>
    </div>

    <div class="pt-2 border-t border-slate-200">
      <p class="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1">Rincian Layanan</p>
      ${itemsRowsHTML}
    </div>

    <div class="space-y-1 text-xs pt-1">
      <div class="flex justify-between">
        <span class="text-slate-600">Total Tagihan</span>
        <span class="font-mono-code font-bold">${formatCurrency(total)}</span>
      </div>
      <div class="flex justify-between">
        <span class="text-slate-600">Sudah Dibayar</span>
        <span class="font-mono-code text-emerald-700 font-semibold">${formatCurrency(paid)}</span>
      </div>
      <div class="flex justify-between text-sm pt-1.5 border-t border-slate-200">
        <span class="font-bold">Sisa Tagihan</span>
        <span class="font-mono-code font-bold text-[#4F6BFF]">${formatCurrency(remaining)}</span>
      </div>
      <div class="pt-2 text-center">
        <span class="inline-block px-3 py-0.5 rounded-full text-[11px] font-bold border ${
          payMeta.badgeClass
        }">
          STATUS: ${payMeta.label.toUpperCase()}
        </span>
      </div>
    </div>

    <p class="text-[11px] text-center text-slate-400 pt-2 border-t border-dashed border-slate-200">
      Lacak progres dengan nomor WhatsApp terdaftar di:<br/>
      <span class="font-mono-code text-slate-600">${window.location.origin}/</span>
    </p>
  <p class="mt-5 pt-2 border-t border-dashed border-slate-300 text-center text-[10px] text-slate-500">by MendTrack</p>
  `;

  receiptModal.classList.remove('hidden');
  if (window.lucide) window.lucide.createIcons();
}

function handleSendReceiptViaWA() {
  if (!currentReceiptOrder) return;
  const o = currentReceiptOrder;
  const items = o.order_items || [];
  const total = Number(o.total_amount || 0);
  const paid = Number(o.paid_amount || 0);
  const remaining = Math.max(0, total - paid);
  const trackingUrl = `${window.location.origin}/`;

  const itemLines = items
    .map(
      (it, idx) =>
        `${idx + 1}. ${it.garment_name} (${it.service_type}) - ${formatCurrency(it.price)}`
    )
    .join('\n');

  const receiptText =
    `*NOTA DIGITAL — ${workshopSettings.NAME}*\n` +
    `No. Tiket: *${o.ticket_code}*\n` +
    `Pelanggan: ${o.customer_name}\n` +
    `Target Selesai: ${formatDateID(o.estimated_done_date)}\n\n` +
    `*Detail Layanan:*\n${itemLines}\n\n` +
    `Total: *${formatCurrency(total)}*\n` +
    `Dibayar: ${formatCurrency(paid)}\n` +
    `Sisa Tagihan: *${formatCurrency(remaining)}*\n\n` +
    `Pantau status pengerjaan Anda secara live di:\n${trackingUrl}\n\n` +
    `Alamat: ${workshopSettings.ADDRESS}\nJam buka: ${workshopSettings.OPENING_HOURS}\n\n` +
    `Terima kasih telah mempercayakan perawatan denim Anda di ${workshopSettings.NAME}.\n\nby MendTrack`;

  const waUrl = buildWhatsAppLink(o.customer_phone, receiptText);
  // Navigasi pada tab yang sama agar Android/Chrome dapat menyerahkan tautan wa.me
  // langsung ke aplikasi WhatsApp, tanpa membuka halaman perantara di tab baru.
  window.location.href = waUrl;
}
