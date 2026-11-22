MENDTRACK R1.1 — PAYMENT & CASH MANAGEMENT

Basis: R1.0.1 Cash Filter UI package. Existing pages and baseline features are retained.

Implemented in this app package:
- New Order retains the DP field. The matching database function save_order_with_items records a non-zero DP as one order_payments row and one cash_transactions income row. Editing an existing order does not create another payment.
- Order list shows a Pelunasan button only when remaining balance is greater than zero. The app calls record_order_payment_v3 with the new payment amount, payment type pelunasan, selected method, and a fresh idempotency key. Partial settlement is rejected; amount must equal remaining balance.
- Completing/collecting an order no longer changes paid_amount.
- Cash page has period filter (today, last 7 days, this month, all time), all-time balance, period income/expense summaries, transaction list, and Tambah Kas form.
- Manual cash uses add_manual_cash_transaction. Categories are the approved income/expense categories. Do not manually re-enter DP or settlement in Tambah Kas.

Database prerequisite:
- The matching MENDTRACK_R1_1_CASH_FINAL.sql must have completed successfully.
- Expected RPCs: record_order_payment_v3(uuid,numeric,text,text,text,text), add_manual_cash_transaction(text,text,numeric,text,text,timestamptz), and updated save_order_with_items(uuid,text,text,text,date,text,numeric,jsonb).

Important:
- No installment workflow is included.
- This package has passed JavaScript syntax checks and static HTML ID checks only. It has not been connected to or end-to-end tested against the user's Supabase project. Test with a disposable order before production deployment.
