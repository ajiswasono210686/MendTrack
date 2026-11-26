(() => {
  const KEY = 'mendtrack-sidebar';
  const root = document.documentElement;
  const desktop = window.matchMedia('(min-width: 1024px)');
  const $ = (sel) => document.querySelector(sel);
  let lastTrigger = null;

  const tr = (key, fallback) => {
    const api = window.MendTrackI18n;
    return api && typeof api.t === 'function' ? api.t(key) : fallback;
  };

  const syncA11y = () => {
    const collapsed = root.dataset.sidebar === 'collapsed';
    document.querySelectorAll('[data-sidebar-collapse]').forEach((b) => {
      b.setAttribute('aria-expanded', String(!collapsed));
      b.setAttribute(
        'aria-label',
        collapsed
          ? tr('common.expandSidebar', 'Lebarkan menu samping')
          : tr('common.collapseSidebar', 'Ciutkan menu samping')
      );
      b.setAttribute('title', tr('common.toggleSidebarTitle', 'Ciutkan atau lebarkan menu'));
    });
  };

  const setCollapsed = (collapsed) => {
    if (collapsed) root.dataset.sidebar = 'collapsed';
    else delete root.dataset.sidebar;
    try {
      localStorage.setItem(KEY, collapsed ? 'collapsed' : 'expanded');
    } catch (_) {
      // Storage may be unavailable in private browsing.
    }
    syncA11y();
  };

  const setDrawer = (open, restoreFocus = false) => {
    const sidebar = $('#admin-sidebar');
    const wasOpen = sidebar?.classList.contains('is-open');
    sidebar?.classList.toggle('is-open', open);
    $('#sidebar-backdrop')?.classList.toggle('is-open', open);
    document.querySelectorAll('[data-sidebar-open]').forEach((btn) => {
      btn.setAttribute('aria-expanded', String(open));
    });
    if (open) {
      sidebar?.querySelector('button, a')?.focus();
    } else if (wasOpen && restoreFocus && lastTrigger) {
      lastTrigger.focus();
      lastTrigger = null;
    }
  };

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-sidebar-collapse]')) {
      return setCollapsed(root.dataset.sidebar !== 'collapsed');
    }
    const openBtn = e.target.closest('[data-sidebar-open]');
    if (openBtn) {
      lastTrigger = openBtn;
      return setDrawer(true);
    }
    if (e.target.closest('[data-sidebar-close]')) {
      return setDrawer(false, true);
    }
    if (!desktop.matches && e.target.closest('#admin-sidebar .mt-sb-item')) {
      setDrawer(false, false);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#admin-sidebar')?.classList.contains('is-open')) {
      setDrawer(false, true);
    }
  });

  document.addEventListener('mendtrack:localechange', syncA11y);
  desktop.addEventListener?.('change', () => setDrawer(false, false));
  syncA11y();
})();
