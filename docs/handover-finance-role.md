# Developer Handover — Finance role (upload payment voucher only)

**Feature:** a new **Finance (الماليّة)** role — its own username/password — that can log into the expenses page and **only upload the payment voucher / transfer receipt (سند الدفع / صورة الحوالة)** on an approved expense. It cannot enter expenses, approve, or edit anything else.
**Branch:** `claude/session-uqllzm`
**Date:** 2026-11-13 · Bassir technical division

---

## The flow

1. Project manager enters the expense (+ quotation).
2. Owner (client) approves it (full/partial).
3. **Finance** logs in → opens the approved expense → records the paid amount/date/reference and uploads the **سند الدفع / صورة الحوالة**.
4. Project manager later uploads the invoice + delivery note.

The company owner creates the finance user from **"👥 إدارة المستخدمين"** → role **الماليّة (رفع سند الدفع فقط)**.

---

## Permissions summary

| Action | pm | finance | pmo | client (owner) | admin |
|---|---|---|---|---|---|
| Enter/edit an expense | ✅ | ❌ | ✅ | ✅ | ✅ |
| Approve (full/partial) | ❌ | ❌ | ✅ | ✅ | ✅ |
| Record payment + upload سند الدفع | ❌ | ✅ | ❌* | ✅ | ✅ |

*Payment is allowed for the owner/admin and finance; pmo approves but does not pay. Finance can pay **only after** the owner has approved.

---

## Files changed (4 files)

| File | Change |
|---|---|
| `server.js` | New role `finance` (ROLES, canAccessProject, canManageUser, user create/edit) |
| `expenses/index.js` | `canPay()` = admin/client/finance; review endpoint splits approval (canApprove) from payment (canPay) |
| `public/expenses.html` | Finance mode in the review dialog (payment-only, read-only approval); 💳 shown for canPay |
| `public/index.html` | `finance` role label/icon + option in user management; finance is redirected to `/expenses` on login |

> No DB/schema migration. Restart the Node service after deploy (server.js changed). No new dependencies.

## Backend

- `server.js`: `finance` added to `ROLES`; `canAccessProject` grants finance their company's projects; a `client` (owner) can create/manage `finance` users (like pmo/pm).
- `expenses/index.js`:
  - `canPay(user, project)` = access && role ∈ {admin, client, finance}.
  - `GET …/expenses` returns `canPay` and `role`.
  - `POST …/expenses/:expId/review` now checks per-section:
    - approval fields → require `canApprove` (admin/client/pmo).
    - payment fields → require `canPay` (admin/client/finance).
    - payment is still rejected while the expense is `pending` (not yet approved).

## Frontend (`public/expenses.html`)

- The review dialog has a finance mode: the approval section is hidden and replaced by a **read-only approval status** line; only the payment section is shown; the label is **"سند الدفع / صورة الحوالة"** and the title is **"تسجيل الدفع ورفع سند الدفع"**.
- Finance sees no add/edit/delete (not in `canManage`); only the 💳 action.

## Automated test result ✅

- Owner creates a finance user → succeeds (role `finance`).
- Finance `GET expenses`: `canManage=false`, `canApprove=false`, `canPay=true`.
- Finance approve → 403; finance enter-expense → 403; finance pay before approval → 400.
- After the owner approves → finance records the payment + uploads the voucher → 200, approval intact.

---

*Bassir — Finance role handover. Branch: `claude/session-uqllzm` · 4 files · no DB/schema migration; restart the Node service after deploy.*
