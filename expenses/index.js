'use strict';
/*
 * وحدة مصاريف وتكاليف المشروع: تسجّل المواد (بفواتير الموردين) والرواتب الموزّعة والنثريات،
 * وتجمّع تكلفة مستخلصات الباطن ومستخلصات العميل حيّاً من ملف المشروع (بلا ازدواج)، وتعرض ربحية
 * المشروع (الإيراد ناقص التكلفة). تتبّع تكاليف فقط — ليست محاسبة — وتغذّي Bassir ERP باتجاه واحد
 * ولا تحلّ محله: لا قيود دفتر أستاذ، لا احتساب رواتب فعلي (GOSI/WPS)، لا تنفيذ دفع فعلي، لا إقرارات ضريبية.
 *
 * التخزين منفصل عمداً عن ملف المشروع (data/expenses/<projectId>.json) حتى لا يُفقد أو يُستبدل
 * عند أي حفظ كامل لبيانات المشروع (PUT /api/projects/:id يستبدل الملف بالكامل).
 */
const path = require('path');
const crypto = require('crypto');

module.exports = function initExpenses(ctx) {
  const {
    app, DATA_DIR, PUBLIC_DIR,
    readJSON, writeJSON, fs,
    auth, isAdmin, loadProject, canAccessProject,
    companyIntegration, setIntegrationStatus
  } = ctx;

  const EXPENSES_DIR = path.join(DATA_DIR, 'expenses');
  fs.mkdirSync(EXPENSES_DIR, { recursive: true });

  const expenseFile = projectId => path.join(EXPENSES_DIR, String(projectId) + '.json');
  const loadExpenses = projectId => readJSON(expenseFile(projectId), { version: 0, items: [] });
  const saveExpenses = (projectId, data) => writeJSON(expenseFile(projectId), data);

  const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
  const genId = () => 'exp_' + crypto.randomBytes(10).toString('hex');
  const now = () => new Date().toISOString();
  const TYPES = ['material', 'salary', 'other'];

  // من يدير (إضافة/تعديل/حذف/مزامنة)؟ admin/client/pmo — مدير المشروع (pm) قراءة فقط
  const canManage = user => isAdmin(user) || ['client', 'pmo'].includes(user.role);

  function loadProjectOr404(req, res) {
    const id = Number(req.params.id);
    const p = loadProject(id);
    if (!p) { res.status(404).json({ error: 'project_not_found' }); return null; }
    if (!canAccessProject(req.user, p)) { res.status(403).json({ error: 'no_project_access' }); return null; }
    return p;
  }

  // ---------- ربحية المشروع: إيراد حيّ من مستخلصات العميل، تكلفة الباطن حيّة من مستخلصاته، + النثريات هنا ----------
  function profitability(project, items) {
    const mus = project.mustakhlasat || [];
    const revenueCertified = round2(mus.filter(m => ['approved', 'paid'].includes(m.status)).reduce((s, m) => s + (Number(m.gross) || 0), 0));
    const revenueSubmitted = round2(mus.filter(m => m.status === 'submitted').reduce((s, m) => s + (Number(m.gross) || 0), 0));
    const revenueCollected = round2(mus.reduce((s, m) => s + (m.payments || []).reduce((a, p) => a + (Number(p.amount) || 0), 0), 0));

    const subMus = project.subMustakhlasat || [];
    const costSubcontractors = round2(subMus.filter(m => m.status !== 'rejected').reduce((s, m) => s + (Number(m.gross) || 0), 0));
    const costMaterials = round2(items.filter(i => i.type === 'material').reduce((s, i) => s + (Number(i.amount) || 0), 0));
    const costSalaries = round2(items.filter(i => i.type === 'salary').reduce((s, i) => s + (Number(i.amount) || 0), 0));
    const costOther = round2(items.filter(i => i.type === 'other').reduce((s, i) => s + (Number(i.amount) || 0), 0));
    const costTotal = round2(costSubcontractors + costMaterials + costSalaries + costOther);

    const margin = round2(revenueCertified - costTotal);
    const marginPct = revenueCertified > 0 ? round2(margin / revenueCertified * 100) : 0;

    return {
      revenue: { certified: revenueCertified, submitted: revenueSubmitted, collected: revenueCollected },
      costs: { subcontractors: costSubcontractors, materials: costMaterials, salaries: costSalaries, other: costOther, total: costTotal },
      margin, marginPct
    };
  }

  // ---------- دفع المصروف إلى Bassir ERP (باتجاه واحد، لا يوقف الحفظ مهما حدث) ----------
  async function pushExpenseToErp(project, exp) {
    const cfg = companyIntegration(project.companyId);
    if (!cfg.enabled || !cfg.url) return { ok: false, reason: 'integration_disabled' };
    const payload = {
      event: 'expense.created', source: 'azoom-project-tracking', sentAt: now(),
      project: { id: project.id, name: (project.info || {}).name || '' },
      expense: {
        id: exp.id, type: exp.type, date: exp.date, description: exp.description, supplier: exp.supplier || '',
        amount: exp.amount, vat: exp.vat, total: exp.total, taxInvoiceNo: exp.taxInvoiceNo || '',
        taxInvoiceDate: exp.taxInvoiceDate || '', category: exp.category || '', month: exp.month || ''
      }
    };
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (cfg.apiKey) headers[cfg.authHeader || 'Authorization'] = (cfg.authPrefix !== undefined ? cfg.authPrefix : 'Bearer ') + cfg.apiKey;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      const r = await fetch(cfg.url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal });
      clearTimeout(t);
      const status = r.ok ? ('success — ' + exp.id + ' (HTTP ' + r.status + ')') : ('failed — HTTP ' + r.status);
      setIntegrationStatus(project.companyId, status);
      return { ok: r.ok, status };
    } catch (e) {
      const status = 'send failed: ' + (e && e.message ? e.message : 'connection error');
      setIntegrationStatus(project.companyId, status);
      return { ok: false, status };
    }
  }

  // ---------- فحص صحة سجل المصروف ----------
  function validateExpense(body, project) {
    const type = String(body.type || '');
    if (!TYPES.includes(type)) return 'نوع المصروف غير معروف';
    if (!body.date) return 'التاريخ مطلوب';
    const amount = Number(body.amount);
    if (!(amount > 0)) return 'المبلغ مطلوب ويجب أن يكون أكبر من صفر';
    if (!body.description || !String(body.description).trim()) return 'الوصف مطلوب';
    if (type === 'material' && !(Array.isArray(body.docs) && body.docs.some(d => d && d.url))) {
      return 'إرفاق فاتورة المورد إلزامي لمصاريف المواد';
    }
    if (body.boqItemId && !(project.boqItems || []).some(i => i.id === body.boqItemId)) {
      return 'رقم البند غير موجود في جدول الكميات';
    }
    const vatRate = Number(body.vatRate) || 0;
    if (vatRate < 0 || vatRate > 100) return 'نسبة الضريبة غير صحيحة';
    return null;
  }
  function buildExpenseFields(body) {
    const amount = round2(body.amount);
    const vatRate = Number(body.vatRate) || 0;
    const vat = round2(amount * vatRate / 100);
    return {
      type: body.type, date: body.date, description: String(body.description).trim(),
      supplier: String(body.supplier || '').trim(), amount, vatRate, vat, total: round2(amount + vat),
      taxInvoiceNo: String(body.taxInvoiceNo || '').trim(), taxInvoiceDate: body.taxInvoiceDate || '',
      category: String(body.category || '').trim(), boqItemId: body.boqItemId || null,
      month: String(body.month || '').trim(), headcount: body.headcount != null ? Number(body.headcount) || 0 : null,
      docs: Array.isArray(body.docs) ? body.docs.filter(d => d && d.url).map(d => ({ url: d.url, name: d.name || '' })) : []
    };
  }

  // ---------- GET: البنود + ملخص الربحية + الصلاحيات ----------
  app.get('/api/projects/:id/expenses', auth, (req, res) => {
    const project = loadProjectOr404(req, res); if (!project) return;
    const store = loadExpenses(project.id);
    res.json({
      items: store.items || [],
      profitability: profitability(project, store.items || []),
      canManage: canManage(req.user),
      integrationEnabled: !!companyIntegration(project.companyId).enabled
    });
  });

  // ---------- POST: إضافة مصروف ----------
  app.post('/api/projects/:id/expenses', auth, async (req, res) => {
    const project = loadProjectOr404(req, res); if (!project) return;
    if (!canManage(req.user)) return res.status(403).json({ error: 'إضافة المصاريف ليست من صلاحيتك' });
    const err = validateExpense(req.body || {}, project);
    if (err) return res.status(400).json({ error: err });
    const store = loadExpenses(project.id);
    const exp = { id: genId(), ...buildExpenseFields(req.body || {}), by: req.user.name, createdAt: now(), updatedAt: now(), erpSyncedAt: null, erpStatus: '' };
    store.items = store.items || []; store.items.push(exp); store.version = (store.version || 0) + 1;
    saveExpenses(project.id, store);
    if ((req.body || {}).syncErp) {
      const r = await pushExpenseToErp(project, exp);
      exp.erpSyncedAt = now(); exp.erpStatus = r.status || (r.ok ? 'success' : 'failed');
      saveExpenses(project.id, store);
    }
    res.json({ ok: true, item: exp });
  });

  // ---------- PUT: تعديل مصروف ----------
  app.put('/api/projects/:id/expenses/:expId', auth, (req, res) => {
    const project = loadProjectOr404(req, res); if (!project) return;
    if (!canManage(req.user)) return res.status(403).json({ error: 'تعديل المصاريف ليس من صلاحيتك' });
    const store = loadExpenses(project.id);
    const exp = (store.items || []).find(x => x.id === req.params.expId);
    if (!exp) return res.status(404).json({ error: 'المصروف غير موجود' });
    const err = validateExpense(req.body || {}, project);
    if (err) return res.status(400).json({ error: err });
    Object.assign(exp, buildExpenseFields(req.body || {}), { updatedAt: now() });
    store.version = (store.version || 0) + 1;
    saveExpenses(project.id, store);
    res.json({ ok: true, item: exp });
  });

  // ---------- DELETE: حذف مصروف ----------
  app.delete('/api/projects/:id/expenses/:expId', auth, (req, res) => {
    const project = loadProjectOr404(req, res); if (!project) return;
    if (!canManage(req.user)) return res.status(403).json({ error: 'حذف المصاريف ليس من صلاحيتك' });
    const store = loadExpenses(project.id);
    const before = (store.items || []).length;
    store.items = (store.items || []).filter(x => x.id !== req.params.expId);
    if (store.items.length === before) return res.status(404).json({ error: 'المصروف غير موجود' });
    store.version = (store.version || 0) + 1;
    saveExpenses(project.id, store);
    res.json({ ok: true });
  });

  // ---------- POST: دفع مصروف واحد يدوياً لـ Bassir ERP ----------
  app.post('/api/projects/:id/expenses/:expId/sync', auth, async (req, res) => {
    const project = loadProjectOr404(req, res); if (!project) return;
    if (!canManage(req.user)) return res.status(403).json({ error: 'مزامنة المصاريف ليست من صلاحيتك' });
    const store = loadExpenses(project.id);
    const exp = (store.items || []).find(x => x.id === req.params.expId);
    if (!exp) return res.status(404).json({ error: 'المصروف غير موجود' });
    const cfg = companyIntegration(project.companyId);
    if (!cfg.enabled || !cfg.url) return res.status(400).json({ error: 'تكامل Bassir ERP غير مفعّل لهذه الشركة' });
    const r = await pushExpenseToErp(project, exp);
    exp.erpSyncedAt = now(); exp.erpStatus = r.status || (r.ok ? 'success' : 'failed');
    saveExpenses(project.id, store);
    res.json({ ok: r.ok, status: exp.erpStatus });
  });

  // ---------- صفحة المصاريف الثابتة ----------
  app.get('/expenses', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'expenses.html')));

  return { profitability, loadExpenses };
};
