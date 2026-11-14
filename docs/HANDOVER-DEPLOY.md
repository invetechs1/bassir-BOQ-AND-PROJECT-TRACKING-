# Developer Handover — Deploy to Live

**Branch to deploy:** `claude/session-uqllzm`
**Repo:** `invetechs1/bassir-BOQ-AND-PROJECT-TRACKING-`
**Date:** 2026-11-12 · Bassir technical division

This is the single document to deploy all the work on the branch. Each feature was tested; details and per-feature notes are in the other files under `docs/`.

---

## How to deploy

```bash
git fetch origin
git checkout claude/session-uqllzm        # or merge it into your main branch
npm install                               # no new dependencies, safe to run
# restart the Node service (pm2 restart / systemctl restart ...)
```

- **`server.js` changed** → a real **service restart** is required (not just a browser refresh).
- Front-end files (`public/…`) are static → users should hard-refresh (Ctrl/Cmd+Shift+R).
- **No database/schema migration.** Storage stays as the existing JSON files; new data is additive and backward-safe (old records read with safe defaults).
- **No new npm dependencies.**

> Repo note: GitHub reports the repository moved to `bassir-BOQ-AND-PROJECT-TRACKING-`. Pushes still work via redirect; consider `git remote set-url origin https://github.com/invetechs1/bassir-BOQ-AND-PROJECT-TRACKING-.git`.

---

## Files changed

| File | What |
|---|---|
| `expenses/index.js` | **New module** — Project Costs / Expenses + profitability + approval/payment + expense documents |
| `public/expenses.html` | **New page** — expenses UI (entry, approve/pay, charge-to, proof, 3 document slots) |
| `public/index.html` | Expenses menu entry; sub-certificate payments (edit/delete, dates, print); decimal prices; Finance role in user management; subcontractor contract + approval |
| `server.js` | Owner-only guard for sub-certificate approve/pay; new `finance` role; owner-only subcontractor approval |
| `saas/index.js`, `saas/tap.js` | Tap recurring (merchant-initiated) hardening |
| `public/saas/billing.html`, `public/saas/owner.html` | Gregorian (Miladi) dates |
| `docs/…` | Handover docs + a demo video |

The Expenses module is **mounted from `server.js`** and is additive — it does not change the existing certificate/BOQ flows.

---

## What shipped (by feature)

### 1. Project Costs / Expenses module + profitability
A new page (menu: **💵 المصاريف والربحية**) where costs are tracked and compared to approved productivity, with a clear **profit/loss verdict**. It **feeds** the data; it is cost-tracking, not accounting. Any project manager can enter their project's expenses and see the verdict. Materials require a supplier tax invoice; subcontractor cost is aggregated automatically.
*Details: this file + `docs/handover-subcharge-expense.md`.*

### 2. Charge an expense to a subcontractor (auto-deduct)
When logging an expense you pick **ذاتي (own)** or **مقاول باطن (sub)**. A sub-charged expense is excluded from project cost and is **auto-deducted from that subcontractor's certificate** (with a "عليه كذا" notice), then marked settled so it is never deducted twice.
- Routes: `GET /api/projects/:id/sub-charges`, `POST …/sub-charges/settle`.
*Details: `docs/handover-subcharge-expense.md` (+ Arabic PDF).*

### 3. Expense approve-then-pay workflow (by role)
Correct sequence and separation of duties:
- **Project manager** enters the expense (no approval/payment fields on that form).
- **Owner/management** approves it **full or partial**, then records the payment and uploads the **bank transfer statement**.
- Route: `POST /api/projects/:id/expenses/:expId/review` (owner/management only; `403` for pm). Payment is rejected until approved.
*Details: `docs/handover-payment-proof.md`. Demo: `docs/videos/Bassir-Expense-Approval-Workflow.mp4`.*

### 4. Gregorian (Miladi) dates on subscription pages
`ar-SA` defaults to the Hijri calendar in browsers; pinned to Gregorian (`ar-SA-u-ca-gregory-nu-latn`) on the billing/owner pages. The rest of the app already stores/shows ISO Gregorian dates.

### 5. Decimal unit prices (10.5 no longer shown as 11)
Subcontractor/catalog unit prices were displayed rounded to a whole number. The value was always stored correctly; the display now uses 2 decimals (`fmtRate`).
*Details: `docs/handover-decimal-rate-fix.md`.*

