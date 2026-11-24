# Developer Handover — Material distribution & cost control

**Feature:** a **Material distribution & cost control** view that links each material expense to a BOQ item and to a sink (subcontractor / self), computes the **actual material cost per executed unit**, compares it to a **target per unit**, flags over-budget items (🔴), and shows **where the site materials went**.
**Branch:** `claude/session-uqllzm`
**Date:** 2026-11-24 · Bassir technical division

---

## The problem it solves

Site materials were consumed with no control — e.g. painting cost 10–12 SAR/m² of material when the target is 6.5. The owner needs to see: what was spent per item, how it split across each subcontractor vs self, and which items blew the budget.

## How it works

1. When entering a **material** expense, the user picks the **📦 البند المستفيد من المواد** (BOQ item) and optionally the covered quantity.
2. In the expenses page, a new view **📦 توزيع المواد ومراقبة التكلفة** shows:
   - KPIs: total materials, split to subs vs self, and total over-budget.
   - A per-item table: executed qty · material spent · **actual cost/unit** · **target/unit** (editable) · variance · 🟢/🔴 status · distribution chips (own + each sub).
   - **"المواد راحت وين؟"** — distribution bars by sink (self + each sub), plus unassigned materials.
3. The owner/management sets the **target per unit** per item; items over target show 🔴 with the waste amount.

## Files changed (2 files)

| File | Change |
|---|---|
| `expenses/index.js` | `materialQty` field; `materialReport()`; `materialTargets` store; routes `GET /material-report`, `POST /material-targets`; GET expenses returns `boqItems` + `materialTargets` |
| `public/expenses.html` | BOQ-item + quantity fields on the material form; view toggle; the material-distribution view and its rendering |

> No DB/schema migration — `materialTargets` is added to the per-project expenses JSON; `boqItemId`/`materialQty` are additive on the expense. Restart the Node service after deploy. No new dependencies.

## Backend

- `materialReport(project, items, targets)`: groups material expenses by BOQ item and by sink (own / sub). Per item: `spent`, `actualRate = spent / executedQty`, `target`, `targetBudget = executed × target`, `variance`, `over`. Plus `distribution` by sink, `unassigned`, `overCount`, `overTotal`. All pre-VAT (consistent with profitability).
- `GET /api/projects/:id/material-report` → `{ report, materialTargets, canApprove }`.
- `POST /api/projects/:id/material-targets` (canApprove only) → `{ boqItemId, rate }` (rate ≤ 0 or empty clears it).

## Frontend

- Material expense form: `#e-boqitem` (BOQ item) and `#e-matqty` (covered quantity); `saveExp` sends `boqItemId` + `materialQty`.
- A segmented toggle switches between **💵 المصاريف والربحية** and **📦 توزيع المواد ومراقبة التكلفة**.
- The material view renders KPIs, the per-item cost-vs-target table (with inline editable target for approvers), and the sink distribution bars.

## Automated test result ✅

Painting item, executed 1,000 m²: own material 7,000 + sub 5,000 = 12,000 → **actual 12 SAR/m²** vs target 6.5 → **🔴 over by 5,500**. Distribution: self 9,000 (incl. 2,000 unassigned) + sub 5,000. Report totals, per-sink split, and unassigned all verified.

---

*Bassir — material distribution & cost control handover. Branch: `claude/session-uqllzm` · 2 files · no DB/schema migration; restart the Node service after deploy.*
