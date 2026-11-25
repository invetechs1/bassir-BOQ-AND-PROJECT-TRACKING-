# Developer Handover — Three document slots on an expense

**Feature:** when adding an expense there are now three separate, labeled upload slots — **عرض السعر (Quotation)**, **فاتورة المصروف (Invoice)**, **كشف الاستلام (Delivery note)**.
**Branch:** `claude/session-uqllzm`
**Date:** 2026-11-12 · Bassir technical division

---

## The flow

1. The project manager enters the expense and uploads the **عرض السعر (Quotation)**.
2. Owner/management approves and transfers (records the transfer statement in the "المدفوع" step — unchanged).
3. **After the transfer**, the project manager opens the expense (edit) and uploads the **فاتورة المصروف (Invoice)** and the **كشف الاستلام (Delivery note)** that proves the materials were received.

All three are optional at entry and can be added later by editing the expense; the owner sees links to all three in the review dialog before approving/paying.

---

## Files changed (2 files)

| File | Change |
|---|---|
| `expenses/index.js` | New fields `quoteDocs`, `invoiceDocs`, `deliveryDocs`; material-invoice-at-creation requirement removed |
| `public/expenses.html` | Three labeled upload fields; table + review-dialog links; buffers/handlers |

> No DB/schema migration; the new fields are additive. Legacy `docs` is kept and shown as the invoice for old expenses (backward-safe). No new dependencies.

## Backend — `expenses/index.js`

`normalizeExpense` now stores three document arrays (each sanitized by `cleanDocs`, image/PDF, max 15):

```js
quoteDocs:    [{url,name}]   // عرض السعر (Quotation)
invoiceDocs:  [{url,name}]   // فاتورة المصروف (Invoice)
deliveryDocs: [{url,name}]   // كشف الاستلام (Delivery note)
docs:         [{url,name}]   // legacy, kept for old expenses
```

- The old rule "material expense requires an invoice at creation" is **removed** — the invoice now arrives after the transfer, so it cannot be required up front.
- Attachments reuse the existing route `POST /api/projects/:id/photos`.

## Frontend — `public/expenses.html`

- The single "📎 المرفقات" field is replaced by a **"📎 مستندات المصروف"** box with the three labeled file inputs (`pickDocs(input, which)` / `renderDocs` / `removeDoc`, buffers `quotePending` / `invPending` / `delivPending`).
- `openEdit` pre-loads each slot; legacy `docs` are shown under the invoice slot (migrated on save).
- The expenses table shows per-type links: 📋 quotation · 🧾 invoice · 📦 delivery (`docLinks`).
- The owner review dialog lists links to all three so they can be checked before approving/paying.

## Automated test result ✅

- Create a **material** expense with **only a quotation** (no invoice) → succeeds (no longer blocked).
- Edit later to add the invoice + delivery note → persists; the quotation is kept.
- Read-back returns all three sets correctly.

---

*Bassir — expense documents handover. Branch: `claude/session-uqllzm` · 2 files · no DB/schema migration, no new dependencies; restart the Node service after deploy (server.js is part of this branch).*
