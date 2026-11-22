MENDTRACK R0.9 — PASTEL PALETTE + COLLAPSIBLE SIDEBAR
=====================================================
Visual/layout only. No Supabase schema, RPC, order logic, or existing element IDs changed.

Sidebar (admin.html, js/sidebar.js, css/modern-theme.css)
- Top-left: store logo + brand name + online status (collapsed: logo with a status dot).
- Menu: Order, Pelanggan, Setting (opens existing store settings modal). Log Out sits above the footer.
- Bottom-left: "MendTrack" + light/dark toggle.
- Collapse button on the sidebar edge; choice is remembered (localStorage key mendtrack-sidebar).
- Mobile (<1024px): slim top bar with a menu button; sidebar opens as a drawer.
- Old header menu and bottom navigation removed; their button IDs were reused inside the sidebar.

Palette
- Calm pastel set: lavender/periwinkle, soft sky, mint, butter, peach, rose; soft ink text instead of near-black.
- Buttons, hero, login, modal headers, workload calendar, and the new icon all use pastel fills with deeper tone text.
- Dark mode is a muted slate-indigo, not a deep navy.
- Service worker cache bumped to v7.
