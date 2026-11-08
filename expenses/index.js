'use strict';
/*
 * وحدة المصاريف وتكاليف المشروع (Project Costs) — تتبّع تكاليف لا محاسبة.
 * تسجّل: مواد (بفواتير الموردين) · رواتب موزّعة على المشروع · مصاريف أخرى/نثريات.
 * تُجمّع تلقائياً: مستخلصات مقاولي الباطن (موجودة) لعرض ربحية المشروع.
 * تُغذّي Bassir ERP (دفعة اتجاه واحد) ولا تحلّ محله (لا قيود/سداد/رواتب/ضريبة).
 *
 * تخزين منفصل لكل مشروع: data/expenses/<projectId>.json  (لا يُلمس ضمن حفظ المشروع في التطبيق).
 */
const path = require('path');

module.exports = function initExpenses(ctx) {
  const {
    app, DATA_DIR, PUBLIC_DIR, readJSON, writeJSON, fs,
    auth, isAdmin, loadProject, canAccessProject,
    companyIntegration, setIntegrationStatus
  } = ctx;

  const EXPENSES_DIR = path.join(DATA_DIR, 'expenses');
  fs.mkdirSync(EXPENSES_DIR, { recursive: true });

  const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
  const now = () => new Date().toISOString();
  const TYPES = ['material', 'salary', 'other'];

  function expFile(id) { return path.join(EXPENSES_DIR, id + '.json'); }
  function loadExpenses(projectId) { return readJSON(expFile(projectId), { version: 0, items: [] }); }
  function saveExpenses(projectId, obj) { obj.version = (obj.version || 0) + 1; writeJSON(expFile(projectId), obj); return obj; }
  function nextExpId(store) { return 'exp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  // صلاحية الكتابة: الأدمن/العميل/مدير المشاريع/مدير المشروع ممن يملك وصولاً للمشروع.
  // مدير المشروع (pm) يصل فقط لمشروعه المعيّن (canAccessProject يفرض ذلك) ويُدخل مصاريف مشروعه.
  function canWrite(user, project) {
    return canAccessProject(user, project) && ['admin', 'client', 'pmo', 'pm'].includes(user.role);
  }

  function cleanDocs(arr) {
    return Array.isArray(arr) ? arr.filter(d => d && d.url).map(d => ({ url: String(d.url), name: String(d.name || 'ملف') })).slice(0, 15) : [];
  }

  // تطبيع سجل مصروف وحسابه
  function normalizeExpense(body, user) {
    const type = TYPES.includes(body.type) ? body.type : 'other';
    const amount = round2(body.amount);
    const vatRate = body.vatRate != null ? Number(body.vatRate) : (type === 'material' ? 15 : 0);
    const vat = body.vat != null ? round2(body.vat) : round2(amount * (vatRate || 0) / 100);
    return {
      type,
      date: String(body.date || '').slice(0, 10) || now().slice(0, 10),
      description: String(body.description || '').trim(),
      supplier: String(body.supplier || '').trim(),
      amount, vatRate: Number(vatRate) || 0, vat, total: round2(amount + vat),
      taxInvoiceNo: String(body.taxInvoiceNo || '').trim(),
      taxInvoiceDate: String(body.taxInvoiceDate || '').slice(0, 10),
      category: String(body.category || '').trim(),
      boqItemId: body.boqItemId || null,
      month: type === 'salary' ? String(body.month || '').slice(0, 7) : '',
      headcount: type === 'salary' ? (Number(body.headcount) || 0) : 0,
      // التحميل: 'own' = ذاتي (على الشركة، تكلفة مشروع) | 'sub' = على مقاول باطن (تُسترد بالخصم من مستخلصه)
      bearer: body.bearer === 'sub' ? 'sub' : 'own',
      subId: body.bearer === 'sub' ? (Number(body.subId) || null) : null,
      settledMusNo: body.settledMusNo || null,   // رقم مستخلص الباطن الذي خُصمت فيه (null = لم تُخصم بعد)
      settledAt: body.settledAt || null,
      // إثبات الدفع: كم دُفع فعلاً + تاريخ التحويل + مرجع + مرفقات إثبات التحويل
      paidAmount: body.paidAmount != null ? round2(body.paidAmount) : 0,
      paidAt: String(body.paidAt || '').slice(0, 10),
      paymentRef: String(body.paymentRef || '').trim(),
      paymentDocs: cleanDocs(body.paymentDocs),
      docs: cleanDocs(body.docs)
    };
  }

  // المصاريف المحمّلة على مقاولي الباطن وغير المخصومة بعد (لكل مقاول)
  function outstandingSubCharges(items) {
    const bySub = {};
    (items || []).forEach(e => {
      if (e.bearer === 'sub' && e.subId && !e.settledMusNo) {
        const k = e.subId;
        if (!bySub[k]) bySub[k] = { subId: e.subId, total: 0, byType: { material: 0, salary: 0, other: 0 }, count: 0, items: [] };
        bySub[k].total = round2(bySub[k].total + (Number(e.amount) || 0));
        bySub[k].byType[e.type] = round2((bySub[k].byType[e.type] || 0) + (Number(e.amount) || 0));
        bySub[k].count++;
        bySub[k].items.push({ id: e.id, type: e.type, amount: e.amount, description: e.description, date: e.date });
      }
    });
    return bySub;
  }

  // ------- حساب ربحية المشروع -------
  function profitability(project, items) {
    const mus = project.mustakhlasat || [];
    const subs = project.subMustakhlasat || [];
    const boq = project.boqItems || [];
    // الإنتاجية (قيمة الأعمال المعتمدة من الاستشاري) = الكمية المعتمدة × سعر الوحدة — المقياس الذي يهم مدير المشروع
    const approvedWork = round2(boq.reduce((s, it) => {
      const aq = it.approvedQty != null ? (Number(it.approvedQty) || 0) : (Number(it.executedQty) || 0);
      return s + aq * (Number(it.unitRate) || 0);
    }, 0));
    const executedWork = round2(boq.reduce((s, it) => s + (Number(it.executedQty) || 0) * (Number(it.unitRate) || 0), 0));
    // الإيراد عبر المستخلصات (معلومة إضافية للمالك)
    const revenueCertified = round2(mus.filter(m => m.status !== 'rejected' && m.status !== 'submitted').reduce((s, m) => s + (Number(m.gross) || 0), 0));
    const revenueSubmitted = round2(mus.filter(m => m.status === 'submitted').reduce((s, m) => s + (Number(m.gross) || 0), 0));
    const collected = round2(mus.reduce((s, m) => s + (m.payments || []).reduce((a, p) => a + (Number(p.amount) || 0), 0), 0));
    // التكاليف
    const subCost = round2(subs.filter(m => m.status !== 'rejected').reduce((s, m) => s + (Number(m.gross) || 0), 0));
    const subPaid = round2(subs.reduce((s, m) => s + (m.payments || []).reduce((a, p) => a + (Number(p.amount) || 0), 0), 0));
    // التكاليف الذاتية فقط (bearer='own'). المصاريف المحمّلة على مقاول باطن تُسترد منه فلا تُحمّل على المشروع.
    const byType = { material: 0, salary: 0, other: 0 };
    let chargedToSubs = 0;
    items.forEach(e => {
      if (e.bearer === 'sub') { chargedToSubs = round2(chargedToSubs + (Number(e.amount) || 0)); return; }
      byType[e.type] = round2((byType[e.type] || 0) + (Number(e.amount) || 0));
    });
    const totalCost = round2(subCost + byType.material + byType.salary + byType.other);
    // الحكم: الإنتاجية المعتمدة مقابل المصاريف
    const income = approvedWork;
    const margin = round2(income - totalCost);
    const marginPct = income > 0 ? round2(margin / income * 100) : 0;
    return {
      productivity: { approved: approvedWork, executed: executedWork },
      revenue: { certified: revenueCertified, submitted: revenueSubmitted, collected },
      costs: { subcontractors: subCost, subPaid, materials: byType.material, salaries: byType.salary, other: byType.other, total: totalCost },
      chargedToSubs,
      income, margin, marginPct, isProfit: margin >= 0,
      note: 'قيم قبل الضريبة. الإنتاجية = قيمة الأعمال المعتمدة من الاستشاري (الكمية المعتمدة × السعر). تكلفة الباطن = مستخلصاته المعتمدة.'
    };
  }

  // ------- دفع مصروف إلى Bassir ERP (اختياري، غير معطِّل) -------
  async function pushExpenseToBassir(companyId, project, exp) {
    if (!companyIntegration || !setIntegrationStatus) return { ok: false, skipped: true };
    const cfg = companyIntegration(companyId);
    if (!cfg.enabled || !cfg.url) return { ok: false, skipped: true };
    const payload = {
      event: 'expense.created', source: 'azoom-project-tracking', sentAt: now(),
      project: { id: project.id, name: (project.info || {}).name || '' },
      expense: {
        id: exp.id, type: exp.type, date: exp.date, description: exp.description,
        supplier: exp.supplier, amount: exp.amount, vat: exp.vat, total: exp.total,
        taxInvoiceNo: exp.taxInvoiceNo, taxInvoiceDate: exp.taxInvoiceDate,
        category: exp.category, month: exp.month
      }
    };
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (cfg.apiKey) headers[cfg.authHeader || 'Authorization'] = (cfg.authPrefix !== undefined ? cfg.authPrefix : 'Bearer ') + cfg.apiKey;
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
      const r = await fetch(cfg.url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal });
      clearTimeout(t);
      setIntegrationStatus(companyId, r.ok ? ('مصروف ' + (exp.supplier || exp.type) + ' → ERP (HTTP ' + r.status + ')') : ('فشل دفع مصروف — HTTP ' + r.status));
      return { ok: r.ok, status: r.status };
    } catch (e) { setIntegrationStatus(companyId, 'فشل دفع مصروف: ' + ((e && e.message) || 'خطأ')); return { ok: false, error: (e && e.message) || 'خطأ' }; }
  }

  // ================= المسارات =================
  function getProjectOr(req, res) {
    const p = loadProject(Number(req.params.id));
    if (!p) { res.status(404).json({ error: 'المشروع غير موجود' }); return null; }
    if (!canAccessProject(req.user, p)) { res.status(403).json({ error: 'لا تملك صلاحية على هذا المشروع' }); return null; }
    return p;
  }

  // التحقق من مقاول الباطن عند التحميل عليه
  function validBearer(p, exp) {
    if (exp.bearer !== 'sub') return true;
    return exp.subId && (p.subcontractors || []).some(s => s.id === exp.subId);
  }

  // قائمة المصاريف + ملخص الربحية + مقاولو الباطن + المصاريف المحمّلة عليهم
  app.get('/api/projects/:id/expenses', auth, (req, res) => {
    const p = getProjectOr(req, res); if (!p) return;
    const db = loadExpenses(p.id);
    res.json({
      version: db.version, items: db.items,
      profitability: profitability(p, db.items),
      subs: (p.subcontractors || []).map(s => ({ id: s.id, name: s.name })),
      subCharges: outstandingSubCharges(db.items),
      canManage: canWrite(req.user, p),
      integrationEnabled: !!(companyIntegration && (companyIntegration(p.companyId) || {}).enabled)
    });
  });

  // المصاريف غير المخصومة المحمّلة على كل مقاول باطن (يستدعيها بنّاء مستخلص الباطن)
  app.get('/api/projects/:id/sub-charges', auth, (req, res) => {
    const p = getProjectOr(req, res); if (!p) return;
    res.json({ bySub: outstandingSubCharges(loadExpenses(p.id).items) });
  });

  // تسوية المصاريف المحمّلة على مقاول بعد خصمها في مستخلصه (تمنع الخصم المزدوج)
  app.post('/api/projects/:id/sub-charges/settle', auth, (req, res) => {
    const p = getProjectOr(req, res); if (!p) return;
    if (!canWrite(req.user, p)) return res.status(403).json({ error: 'غير مصرّح' });
    const subId = Number((req.body || {}).subId); const musNo = String((req.body || {}).musNo || '').trim();
    if (!subId || !musNo) return res.status(400).json({ error: 'subId و musNo مطلوبان' });
    const db = loadExpenses(p.id); let settled = 0, n = 0;
    db.items.forEach(e => {
      if (e.bearer === 'sub' && e.subId === subId && !e.settledMusNo) { e.settledMusNo = musNo; e.settledAt = now(); settled = round2(settled + (Number(e.amount) || 0)); n++; }
    });
    if (n) saveExpenses(p.id, db);
    res.json({ ok: true, settled, count: n });
  });

  app.post('/api/projects/:id/expenses', auth, async (req, res) => {
    const p = getProjectOr(req, res); if (!p) return;
    if (!canWrite(req.user, p)) return res.status(403).json({ error: 'إدارة المصاريف صلاحية الإدارة (أدمن/عميل/مدير مشاريع)' });
    const b = req.body || {};
    const exp = normalizeExpense(b, req.user);
    if (!(exp.amount >= 0) || exp.amount === 0) return res.status(400).json({ error: 'أدخل مبلغاً صحيحاً أكبر من صفر' });
    if (exp.type === 'material' && !exp.docs.length) return res.status(400).json({ error: 'فاتورة المورّد الضريبية إلزامية للمواد — أرفقها' });
    if (!validBearer(p, exp)) return res.status(400).json({ error: 'اختر مقاول باطن صحيحاً للتحميل عليه' });
    exp.id = nextExpId(); exp.by = req.user.name; exp.createdAt = now(); exp.updatedAt = now(); exp.erpSyncedAt = null; exp.erpStatus = '';
    const db = loadExpenses(p.id); db.items.push(exp); saveExpenses(p.id, db);
    // دفع اختياري للـ ERP إن طُلب والتكامل مُفعّل
    if (b.syncErp) { const r = await pushExpenseToBassir(p.companyId, p, exp); if (r.ok) { exp.erpSyncedAt = now(); exp.erpStatus = 'synced'; saveExpenses(p.id, db); } }
    res.json({ ok: true, expense: exp, profitability: profitability(p, db.items) });
  });

  app.put('/api/projects/:id/expenses/:expId', auth, (req, res) => {
    const p = getProjectOr(req, res); if (!p) return;
    if (!canWrite(req.user, p)) return res.status(403).json({ error: 'غير مصرّح' });
    const db = loadExpenses(p.id); const i = db.items.findIndex(x => x.id === req.params.expId);
    if (i < 0) return res.status(404).json({ error: 'المصروف غير موجود' });
    const exp = normalizeExpense({ ...db.items[i], ...req.body }, req.user);
    if (exp.type === 'material' && !exp.docs.length) return res.status(400).json({ error: 'فاتورة المورّد إلزامية للمواد' });
    if (!validBearer(p, exp)) return res.status(400).json({ error: 'اختر مقاول باطن صحيحاً للتحميل عليه' });
    exp.id = db.items[i].id; exp.by = db.items[i].by; exp.createdAt = db.items[i].createdAt; exp.updatedAt = now();
    exp.erpSyncedAt = db.items[i].erpSyncedAt || null; exp.erpStatus = db.items[i].erpStatus || '';
    db.items[i] = exp; saveExpenses(p.id, db);
    res.json({ ok: true, expense: exp, profitability: profitability(p, db.items) });
  });

  app.delete('/api/projects/:id/expenses/:expId', auth, (req, res) => {
    const p = getProjectOr(req, res); if (!p) return;
    if (!canWrite(req.user, p)) return res.status(403).json({ error: 'غير مصرّح' });
    const db = loadExpenses(p.id); const before = db.items.length;
    db.items = db.items.filter(x => x.id !== req.params.expId);
    if (db.items.length === before) return res.status(404).json({ error: 'المصروف غير موجود' });
    saveExpenses(p.id, db);
    res.json({ ok: true, profitability: profitability(p, db.items) });
  });

  // دفع مصروف للـ ERP يدوياً
  app.post('/api/projects/:id/expenses/:expId/sync', auth, async (req, res) => {
    const p = getProjectOr(req, res); if (!p) return;
    if (!canWrite(req.user, p)) return res.status(403).json({ error: 'غير مصرّح' });
    const db = loadExpenses(p.id); const exp = db.items.find(x => x.id === req.params.expId);
    if (!exp) return res.status(404).json({ error: 'غير موجود' });
    const r = await pushExpenseToBassir(p.companyId, p, exp);
    if (r.skipped) return res.status(400).json({ error: 'تكامل Bassir ERP غير مُفعّل لهذه الشركة' });
    if (r.ok) { exp.erpSyncedAt = now(); exp.erpStatus = 'synced'; saveExpenses(p.id, db); }
    res.json({ ok: r.ok, status: r.status, error: r.error });
  });

  // صفحة المصاريف
  app.get('/expenses', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'expenses.html')));

  return { loadExpenses, profitability, pushExpenseToBassir };
};
