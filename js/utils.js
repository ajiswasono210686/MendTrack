import { WORKSHOP_INFO } from './config.js';
import {
  t,
  getLocale,
  getIntlLocale,
  getCurrency,
  getCurrencyMeta,
  getTimezone,
} from './i18n.js';

const DATE_ONLY_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

export function formatCurrency(amount, options = {}) {
  const num = Number(amount);
  const safeNum = Number.isFinite(num) ? num : 0;
  const currencyCode = options.currency || getCurrency();
  const locale = options.locale || getLocale();
  const meta = getCurrencyMeta(currencyCode);
  const intlLocale = getIntlLocale(locale);

  try {
    return new Intl.NumberFormat(intlLocale, {
      style: 'currency',
      currency: meta.code,
      minimumFractionDigits: meta.decimals,
      maximumFractionDigits: meta.decimals,
    }).format(safeNum);
  } catch (_) {
    return new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: 'IDR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(safeNum);
  }
}

export function formatDate(dateStr, includeTime = false, options = {}) {
  if (!dateStr) return '-';

  const locale = options.locale || getLocale();
  const intlLocale = getIntlLocale(locale);
  const dateOnlyMatch = typeof dateStr === 'string' ? dateStr.trim().match(DATE_ONLY_REGEX) : null;

  let date;
  const formatOptions = {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  };

  if (dateOnlyMatch) {
    // Parse YYYY-MM-DD as a calendar date so negative UTC offsets never shift deadlines by one day.
    const [, y, m, d] = dateOnlyMatch;
    date = new Date(Number(y), Number(m) - 1, Number(d));
  } else {
    date = new Date(dateStr);
    if (includeTime) {
      formatOptions.hour = '2-digit';
      formatOptions.minute = '2-digit';
    }
    const tz = options.timezone || getTimezone();
    if (tz) {
      formatOptions.timeZone = tz;
    }
  }

  if (Number.isNaN(date.getTime())) return String(dateStr);

  try {
    return new Intl.DateTimeFormat(intlLocale, formatOptions).format(date);
  } catch (_) {
    delete formatOptions.timeZone;
    return new Intl.DateTimeFormat(intlLocale, formatOptions).format(date);
  }
}

// Backward-compatible export name used across existing modules.
export const formatDateID = formatDate;

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

export function generateTicketCode(sequenceNumber = null, prefix = WORKSHOP_INFO.TICKET_PREFIX) {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const seq =
    sequenceNumber !== null
      ? String(sequenceNumber).padStart(3, '0')
      : String(Math.floor(100 + Math.random() * 900));
  const safePrefix =
    String(prefix || WORKSHOP_INFO.TICKET_PREFIX || 'MND')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '') || 'MND';

  return `${safePrefix}-${yy}${mm}-${seq}`;
}

export function buildWhatsAppLink(phone, message) {
  const cleanPhone = normalizePhone(phone);
  const encodedText = encodeURIComponent(message || '');
  const webUrl = `https://wa.me/${cleanPhone}?text=${encodedText}`;

  // Android Chrome hands off directly to the WhatsApp app via intent, avoiding an intermediate web hop.
  const isAndroid = /Android/i.test(navigator.userAgent || '');
  if (isAndroid) {
    const intentTarget = `send?phone=${cleanPhone}&text=${encodedText}`;
    const fallback = encodeURIComponent(webUrl);
    return `intent://${intentTarget}#Intent;scheme=whatsapp;package=com.whatsapp;S.browser_fallback_url=${fallback};end`;
  }

  return webUrl;
}

export function escapeHTML(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function debounce(fn, delay = 400) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function compressImage(file, maxWidth = 1080, quality = 0.8) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) {
      reject(new Error(t('image.invalidFile')));
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t('image.readFailed')));
    reader.onload = (event) => {
      const img = new Image();
      img.onerror = () => reject(new Error(t('image.loadFailed')));
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
            if (blob) resolve(blob);
            else reject(new Error(t('image.compressFailed')));
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

export function getDeadlineStatus(estimatedDateStr) {
  if (!estimatedDateStr) {
    return { label: t('deadline.none'), isUrgent: false, isOverdue: false, diffDays: null };
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dateOnlyMatch = typeof estimatedDateStr === 'string' ? estimatedDateStr.trim().match(DATE_ONLY_REGEX) : null;
  const target = dateOnlyMatch
    ? new Date(Number(dateOnlyMatch[1]), Number(dateOnlyMatch[2]) - 1, Number(dateOnlyMatch[3]))
    : new Date(estimatedDateStr);
  target.setHours(0, 0, 0, 0);

  const diffDays = Math.round((target - today) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    return {
      label: t('deadline.overdue', { days: Math.abs(diffDays) }),
      isUrgent: true,
      isOverdue: true,
      diffDays,
    };
  }
  if (diffDays === 0) {
    return { label: t('deadline.today'), isUrgent: true, isOverdue: false, diffDays: 0 };
  }
  if (diffDays === 1) {
    return { label: t('deadline.tomorrow'), isUrgent: true, isOverdue: false, diffDays: 1 };
  }
  return {
    label: t('deadline.inDays', { days: diffDays }),
    isUrgent: false,
    isOverdue: false,
    diffDays,
  };
}
