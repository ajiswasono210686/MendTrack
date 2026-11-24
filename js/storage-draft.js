const DRAFT_STORAGE_KEY = 'mendtrack_admin_order_draft_v1';

export function initConnectionMonitor(badgeElementId = 'connection-badge', onStatusChange = null) {
  const updateUI = () => {
    const isOnline = navigator.onLine;
    const badge = document.getElementById(badgeElementId);

    if (badge) {
      if (isOnline) {
        badge.className = 'mt-badge mt-badge-online';
        badge.innerHTML = '<span class="mt-badge-dot" aria-hidden="true"></span><span>Online</span>';
      } else {
        badge.className = 'mt-badge mt-badge-offline';
        badge.innerHTML = '<span class="mt-badge-dot" aria-hidden="true"></span><span>Offline (Draf Lokal)</span>';
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

export function clearOrderDraft() {
  try {
    localStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch (err) {
    console.warn('Gagal menghapus draf order:', err);
  }
}
