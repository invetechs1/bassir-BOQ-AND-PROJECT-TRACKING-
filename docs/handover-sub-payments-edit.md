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

## Files changed (1 file)

`public/index.html`:
- Payment modal (`#subpay-modal`): added a payments list + an edit/cancel form state.
- JS: `openSubPay` now renders the list; new `renderSubPayList`, `editSubPay`, `delSubPay`, `subPayResetForm`, `subPayRefreshInfo`, `subPayRecomputeStatus`; `saveSubPay` handles both add and edit.
- `subMusDocHtml`: added the payments section.

> No backend/storage/schema change (payments already live in `subMustakhlasat[].payments`). No new dependencies. A static-file deploy + hard refresh is enough.

## Deploy

```bash
git fetch origin
git checkout claude/session-uqllzm   # or merge into your main branch
# restart the Node service (static file — a hard refresh in the browser is enough)
```

## Verify

Open a subcontractor certificate → "💵 اعتماد صرف" → the recorded payment shows with ✎/🗑 → edit 10,000 to 8,000 → paid/remaining update. Then "عرض" / print → the certificate shows the "الدفعات المصروفة للمقاول" table with the 8,000 payment and the remaining balance.
