(() => {
  const KEY = 'mendtrack-theme';
  const root = document.documentElement;
  const meta = document.querySelector('meta[name="theme-color"]');

  const tr = (key, fallback) => {
    const api = window.MendTrackI18n;
    return api && typeof api.t === 'function' ? api.t(key) : fallback;
  };

  const getSaved = () => {
    try {
      return localStorage.getItem(KEY);
    } catch (_) {
      return null;
    }
  };

  const apply = (theme) => {
    const selected = theme === 'dark' ? 'dark' : 'light';
    root.dataset.theme = selected;
    if (meta) meta.setAttribute('content', selected === 'dark' ? '#101623' : '#F5F2EB');
    document.querySelectorAll('[data-mt-theme-toggle]').forEach((button) => {
      const dark = selected === 'dark';
      button.setAttribute(
        'aria-label',
        dark ? tr('common.enableLight', 'Aktifkan mode terang') : tr('common.enableDark', 'Aktifkan mode gelap')
      );
      button.setAttribute('aria-pressed', String(dark));
      button.setAttribute(
        'title',
        dark ? tr('common.lightModeTitle', 'Mode terang') : tr('common.darkModeTitle', 'Mode gelap')
      );
      button.innerHTML = dark
        ? `<i data-lucide="sun" aria-hidden="true"></i><span class="mt-theme-label">${tr('common.light', 'Terang')}</span>`
        : `<i data-lucide="moon" aria-hidden="true"></i><span class="mt-theme-label">${tr('common.dark', 'Gelap')}</span>`;
    });
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  };

  const initial = getSaved() === 'dark' ? 'dark' : 'light';
  apply(initial);

  document.addEventListener('mendtrack:localechange', () => {
    apply(root.dataset.theme === 'dark' ? 'dark' : 'light');
  });

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-mt-theme-toggle]');
    if (!button) return;
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    apply(next);
    try {
      localStorage.setItem(KEY, next);
    } catch (_) {
      // Storage may be blocked in private browsing.
    }
  });
})();
