# Developer Handover — Project-manager pledge on a subcontractor claim

**Feature:** when the project manager submits a subcontractor claim (مستخلص مقاول باطن), a pledge dialog appears: **"أتعهّد بصفتي مدير المشروع بصحّة ما ورد في مستخلص مقاول الباطن."** On **"✅ نعم، أتعهّد"** the claim is submitted to the subcontractor-claims page for management review, and the pledge is recorded on the claim.
**Branch:** `claude/session-uqllzm`
**Date:** 2026-11-14 · Bassir technical division

---

## Behavior

1. On the subcontractor page, the PM allocates quantities, attaches the required documents, and clicks **"💾 بناء مستخلص المقاول"**.
2. After the usual validations, a **pledge modal** shows the undertaking text and the claim net.
3. On **"✅ نعم، أتعهّد"**, the claim is built with `status: 'submitted'` and the pledge recorded, then the view switches to **مستخلصات مقاولي الباطن** for management to review/approve.
4. Cancelling the pledge does nothing (no claim is created).

The pledge text, author and date are stored on the claim and printed on the certificate.

## Files changed (1 file)

`public/index.html`:
- New `#pledge-modal` with the undertaking text and a **"✅ نعم، أتعهّد"** button.
- `buildSubMus()` now runs the validations then opens the pledge modal; the actual build was moved to `doBuildSubMus()` (called by `pledgeConfirm()`).
- The built claim stores `pledge`, `pledgedBy`, `pledgedAt`; `subMusDocHtml()` prints the pledge line on the certificate.
- English strings added to `I18N_EN`.

> No backend/storage/schema change (the claim already lives in `project.subMustakhlasat[]`). No new dependencies. Static-file deploy + hard refresh is enough.

## Automated / visual check ✅

- The pledge modal shows the exact wording with a green "✅ نعم، أتعهّد" button and the claim net.
- On confirm, the claim is submitted to the review page; the printed certificate carries the pledge line (`📝 تعهّد: … — <pm name> · <date>`).

---

*Bassir — subcontractor-claim pledge handover. Branch: `claude/session-uqllzm` · 1 file · no DB/schema change.*
