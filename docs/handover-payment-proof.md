# Developer Handover — Expense approval + payment proof

**Feature:** a proper expense lifecycle — the project manager enters the expense, the **owner approves it (full/partial)**, then records the payment and uploads the **bank transfer statement**. Entry and approval/payment are strictly separated by role.
**Branch:** `claude/session-uqllzm`
**Date:** 2026-11-08 · Bassir technical division

---

## The workflow

1. **Project manager (pm)** enters the expense. The add-expense form has **no** approval or payment fields — that is not the PM's concern.
2. **Owner / management (client, pmo, admin)** opens the expense's **"💳 اعتماد ودفع"** dialog and **approves** it — **full** (whole amount) or **partial** (a smaller approved amount).
3. Finance transfers from the bank and sends back the transfer statement.
4. The owner opens the same dialog and records the **paid amount + date + reference** and uploads the **transfer statement (كشف التحويل)** — in the **"الاعتماد والدفع"** column of the expense they approved.

The PM never sees or touches approval/payment; the owner never uses the add-expense form.

---

## Files changed (2 files)

| File | Change |
|---|---|
| `expenses/index.js` | Backend: approval + payment fields, a role gate, and a `/review` endpoint |
| `public/expenses.html` | Expenses page: approve/pay dialog (owner-only) + status column; payment removed from the add-expense form |

> No database/schema changes. No change to `server.js`. No new dependencies. Backward-safe (old expenses read as `pending`, unpaid).

---

## Deploy

```bash
git fetch origin
git checkout claude/session-uqllzm   # or merge into your main branch
# restart the Node service
```

Attachments reuse the existing route `POST /api/projects/:id/photos` — no new storage.

---

## Backend — `expenses/index.js`

New fields on each expense (`normalizeExpense`):

```js
approvalStatus: 'pending' | 'approved_full' | 'approved_partial'
approvedAmount: Number        // = total when full, the approved sum when partial
approvedBy:     String         // owner name, set on approval
approvedAt:     'YYYY-MM-DD'
paidAmount:     Number         // actually transferred (0 = unpaid)
paidAt:         'YYYY-MM-DD'    // transfer date
paymentRef:     String         // transfer no. / bank / last 4 digits
paymentDocs:    [{url,name}]    // transfer statement (كشف التحويل), image/PDF, max 15
```

Role gate:

```js
canApprove(user, project) = access && role ∈ {admin, client, pmo}   // NOT pm
```

Enforcement:
- **POST** (create, PM allowed): approval + payment are always forced to `pending` / empty — a PM cannot preset them.
- **PUT** (edit core fields, PM allowed): approval + payment are preserved from the stored record — editing the description/amount never changes them.
- **POST `/api/projects/:id/expenses/:expId/review`** (new, `canApprove` only → `403` for pm):
  - Approval: `approved_full` sets `approvedAmount = total`; `approved_partial` validates `0 < approvedAmount ≤ total`; stamps `approvedBy`/`approvedAt`.
  - Payment: rejected with `400` while the expense is still `pending`; otherwise saves `paidAmount`, `paidAt`, `paymentRef`, `paymentDocs`.
- `GET …/expenses` now returns `canApprove` so the UI can show/hide the owner controls.

> Reference-only for now: approval/payment do **not** change profitability (project cost still uses the entered pre-VAT `amount`). Can be revisited if you want cost to follow the approved amount.

## Frontend — `public/expenses.html`

- Payment fields **removed** from the add-expense modal (PM form); a one-line hint explains the owner approves then uploads the statement.
- New owner-only **"اعتماد ودفع"** dialog (`openReview`/`saveReview`): approval radios (full/partial + approved amount) and the payment section (amount, date, reference, transfer-statement upload). Payment section is disabled until an approval is chosen.
- New **"الاعتماد والدفع"** column (`paidCell`): `⏳ بانتظار الاعتماد` (amber) / `معتمد كلي ✓` (green) / `معتمد جزئي <amount>` (blue), plus a second line `💰 دُفع <amount>` with a 📄/🖼 link to the statement, or `لم يُدفع بعد`.
- A **💳** action button opens the dialog — shown only when `canApprove`.

---

## Automated test result ✅

- PM creates an expense → `pending`, no approval/payment preset.
- PM calls `/review` → **403**; PM presets approval via POST → **ignored** (stays pending).
- Owner pays before approving → **400**.
- Owner approves **partial 2,500**; partial > total → **400**.
- Owner records payment + statement → saved, approval kept.
- PM edits the description → approval + payment **preserved**.
- `canApprove`: admin `true`, pm `false`.

---

*Bassir — expense approval + payment-proof handover. Branch: `claude/session-uqllzm` · 2 files · no DB or dependency changes.*
