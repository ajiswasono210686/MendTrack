const DRAFT_STORAGE_PREFIX = 'mendtrack_admin_order_draft_v1';

function getDraftStorageKey(tenantId) {
  const id = String(tenantId || '').trim();
  return id ? `${DRAFT_STORAGE_PREFIX}:${id}` : null;
}

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

export function saveOrderDraft(draftData, tenantId) {
  const key = getDraftStorageKey(tenantId);
  if (!key) return false;
  try {
    const payload = {
      savedAt: new Date().toISOString(),
      data: draftData,
    };
    localStorage.setItem(key, JSON.stringify(payload));
    return true;
  } catch (err) {
    console.warn('Gagal menyimpan draf order ke localStorage:', err);
    return false;
  }
}

export function loadOrderDraft(tenantId) {
  const key = getDraftStorageKey(tenantId);
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.data ? parsed : null;
  } catch (err) {
    console.warn('Gagal membaca draf order:', err);
    return null;
  }
}

export function clearOrderDraft(tenantId) {
  const key = getDraftStorageKey(tenantId);
  if (!key) return;
  try {
    localStorage.removeItem(key);
  } catch (err) {
    console.warn('Gagal menghapus draf order:', err);
  }
}
