# Developer Handover — Lock an approved expense for the project manager

**Feature:** once an expense is **approved**, the project manager can no longer edit its data or delete it — they can only open it and **upload documents** (invoice / delivery note).
**Branch:** `claude/session-uqllzm`
**Date:** 2026-11-13 · Bassir technical division

---

## Behavior

- **Before approval** (`pending`): the project manager edits/deletes their expense as before.
- **After approval** (`approved_full` / `approved_partial`): for anyone who is **not an approver** (i.e. the project manager):
  - Core fields (amount, description, type, supplier, VAT, charge-to, …) are **locked** — any change sent is ignored and the stored values are kept.
  - The expense **cannot be deleted**.
  - They can still **upload the documents** (quotation / invoice / delivery note).
- The company **owner / admin** (approvers) can still edit core fields and delete an approved expense if needed.

---

## Files changed (2 files)

| File | Change |
|---|---|
| `expenses/index.js` | PUT: on an approved expense, a non-approver's core-field changes are forced back to the stored values (documents still accepted). DELETE: an approved expense can only be deleted by an approver (owner/admin). |
| `public/expenses.html` | On an approved expense, the PM's row shows a 📎 "upload documents" button (no 🗑 delete); the edit modal opens in **documents-only** mode — a 🔒 notice, all core inputs disabled, only the three document uploads active; title "رفع مستندات المصروف". |

> No DB/schema change. The server enforcement is authoritative (the UI lock is for clarity). Restart the Node service after deploy (part of the same branch's server.js changes).

## Backend — `expenses/index.js`

```js
// PUT: lock core fields of an approved expense for non-approvers (documents still updatable)
const locked = prev.approvalStatus && prev.approvalStatus !== 'pending';
if (locked && !canApprove(req.user, p)) {
  ['type','date','description','supplier','amount','vatRate','vat','total','taxInvoiceNo',
   'taxInvoiceDate','category','boqItemId','month','headcount','bearer','subId',
   'settledMusNo','settledAt'].forEach(k => { exp[k] = prev[k]; });
}
// DELETE: an approved expense is deletable only by an approver (owner/admin)
if (target.approvalStatus !== 'pending' && !canApprove(req.user, p))
  return res.status(403).json({ error: 'لا يمكن حذف مصروف معتمد — راجع صاحب الشركة' });
```

## Automated test result ✅

- Before approval: pm edits the description → applied.
- After approval: pm sends a new amount + description → **ignored** (stays as stored); invoice + delivery note → **accepted**.
- After approval: pm deletes → **403**.
- Owner can still edit core and delete an approved expense.

---

*Bassir — approved-expense lock handover. Branch: `claude/session-uqllzm` · 2 files · no DB/schema change; restart the Node service after deploy.*
