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

  // صلاحية الكتابة: الأدمن/العميل/مدير المشاريع ممن يملك وصولاً للمشروع (مدير الموقع: قراءة فقط)
  function canWrite(user, project) {
    return canAccessProject(user, project) && ['admin', 'client', 'pmo'].includes(user.role);
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
      docs: Array.isArray(body.docs) ? body.docs.filter(d => d && d.url).map(d => ({ url: String(d.url), name: String(d.name || 'ملف') })).slice(0, 15) : []
    };
  }

  // ------- حساب ربحية المشروع -------
  function profitability(project, items) {
    const mus = project.mustakhlasat || [];
    const subs = project.subMustakhlasat || [];
    // الإيراد: قيمة الأعمال (gross، قبل الضريبة) للمستخلصات غير المرفوضة
    const revenueCertified = round2(mus.filter(m => m.status !== 'rejected' && m.status !== 'submitted').reduce((s, m) => s + (Number(m.gross) || 0), 0));
    const revenueSubmitted = round2(mus.filter(m => m.status === 'submitted').reduce((s, m) => s + (Number(m.gross) || 0), 0));
    const collected = round2(mus.reduce((s, m) => s + (m.payments || []).reduce((a, p) => a + (Number(p.amount) || 0), 0), 0));
    // التكاليف
    const subCost = round2(subs.filter(m => m.status !== 'rejected').reduce((s, m) => s + (Number(m.gross) || 0), 0));
    const subPaid = round2(subs.reduce((s, m) => s + (m.payments || []).reduce((a, p) => a + (Number(p.amount) || 0), 0), 0));
    const byType = { material: 0, salary: 0, other: 0 };
    items.forEach(e => { byType[e.type] = round2((byType[e.type] || 0) + (Number(e.amount) || 0)); });
    const totalCost = round2(subCost + byType.material + byType.salary + byType.other);
    const margin = round2(revenueCertified - totalCost);
    const marginPct = revenueCertified > 0 ? round2(margin / revenueCertified * 100) : 0;
    return {
      revenue: { certified: revenueCertified, submitted: revenueSubmitted, collected },
      costs: { subcontractors: subCost, subPaid, materials: byType.material, salaries: byType.salary, other: byType.other, total: totalCost },
      margin, marginPct,
      note: 'قيم قبل الضريبة (قيمة الأعمال). الإيراد = مستخلصات العميل المعتمدة؛ تكلفة الباطن = مستخلصاته المعتمدة.'
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

  // قائمة المصاريف + ملخص الربحية
  app.get('/api/projects/:id/expenses', auth, (req, res) => {
    const p = getProjectOr(req, res); if (!p) return;
    const db = loadExpenses(p.id);
    res.json({
      version: db.version, items: db.items,
      profitability: profitability(p, db.items),
      canManage: canWrite(req.user, p),
      integrationEnabled: !!(companyIntegration && (companyIntegration(p.companyId) || {}).enabled)
    });
  });

  app.post('/api/projects/:id/expenses', auth, async (req, res) => {
    const p = getProjectOr(req, res); if (!p) return;
    if (!canWrite(req.user, p)) return res.status(403).json({ error: 'إدارة المصاريف صلاحية الإدارة (أدمن/عميل/مدير مشاريع)' });
    const b = req.body || {};
    const exp = normalizeExpense(b, req.user);
    if (!(exp.amount >= 0) || exp.amount === 0) return res.status(400).json({ error: 'أدخل مبلغاً صحيحاً أكبر من صفر' });
    if (exp.type === 'material' && !exp.docs.length) return res.status(400).json({ error: 'فاتورة المورّد الضريبية إلزامية للمواد — أرفقها' });
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
