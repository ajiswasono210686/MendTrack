/* MendTrack sidebar: collapse on desktop (remembered), drawer on mobile. UI only. */
(() => {
  const KEY = 'mendtrack-sidebar';
  const root = document.documentElement;
  const desktop = window.matchMedia('(min-width: 1024px)');
  const $ = (sel) => document.querySelector(sel);

  const syncA11y = () => {
    const collapsed = root.dataset.sidebar === 'collapsed';
    document.querySelectorAll('[data-sidebar-collapse]').forEach((b) => {
      b.setAttribute('aria-expanded', String(!collapsed));
      b.setAttribute('aria-label', collapsed ? 'Lebarkan menu' : 'Ciutkan menu');
    });
  };
  const setCollapsed = (collapsed) => {
    if (collapsed) root.dataset.sidebar = 'collapsed'; else delete root.dataset.sidebar;
    try { localStorage.setItem(KEY, collapsed ? 'collapsed' : 'expanded'); } catch (_) { /* storage may be blocked */ }
    syncA11y();
  };
  const setDrawer = (open) => {
    $('#admin-sidebar')?.classList.toggle('is-open', open);
    $('#sidebar-backdrop')?.classList.toggle('is-open', open);
  };

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-sidebar-collapse]')) return setCollapsed(root.dataset.sidebar !== 'collapsed');
    if (e.target.closest('[data-sidebar-open]')) return setDrawer(true);
    if (e.target.closest('[data-sidebar-close]')) return setDrawer(false);
    if (!desktop.matches && e.target.closest('#admin-sidebar .mt-sb-item')) setDrawer(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setDrawer(false); });
  desktop.addEventListener?.('change', () => setDrawer(false));
  syncA11y();
})();
