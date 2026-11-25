# Developer Handover — Subcontractor contract + owner approval

**Feature:** when the project manager adds a subcontractor, they now **attach the contract** and click **"حفظ وإرسال للإدارة"**. The subcontractor becomes **pending**; the company owner reviews the contract and **approves** them. Only after approval can the subcontractor start work (build certificates).
**Branch:** `claude/session-uqllzm`
**Date:** 2026-11-14 · Bassir technical division

---

## The flow

1. Project manager opens "➕ إضافة مقاول باطن", fills the data, **attaches the contract** (📄 عقد مقاول الباطن), and clicks **"حفظ وإرسال للإدارة"**.
2. The subcontractor is saved as **pending** (⏳ بانتظار اعتماد الإدارة). The PM cannot build his certificate yet (the build button is locked).
3. The company **owner** reviews the contract (📄 link) and clicks **"✅ اعتماد المقاول"**.
4. The subcontractor becomes **approved** and can start work (the build button unlocks).

Everything else about subcontractors is unchanged. **Existing subcontractors have no status and are treated as approved** (backward-safe — nothing changes for them).

---

## Files changed (2 files)

| File | Change |
|---|---|
| `public/index.html` | Contract upload in the sub edit modal; dynamic save button; status badge + contract link + locked build button + "اعتماد المقاول"; `openSubDetail` blocks a pending sub; `approveSub()` |
| `server.js` | Only the owner/admin can approve a subcontractor (set `status: 'approved'`); the PM is denied |

> No DB/schema migration (the fields are additive on `project.subcontractors[]`). Restart the Node service (server.js changed). No new dependencies.

## Data model (on each `project.subcontractors[]`)

```js
status:       'pending' | 'approved'   // absent = approved (legacy)
contractDocs: [{url,name}]             // the attached contract (image/PDF)
submittedBy, submittedAt               // who sent it to management
approvedBy, approvedAt                 // who approved, when
```

## Backend guard (`server.js`, inside the non-admin block)

```js
const storedSubs = new Map((stored.subcontractors||[]).map(s => [s.id, s]));
for (const sc of (data.subcontractors||[])) {
  const old = storedSubs.get(sc.id);
  const oldApproved = old ? (old.status === undefined || old.status === 'approved') : false;
  const newApproved = (sc.status === undefined || sc.status === 'approved');
  if (newApproved && !oldApproved && !isOwner) return deny('subcontractor_approval_owner_only', { id: sc.id });
  if (old && (old.approvedBy||'') !== (sc.approvedBy||'') && !isOwner) return deny('subcontractor_approval_owner_only', { id: sc.id });
}
```

The PM can create/edit a pending subcontractor and attach the contract, but cannot flip it to approved; that is owner/admin only. Legacy subs (no `status`) stay editable and are treated as approved.

## Frontend

- Sub edit modal: a **📄 عقد مقاول الباطن (ارفاق)** file input (uploads via `/photos` on save); the save button reads **"حفظ وإرسال للإدارة"** for the PM. A new subcontractor by the PM requires a contract.
- Subcontractor card: a **⏳ بانتظار اعتماد الإدارة** / **✅ معتمد** badge, the contract link, a warning for pending, the build button **locked** until approved, and a **"✅ اعتماد المقاول"** button for the owner.
- `openSubDetail()` refuses to open the build page for a pending subcontractor.

## Automated test result ✅

- PM adds a subcontractor as pending (with contract) → allowed.
- PM tries to set it approved → **403 `subcontractor_approval_owner_only`**.
- Owner approves → allowed.
- PM edits the now-approved subcontractor (keeping approved) → allowed.

---

*Bassir — subcontractor contract + approval handover. Branch: `claude/session-uqllzm` · 2 files · no DB/schema migration; restart the Node service after deploy.*
