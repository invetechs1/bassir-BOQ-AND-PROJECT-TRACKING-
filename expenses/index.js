'use strict';
/*
 * وحدة مصاريف وتكاليف المشروع (تتبّع تكاليف + ربحية، تغذّي Bassir ERP ولا تحل محله):
 * تسجّل المواد (بفواتير الموردين) والرواتب الموزّعة والنثريات، وتجمّع تكلفة مستخلصات الباطن
 * ومستخلصات العميل حيّاً من ملف المشروع (بلا ازدواج)، وتعرض ربحية المشروع (الإيراد ناقص التكلفة).
 * تتبّع تكاليف فقط — ليست محاسبة: لا قيود دفتر أستاذ، لا احتساب رواتب فعلي (GOSI/WPS)،
 * لا تنفيذ دفع فعلي، لا إقرارات ضريبية.
 *
 * دورة حياة المصروف: مدير المشروع (pm) يُدخل المصروف فقط (بلا اعتماد ولا دفع) ← المالك/الإدارة
 * (admin/client) يعتمده كاملاً أو جزئياً أو يرفضه ← بعد الاعتماد فقط، المالك يسجّل مبلغ الدفع الفعلي
 * ويرفع كشف التحويل البنكي كإثبات. كل خطوة منفصلة عن التي تليها ومحفوظة بصلاحية مختلفة.
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

  // من يدير (إضافة/تعديل/مزامنة)؟ admin/client/pmo/pm — كل الأدوار التشغيلية على المشروع.
  // الحذف مستثنى عمداً من هذا الفحص (انظر أسفل) — أي مستخدم يملك صلاحية الوصول لهذا المشروع يمكنه الحذف،
  // بصرف النظر عن دوره، لأن هذه وحدة تتبّع تكاليف وليست دفتر محاسبة (انظر التعليق أعلى الملف).
  const canManage = user => isAdmin(user) || ['client', 'pmo', 'pm'].includes(user.role);
  // من يعتمد/يرفض/يدفع المصروف؟ أدمن النظام والعميل (مالك الشركة) فقط — وليس مدير المشاريع (pmo)
  // ولا مدير المشروع (pm). مدير المشروع يُدخل المصروف فقط؛ المالك يعتمده ويسجّل دفعه.
  const canApprove = user => isAdmin(user) || user.role === 'client';
  // المساهمة الفعلية للمصروف في إجمالي التكلفة/الربحية بعد الاعتماد:
  // مرفوض = صفر، معتمد جزئياً = المبلغ المعتمد فقط، معتمد كامل أو لم يُراجَع بعد = كامل المبلغ
  // (عدم تغيير سلوك المصاريف القديمة التي لا تحمل حالة اعتماد أصلاً — توافق خلفي).
  function approvedCost(i) {
    if (i.status === 'rejected') return 0;
    if (i.status === 'partially_approved') return round2(Number(i.approvedAmount) || 0);
    return round2(Number(i.amount) || 0);
  }

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
    // مصاريف ذاتية فقط (bearer='own') تُحتسب على تكلفة المشروع — المحمّلة على مقاول باطن تُسترد منه فلا تُحمَّل على المشروع
    const ownItems = items.filter(i => i.bearer !== 'sub');
    const costMaterials = round2(ownItems.filter(i => i.type === 'material').reduce((s, i) => s + approvedCost(i), 0));
    const costSalaries = round2(ownItems.filter(i => i.type === 'salary').reduce((s, i) => s + approvedCost(i), 0));
    const costOther = round2(ownItems.filter(i => i.type === 'other').reduce((s, i) => s + approvedCost(i), 0));
    const costTotal = round2(costSubcontractors + costMaterials + costSalaries + costOther);
    const chargedToSubs = round2(items.filter(i => i.bearer === 'sub').reduce((s, i) => s + approvedCost(i), 0));

    const margin = round2(revenueCertified - costTotal);
    const marginPct = revenueCertified > 0 ? round2(margin / revenueCertified * 100) : 0;

    return {
      revenue: { certified: revenueCertified, submitted: revenueSubmitted, collected: revenueCollected },
      costs: { subcontractors: costSubcontractors, materials: costMaterials, salaries: costSalaries, other: costOther, total: costTotal },
      chargedToSubs,
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
    // عرض السعر يُرفع عند الإدخال (اختياري)؛ الفاتورة وكشف الاستلام يصلان لاحقاً بعد التحويل —
    // لذا لا يُشترط أي مستند عند إنشاء مصروف المواد (كان يُشترط سابقاً قبل فصل المستندات الثلاثة).
    if (body.boqItemId && !(project.boqItems || []).some(i => i.id === body.boqItemId)) {
      return 'رقم البند غير موجود في جدول الكميات';
    }
    const vatRate = Number(body.vatRate) || 0;
    if (vatRate < 0 || vatRate > 100) return 'نسبة الضريبة غير صحيحة';
    // التحميل على مقاول باطن: لا بد من مقاول صحيح مسجَّل في هذا المشروع
    if (body.bearer === 'sub') {
      const subId = Number(body.subId);
      if (!subId || !(project.subcontractors || []).some(s => s.id === subId)) return 'اختر مقاول باطن صحيحاً للتحميل عليه';
    }
    return null;
  }
  function cleanDocs(arr) {
    return Array.isArray(arr) ? arr.filter(d => d && d.url).map(d => ({ url: String(d.url), name: String(d.name || 'ملف') })).slice(0, 15) : [];
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
      // التحميل: 'own' = ذاتي (تكلفة مشروع كالمعتاد) | 'sub' = على مقاول باطن (يُستبعد من تكلفة المشروع ويُخصم من مستخلصه)
      bearer: body.bearer === 'sub' ? 'sub' : 'own',
      subId: body.bearer === 'sub' ? (Number(body.subId) || null) : null,
      // مستندات المصروف الثلاثة (يرفعها مدير المشروع): عرض السعر عند الإدخال، والفاتورة وكشف الاستلام بعد التحويل
      quoteDocs: cleanDocs(body.quoteDocs),        // عرض السعر (Quotation)
      invoiceDocs: cleanDocs(body.invoiceDocs),    // فاتورة المصروف (Invoice)
      deliveryDocs: cleanDocs(body.deliveryDocs),  // كشف الاستلام (Delivery note)
      docs: cleanDocs(body.docs)                   // مرفقات قديمة (توافق رجعي)
    };
  }
  // المصاريف المحمّلة على مقاولي الباطن وغير المخصومة بعد (لكل مقاول) — يستدعيها بنّاء مستخلص الباطن
  function outstandingSubCharges(items) {
    const bySub = {};
    (items || []).forEach(e => {
      if (e.bearer === 'sub' && e.subId && !e.settledMusNo && e.status !== 'rejected') {
        const k = e.subId;
        if (!bySub[k]) bySub[k] = { subId: e.subId, total: 0, byType: { material: 0, salary: 0, other: 0 }, count: 0, items: [] };
        bySub[k].total = round2(bySub[k].total + approvedCost(e));
        bySub[k].byType[e.type] = round2((bySub[k].byType[e.type] || 0) + approvedCost(e));
        bySub[k].count++;
        bySub[k].items.push({ id: e.id, type: e.type, amount: e.amount, description: e.description, date: e.date });
      }
    });
    return bySub;
  }

  // ---------- GET: البنود + ملخص الربحية + الصلاحيات ----------
  app.get('/api/projects/:id/expenses', auth, (req, res) => {
    const project = loadProjectOr404(req, res); if (!project) return;
    const store = loadExpenses(project.id);
    res.json({
      items: store.items || [],
      profitability: profitability(project, store.items || []),
      subs: (project.subcontractors || []).map(s => ({ id: s.id, name: s.name })),
      subCharges: outstandingSubCharges(store.items || []),
      canManage: canManage(req.user),
      canDelete: true, // أي دور يملك صلاحية الوصول لهذا المشروع يمكنه الحذف (انظر تعليق DELETE أدناه)
      canApprove: canApprove(req.user),
      integrationEnabled: !!companyIntegration(project.companyId).enabled
    });
  });

  // ---------- GET: المصاريف المحمّلة على كل مقاول باطن وغير المسوَّاة بعد (يستدعيها بنّاء مستخلص الباطن) ----------
  app.get('/api/projects/:id/sub-charges', auth, (req, res) => {
    const project = loadProjectOr404(req, res); if (!project) return;
    res.json({ bySub: outstandingSubCharges(loadExpenses(project.id).items || []) });
  });

  // ---------- POST: تسوية المصاريف المحمّلة على مقاول بعد خصمها في مستخلصه (تمنع الخصم المزدوج) ----------
  app.post('/api/projects/:id/sub-charges/settle', auth, (req, res) => {
    const project = loadProjectOr404(req, res); if (!project) return;
    if (!canManage(req.user)) return res.status(403).json({ error: 'غير مصرّح' });
    const subId = Number((req.body || {}).subId);
    const musNo = String((req.body || {}).musNo || '').trim();
    if (!subId || !musNo) return res.status(400).json({ error: 'subId و musNo مطلوبان' });
    const store = loadExpenses(project.id);
    let settled = 0, count = 0;
    (store.items || []).forEach(e => {
      if (e.bearer === 'sub' && e.subId === subId && !e.settledMusNo && e.status !== 'rejected') {
        e.settledMusNo = musNo; e.settledAt = now();
        settled = round2(settled + approvedCost(e)); count++;
      }
    });
    if (count) { store.version = (store.version || 0) + 1; saveExpenses(project.id, store); }
    res.json({ ok: true, settled, count });
  });

  // ---------- POST: إضافة مصروف — مدير المشروع يُدخلها فقط، بلا اعتماد ولا دفع (خطوة منفصلة للمالك) ----------
  app.post('/api/projects/:id/expenses', auth, async (req, res) => {
    const project = loadProjectOr404(req, res); if (!project) return;
    if (!canManage(req.user)) return res.status(403).json({ error: 'إضافة المصاريف ليست من صلاحيتك' });
    const err = validateExpense(req.body || {}, project);
    if (err) return res.status(400).json({ error: err });
    const store = loadExpenses(project.id);
    const exp = {
      id: genId(), ...buildExpenseFields(req.body || {}), by: req.user.name, createdAt: now(), updatedAt: now(), erpSyncedAt: null, erpStatus: '',
      status: 'pending', approvedAmount: 0, approvedBy: null, approvedAt: null, rejectReason: '',
      settledMusNo: null, settledAt: null, // تُخصَّص فقط عبر /sub-charges/settle بعد بناء مستخلص الباطن
      paidAmount: 0, paidAt: null, paymentRef: '', paymentDocs: [] // تُخصَّص فقط عبر /pay بعد الاعتماد
    };
    store.items = store.items || []; store.items.push(exp); store.version = (store.version || 0) + 1;
    saveExpenses(project.id, store);
    if ((req.body || {}).syncErp) {
      const r = await pushExpenseToErp(project, exp);
      exp.erpSyncedAt = now(); exp.erpStatus = r.status || (r.ok ? 'success' : 'failed');
      saveExpenses(project.id, store);
    }
    res.json({ ok: true, item: exp });
  });

  // ---------- PUT: تعديل مصروف — تعديل البيانات الأساسية فقط، لا يمسّ الاعتماد ولا الدفع ----------
  app.put('/api/projects/:id/expenses/:expId', auth, (req, res) => {
    const project = loadProjectOr404(req, res); if (!project) return;
    if (!canManage(req.user)) return res.status(403).json({ error: 'تعديل المصاريف ليس من صلاحيتك' });
    const store = loadExpenses(project.id);
    const exp = (store.items || []).find(x => x.id === req.params.expId);
    if (!exp) return res.status(404).json({ error: 'المصروف غير موجود' });
    const err = validateExpense(req.body || {}, project);
    if (err) return res.status(400).json({ error: err });
    // مُسوّاة بالفعل ضمن مستخلص مقاول باطن مرفوع — لا يجوز تغيير التحميل بعد ذلك حتى لا يختل مستخلصه
    if (exp.settledMusNo) {
      const bodyBearer = (req.body || {}).bearer === 'sub' ? 'sub' : 'own';
      const bodySubId = bodyBearer === 'sub' ? (Number((req.body || {}).subId) || null) : null;
      if (bodyBearer !== exp.bearer || bodySubId !== exp.subId) {
        return res.status(400).json({ error: 'هذا المصروف سُوّي ضمن مستخلص مقاول الباطن ' + exp.settledMusNo + ' — لا يمكن تغيير التحميل بعد التسوية' });
      }
    }
    Object.assign(exp, buildExpenseFields(req.body || {}), { updatedAt: now() });
    // توافق مع الاعتماد القائم: إن قلّ المبلغ المعدَّل عن اعتماد سابق (كامل أو جزئي)، نقصّ المعتمد ليطابق
    // الواقع الجديد، ونُنزل الاعتماد الكامل إلى جزئي تلقائياً بدل ترك حالة غير متسقة (معتمد > المبلغ الفعلي).
    if ((exp.approvedAmount || 0) > exp.amount) exp.approvedAmount = exp.amount;
    if (exp.status === 'approved' && (exp.approvedAmount || 0) < exp.amount - 0.01) exp.status = 'partially_approved';
    // وبالمثل: لا يصح أن يبقى المدفوع أكبر من المعتمد بعد التعديل
    if ((exp.paidAmount || 0) > (exp.approvedAmount || 0)) exp.paidAmount = exp.approvedAmount || 0;
    store.version = (store.version || 0) + 1;
    saveExpenses(project.id, store);
    res.json({ ok: true, item: exp });
  });

  // ---------- DELETE: حذف مصروف — متاح لأي مستخدم يملك صلاحية الوصول للمشروع (كل الأدوار) ----------
  app.delete('/api/projects/:id/expenses/:expId', auth, (req, res) => {
    const project = loadProjectOr404(req, res); if (!project) return;
    const store = loadExpenses(project.id);
    const existing = (store.items || []).find(x => x.id === req.params.expId);
    // مُسوّاة بالفعل ضمن مستخلص مقاول باطن مرفوع — حذفها يفقد الأثر المحاسبي لذلك المستخلص
    if (existing && existing.settledMusNo) {
      return res.status(400).json({ error: 'هذا المصروف سُوّي ضمن مستخلص مقاول الباطن ' + existing.settledMusNo + ' — لا يمكن حذفه' });
    }
    // دُفع بالفعل (كشف تحويل مرفوع) — حذفها يفقد أثر دفعة حقيقية فعلاً
    if (existing && existing.paidAmount > 0) {
      return res.status(400).json({ error: 'هذا المصروف سُجِّل دفعه بالفعل — لا يمكن حذفه' });
    }
    const before = (store.items || []).length;
    store.items = (store.items || []).filter(x => x.id !== req.params.expId);
    if (store.items.length === before) return res.status(404).json({ error: 'المصروف غير موجود' });
    store.version = (store.version || 0) + 1;
    saveExpenses(project.id, store);
    res.json({ ok: true });
  });

  // ---------- POST: اعتماد مصروف — كاملاً أو جزئياً (مبلغ الاعتماد <= مبلغ المصروف قبل الضريبة) ----------
  app.post('/api/projects/:id/expenses/:expId/approve', auth, (req, res) => {
    const project = loadProjectOr404(req, res); if (!project) return;
    if (!canApprove(req.user)) return res.status(403).json({ error: 'اعتماد المصاريف صلاحية العميل أو أدمن النظام' });
    const store = loadExpenses(project.id);
    const exp = (store.items || []).find(x => x.id === req.params.expId);
    if (!exp) return res.status(404).json({ error: 'المصروف غير موجود' });
    const amount = round2(Number((req.body || {}).amount));
    if (!(amount > 0) || amount > exp.amount + 0.01) return res.status(400).json({ error: 'مبلغ الاعتماد يجب أن يكون أكبر من صفر ولا يتجاوز مبلغ المصروف' });
    // لا يصح إنزال الاعتماد تحت ما دُفع بالفعل
    if (amount < (exp.paidAmount || 0) - 0.01) return res.status(400).json({ error: 'تم دفع ' + exp.paidAmount + ' بالفعل — لا يمكن اعتماد مبلغ أقل من المدفوع' });
    exp.approvedAmount = Math.min(amount, exp.amount);
    exp.status = exp.approvedAmount >= exp.amount - 0.01 ? 'approved' : 'partially_approved';
    exp.approvedBy = req.user.name; exp.approvedAt = now(); exp.rejectReason = '';
    store.version = (store.version || 0) + 1;
    saveExpenses(project.id, store);
    res.json({ ok: true, item: exp });
  });

  // ---------- POST: رفض مصروف ----------
  app.post('/api/projects/:id/expenses/:expId/reject', auth, (req, res) => {
    const project = loadProjectOr404(req, res); if (!project) return;
    if (!canApprove(req.user)) return res.status(403).json({ error: 'رفض المصاريف صلاحية العميل أو أدمن النظام' });
    const store = loadExpenses(project.id);
    const exp = (store.items || []).find(x => x.id === req.params.expId);
    if (!exp) return res.status(404).json({ error: 'المصروف غير موجود' });
    if (exp.paidAmount > 0) return res.status(400).json({ error: 'هذا المصروف دُفع بالفعل — لا يمكن رفضه' });
    exp.status = 'rejected'; exp.approvedAmount = 0;
    exp.rejectReason = String((req.body || {}).reason || '').trim();
    exp.approvedBy = req.user.name; exp.approvedAt = now();
    store.version = (store.version || 0) + 1;
    saveExpenses(project.id, store);
    res.json({ ok: true, item: exp });
  });

  // ---------- POST: تسجيل دفع مصروف معتمد (كلياً أو جزئياً) + رفع كشف التحويل البنكي كإثبات ----------
  // لا يجوز الدفع قبل الاعتماد، ولا يتجاوز المدفوع المبلغ المعتمد — خطوة منفصلة تماماً عن الاعتماد نفسه.
  app.post('/api/projects/:id/expenses/:expId/pay', auth, (req, res) => {
    const project = loadProjectOr404(req, res); if (!project) return;
    if (!canApprove(req.user)) return res.status(403).json({ error: 'تسجيل الدفع صلاحية العميل أو أدمن النظام' });
    const store = loadExpenses(project.id);
    const exp = (store.items || []).find(x => x.id === req.params.expId);
    if (!exp) return res.status(404).json({ error: 'المصروف غير موجود' });
    if (exp.status === 'pending' || exp.status === 'rejected') return res.status(400).json({ error: 'لا يمكن تسجيل الدفع قبل اعتماد المصروف' });
    const body = req.body || {};
    const paidAmount = round2(Number(body.paidAmount));
    const cap = exp.status === 'approved' ? exp.amount : exp.approvedAmount;
    if (!(paidAmount > 0) || paidAmount > cap + 0.01) return res.status(400).json({ error: 'مبلغ الدفع يجب أن يكون أكبر من صفر ولا يتجاوز المبلغ المعتمد (' + cap + ')' });
    const docs = cleanDocs(body.paymentDocs);
    if (!docs.length) return res.status(400).json({ error: 'إرفاق كشف التحويل البنكي إلزامي لتسجيل الدفع' });
    exp.paidAmount = paidAmount;
    exp.paidAt = String(body.paidAt || '').slice(0, 10) || now().slice(0, 10);
    exp.paymentRef = String(body.paymentRef || '').trim();
    exp.paymentDocs = docs;
    exp.updatedAt = now();
    store.version = (store.version || 0) + 1;
    saveExpenses(project.id, store);
    res.json({ ok: true, item: exp });
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
