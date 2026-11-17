'use strict';
/*
 * محوّل بوابة Moyasar + محاكي مدمج (sim) للتجربة قبل توفّر المفاتيح.
 * الدفعة الأولى تتم من المتصفح مباشرة عبر عنصر moyasar.js (بالمفتاح العام) — بطاقة العميل
 * لا تمر عبر خادمنا أبداً. خادمنا فقط: (أ) يُنشئ الفاتورة ويحدّد المبلغ المطلوب، (ب) يؤكّد
 * نتيجة الدفع بجلبها مباشرة من Moyasar بمفتاحنا السرّي (لا يُعتمد على حالة يرسلها المتصفح أو
 * الـwebhook بلا تحقق)، (ج) يُنشئ شحنات التجديد الدوري (MIT) ببطاقة محفوظة (token).
 *
 * المبالغ لدى Moyasar بأصغر وحدة عملة (هللة): 10 ر.س = 1000. مبالغنا الداخلية بالريال (عشري)،
 * فنحوّلها *100 عند الإرسال فقط.
 *
 * الحالات المُوحّدة (كما في tap.js): 'initiated' (يحتاج توجيه/3DS) | 'captured' (نجح) | 'failed'.
 */
const crypto = require('crypto');

function normStatus(s) {
  const u = String(s || '').toLowerCase();
  if (['paid', 'captured', 'authorized', 'verified'].includes(u)) return 'captured';
  if (['initiated', 'pending'].includes(u)) return 'initiated';
  return 'failed';
}

module.exports = function createMoyasar(store) {
  const cfg = () => store.loadConfig().moyasar;
  const isSim = () => (cfg().mode || 'sim') === 'sim';
  const halalas = n => Math.round((Number(n) || 0) * 100);

  async function msrFetch(method, endpoint, body) {
    const c = cfg();
    const url = 'https://api.moyasar.com' + endpoint;
    const auth = 'Basic ' + Buffer.from((c.secretKey || '') + ':').toString('base64');
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
    try {
      const r = await fetch(url, {
        method, headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal
      });
      clearTimeout(t);
      let d = {}; try { d = await r.json(); } catch (e) {}
      return { httpOk: r.ok, status: r.status, data: d };
    } catch (e) { clearTimeout(t); return { httpOk: false, status: 0, data: { message: (e && e.message) || 'network error' } }; }
  }

  // رابط دفع محلي للمحاكاة فقط (بدلاً من نافذة moyasar.js الحقيقية) — نفس صفحة محاكاة Tap المشتركة
  function simCheckoutUrl(opts) {
    const id = 'pay_sim_' + crypto.randomBytes(8).toString('hex');
    return {
      ok: true, id, status: 'initiated',
      redirectUrl: '/saas/sim/pay?chg=' + id + '&amount=' + encodeURIComponent(opts.amount) +
        '&back=' + encodeURIComponent(opts.redirectUrl || '/billing')
    };
  }

  // جلب حالة عملية دفع من Moyasar مباشرة بمفتاحنا السرّي — نقطة الحقيقة الوحيدة للتأكيد
  async function retrieveCharge(id) {
    if (isSim()) return { ok: true, id, status: 'captured', cardLast4: '4242', cardBrand: 'VISA', cardId: 'token_sim_' + id, raw: { sim: true } };
    const r = await msrFetch('GET', '/v1/payments/' + encodeURIComponent(id));
    const d = r.data || {};
    if (!r.httpOk || !d.id) return { ok: false, error: errOf(d), raw: d };
    const src = d.source || {};
    // Moyasar لا يُرجع last_four كحقل منفصل — يُرجع رقماً مقنّعاً مثل "4111-11XX-XXXX-1111"؛
    // نستخرج آخر 4 أرقام فعلية منه (وليس آخر 4 محارف، التي قد تكون أرقام القناع نفسه)
    const digits = String(src.number || '').replace(/\D/g, '');
    return {
      ok: true, id: d.id, status: normStatus(d.status),
      cardLast4: digits ? digits.slice(-4) : null,
      cardBrand: src.company || src.brand || null,
      cardId: src.token || null, // توكن البطاقة المحفوظة (نشِط فقط بعد paid، ويتطلب تفعيل Tokenization + credit_card.save_card في الواجهة)
      raw: d
    };
  }

  // تجديد تلقائي/ترقية ببطاقة محفوظة (MIT) — source.type:"token"، بلا 3DS افتراضياً
  //  opts: { amount, currency, cardId(=token), description, metadata, simFail }
  async function createRecurringCharge(opts) {
    if (isSim()) {
      const id = 'pay_sim_' + crypto.randomBytes(8).toString('hex');
      if (opts.simFail) return { ok: true, id, status: 'failed', raw: { sim: true, declined: true } };
      return { ok: true, id, status: 'captured', raw: { sim: true } };
    }
    if (!opts.cardId) return { ok: false, error: 'لا يوجد توكن بطاقة محفوظ' };
    const body = {
      amount: halalas(opts.amount), currency: opts.currency || 'SAR',
      description: opts.description || 'Subscription renewal',
      source: { type: 'token', token: opts.cardId },
      metadata: opts.metadata || {}
    };
    const r = await msrFetch('POST', '/v1/payments', body);
    const d = r.data || {};
    if (!r.httpOk || !d.id) return { ok: false, error: errOf(d), raw: d };
    return { ok: true, id: d.id, status: normStatus(d.status), raw: d };
  }

  // تحقّق Webhook: Moyasar يضع secret_token (الذي نضبطه نحن) داخل جسم كل إشعار — لا توقيع HMAC.
  // نستخدمه كتصفية أولى فقط؛ التأكيد الحقيقي يبقى عبر retrieveCharge دائماً (applyChargeResult).
  function verifyWebhook(headers, payload) {
    if (isSim()) return true;
    const secret = cfg().webhookSecret;
    if (!secret) return true; // لم يُضبط سر — نعتمد على retrieveCharge للتأكيد
    return String((payload || {}).secret_token || '') === secret;
  }

  function errOf(d) {
    if (d && d.message) return d.message;
    if (d && d.errors) { try { return JSON.stringify(d.errors); } catch (e) {} }
    return 'تعذّر إنشاء العملية لدى Moyasar';
  }

  return { isSim, halalas, simCheckoutUrl, retrieveCharge, createRecurringCharge, verifyWebhook, normStatus };
};
