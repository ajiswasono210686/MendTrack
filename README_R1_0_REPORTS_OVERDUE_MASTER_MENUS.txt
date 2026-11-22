MENDTRACK R1.0 — REPORTS, OVERDUE BADGE & SEPARATED MASTER MENUS

Basis: R0.9 Pastel Sidebar. Existing Supabase schema and order/payment/measurement data are preserved.

Changes:
- Added sidebar destinations: Jadwal, Kas (placeholder), Laporan, Layanan & Harga, Template Ukuran, Arsip, Setting Toko.
- Moved the existing workload calendar to its own Jadwal page without changing workload calculations.
- Moved existing service catalog controls to Layanan & Harga page.
- Moved existing measurement template controls to Template Ukuran page. Customer measurement records and snapshots are untouched.
- Simplified Setting Toko modal to store identity and daily capacity only.
- Added overdue badge for orders past estimated_done_date unless status is ready/completed.
- Added report cards for order value, current paid amount, receivables, unpaid orders, and most-used services.
- Added Arsip view for completed orders.

Report interpretation:
- Date range is based on orders.created_at.
- Paid amount is current orders.paid_amount; the app does not currently keep a separate dated payment transaction ledger in the selected source, so it is not represented as cash received by day.
- Kas menu is a placeholder; no new cash ledger or database schema is introduced.

No SQL migration required for these UI/report calculations. Existing schema, RPC, order logic, and measurement data are not intentionally changed.

R1.0.1 — ORDER LIST & CASH PREPARATION
- Moved New Order to the first position in the sidebar.
- Added workflow status filter directly below order search: received, queued, in_progress, qc, ready, completed.
- Added reset filters action; clears search, process filter, and selected workload date.
- Added a non-functional Cash preparation page describing the planned cash transaction fields.
- No database migration has been run or embedded. Confirm whether the requested migration means importing legacy BRKH Denim database records into the current MendTrack Supabase project, or creating the new cash-ledger tables in the current project.
