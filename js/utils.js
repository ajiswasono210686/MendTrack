// js/utils.js
import { WORKSHOP_INFO } from './config.js';

/**
 * Format angka ke mata uang Rupiah (contoh: Rp 150.000)
 */
export function formatCurrency(amount) {
  const num = Number(amount) || 0;
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(num);
}

/**
 * Format tanggal ISO/DATE ke format Indonesia (contoh: Sen, 16 Nov 2026)
 */
export function formatDateID(dateStr, includeTime = false) {
  if (!dateStr) return '-';
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return dateStr;

  const options = {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  };

  if (includeTime) {
    options.hour = '2-digit';
    options.minute = '2-digit';
  }

  return new Intl.DateTimeFormat('id-ID', options).format(date);
}

/**
 * Normalisasi nomor HP Indonesia ke format internasional 628...
 */
export function normalizePhone(rawPhone) {
  if (!rawPhone) return '';
  let digits = String(rawPhone).replace(/[^0-9]/g, '');

  if (digits.startsWith('0')) {
    digits = '62' + digits.slice(1);
  } else if (digits.startsWith('8')) {
    digits = '62' + digits;
  }

  return digits;
}

/**
 * Generate kode tiket otomatis format MND-YYMM-XXX
 * @param {number} sequenceNumber - Urutan tiket bulan ini (default random 3 digit jika belum dihitung)
 */
export function generateTicketCode(sequenceNumber = null) {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const seq =
    sequenceNumber !== null
      ? String(sequenceNumber).padStart(3, '0')
      : String(Math.floor(100 + Math.random() * 900));

  return `${WORKSHOP_INFO.TICKET_PREFIX}-${yy}${mm}-${seq}`;
}

/**
 * Buat tautan WhatsApp Click-to-Chat (wa.me)
 */
export function buildWhatsAppLink(phone, message) {
  const cleanPhone = normalizePhone(phone);
  const encodedText = encodeURIComponent(message || '');
  const webUrl = `https://wa.me/${cleanPhone}?text=${encodedText}`;

  // Android Chrome: gunakan Intent agar langsung menyerahkan pesan ke aplikasi WhatsApp,
  // bukan membuka halaman perantara api.whatsapp.com.
  const isAndroid = /Android/i.test(navigator.userAgent || '');
  if (isAndroid) {
    const intentTarget = `send?phone=${cleanPhone}&text=${encodedText}`;
    const fallback = encodeURIComponent(webUrl);
    return `intent://${intentTarget}#Intent;scheme=whatsapp;package=com.whatsapp;S.browser_fallback_url=${fallback};end`;
  }

  // iOS dan desktop tetap memakai tautan Click-to-Chat standar.
  return webUrl;
}

/**
 * Escape karakter HTML untuk keamanan rendering teks input user
 */
export function escapeHTML(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Debounce helper untuk menunda eksekusi fungsi (misal auto-save draft / search)
 */
export function debounce(fn, delay = 400) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

/**
 * Kompresi gambar di browser menggunakan HTML5 Canvas sebelum upload ke Supabase Storage
 * @param {File} file - File gambar asli dari input kamera/galeri
 * @param {number} maxWidth - Lebar maksimal piksel (default 1080px)
 * @param {number} quality - Kualitas JPEG 0.1 - 1.0 (default 0.8)
 * @returns {Promise<Blob>}
 */
export function compressImage(file, maxWidth = 1080, quality = 0.8) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) {
      reject(new Error('File bukan gambar yang valid.'));
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Gagal membaca file gambar.'));
    reader.onload = (event) => {
      const img = new Image();
      img.onerror = () => reject(new Error('Gagal memuat gambar untuk kompresi.'));
      img.onload = () => {
        let { width, height } = img;

        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob(
          (blob) => {
            if (blob) {
              resolve(blob);
            } else {
              reject(new Error('Gagal mengompresi gambar.'));
            }
          },
          'image/jpeg',
          quality
        );
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Hitung selisih hari dari hari ini ke tanggal deadline
 */
export function getDeadlineStatus(estimatedDateStr) {
  if (!estimatedDateStr) {
    return { label: 'Tanpa Deadline', isUrgent: false, isOverdue: false, diffDays: null };
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const target = new Date(estimatedDateStr);
  target.setHours(0, 0, 0, 0);

  const diffDays = Math.round((target - today) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    return {
      label: `Terlambat ${Math.abs(diffDays)} hari`,
      isUrgent: true,
      isOverdue: true,
      diffDays,
    };
  }
  if (diffDays === 0) {
    return { label: 'Deadline Hari Ini', isUrgent: true, isOverdue: false, diffDays: 0 };
  }
  if (diffDays === 1) {
    return { label: 'Besok (H-1)', isUrgent: true, isOverdue: false, diffDays: 1 };
  }
  return {
    label: `${diffDays} hari lagi`,
    isUrgent: false,
    isOverdue: false,
    diffDays,
  };
}
