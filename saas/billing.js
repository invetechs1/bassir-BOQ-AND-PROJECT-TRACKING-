'use strict';
/*
 * منطق الفوترة: التسعير، الضريبة، التقسيط الزمني (proration)، بناء الفواتير، حساب الدورة.
 * دوال حسابية صرفة قدر الإمكان ليسهل اختبارها. الأموال تُقرّب لخانتين.
 */

const money = n => Math.round((Number(n) || 0) * 100) / 100;
const DAY = 24 * 3600 * 1000;

// إضافة أشهر لتاريخ ISO مع ضبط نهاية الشهر (31 يناير + شهر = 28/29 فبراير)
function addMonths(iso, n) {
  const d = new Date(iso);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString();
}
const daysBetween = (aISO, bISO) => Math.max(0, Math.round((new Date(bISO) - new Date(aISO)) / DAY));

module.exports = function createBilling(store) {
  function tierPrice(config, tier) {
    const t = String(tier);
    return money(config.tiers[t] != null ? config.tiers[t] : config.tiers['15']);
  }
  function tierCapacityGB(tier) { return Number(tier) || 15; }

  const activeProjects = tenant => (tenant.projects || []).filter(p => p.status === 'active');

  // المبلغ الشهري (صافي، قبل الضريبة) = مجموع أسعار المشاريع الفعّالة
  function subscriptionNet(config, tenant) {
    return money(activeProjects(tenant).reduce((s, p) => s + tierPrice(config, p.tier), 0));
  }

  // تقسيم الضريبة على مبلغ صافٍ أو شامل حسب الإعداد
  function applyVat(config, netOrGross) {
    const vr = Number(config.vatRate) || 0;
    if (config.priceInclusiveVat) {
      const total = money(netOrGross);
      const subtotal = money(total / (1 + vr / 100));
      return { subtotal, vat: money(total - subtotal), total };
    }
    const subtotal = money(netOrGross);
    const vat = money(subtotal * vr / 100);
    return { subtotal, vat, total: money(subtotal + vat) };
  }

  // حصّة التقسيط لإضافة مشروع في منتصف الدورة
  function prorationFactor(nowISO, cycleStartISO, cycleEndISO) {
    const total = daysBetween(cycleStartISO, cycleEndISO) || 30;
    const remaining = daysBetween(nowISO, cycleEndISO);
    return Math.max(0, Math.min(1, remaining / total));
  }

  // بناء فاتورة من بنود صافية. كل سطر: {projectId,name,tier,desc,qty,unit,amount(صافٍ)}
  function buildInvoice(config, tenant, { kind, lines, periodStart, periodEnd, issuedAt }) {
    const now = issuedAt || new Date().toISOString();
    const net = money(lines.reduce((s, l) => s + (Number(l.amount) || 0), 0));
    const { subtotal, vat, total } = applyVat(config, net);
    return {
      id: store.saasId('inv'),
      no: store.invoiceNo(),
      tenantCompanyId: tenant.companyId,
      kind: kind || 'subscription',          // subscription | signup | project_add | renewal
      issuedAt: now,
      dueAt: now,
      periodStart: periodStart || null,
      periodEnd: periodEnd || null,
      lines: lines.map(l => ({
        projectId: l.projectId != null ? l.projectId : null,
        name: l.name || '', tier: l.tier || null, desc: l.desc || '',
        qty: l.qty != null ? l.qty : 1, unit: money(l.unit != null ? l.unit : l.amount), amount: money(l.amount)
      })),
      subtotal, vatRate: Number(config.vatRate) || 0, vat, total,
      currency: config.currency || 'SAR',
      status: 'unpaid',                       // unpaid | paid | failed | void | refunded
      tapChargeId: null, paidAt: null, cardLast4: null, cardBrand: null,
      attempts: 0, lastError: null
    };
  }

  // بنود اشتراك دورة كاملة (كل المشاريع الفعّالة)
  function subscriptionLines(config, tenant) {
    return activeProjects(tenant).map(p => ({
      projectId: p.projectId, name: p.name, tier: p.tier,
      desc: 'اشتراك شهري — مشروع «' + (p.name || p.projectId) + '» (' + tierCapacityGB(p.tier) + ' جيجابايت)',
      qty: 1, unit: tierPrice(config, p.tier), amount: tierPrice(config, p.tier)
    }));
  }

  return {
    money, addMonths, daysBetween,
    tierPrice, tierCapacityGB, activeProjects, subscriptionNet,
    applyVat, prorationFactor, buildInvoice, subscriptionLines
  };
};
