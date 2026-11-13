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

  // صلاحية الاعتماد (المالك/الإدارة — ليس مدير المشروع ولا الماليّة).
  function canApprove(user, project) {
    return canAccessProject(user, project) && ['admin', 'client', 'pmo'].includes(user.role);
  }
  // صلاحية الدفع ورفع سند الدفع/صورة الحوالة: المالك أو الماليّة أو الأدمن.
  // موظف الماليّة (finance) يرفع سند الدفع فقط على مصروف معتمد — لا يُدخل مصروفاً ولا يعتمد.
  function canPay(user, project) {
    return canAccessProject(user, project) && ['admin', 'client', 'finance'].includes(user.role);
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
      // الاعتماد (يقوم به المالك/الإدارة، لا مدير المشروع): بانتظار الاعتماد | معتمد كلي | معتمد جزئي
      approvalStatus: ['approved_full', 'approved_partial'].includes(body.approvalStatus) ? body.approvalStatus : 'pending',
      approvedAmount: body.approvedAmount != null ? round2(body.approvedAmount) : 0,
      approvedBy: String(body.approvedBy || '').trim(),
      approvedAt: String(body.approvedAt || '').slice(0, 10),
      // الدفع (يُرفع كشف التحويل بعد اعتماد المالك): كم دُفع فعلاً + تاريخ + مرجع + كشف التحويل
      paidAmount: body.paidAmount != null ? round2(body.paidAmount) : 0,
      paidAt: String(body.paidAt || '').slice(0, 10),
      paymentRef: String(body.paymentRef || '').trim(),
      paymentDocs: cleanDocs(body.paymentDocs),
      // مستندات المصروف (يرفعها مدير المشروع): عرض السعر عند الإدخال، والفاتورة وكشف الاستلام بعد التحويل
      quoteDocs: cleanDocs(body.quoteDocs),        // عرض السعر (Quotation)
      invoiceDocs: cleanDocs(body.invoiceDocs),    // فاتورة المصروف (Invoice)
      deliveryDocs: cleanDocs(body.deliveryDocs),  // كشف الاستلام (Delivery note)
      docs: cleanDocs(body.docs)                   // مرفقات قديمة (توافق رجعي)
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
      canApprove: canApprove(req.user, p),
      canPay: canPay(req.user, p),
      role: req.user.role,
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
    // فاتورة المصروف وكشف الاستلام يُرفعان بعد التحويل (خطوة لاحقة لمدير المشروع) — لا يُشترطان عند الإدخال
    if (!validBearer(p, exp)) return res.status(400).json({ error: 'اختر مقاول باطن صحيحاً للتحميل عليه' });
    // مصروف جديد = بانتظار اعتماد المالك دائماً؛ لا اعتماد/دفع عند الإدخال (خطوة منفصلة للمالك)
    exp.approvalStatus = 'pending'; exp.approvedAmount = 0; exp.approvedBy = ''; exp.approvedAt = '';
    exp.paidAmount = 0; exp.paidAt = ''; exp.paymentRef = ''; exp.paymentDocs = [];
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
    const prev = db.items[i];
    const exp = normalizeExpense({ ...prev, ...req.body }, req.user);
    if (!validBearer(p, exp)) return res.status(400).json({ error: 'اختر مقاول باطن صحيحاً للتحميل عليه' });
    // تعديل بيانات المصروف لا يغيّر الاعتماد ولا الدفع (خطوة المالك المنفصلة) — تُحفظ كما هي من السجل المخزّن
    exp.approvalStatus = prev.approvalStatus || 'pending'; exp.approvedAmount = prev.approvedAmount || 0;
    exp.approvedBy = prev.approvedBy || ''; exp.approvedAt = prev.approvedAt || '';
    exp.paidAmount = prev.paidAmount || 0; exp.paidAt = prev.paidAt || ''; exp.paymentRef = prev.paymentRef || ''; exp.paymentDocs = prev.paymentDocs || [];
    exp.id = prev.id; exp.by = prev.by; exp.createdAt = prev.createdAt; exp.updatedAt = now();
    exp.erpSyncedAt = prev.erpSyncedAt || null; exp.erpStatus = prev.erpStatus || '';
    db.items[i] = exp; saveExpenses(p.id, db);
    res.json({ ok: true, expense: exp, profitability: profitability(p, db.items) });
  });

  // اعتماد المصروف (كلي/جزئي) وتسجيل الدفع ورفع سند الدفع — الاعتماد للمالك/الإدارة، والدفع للمالك/الماليّة
  app.post('/api/projects/:id/expenses/:expId/review', auth, (req, res) => {
    const p = getProjectOr(req, res); if (!p) return;
    const b = req.body || {};
    const wantsApproval = b.approvalStatus !== undefined;
    const wantsPayment = (b.paidAmount !== undefined || b.paymentDocs !== undefined || b.paidAt !== undefined || b.paymentRef !== undefined);
    if (!wantsApproval && !wantsPayment) return res.status(400).json({ error: 'لا يوجد تغيير' });
    if (wantsApproval && !canApprove(req.user, p)) return res.status(403).json({ error: 'الاعتماد صلاحية المالك/الإدارة فقط — إدخال المصروف لمدير المشروع' });
    if (wantsPayment && !canPay(req.user, p)) return res.status(403).json({ error: 'تسجيل الدفع ورفع سند الدفع صلاحية المالك أو موظف الماليّة فقط' });
    const db = loadExpenses(p.id); const i = db.items.findIndex(x => x.id === req.params.expId);
    if (i < 0) return res.status(404).json({ error: 'المصروف غير موجود' });
    const e = db.items[i];
    const total = round2(e.total || e.amount || 0);
    // ---- الاعتماد ----
    if (b.approvalStatus !== undefined) {
      if (b.approvalStatus === 'approved_full') {
        e.approvalStatus = 'approved_full'; e.approvedAmount = total;
      } else if (b.approvalStatus === 'approved_partial') {
        const amt = round2(b.approvedAmount);
        if (!(amt > 0) || amt > total + 0.01) return res.status(400).json({ error: 'مبلغ الاعتماد الجزئي يجب أن يكون أكبر من صفر ولا يتجاوز إجمالي المصروف' });
        e.approvalStatus = 'approved_partial'; e.approvedAmount = amt;
      } else if (b.approvalStatus === 'pending') {
        e.approvalStatus = 'pending'; e.approvedAmount = 0; e.approvedBy = ''; e.approvedAt = '';
      } else {
        return res.status(400).json({ error: 'حالة اعتماد غير صحيحة' });
      }
      if (e.approvalStatus !== 'pending') { e.approvedBy = req.user.name; e.approvedAt = now().slice(0, 10); }
    }
    // ---- الدفع (كشف التحويل يُرفع بعد الاعتماد) ----
    if (b.paidAmount !== undefined || b.paymentDocs !== undefined || b.paidAt !== undefined || b.paymentRef !== undefined) {
      if (e.approvalStatus === 'pending') return res.status(400).json({ error: 'لا يمكن تسجيل الدفع قبل اعتماد المصروف' });
      if (b.paidAmount !== undefined) e.paidAmount = round2(b.paidAmount);
      if (b.paidAt !== undefined) e.paidAt = String(b.paidAt || '').slice(0, 10);
      if (b.paymentRef !== undefined) e.paymentRef = String(b.paymentRef || '').trim();
      if (b.paymentDocs !== undefined) e.paymentDocs = cleanDocs(b.paymentDocs);
    }
    e.updatedAt = now();
    db.items[i] = e; saveExpenses(p.id, db);
    res.json({ ok: true, expense: e, profitability: profitability(p, db.items) });
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
