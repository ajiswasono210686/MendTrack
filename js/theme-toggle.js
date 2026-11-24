(() => {
  const KEY = 'mendtrack-theme';
  const root = document.documentElement;
  const meta = document.querySelector('meta[name="theme-color"]');

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
      button.setAttribute('aria-label', dark ? 'Aktifkan mode terang' : 'Aktifkan mode gelap');
      button.setAttribute('aria-pressed', String(dark));
      button.setAttribute('title', dark ? 'Mode terang' : 'Mode gelap');
      button.innerHTML = dark
        ? '<i data-lucide="sun" aria-hidden="true"></i><span class="mt-theme-label">Terang</span>'
        : '<i data-lucide="moon" aria-hidden="true"></i><span class="mt-theme-label">Gelap</span>';
    });
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  };

  const initial = getSaved() === 'dark' ? 'dark' : 'light';
  apply(initial);

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
