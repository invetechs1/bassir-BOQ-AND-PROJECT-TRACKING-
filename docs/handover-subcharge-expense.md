# Developer Handover — "Charge expense to a subcontractor"

**Feature:** auto-deduct expenses charged to a subcontractor from that subcontractor's payment certificate.
**Branch:** `claude/session-uqllzm`
**Date:** 2026-11-04 · Bassir technical division

---

## TL;DR

When logging any expense, the user now picks a **"Charge to"** option:

- **Own (ذاتي)** — a cost on the company → counted in project profitability as before.
- **Subcontractor (مقاول باطن)** — recovered from that subcontractor → **excluded from project cost** and **auto-deducted** from his payment certificate.

The code is merged and tested on the branch above. Just pull and deploy.

---

## 1) Files changed (3 files only)

| File | Change |
|---|---|
| `expenses/index.js` | Backend: new fields + helpers + 2 new routes |
| `public/expenses.html` | Expenses page: "Charge to" selector + table column |
| `public/index.html` | App: sub-certificate builder auto-deducts |

> No database/schema changes. No change to `server.js`. No new npm dependencies.

---

## 2) How to deploy to Live

```bash
git fetch origin
git checkout claude/session-uqllzm   # or merge it into your main branch
# restart the Node service (pm2 restart / systemctl restart ...)
```

Restarting the server is enough. Storage is unchanged — per-project JSON files under
`data/expenses/<projectId>.json`. Existing expenses stay as **own** by default (backward-safe).

---

## 3) Behavior (to test & confirm)

- New **"Charge to"** field on the expenses page: Own / Subcontractor. Choosing *Subcontractor* reveals a dropdown of the project's registered subcontractors.
- An expense charged to a subcontractor is **excluded from project cost** in the profitability panel (it will be recovered via the deduction) and reported separately as `chargedToSubs`.
- When opening the **subcontractor-certificate builder**, the system fetches the sub's unsettled charges and auto-fills the deduction fields ("materials" ← material, "other" ← salary+other) and shows a notice: "🧱 This subcontractor has X SAR of charged expenses…".
- After the certificate is built, a *settle* call marks those expenses as settled under the certificate number — so they are **never deducted twice**.

---

## 4) Backend — `expenses/index.js`

### a) Expense fields (normalizeExpense)

```js
bearer:        'own' | 'sub'      // own, or charged to a subcontractor
subId:         Number | null      // subcontractor id when bearer === 'sub'
settledMusNo:  String | null      // sub-certificate no. it was deducted in (null = not yet)
settledAt:     ISO date | null
```

### b) Aggregate unsettled charges per subcontractor

```js
outstandingSubCharges(items) → {
  "<subId>": { subId, total, byType:{material,salary,other}, count, items:[…] }
}
// includes only: bearer === 'sub' && subId && !settledMusNo
```

### c) Profitability excludes sub-charged expenses

```js
items.forEach(e => {
  if (e.bearer === 'sub') { chargedToSubs += e.amount; return; } // excluded from cost
  byType[e.type] += e.amount;                                     // own = project cost
});
// return value now includes a new field: chargedToSubs
```

### d) Subcontractor validation

```js
validBearer(project, exp):
  rejects bearer === 'sub' without a subId that exists in project.subcontractors
  applied in POST and PUT for an expense (HTTP 400 on error)
```

### e) The two new routes

| Route | Request | Response |
|---|---|---|
| `GET /api/projects/:id/sub-charges` | — | `{ bySub: {…} }` unsettled charges per subcontractor |
| `POST /api/projects/:id/sub-charges/settle` | `{ subId, musNo }` | `{ ok, settled, count }` marks the sub's charges settled under the certificate no. |

> Authorization on both routes is the same as the rest of expenses: admin / client / projects-manager / project-manager with access to the project (`canWrite`).

---

## 5) Frontend

### `public/expenses.html`

- `#e-bearer` select (own/sub) + subcontractors list `#e-subid` shown when "Subcontractor" is chosen.
- "Charge to" column in the expenses table with a per-row chip (Own / 🧱 sub name, and a ✓ if settled).
- The save request body includes `bearer` and `subId`.

### `public/index.html` — subcontractor-certificate builder

- `openSubDetail()` calls `loadSdSubCharges(subId)`: fetches `/sub-charges`, pre-fills the deduction fields, and shows the notice.
- `buildSubMus()` after creating the certificate calls `/sub-charges/settle` with `{subId, musNo}` (settlement is independent of the project save).

---

## 6) Important notes

- All values in the profitability module are **pre-VAT** (`amount` field), and so is the sub charge deduction — for consistency with the rest of the project's calculations.
- Expense storage is separate per project and is **not touched** by the app's project save — no conflict with the version/409 optimistic-concurrency in `server.js`.
- Backward-safe: expenses recorded before this update read as `bearer='own'` automatically.
- Settlement keys off the textual `musNo`; settled expenses stay excluded from project cost (recovered).

---

## 7) Automated test result ✅

Logged two expenses charged to a subcontractor (materials 10,000 + other 5,000) and one own expense (salaries 8,000):

- `sub-charges` showed **15,000** for the subcontractor.
- Profitability charged **only 8,000** to the project and excluded 15,000 (`chargedToSubs`).
- Settlement marked both expenses and emptied the list (no double deduction).

---

*Bassir — handover for charging expenses to subcontractors. Branch: `claude/session-uqllzm` · 3 files · no DB or dependency changes.*
