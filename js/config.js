// js/config.js

export const SUPABASE_CONFIG = {
  URL: 'https://ncobbhceczfpxosgszwz.supabase.co',
  ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5jb2JiaGNlY3pmcHhvc2dzend6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUwMDIwMTMsImV4cCI6MjExMDU3ODAxM30.ubndmziwjFh2hfxCG3PYrGxnnddYnhXwHYPGC_3MSao',
  STORAGE_BUCKET: 'garment-photos',
};

export const WORKSHOP_INFO = {
  NAME: 'BRKH DENIM',
  SUBTITLE: 'Mending, Alteration & Custom Apparel',
  ADDRESS: 'Jl. Gajayana 21 B, Malang, Jawa Timur',
  ADMIN_PHONE: '6285648492858', // Format internasional 628...
  TICKET_PREFIX: 'MND',
};

// Tahapan visual stepper untuk pelanggan (5 tahap utama)
export const ORDER_STEPS = [
  {
    key: 'received',
    label: 'Diterima',
    shortLabel: 'Diterima',
    description: 'Item telah diterima dan dicatat oleh workshop.',
    icon: 'package-check',
  },
  {
    key: 'queued',
    label: 'Antrean',
    shortLabel: 'Antrean',
    description: 'Menunggu giliran pengerjaan oleh artisan.',
    icon: 'clock',
  },
  {
    key: 'in_progress',
    label: 'Proses Pengerjaan',
    shortLabel: 'Dikerjakan',
    description: 'Sedang dalam proses jahit, reparasi, atau custom.',
    icon: 'scissors',
  },
  {
    key: 'qc',
    label: 'Quality Check',
    shortLabel: 'QC',
    description: 'Pemeriksaan detail jahitan, ukuran, dan kebersihan akhir.',
    icon: 'shield-check',
  },
  {
    key: 'ready',
    label: 'Selesai / Siap Diambil',
    shortLabel: 'Siap Diambil',
    description: 'Pengerjaan selesai! Silakan ambil di workshop.',
    icon: 'sparkles',
  },
];

// Kamus lengkap seluruh status enum database (termasuk 'completed')
export const STATUS_META = {
  received: {
    label: 'Diterima',
    badgeClass: 'bg-slate-100 text-slate-700 border-slate-300',
    dotClass: 'bg-slate-500',
  },
  queued: {
    label: 'Antrean',
    badgeClass: 'bg-blue-50 text-blue-700 border-blue-200',
    dotClass: 'bg-blue-500',
  },
  in_progress: {
    label: 'Proses Pengerjaan',
    badgeClass: 'bg-amber-50 text-amber-800 border-amber-300',
    dotClass: 'bg-amber-500',
  },
  qc: {
    label: 'Quality Check',
    badgeClass: 'bg-purple-50 text-purple-700 border-purple-200',
    dotClass: 'bg-purple-500',
  },
  ready: {
    label: 'Siap Diambil',
    badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-300',
    dotClass: 'bg-emerald-500',
  },
  completed: {
    label: 'Sudah Diambil',
    badgeClass: 'bg-slate-800 text-slate-100 border-slate-700',
    dotClass: 'bg-slate-900',
  },
};

export const PAYMENT_STATUS_META = {
  unpaid: {
    label: 'Belum Lunas',
    badgeClass: 'bg-rose-50 text-rose-700 border-rose-200',
  },
  partial: {
    label: 'DP / Sebagian',
    badgeClass: 'bg-amber-50 text-amber-800 border-amber-300',
  },
  paid: {
    label: 'Lunas',
    badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
};
