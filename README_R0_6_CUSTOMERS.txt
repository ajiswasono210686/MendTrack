MENDTRACK R0.6 - CUSTOMER DIRECTORY
Basis: MendTrack R0.5 Customer Integration

Changes:
- Added Pelanggan button in dashboard workload area.
- Added compact one-row customer list: clickable name + WhatsApp number + Edit + Order.
- Clicking customer name opens customer detail modal with transaction count, total transaction value, and transaction history.
- Added Edit customer action with duplicate-phone validation.
- Added Tambah Order action with customer name and phone prefilled.
- Existing R0.5 customer phone lookup and order save integration retained.

Database prerequisites:
- public.customers table
- public.orders.customer_id
- public.normalize_customer_phone(text)
- updated public.save_order_with_items(...)

Notes:
- This release does not implement multi-tenant access isolation.
- Customer list access follows the existing authenticated policy pattern.
- Browser + live Supabase end-to-end testing is still required before production deployment.
