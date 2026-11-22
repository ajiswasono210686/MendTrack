// js/storage-draft.js

const DRAFT_STORAGE_KEY = 'mendtrack_admin_order_draft_v1';

/**
 * Memantau status koneksi internet (online/offline) dan memperbarui elemen badge UI
 * @param {string} badgeElementId - ID elemen HTML indikator status koneksi
 * @param {Function} [onStatusChange] - Callback opsional (isOnline: boolean)
 */
export function initConnectionMonitor(badgeElementId = 'connection-badge', onStatusChange = null) {
  const updateUI = () => {
    const isOnline = navigator.onLine;
    const badge = document.getElementById(badgeElementId);

    if (badge) {
      if (isOnline) {
        badge.className =
          'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/15 text-emerald-300 border border-emerald-500/30';
        badge.innerHTML =
          '<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span><span>Online</span>';
      } else {
        badge.className =
          'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-rose-500/20 text-rose-300 border border-rose-500/40';
        badge.innerHTML =
          '<span class="w-2 h-2 rounded-full bg-rose-400"></span><span>Offline (Draf Lokal)</span>';
      }
    }

    if (typeof onStatusChange === 'function') {
      onStatusChange(isOnline);
    }
  };

  window.addEventListener('online', updateUI);
  window.addEventListener('offline', updateUI);
  updateUI();

  return () => {
    window.removeEventListener('online', updateUI);
    window.removeEventListener('offline', updateUI);
  };
}

/**
 * Simpan draf form order admin ke localStorage
 */
export function saveOrderDraft(draftData) {
  try {
    const payload = {
      savedAt: new Date().toISOString(),
      data: draftData,
    };
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch (err) {
    console.warn('Gagal menyimpan draf order ke localStorage:', err);
    return false;
  }
}

/**
 * Ambil draf form order dari localStorage (jika ada)
 */
export function loadOrderDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.data ? parsed : null;
  } catch (err) {
    console.warn('Gagal membaca draf order:', err);
    return null;
  }
}

/**
 * Hapus draf setelah order berhasil disimpan ke Supabase
 */
export function clearOrderDraft() {
  try {
    localStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch (err) {
    console.warn('Gagal menghapus draf order:', err);
  }
}
