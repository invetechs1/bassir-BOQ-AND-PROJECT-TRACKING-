# Developer Handover — Edit subcontractor payments + show them on the certificate

**Feature:** on a subcontractor certificate you can now **edit or delete** any recorded payment (e.g. change 10,000 to 8,000), and the **payments are printed on the certificate** (paper/PDF).
**Branch:** `claude/session-uqllzm`
**Date:** 2026-11-11 · Bassir technical division

---

## What changed

Before: the "اعتماد صرف" dialog could only **add** payments — a wrong amount could not be corrected, and payments never appeared on the printed certificate.

Now:
1. The payment dialog lists every recorded payment with **✎ تعديل** and **🗑 حذف**. Editing updates the amount/date/note in place; the net/paid/remaining and the certificate status (`paid` ⇄ `approved`) recompute automatically. The dialog stays open so you can make several edits.
2. The printed certificate (`subMusDocHtml`) has a new **"الدفعات المصروفة للمقاول"** table: each payment (date · amount · note) plus **إجمالي المصروف** and **المتبقٍ للمقاول**.
3. **Payment dates are visible everywhere** — the certificates table's "المدفوع" column now lists each payment under the total as `📅 <date>: <amount>`, not just the certificate's submission date.
4. **Owner-only (company owner / client)** — approving, paying, and editing/deleting sub-certificate payments is restricted to the company owner (`client`) and the system admin. The project manager (`pm`) and projects manager (`pmo`) **only submit** certificates; they cannot pay or edit payments.

## Files changed (2 files)

`public/index.html`:
- Payment modal (`#subpay-modal`): added a payments list + an edit/cancel form state.
- JS: `openSubPay` renders the list; new `renderSubPayList`, `editSubPay`, `delSubPay`, `subPayResetForm`, `subPayRefreshInfo`, `subPayRecomputeStatus`; `saveSubPay` handles add + edit.
- `subMusDocHtml`: added the payments section; the certificates table shows per-payment dates.
- `canApproveSubMus()` now allows the company owner (`client`), not only admin.

`server.js` (the authoritative guard):
- Sub-certificate approve/reject and **any** payment change (add/edit/delete) are allowed only for `canAdminCompany` (the company owner or admin) — errors `subcontractor_approval_owner_only` / `subcontractor_payment_owner_only`. This also closes an earlier gap where editing/deleting a payment was not guarded.

> No storage/schema change (payments already live in `subMustakhlasat[].payments`). No new dependencies. Restart the Node service after deploy.

## Automated test result ✅

- Owner (client): add 10,000 → edit to 8,000 → delete — all succeed.
- pmo (projects manager): add / edit a payment → **403 `subcontractor_payment_owner_only`**.
- pm (site manager): blocked from payments (by this guard and the earlier quantity guards).

## Deploy

```bash
git fetch origin
git checkout claude/session-uqllzm   # or merge into your main branch
# restart the Node service (static file — a hard refresh in the browser is enough)
```

## Verify

Open a subcontractor certificate → "💵 اعتماد صرف" → the recorded payment shows with ✎/🗑 → edit 10,000 to 8,000 → paid/remaining update. Then "عرض" / print → the certificate shows the "الدفعات المصروفة للمقاول" table with the 8,000 payment and the remaining balance.
