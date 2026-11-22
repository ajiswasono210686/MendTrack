MENDTRACK R0.7 - CUSTOMER MEASUREMENTS + BOTTOM NAVIGATION

Based on uploaded MendTrack R0.6 Customer Menu ZIP.

Changes:
- Bottom navigation with Order and Pelanggan.
- Removed old Pelanggan shortcut next to Tambah Order below the workload calendar.
- Customer detail is simplified to name, phone, List Ukuran, and Riwayat Order.
- Customer measurement collections support garment type, model, description/pemakai, flexible JSONB measurement values, and saved template snapshot.
- Measurement templates and their fields can be managed in Setting Toko > Template Ukuran.
- Templates support add garment type, add/edit/activate/deactivate fields, and activate/deactivate garment templates.
- Existing order/customer flows and legacy measurement_specs in order_items are preserved.

Database prerequisite:
Run MENDTRACK_R07_MEASUREMENT_TEMPLATES_FIXED.sql successfully before using the new measurement features.

Important:
- A customer account can hold measurements for multiple wearers. Use Keterangan / Pemakai to label each set (e.g. Budi, Ani, Andi).
- Editing a template does not rewrite saved records; template_snapshot stores the field labels/units used when the measurement was saved.
- Browser and live Supabase end-to-end testing is required before production deployment.


R0.7 CUSTOMER ENTRY UPDATE
- Customer creation is available from both the Orders page and Customers page.
- A customer record is valid with only two required fields: name and phone number.
- The standalone Add Customer form does not require an order, garment, measurement, or address.
- Existing order creation flow remains unchanged: customer name and phone are entered in the order form, and the existing save_order_with_items RPC continues to handle order persistence/customer linkage.
- Duplicate phone numbers are blocked in the standalone Add Customer form; use the existing customer record instead.


CUSTOMER FLOW CLARIFICATION
- No standalone Add Customer action or form is shown on the Orders or Customers pages.
- Customer identity is entered only in the existing Order form using customer name and phone.
- As the phone number is entered, the app checks the customers table:
  - Existing phone: show "Nomor ini sudah terdaftar dengan nama [name]."
  - New phone: show that the new customer will be added automatically when the order is saved.
- The existing save_order_with_items RPC remains the single path for saving an order and its customer linkage/creation.
- The customer is therefore not created before the order is saved.
