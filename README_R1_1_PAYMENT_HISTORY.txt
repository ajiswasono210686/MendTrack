MENDTRACK R1.1 — PAYMENT HISTORY & CASH APP UPDATE

Basis: MendTrack_R1_0_1_OrderFilter_CashPrep.zip

APP CHANGES
- Removed DP/payment amount from the New/Edit Order form.
- New orders start with paid_amount = 0; edits preserve the current paid_amount.
- Added a Bayar action on each order card.
- Payment modal records the NEW amount received, not a cumulative total.
- Payment type: DP, Cicilan, Pelunasan.
- Payment method: Tunai, Transfer, QRIS, Lainnya.
- Payment modal displays order_payments history.
- Payment submit calls record_order_payment_v3 with a client idempotency key.
- Marking an order completed no longer changes paid_amount or payment_status.

DATABASE DEPLOYMENT ORDER
1. The previously deployed MENDTRACK_R1_1_PAYMENT_HISTORY_SCHEMA.sql must already be installed.
2. Run MENDTRACK_R1_1_PAYMENT_APP_PATCH.sql in Supabase SQL Editor.
3. Verify record_order_payment_v3 and order_payments.idempotency_key exist.
4. Deploy this app package to the same Vercel project.

IMPORTANT
- Do not deploy this app before running the app patch SQL. The app calls record_order_payment_v3.
- Existing paid_amount values are preserved but are not fabricated into dated order_payments or cash history.
- Payment history only includes payments entered after R1.1 rollout.
- Test on a non-critical order first: DP, additional installment, final payment, retry behavior, and completed status while unpaid.
- Take a database backup before production deployment.
