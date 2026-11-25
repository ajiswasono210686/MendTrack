export const SUPABASE_CONFIG = {
  URL: 'https://ncobbhceczfpxosgszwz.supabase.co',
  ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5jb2JiaGNlY3pmcHhvc2dzend6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUwMDIwMTMsImV4cCI6MjExMDU3ODAxM30.ubndmziwjFh2hfxCG3PYrGxnnddYnhXwHYPGC_3MSao',
  STORAGE_BUCKET: 'garment-photos',
};

export const WORKSHOP_INFO = {
  NAME: 'MendTrack',
  SUBTITLE: 'Reparasi, Vermak & Custom Pakaian',
  ADDRESS: '',
  ADMIN_PHONE: '',
  TICKET_PREFIX: 'MND',
};

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
    description: 'Menunggu giliran pengerjaan di meja reparasi.',
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
    label: 'Siap Diambil',
    shortLabel: 'Siap Diambil',
    description: 'Pengerjaan selesai. Silakan ambil di workshop.',
    icon: 'shopping-bag',
  },
];

export const STATUS_META = {
  received: {
    label: 'Diterima',
    badgeClass: 'mt-badge mt-badge-received',
    dotClass: 'mt-badge-dot',
  },
  queued: {
    label: 'Antrean',
    badgeClass: 'mt-badge mt-badge-queued',
    dotClass: 'mt-badge-dot',
  },
  in_progress: {
    label: 'Proses Pengerjaan',
    badgeClass: 'mt-badge mt-badge-in_progress',
    dotClass: 'mt-badge-dot',
  },
  qc: {
    label: 'Quality Check',
    badgeClass: 'mt-badge mt-badge-qc',
    dotClass: 'mt-badge-dot',
  },
  ready: {
    label: 'Siap Diambil',
    badgeClass: 'mt-badge mt-badge-ready',
    dotClass: 'mt-badge-dot',
  },
  completed: {
    label: 'Sudah Diambil',
    badgeClass: 'mt-badge mt-badge-completed',
    dotClass: 'mt-badge-dot',
  },
};

export const PAYMENT_STATUS_META = {
  unpaid: {
    label: 'Belum Lunas',
    badgeClass: 'mt-badge mt-badge-unpaid',
  },
  partial: {
    label: 'DP / Sebagian',
    badgeClass: 'mt-badge mt-badge-partial',
  },
  paid: {
    label: 'Lunas',
    badgeClass: 'mt-badge mt-badge-paid',
  },
};
