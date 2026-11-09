# Developer Handover — Decimal unit prices (10.5 was shown as 11)

**Fix:** subcontractor/unit prices with decimals (e.g. `10.5`) were displayed rounded to a whole number (`11`), making it look like the system rejected decimals.
**Branch:** `claude/session-uqllzm`
**Date:** 2026-11-08 · Bassir technical division

---

## What was wrong

The value was **always stored correctly** (`10.5`). Only the **display** rounded: these unit-price cells used `fmtN` (0 decimals) instead of `fmtRate` (2 decimals).

```js
const fmtN    = n => Number(n||0).toLocaleString('en-US',{maximumFractionDigits:0});   // 10.5 -> "11"
const fmtRate = n => Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); // -> "10.50"
```

## Files changed (1 file)

`public/index.html` — switched unit-price displays from `fmtN` to `fmtRate`:

- Subcontractor draft items list (when adding a sub).
- Subcontractor certificate build table (rate column).
- Company and subcontractor certificate rows (printable).
- The two price-cap warning messages (sub rate vs contract rate).
- The price catalog table + its "insert into project" line.

Amount/total columns are unchanged (whole-number display is fine there), and the main BOQ table already used `fmtRate`.

> No backend, storage, schema or dependency changes. Nothing to migrate — existing decimal values simply display correctly now.

## Deploy

```bash
git fetch origin
git checkout claude/session-uqllzm   # or merge into your main branch
# restart the Node service (static file — a hard refresh in the browser is enough)
```

## Verify

Enter a subcontractor rate of `10.5` → it now shows **10.50** everywhere (list, certificate, print), not `11`.
