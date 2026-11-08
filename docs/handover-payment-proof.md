# Developer Handover — "Payment proof" on expenses

**Feature:** record how much was actually paid for an expense, when, a reference, and attach the transfer proof.
**Branch:** `claude/session-uqllzm`
**Date:** 2026-11-08 · Bassir technical division

---

## TL;DR

Each expense can now carry a **payment proof**: when the user makes a bank transfer they log in, open the expense, enter the paid amount + date + reference and upload the transfer receipt. The expenses table shows a **"Paid"** column (✓ full / partial, with a link to the proof) so the user always knows how much was paid against each expense.

Merged and tested on the branch above — just pull and deploy.

---

## Files changed (2 files)

| File | Change |
|---|---|
| `expenses/index.js` | Backend: new fields on the expense record |
| `public/expenses.html` | Expenses page: payment-proof section in the modal + "Paid" column |

> No database/schema changes. No change to `server.js`. No new dependencies. Backward-safe (old expenses read as unpaid).

---

## Deploy

```bash
git fetch origin
git checkout claude/session-uqllzm   # or merge into your main branch
# restart the Node service
```

Attachments reuse the existing upload route `POST /api/projects/:id/photos` (same as other expense attachments) — no new storage.

---

## Backend — `expenses/index.js` (normalizeExpense)

New fields on each expense:

```js
paidAmount:  Number     // how much was actually paid (0 = unpaid)
paidAt:      'YYYY-MM-DD'// transfer date
paymentRef:  String     // transfer no. / bank / last 4 digits
paymentDocs: [{url,name}]// transfer-proof attachments (image/PDF), max 15
```

- A shared `cleanDocs()` helper sanitizes both `docs` (invoice) and `paymentDocs` (proof).
- Fields are merged on `PUT` (edit), so updating the paid amount keeps the uploaded proof.
- `paymentDocs` does **not** affect the material-invoice requirement (`docs` still required for materials) and does **not** change profitability — it is a reference record only.

## Frontend — `public/expenses.html`

- New **"💳 Payment proof"** section in the add/edit modal: paid amount, transfer date, reference, and a file input for the receipt (`payFilesPicked` / `renderPayFiles`, with its own `payPending` buffer).
- New **"Paid"** column in the table (`paidCell`): shows `✓ <amount>` in green when fully paid, `جزئي <amount>` in amber when partial, plus a 📄/🖼 link to the proof; tooltip shows date + reference.
- `saveExp` uploads the proof files and sends `paidAmount`, `paidAt`, `paymentRef`, `paymentDocs` in the request body.

---

## Automated test result ✅

- Created an expense with full payment (2,000 paid, ref, proof) → persisted and read back correctly.
- Edited to a partial payment (1,200) → amount + ref updated, **proof retained**.
- Created an expense with no payment → safe defaults (`paidAmount=0`, empty proof).

---

*Bassir — payment-proof handover. Branch: `claude/session-uqllzm` · 2 files · no DB or dependency changes.*