### 6. Subcontractor-certificate payments: edit, dates, print, owner-only
On a subcontractor certificate:
- **Edit/delete** any recorded payment (e.g. change 10,000 → 8,000); totals and status (`paid` ⇄ `approved`) recompute.
- **Payment dates are shown** everywhere — the "المدفوع" column lists each payment as `📅 <date>: <amount>`, plus in the dialog and on the printed certificate ("الدفعات المصروفة للمقاول").
- **Owner-only**: approving, paying, and editing/deleting payments is limited to the company **owner (client)** and admin; **pm/pmo only submit**. Enforced in `server.js` (`subcontractor_approval_owner_only` / `subcontractor_payment_owner_only`), closing an earlier gap where editing/deleting a payment was unguarded.
*Details: `docs/handover-sub-payments-edit.md`.*

### 7. Three document slots on an expense
Adding an expense now has three separate, labeled upload slots:
- **📋 عرض السعر (Quotation)** — uploaded at entry.
- **🧾 فاتورة المصروف (Invoice)** — uploaded by the project manager **after the transfer**.
- **📦 كشف الاستلام (Delivery note)** — proof the materials were received.
All three are optional at entry and can be added later by editing the expense; the owner sees links to all three in the review dialog before approving/paying. The old "material requires an invoice at creation" rule was removed (the invoice arrives after the transfer). Legacy attachments are kept and shown under the invoice slot.
*Details: `docs/handover-expense-documents.md`.*

### 8. Finance role (upload payment voucher only)
A new **Finance (الماليّة)** role with its own username/password. A finance employee logs into the expenses page and can **only** record the payment and upload the **payment voucher / transfer receipt (سند الدفع / صورة الحوالة)** on an **approved** expense — they cannot enter expenses, approve, or edit anything else. Flow: PM enters → owner approves → finance uploads the voucher. The owner creates the finance user from **"👥 إدارة المستخدمين"** → role **الماليّة**. The review endpoint now guards per section (approval = admin/client/pmo; payment = admin/client/finance).
*Details: `docs/handover-finance-role.md`.*

### 9. Lock an approved expense for the project manager
Once an expense is **approved**, the project manager can no longer edit its data or delete it — they can only open it and upload documents (invoice / delivery note). Core-field changes from a non-approver are ignored server-side and the stored values kept; deletion of an approved expense is limited to the owner/admin. The PM's row shows a 📎 upload button (no delete), and the edit modal opens in documents-only mode (🔒 notice, core fields disabled).
*Details: `docs/handover-lock-approved-expense.md`.*

### 10. Subcontractor contract + owner approval
When the project manager adds a subcontractor, they **attach the contract** and click **"حفظ وإرسال للإدارة"**; the subcontractor becomes **pending**. The company owner reviews the contract and clicks **"✅ اعتماد المقاول"**. Only after approval can the subcontractor start work (the "build certificate" button is locked until then). Server-side, only the owner/admin can approve a subcontractor. Existing subcontractors have no status and are treated as approved (backward-safe).
*Details: `docs/handover-subcontractor-approval.md`.*

### 11. Tap recurring hardening
Tap adapter hardened for real monthly recurring charges (payment agreement + merchant-initiated charges). Keys are entered by you; sim/test/live modes supported.

---

## Post-deploy smoke test

1. **Service restart** done; app loads; existing projects/certificates intact.
2. **Expenses page** opens from the menu; add an expense; verdict shows.
3. **Charge-to-sub**: log a sub-charged expense → it shows on that sub's certificate deduction, excluded from project cost.
4. **Expense review**: pm enters an expense → owner approves (partial) and uploads a transfer statement; pm cannot approve/pay.
5. **Sub-certificate payment**: owner records a payment → edit its amount → it updates; the table/print show the payment date(s); pm/pmo cannot pay.
6. **Dates** on billing/owner pages show Gregorian; a sub rate of `10.5` shows as `10.50`.
7. **Expense documents**: add an expense with only a **quotation** (no invoice) → it saves; edit it later to add the **invoice** and **delivery note** → they persist and the quotation is kept; the three links show in the table and the owner review dialog.
8. **Finance role**: the owner creates a finance user (role الماليّة) in user management; that user logs in → lands on the expenses page → can open an **approved** expense and upload the **payment voucher (سند الدفع)** only; it cannot add/approve/edit expenses, and cannot pay a still-pending one.
9. **Locked approved expense**: as the project manager, approve one of your expenses (as the owner), then as the PM open it → the core fields are disabled and there is no delete button, only document upload; sending an amount change is ignored, uploading an invoice/delivery note works.
10. **Subcontractor approval**: as the PM, add a subcontractor with a contract → "حفظ وإرسال للإدارة" → it shows ⏳ pending and the build button is locked; as the owner, open subcontractors → "✅ اعتماد المقاول" → the build button unlocks. A PM cannot self-approve (server returns 403).

---

*Bassir — consolidated deploy handover. Branch: `claude/session-uqllzm`. No DB/schema migration, no new dependencies; restart the Node service after deploy.*
