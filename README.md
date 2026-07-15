# Order Desk — sales order automation

A small full-stack app (Node/Express + SQLite) implementing:

Inquiry received → Quotation created & sent → LPO received → LPO checked against quotation → Customer ledger & payment terms checked → Sales order issued

## Run it

```
npm install
npm run seed      # loads 4 demo customers (one blocked, one on watch, two good)
npm start
```

Open http://localhost:3000

The database is a single file at `db/sales_orders.db` (SQLite). Delete it and re-run `npm run seed` to reset.

## How the workflow is enforced

- **Quotation lock-in**: a quotation must be explicitly "sent" before an LPO can be checked against it. Once sent, its items/terms/total are the frozen reference — the app never re-derives them from the LPO.
- **LPO matching (`logic.js` → `matchLpoToQuotation`)**: compares customer name, every line item (product, quantity, unit price, line total), grand total, delivery terms, and payment terms. Any difference — including a product on the LPO that was never quoted, or one missing from it — flags the LPO and **blocks** the financial check and order issuance at the API level, not just in the UI.
- **Resolving a flag**: either resubmit a corrected LPO (re-runs the same check) or have someone approve an override, which requires an approver name and reason and is written to the audit log — never a silent bypass.
- **Ledger & credit check (`logic.js` → `checkCustomerLedger`)**: fails (goes `on hold`) if the customer is credit-blocked, if outstanding balance + this order's total would exceed their credit limit, or if the LPO's payment terms don't match what's approved for that customer. "Watch" status is surfaced as a warning but isn't a hard block on its own.
- **Sales order issuance**: only allowed once match status is `matched`/`approved_override` **and** financial status is `pass`. Each LPO can only produce one sales order.
- **Audit trail**: every state transition (inquiry logged, quotation sent, LPO matched/flagged, override approved, financial pass/hold, order issued) is written to `audit_log` — visible under the "Audit log" tab.

## Data model

`customers → inquiries → inquiry_items`, `inquiries → quotations → quotation_items`, `quotations → lpos → lpo_items`, `lpos → sales_orders`, plus `audit_log`. See `db/database.js` for the full schema.

## Extending it

- Swap SQLite for Postgres by replacing `db/database.js` — the rest of the app talks to `db` through `better-sqlite3`'s synchronous API, so the query surface would need `async/await` if you switch drivers.
- The price list is entered manually when building a quotation (`target_price` on the inquiry, `unit_price` on the quotation form). Wire in a real product/price table if you want it looked up automatically.
- Notifications (email/Slack) aren't wired in — the natural hook is inside `runMatchCheck`, `check-financials`, and `issue-order` in `server.js`, right after each `logAudit` call.
