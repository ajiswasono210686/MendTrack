MENDTRACK R0 — PREMIUM THEME FOUNDATION
=======================================
Basis: ordertrack-main(3).zip

Changes in this R0 patch:
- Added css/premium-theme.css (Obsidian & Champagne design tokens and initial dark-mode styling layer).
- Added js/theme-toggle.js (light/dark toggle, local preference storage).
- Added theme toggle control to the admin header and customer tracking header.
- Loaded the shared theme stylesheet on admin.html and index.html.
- Updated service-worker cache version and app shell for the two new assets.

Preservation:
- No Supabase schema, policies, RPCs, data, or production settings changed.
- No existing business-logic JavaScript was edited.
- Existing HTML IDs used by the application were preserved.
- Official baseline ordertrack-main(2).zip was not modified.

Validation performed:
- node --check js/theme-toggle.js: passed.
- node --check sw.js: passed.
- HTML changes were limited to stylesheet/script references and theme toggle buttons.

Important:
This is the first theme-foundation step, not the complete redesign. The calendar dashboard, order-row layout, customer detail card, and overdue badge are not implemented in this patch. Those depend on the workload/order data integration and will be added in separate tested steps.


R0.1 — DAILY WORKLOAD DASHBOARD
================================
Added:
- Monthly Daily Workload calendar below the three existing dashboard summary cards.
- Month navigation, Today shortcut, Monday-first calendar grid, and selected-day detail.
- Workload levels: low (<40%), medium (40–79%), full (80–100%), and over capacity (>100%).
- Workload is calculated by assigning the sum of service estimated_minutes for all order items to estimated_done_date.
- Orders in ready or completed status are excluded immediately from workload totals.
- Daily capacity uses store_settings.daily_capacity_minutes (existing fixed daily capacity setting).
- Unknown/unmatched service names are surfaced as unestimated items and are not silently assigned invented durations.
- Responsive calendar styles support existing light/dark theme.
- Service-worker cache version bumped to v5.

Preservation:
- No database schema, policies, RPCs, production data, or Supabase configuration changed.
- Existing order CRUD, payment, receipt, WhatsApp, tracking, and activity-related code paths were not intentionally changed.
- Existing summary cards, search, filters, and order list remain in place.

Validation:
- node --check js/admin-panel.js: passed.
- node --check js/theme-toggle.js: passed.
- node --check sw.js: passed.
