'use strict';
/*
 * محوّل بوابة Tap Payments + محاكي مدمج (sim) للتجربة قبل توفّر المفاتيح.
 * البيانات الحسّاسة (مفتاح السر) تبقى على الخادم. بيانات البطاقة لا تمر عبر خادمنا:
 * تُرمّز في الواجهة عبر Tap Card SDK وتصلنا كـ token فقط (متوافق مع PCI).
 *
 * الحالات المُوحّدة: 'initiated' (يحتاج توجيه/3DS) | 'captured' (نجح) | 'failed'.
 */
const crypto = require('crypto');

function normStatus(s) {
  const u = String(s || '').toUpperCase();
  if (u === 'CAPTURED' || u === 'AUTHORIZED') return 'captured';
  if (['INITIATED', 'IN_PROGRESS', 'PENDING'].includes(u)) return 'initiated';
  return 'failed';
}

module.exports = function createTap(store) {
  const cfg = () => store.loadConfig().tap;
  const isSim = () => (cfg().mode || 'sim') === 'sim';

  async function tapFetch(method, endpoint, body) {
    const c = cfg();
    const url = (c.baseUrl || 'https://api.tap.company').replace(/\/+$/, '') + endpoint;
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
    try {
      const r = await fetch(url, {
        method,
        headers: { 'Authorization': 'Bearer ' + (c.secretKey || ''), 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal
      });
      clearTimeout(t);
      let d = {}; try { d = await r.json(); } catch (e) {}
      return { httpOk: r.ok, status: r.status, data: d };
    } catch (e) { clearTimeout(t); return { httpOk: false, status: 0, data: { errors: [{ description: (e && e.message) || 'network error' }] } }; }
  }

  // إنشاء عملية دفع أولى (تفتح صفحة Tap للدفع/3DS وتحفظ البطاقة للتجديد الشهري)
  //  opts: { amount, currency, customer:{name,email,phone}, token, redirectUrl, webhookUrl, description, metadata }
  async function createCharge(opts) {
    if (isSim()) {
      const id = 'chg_sim_' + crypto.randomBytes(8).toString('hex');
      const sep = opts.redirectUrl && opts.redirectUrl.indexOf('?') >= 0 ? '&' : '?';
      return {
        ok: true, id, status: 'initiated',
        redirectUrl: '/saas/sim/pay?chg=' + id + '&amount=' + encodeURIComponent(opts.amount) +
          '&back=' + encodeURIComponent(opts.redirectUrl || '/billing'),
        customerId: 'cus_sim_' + crypto.randomBytes(6).toString('hex'),
        cardId: null, cardLast4: null, cardBrand: null, raw: { sim: true }
      };
    }
    const body = {
      amount: opts.amount, currency: opts.currency || 'SAR',
      threeDSecure: true, save_card: true,
      // إنشاء اتفاقية دفع غير مجدولة ليصبح التجديد الشهري (MIT) مدعوماً لدى Tap
      payment_agreement: { type: 'UNSCHEDULED' },
      customer: opts.customer && opts.customer.id ? { id: opts.customer.id } : {
        first_name: (opts.customer && opts.customer.name) || 'Customer',
        email: (opts.customer && opts.customer.email) || undefined,
        phone: opts.customer && opts.customer.phone ? { country_code: '966', number: String(opts.customer.phone).replace(/^0/, '') } : undefined
      },
      source: { id: opts.token || 'src_all' },
      redirect: { url: opts.redirectUrl },
      post: opts.webhookUrl ? { url: opts.webhookUrl } : undefined,
      description: opts.description || 'Subscription',
      metadata: opts.metadata || {}
    };
    const r = await tapFetch('POST', '/v2/charges', body);
    const d = r.data || {};
    if (!r.httpOk || !d.id) return { ok: false, error: errOf(d), raw: d };
    return {
      ok: true, id: d.id, status: normStatus(d.status),
      redirectUrl: d.transaction && d.transaction.url ? d.transaction.url : null,
      customerId: d.customer && d.customer.id ? d.customer.id : null,
      cardId: d.card && d.card.id ? d.card.id : (d.source && d.source.id) || null,
      cardLast4: d.card && (d.card.last_four || d.card.last4) || null,
      cardBrand: d.card && (d.card.brand || d.card.scheme) || null,
      paymentAgreementId: paymentAgreementOf(d),
      raw: d
    };
  }

  // تجديد تلقائي بالبطاقة المحفوظة (Merchant Initiated — بلا توجيه عادةً)
  //  opts: { amount, currency, customerId, cardId, description, metadata, simFail }
  async function createRecurringCharge(opts) {
    if (isSim()) {
      const id = 'chg_sim_' + crypto.randomBytes(8).toString('hex');
      if (opts.simFail) return { ok: true, id, status: 'failed', raw: { sim: true, declined: true } };
      return { ok: true, id, status: 'captured', raw: { sim: true } };
    }
    // معاملة بمبادرة التاجر (MIT) وفق Tap: بطاقة محفوظة + اتفاقية دفع + بلا 3DS
    const body = {
      amount: opts.amount, currency: opts.currency || 'SAR',
      threeDSecure: false, save_card: false,
      customer_initiated: false,
      customer: { id: opts.customerId },
      source: { id: opts.cardId, on_file: true },
      description: opts.description || 'Subscription renewal',
      metadata: opts.metadata || {}
    };
    if (opts.paymentAgreementId) body.payment_agreement = { id: opts.paymentAgreementId };
    const r = await tapFetch('POST', '/v2/charges', body);
    const d = r.data || {};
    if (!r.httpOk || !d.id) return { ok: false, error: errOf(d), raw: d };
    return { ok: true, id: d.id, status: normStatus(d.status), raw: d };
  }

  async function retrieveCharge(id) {
    if (isSim()) return { ok: true, id, status: 'captured', raw: { sim: true } };
    const r = await tapFetch('GET', '/v2/charges/' + encodeURIComponent(id));
    const d = r.data || {};
    if (!r.httpOk || !d.id) return { ok: false, error: errOf(d), raw: d };
    return {
      ok: true, id: d.id, status: normStatus(d.status),
      cardLast4: d.card && (d.card.last_four || d.card.last4) || null,
      cardBrand: d.card && (d.card.brand || d.card.scheme) || null,
      customerId: d.customer && d.customer.id || null,
      cardId: d.card && d.card.id || null,
      paymentAgreementId: paymentAgreementOf(d),
      raw: d
    };
  }

  // استخراج معرّف اتفاقية الدفع من استجابة Tap (مواضع محتملة مختلفة)
  function paymentAgreementOf(d) {
    if (!d) return null;
    return (d.payment_agreement && d.payment_agreement.id)
      || (d.card && d.card.payment_agreement && d.card.payment_agreement.id)
      || (d.source && d.source.payment_agreement && d.source.payment_agreement.id)
      || null;
  }

  // تحقق توقيع إشعار tap (hashstring). المرجعية الأضمن: إعادة جلب العملية للتأكد.
  function verifyWebhook(headers, payload) {
    if (isSim()) return true;
    const secret = cfg().webhookSecret;
    if (!secret) return true; // لم يُضبط سر — نعتمد على retrieveCharge للتأكيد
    const sig = headers['hashstring'] || headers['Hashstring'] || '';
    try {
      const p = payload || {};
      const toHash =
        'x_id' + (p.id || '') +
        'x_amount' + (p.amount != null ? Number(p.amount).toFixed(3) : '') +
        'x_currency' + (p.currency || '') +
        'x_gateway_reference' + ((p.reference && p.reference.gateway) || '') +
        'x_payment_reference' + ((p.reference && p.reference.payment) || '') +
        'x_status' + (p.status || '') +
        'x_created' + (p.transaction && p.transaction.created || p.created || '');
      const h = crypto.createHmac('sha256', secret).update(toHash).digest('hex');
      return h === sig;
    } catch (e) { return false; }
  }

  function errOf(d) {
    if (d && Array.isArray(d.errors) && d.errors.length) return d.errors.map(e => e.description || e.code).join('; ');
    if (d && d.message) return d.message;
    return 'تعذّر إنشاء العملية لدى Tap';
  }

  return { isSim, createCharge, createRecurringCharge, retrieveCharge, verifyWebhook, normStatus };
};
