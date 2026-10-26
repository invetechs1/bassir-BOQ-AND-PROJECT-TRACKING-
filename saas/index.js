'use strict';
/*
 * طبقة SaaS: تأجير (tenant=شركة)، باقات لكل مشروع، فوترة تلقائية، دفع عبر Tap،
 * تفعيل/إيقاف تلقائي حسب السداد، لوحة تحكم المالك، وتسجيل عام من صفحة الهبوط.
 *
 * يُركّب على الخادم القائم: require('./saas')(ctx) ثم ctx يمرّر الدوال المشتركة.
 * tenant.saasManaged=true يعني مُدار بالاشتراك؛ الشركات القديمة تبقى بلا قيود.
 */
const path = require('path');

module.exports = function initSaas(ctx) {
  const {
    app, express, DATA_DIR, UPLOADS_DIR, PUBLIC_DIR,
    readJSON, writeJSON, nextId,
    loadCompanies, saveCompanies, loadUsers, saveUsers,
    listProjects, saveProject,
    bcrypt, auth, isAdmin,
    fs
  } = ctx;

  const store = require('./store')({ dataDir: DATA_DIR, readJSON, writeJSON });
  const B = require('./billing')(store);
  const tap = require('./tap')(store);

  const now = () => new Date().toISOString();
  const adminOnly = (req, res, nx) => isAdmin(req.user) ? nx() : res.status(403).json({ error: 'صلاحية مالك المنصّة فقط' });

  // ---------- أدوات ----------
  function tenantOfUser(user) {
    if (!user || !user.companyId) return null;
    return store.getTenant(user.companyId);
  }
  function dirSize(dir) {
    let total = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        const st = fs.statSync(path.join(dir, f));
        if (st.isFile()) total += st.size; else if (st.isDirectory()) total += dirSize(path.join(dir, f));
      }
    } catch (e) {}
    return total;
  }
  const projectStorageBytes = projectId => dirSize(path.join(UPLOADS_DIR, String(projectId)));
  const GB = 1024 * 1024 * 1024;

  function companyName(companyId) {
    const c = loadCompanies().find(x => x.id === Number(companyId));
    return c ? c.name : ('#' + companyId);
  }
  function publicBaseUrl(req) {
    const envUrl = process.env.PUBLIC_URL;
    if (envUrl) return envUrl.replace(/\/+$/, '');
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return proto + '://' + host;
  }

  // ---------- تطبيق نتيجة عملية الدفع على فاتورة (نقطة الحقيقة الوحيدة) ----------
  function applyChargeResult(invoiceId, result) {
    const inv = store.getInvoice(invoiceId);
    if (!inv) return { ok: false, error: 'invoice not found' };
    if (inv.status === 'paid') return { ok: true, invoice: inv, already: true };
    const tenant = store.getTenant(inv.tenantCompanyId);
    if (!tenant) return { ok: false, error: 'tenant not found' };

    if (result.status === 'captured') {
      store.updateInvoice(inv.id, {
        status: 'paid', paidAt: now(), tapChargeId: result.id || inv.tapChargeId,
        cardLast4: result.cardLast4 || inv.cardLast4, cardBrand: result.cardBrand || inv.cardBrand
      });
      store.addPayment({
        id: store.saasId('pay'), invoiceId: inv.id, tenantCompanyId: tenant.companyId,
        tapChargeId: result.id || inv.tapChargeId, amount: inv.total, currency: inv.currency,
        status: 'captured', cardLast4: result.cardLast4 || inv.cardLast4 || null,
        cardBrand: result.cardBrand || inv.cardBrand || null, kind: inv.kind, at: now()
      });
      provisionPaid(tenant, inv, result);
      pushErpRevenue(tenant, store.getInvoice(inv.id));
      return { ok: true, invoice: store.getInvoice(inv.id) };
    }
    // فشل الدفع
    store.updateInvoice(inv.id, { status: 'failed', lastError: result.error || 'declined', attempts: (inv.attempts || 0) + 1 });
    if (inv.kind === 'renewal' || inv.kind === 'subscription') {
      const cfg = store.loadConfig();
      tenant.status = 'past_due';
      tenant.billing.graceUntil = new Date(Date.now() + (Number(cfg.graceDays) || 3) * 86400000).toISOString();
      store.upsertTenant(tenant);
    }
    return { ok: false, error: result.error || 'declined', invoice: store.getInvoice(inv.id) };
  }

  // تفعيل بعد سداد ناجح: حفظ البطاقة/العميل، فتح الدورة، تفعيل المشاريع
  function provisionPaid(tenant, inv, result) {
    const cfg = store.loadConfig();
    if (result.customerId) tenant.billing.customerId = result.customerId;
    if (result.cardId || result.cardLast4) {
      tenant.billing.card = {
        id: result.cardId || tenant.billing.card && tenant.billing.card.id || null,
        last4: result.cardLast4 || (tenant.billing.card && tenant.billing.card.last4) || null,
        brand: result.cardBrand || (tenant.billing.card && tenant.billing.card.brand) || null
      };
    }
    if (result.paymentAgreementId) tenant.billing.paymentAgreementId = result.paymentAgreementId;
    tenant.billing.lastPaymentAt = now();

    if (inv.kind === 'signup') {
      // فتح أول دورة شهرية وتفعيل الكل
      const start = now();
      tenant.billing.cycleStart = start;
      tenant.billing.cycleEnd = B.addMonths(start, 1);
      tenant.billing.nextRenewalAt = tenant.billing.cycleEnd;
      tenant.billing.graceUntil = null;
      tenant.status = 'active';
      (tenant.projects || []).forEach(p => { if (p.status === 'pending') p.status = 'active'; });
    } else if (inv.kind === 'project_add') {
      // تفعيل المشاريع المرتبطة بهذه الفاتورة
      const ids = new Set((inv.lines || []).map(l => l.projectId));
      (tenant.projects || []).forEach(p => { if (ids.has(p.projectId) && p.status === 'pending') p.status = 'active'; });
      if (tenant.status === 'suspended' || tenant.status === 'past_due') tenant.status = 'active';
    } else if (inv.kind === 'renewal' || inv.kind === 'subscription') {
      // تمديد الدورة
      const base = tenant.billing.cycleEnd && new Date(tenant.billing.cycleEnd) <= new Date() ? tenant.billing.cycleEnd : now();
      tenant.billing.cycleStart = base;
      tenant.billing.cycleEnd = B.addMonths(base, 1);
      tenant.billing.nextRenewalAt = tenant.billing.cycleEnd;
      tenant.billing.graceUntil = null;
      tenant.status = 'active';
      (tenant.projects || []).forEach(p => { if (p.status === 'suspended') p.status = 'active'; });
    }
    store.upsertTenant(tenant);
  }

  // دفعة مؤكدة من مستأجر مُدار بالاشتراك → تغذية إيرادات SaaS في Bassir ERP الخاص بمنصّتكم (أحادي الاتجاه،
  // لا يوقف أو يؤخر عملية الدفع نفسها مهما حدث — منفصل تماماً عن تكامل كل شركة بحساباتها الخاصة)
  async function pushErpRevenue(tenant, inv) {
    const cfg = store.loadConfig().erpWebhook;
    if (!cfg || !cfg.enabled || !cfg.url) return;
    const payload = {
      event: 'saas_payment.captured', source: 'azoom-project-tracking-saas', sentAt: now(),
      tenant: { companyId: tenant.companyId, company: companyName(tenant.companyId), status: tenant.status },
      invoice: { id: inv.id, no: inv.no, kind: inv.kind, total: inv.total, currency: inv.currency, paidAt: inv.paidAt }
    };
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      const r = await fetch(cfg.url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal });
      clearTimeout(t);
      const c = store.loadConfig();
      c.erpWebhook.lastStatus = r.ok ? ('success — ' + inv.no + ' (HTTP ' + r.status + ')') : ('failed — HTTP ' + r.status);
      c.erpWebhook.lastAt = now();
      store.saveConfig(c);
    } catch (e) {
      try {
        const c = store.loadConfig();
        c.erpWebhook.lastStatus = 'send failed: ' + (e && e.message ? e.message : 'connection error');
        c.erpWebhook.lastAt = now();
        store.saveConfig(c);
      } catch (e2) {}
    }
  }

  // ---------- تسجيل جديد (عام) ----------
  function doSignup(body, req) {
    const cfg = store.loadConfig();
    const company = String(body.company || '').trim();
    const ownerName = String(body.ownerName || '').trim();
    const username = String(body.username || '').trim().toLowerCase();
    const email = String(body.email || '').trim();
    const phone = String(body.phone || '').trim();
    const password = String(body.password || '');
    const projName = String((body.project && body.project.name) || '').trim();
    const tier = String((body.project && body.project.tier) || '15');
    const token = body.token || null; // رمز بطاقة Tap من الواجهة (أو فارغ في المحاكاة)

    if (!company || !ownerName || !username || !password || !projName)
      return { code: 400, error: 'أكمل: اسم الشركة، اسم المالك، اسم المستخدم، كلمة المرور، اسم المشروع' };
    if (password.length < 6) return { code: 400, error: 'كلمة المرور 6 أحرف على الأقل' };
    if (!['15', '20'].includes(tier)) return { code: 400, error: 'باقة غير معروفة' };
    const users = loadUsers();
    if (users.some(u => u.username === username)) return { code: 400, error: 'اسم المستخدم محجوز، اختر غيره' };
    if (tap.isSim() === false && !token) return { code: 400, error: 'بيانات البطاقة ناقصة' };

    // إنشاء الشركة والمالك والمشروع الأول (حالة pending حتى يُسدَّد)
    const companies = loadCompanies();
    const comp = { id: nextId(), name: company };
    companies.push(comp); saveCompanies(companies);

    const owner = { id: nextId(), username, name: ownerName, role: 'client', companyId: comp.id, phone, email, hash: bcrypt.hashSync(password, 10) };
    users.push(owner); saveUsers(users);

    const project = emptyProject(comp.id, projName);
    saveProject(project);

    const price = B.tierPrice(cfg, tier);
    const tenant = {
      companyId: comp.id, ownerUserId: owner.id, saasManaged: true, status: 'pending', createdAt: now(),
      billing: { customerId: null, paymentAgreementId: null, card: { id: null, last4: null, brand: null }, cycleStart: null, cycleEnd: null, nextRenewalAt: null, graceUntil: null, lastPaymentAt: null },
      projects: [{ projectId: project.id, name: projName, tier, price, status: 'pending', addedAt: now() }],
      contact: { name: ownerName, email, phone }, note: ''
    };
    store.upsertTenant(tenant);

    const inv = B.buildInvoice(cfg, tenant, {
      kind: 'signup',
      lines: [{ projectId: project.id, name: projName, tier, desc: 'اشتراك أول مشروع «' + projName + '» (' + B.tierCapacityGB(tier) + ' جيجابايت) — شهر', qty: 1, unit: price, amount: price }]
    });
    store.addInvoice(inv);

    return { code: 200, ok: true, tenant, invoice: inv, owner, token, req };
  }

  function emptyProject(companyId, name) {
    return {
      id: nextId(), companyId, version: 1, managerUserId: null, seq: 1000,
      info: { name, client: '', vatRate: 15, retentionRate: 10, advanceRate: 0, projectType: 'residential', unitLabel: 'وحدة', unitsTitle: 'الوحدات' },
      boqItems: [], villas: [], villaProgress: {}, mustakhlasat: [], workLogs: [], blockerLog: [], editRequests: [],
      subcontractors: [], subMustakhlasat: [], subAlerts: []
    };
  }

  // إنشاء عملية الدفع الأولى وإرجاع رابط التوجيه
  async function startCharge(invoice, tenant, { token, description, req, kind }) {
    const cfg = store.loadConfig();
    const base = publicBaseUrl(req);
    const charge = await tap.createCharge({
      amount: invoice.total, currency: invoice.currency,
      customer: { id: tenant.billing.customerId || undefined, name: tenant.contact && tenant.contact.name, email: tenant.contact && tenant.contact.email, phone: tenant.contact && tenant.contact.phone },
      token, description: description || ('فاتورة ' + invoice.no),
      redirectUrl: base + '/saas/return?inv=' + invoice.id,
      webhookUrl: base + '/api/saas/tap/webhook',
      metadata: { invoiceId: invoice.id, companyId: tenant.companyId, kind: kind || invoice.kind }
    });
    if (!charge.ok) { store.updateInvoice(invoice.id, { status: 'failed', lastError: charge.error }); return { ok: false, error: charge.error }; }
    store.updateInvoice(invoice.id, { tapChargeId: charge.id });
    // إن رجعت العملية مُحصّلة فوراً (نادر للبطاقة الأولى) طبّقها
    if (charge.status === 'captured') { applyChargeResult(invoice.id, charge); return { ok: true, captured: true }; }
    return { ok: true, redirectUrl: charge.redirectUrl, chargeId: charge.id };
  }

  // ---------- إضافة مشروع لمستأجر قائم ----------
  async function addProjectForTenant(tenant, { name, tier, token, req }) {
    const cfg = store.loadConfig();
    name = String(name || '').trim(); tier = String(tier || '15');
    if (!name) return { code: 400, error: 'اكتب اسم المشروع' };
    if (!['15', '20'].includes(tier)) return { code: 400, error: 'باقة غير معروفة' };

    const project = emptyProject(tenant.companyId, name);
    saveProject(project);
    const price = B.tierPrice(cfg, tier);
    tenant.projects.push({ projectId: project.id, name, tier, price, status: 'pending', addedAt: now() });
    store.upsertTenant(tenant);

    // تقسيط لبقية الدورة الحالية
    let proratedNet = price;
    if (tenant.billing.cycleStart && tenant.billing.cycleEnd) {
      proratedNet = B.money(price * B.prorationFactor(now(), tenant.billing.cycleStart, tenant.billing.cycleEnd));
    }
    const inv = B.buildInvoice(cfg, tenant, {
      kind: 'project_add',
      periodStart: tenant.billing.cycleStart, periodEnd: tenant.billing.cycleEnd,
      lines: [{ projectId: project.id, name, tier, desc: 'إضافة مشروع «' + name + '» (' + B.tierCapacityGB(tier) + ' جيجابايت) — حصّة بقية الدورة', qty: 1, unit: proratedNet, amount: proratedNet }]
    });
    store.addInvoice(inv);

    // إن كانت الحصّة صفرية (آخر الدورة) فعّل مجاناً حتى التجديد
    if (inv.total <= 0.5) {
      applyChargeResult(inv.id, { status: 'captured', id: 'free_' + inv.id });
      return { code: 200, ok: true, projectId: project.id, invoice: store.getInvoice(inv.id), free: true };
    }
    // بطاقة محفوظة وفعّال → خصم فوري (MIT)
    if (tenant.status === 'active' && tenant.billing.customerId && tenant.billing.card && tenant.billing.card.id && !token) {
      const r = await tap.createRecurringCharge({ amount: inv.total, currency: inv.currency, customerId: tenant.billing.customerId, cardId: tenant.billing.card.id, paymentAgreementId: tenant.billing.paymentAgreementId, description: 'إضافة مشروع ' + name, metadata: { invoiceId: inv.id, companyId: tenant.companyId, kind: 'project_add' } });
      const applied = applyChargeResult(inv.id, { ...r, cardLast4: tenant.billing.card.last4, cardBrand: tenant.billing.card.brand });
      if (applied.ok) return { code: 200, ok: true, projectId: project.id, invoice: applied.invoice };
      return { code: 402, error: 'تعذّر الخصم من البطاقة المحفوظة: ' + (r.error || 'مرفوضة') };
    }
    // غير ذلك: توجيه لصفحة الدفع
    const s = await startCharge(inv, tenant, { token, description: 'إضافة مشروع ' + name, req, kind: 'project_add' });
    if (!s.ok) return { code: 402, error: s.error };
    return { code: 200, ok: true, projectId: project.id, redirectUrl: s.redirectUrl, invoiceId: inv.id };
  }

  // ---------- التجديد والمرور الدوري ----------
  async function renewTenant(tenant) {
    const cfg = store.loadConfig();
    const lines = B.subscriptionLines(cfg, tenant);
    if (!lines.length) return { ok: false, error: 'no active projects' };
    const inv = B.buildInvoice(cfg, tenant, {
      kind: 'renewal',
      periodStart: tenant.billing.cycleEnd, periodEnd: B.addMonths(tenant.billing.cycleEnd, 1),
      lines
    });
    store.addInvoice(inv);
    if (!tenant.billing.customerId || !tenant.billing.card || !tenant.billing.card.id) {
      // لا بطاقة محفوظة → فشل منطقي يؤدي لمهلة ثم إيقاف
      return applyChargeResult(inv.id, { status: 'failed', error: 'لا توجد بطاقة محفوظة' });
    }
    const r = await tap.createRecurringCharge({
      amount: inv.total, currency: inv.currency, customerId: tenant.billing.customerId, cardId: tenant.billing.card.id,
      paymentAgreementId: tenant.billing.paymentAgreementId,
      description: 'تجديد اشتراك — ' + companyName(tenant.companyId), metadata: { invoiceId: inv.id, companyId: tenant.companyId, kind: 'renewal' },
      simFail: !!tenant._simFailRenewal
    });
    return applyChargeResult(inv.id, { ...r, cardLast4: tenant.billing.card.last4, cardBrand: tenant.billing.card.brand });
  }

  function suspendTenant(tenant, reason) {
    tenant.status = 'suspended';
    (tenant.projects || []).forEach(p => { if (p.status === 'active') p.status = 'suspended'; });
    tenant.note = reason || tenant.note || '';
    store.upsertTenant(tenant);
  }

  async function runBillingPass(reason) {
    const nowT = Date.now();
    const result = { renewed: 0, failed: 0, suspended: 0, checked: 0 };
    for (const tenant of store.loadTenants()) {
      if (!tenant.saasManaged) continue;
      if (!['active', 'past_due'].includes(tenant.status)) continue;
      result.checked++;
      const due = tenant.billing.nextRenewalAt && new Date(tenant.billing.nextRenewalAt).getTime() <= nowT;
      if (tenant.status === 'active' && due) {
        const r = await renewTenant(tenant);
        if (r.ok) result.renewed++; else result.failed++;
      } else if (tenant.status === 'past_due') {
        // أعِد المحاولة إن حان موعد التجديد ولم يُسدَّد بعد
        if (due) { const r = await renewTenant(store.getTenant(tenant.companyId)); if (r.ok) { result.renewed++; continue; } result.failed++; }
        const fresh = store.getTenant(tenant.companyId);
        if (fresh.billing.graceUntil && new Date(fresh.billing.graceUntil).getTime() < nowT) {
          suspendTenant(fresh, 'إيقاف تلقائي: انتهت مهلة السداد'); result.suspended++;
        }
      }
    }
    return result;
  }

  // ---------- حُرّاس الصلاحية (تُستدعى من مسارات المشاريع في الخادم) ----------
  const guards = {
    // منع إنشاء مشروع مباشرة لمستأجر مُدار (يجب أن يمر عبر الفوترة)
    projectCreate(user) {
      const t = store.getTenant(user.companyId);
      if (!t || !t.saasManaged) return { ok: true };
      return { ok: false, code: 402, error: 'لإضافة مشروع جديد مُرّ عبر صفحة الاشتراك والدفع', billing: '/billing' };
    },
    // منع الكتابة إذا كان المستأجر موقوفاً
    projectWrite(user) {
      if (isAdmin(user)) return { ok: true };
      const t = store.getTenant(user.companyId);
      if (!t || !t.saasManaged) return { ok: true };
      if (t.status === 'suspended') return { ok: false, code: 402, error: 'الاشتراك موقوف لعدم السداد — جدّد من صفحة الاشتراك لتفعيل الكتابة', billing: '/billing' };
      return { ok: true };
    },
    // منع الكتابة على مشروع بانتظار تأكيد الدفع (أُنشئ عبر "إضافة مشروع" ولم يُسدَّد بعد) — يُفعَّل تلقائياً
    // بمجرد نجاح الدفع (provisionPaid يُحوّل حالته إلى active)؛ قبل ذلك يبقى المشروع مرئياً لكن خاملاً تماماً
    projectActive(user, project) {
      if (isAdmin(user)) return { ok: true };
      if (!project) return { ok: true };
      const t = store.getTenant(project.companyId);
      if (!t || !t.saasManaged) return { ok: true };
      const rec = (t.projects || []).find(p => p.projectId === project.id);
      if (rec && rec.status === 'pending') {
        return { ok: false, code: 402, error: 'هذا المشروع بانتظار تأكيد الدفع — أكمل الدفع من صفحة الاشتراك', billing: '/billing' };
      }
      return { ok: true };
    },
    // حدّ السعة لكل مشروع حسب الباقة
    upload(project, incomingBytes) {
      const t = store.getTenant(project.companyId);
      if (!t || !t.saasManaged) return { ok: true };
      const rec = (t.projects || []).find(p => p.projectId === project.id);
      const tier = rec ? rec.tier : '15';
      const capBytes = B.tierCapacityGB(tier) * GB;
      const used = projectStorageBytes(project.id);
      if (used + (incomingBytes || 0) > capBytes)
        return { ok: false, code: 413, error: 'تجاوزت سعة الباقة (' + B.tierCapacityGB(tier) + ' جيجابايت). رقّ الباقة من صفحة الاشتراك.' };
      return { ok: true };
    }
  };

  // ================= المسارات =================

  // ---- عام: الإعداد والتسعير لصفحة الهبوط ----
  app.get('/api/saas/public/config', (req, res) => res.json(store.publicConfig()));

  // ---- عام: تسجيل جديد ----
  app.post('/api/saas/public/signup', async (req, res) => {
    const s = doSignup(req.body || {}, req);
    if (!s.ok) return res.status(s.code).json({ error: s.error });
    const start = await startCharge(s.invoice, s.tenant, { token: s.token, description: 'اشتراك جديد — ' + companyName(s.tenant.companyId), req, kind: 'signup' });
    if (!start.ok) return res.status(402).json({ error: start.error || 'تعذّر بدء الدفع' });
    if (start.captured) return res.json({ ok: true, captured: true, invoiceId: s.invoice.id, username: s.owner.username, companyId: s.tenant.companyId });
    res.json({ ok: true, redirectUrl: start.redirectUrl, invoiceId: s.invoice.id, username: s.owner.username, companyId: s.tenant.companyId });
  });

  // ---- عام: حالة فاتورة (لصفحة العودة) ----
  app.get('/api/saas/public/invoice/:id', (req, res) => {
    const inv = store.getInvoice(req.params.id);
    if (!inv) return res.status(404).json({ error: 'غير موجودة' });
    res.json({ id: inv.id, no: inv.no, status: inv.status, total: inv.total, currency: inv.currency, kind: inv.kind, companyId: inv.tenantCompanyId });
  });

  // ---- محاكاة الدفع (sim فقط): صفحة دفع وهمية ----
  app.get('/saas/sim/pay', (req, res) => {
    if (!tap.isSim()) return res.status(404).send('غير متاح');
    const chg = String(req.query.chg || ''); const amount = String(req.query.amount || '');
    const back = String(req.query.back || '/billing');
    res.set('Content-Type', 'text/html; charset=utf-8').send(simPayPage(chg, amount, back));
  });
  // إتمام المحاكاة
  app.post('/api/saas/pay/sim-complete', express.urlencoded ? express.urlencoded({ extended: false }) : (q, s, n) => n(), (req, res) => {
    if (!tap.isSim()) return res.status(404).json({ error: 'غير متاح' });
    const chg = (req.body && req.body.chg) || req.query.chg;
    const result = (req.body && req.body.result) || req.query.result;
    const inv = store.loadInvoices().find(v => v.tapChargeId === chg);
    if (!inv) return res.status(404).json({ error: 'عملية غير معروفة' });
    const r = applyChargeResult(inv.id, result === 'ok' ? { status: 'captured', id: chg, cardLast4: '4242', cardBrand: 'VISA', customerId: 'cus_sim_' + inv.tenantCompanyId, cardId: 'card_sim_' + inv.tenantCompanyId, paymentAgreementId: 'agr_sim_' + inv.tenantCompanyId } : { status: 'failed', id: chg, error: 'المحاكاة: رُفضت' });
    res.redirect('/saas/return?inv=' + inv.id);
  });

  // ---- Webhook من Tap ----
  app.post('/api/saas/tap/webhook', async (req, res) => {
    const payload = req.body || {};
    try {
      const chargeId = payload.id;
      if (!chargeId) return res.json({ ok: true, ignored: true });
      const invoiceId = (payload.metadata && payload.metadata.invoiceId) || (store.loadInvoices().find(v => v.tapChargeId === chargeId) || {}).id;
      if (!invoiceId) return res.json({ ok: true, ignored: true });
      // نقطة الحقيقة: نعيد جلب العملية من Tap بمفتاحنا السرّي (آمن ضد الإشعارات المزوّرة —
      // لا يستطيع مهاجم تزوير حالة "مدفوعة" لأن الحالة تؤخذ من Tap مباشرة لا من جسم الإشعار).
      const fetched = await tap.retrieveCharge(chargeId);
      if (fetched.ok) applyChargeResult(invoiceId, fetched);
      else if (tap.verifyWebhook(req.headers, payload)) applyChargeResult(invoiceId, { status: tap.normStatus(payload.status), id: chargeId });
    } catch (e) { /* لا نكسر الـwebhook */ }
    res.json({ ok: true });
  });

  // ---- صفحة العودة بعد الدفع ----
  app.get('/saas/return', (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8').send(returnPage(String(req.query.inv || '')));
  });

  // ---- مستأجر (client/pmo): اشتراكي ----
  app.get('/api/saas/me', auth, (req, res) => {
    const t = tenantOfUser(req.user);
    if (!t) return res.json({ saasManaged: false });
    const cfg = store.loadConfig();
    res.json({
      saasManaged: true, status: t.status, company: companyName(t.companyId), companyId: t.companyId,
      billing: { cycleStart: t.billing.cycleStart, cycleEnd: t.billing.cycleEnd, nextRenewalAt: t.billing.nextRenewalAt, graceUntil: t.billing.graceUntil, card: t.billing.card, customerSaved: !!t.billing.customerId },
      projects: (t.projects || []).map(p => ({ ...p, capacityGB: B.tierCapacityGB(p.tier), usedBytes: projectStorageBytes(p.projectId) })),
      monthlyNet: B.subscriptionNet(cfg, t), currency: cfg.currency, vatRate: cfg.vatRate, priceInclusiveVat: cfg.priceInclusiveVat, tiers: cfg.tiers,
      canManage: req.user.role === 'client'
    });
  });

  app.get('/api/saas/invoices', auth, (req, res) => {
    const t = tenantOfUser(req.user);
    if (!t) return res.json([]);
    res.json(store.invoicesOf(t.companyId).sort((a, b) => (b.issuedAt || '').localeCompare(a.issuedAt || '')));
  });
  app.get('/api/saas/invoices/:id', auth, (req, res) => {
    const inv = store.getInvoice(req.params.id);
    if (!inv) return res.status(404).json({ error: 'غير موجودة' });
    if (!isAdmin(req.user) && inv.tenantCompanyId !== req.user.companyId) return res.status(403).json({ error: 'غير مصرّح' });
    res.json(inv);
  });

  // إضافة مشروع (client فقط)
  app.post('/api/saas/projects', auth, async (req, res) => {
    if (req.user.role !== 'client') return res.status(403).json({ error: 'إضافة المشاريع صلاحية مالك الحساب' });
    const t = tenantOfUser(req.user);
    if (!t || !t.saasManaged) return res.status(400).json({ error: 'لا يوجد اشتراك مُدار لهذه الشركة' });
    if (t.status === 'pending') return res.status(402).json({ error: 'أكمل دفع الاشتراك الأول أولاً' });
    const out = await addProjectForTenant(t, { name: (req.body || {}).name, tier: (req.body || {}).tier, token: (req.body || {}).token, req });
    res.status(out.code).json(out.code === 200 ? out : { error: out.error });
  });

  // تحديث البطاقة: يبدأ عملية حفظ بطاقة جديدة (توجيه لصفحة Tap)
  app.post('/api/saas/card/update', auth, async (req, res) => {
    if (req.user.role !== 'client') return res.status(403).json({ error: 'صلاحية مالك الحساب' });
    const t = tenantOfUser(req.user);
    if (!t || !t.saasManaged) return res.status(400).json({ error: 'لا يوجد اشتراك' });
    const cfg = store.loadConfig();
    // فاتورة تحقق بسيطة بقيمة 1 (تُستردّ عملياً؛ في المحاكاة ترمز الحفظ)
    const inv = B.buildInvoice(cfg, t, { kind: 'card_update', lines: [{ name: 'تحديث/حفظ بطاقة', desc: 'عملية تحقق لحفظ البطاقة للتجديد', qty: 1, unit: 1, amount: 1 }] });
    store.addInvoice(inv);
    const s = await startCharge(inv, t, { token: (req.body || {}).token, description: 'حفظ بطاقة', req, kind: 'card_update' });
    if (!s.ok) return res.status(402).json({ error: s.error });
    res.json({ ok: true, redirectUrl: s.redirectUrl, invoiceId: inv.id });
  });

  // ================= لوحة المالك (admin) =================
  app.get('/api/saas/admin/overview', auth, adminOnly, (req, res) => {
    const cfg = store.loadConfig();
    const tenants = store.loadTenants();
    const byStatus = {};
    let mrrNet = 0, activeProjects = 0, storageBytes = 0;
    tenants.forEach(t => {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;
      if (t.status === 'active') { mrrNet += B.subscriptionNet(cfg, t); activeProjects += B.activeProjects(t).length; }
      (t.projects || []).forEach(p => { storageBytes += projectStorageBytes(p.projectId); });
    });
    const invoices = store.loadInvoices();
    const paid = invoices.filter(v => v.status === 'paid');
    const monthKey = now().slice(0, 7);
    const revenueAll = B.money(paid.reduce((s, v) => s + v.total, 0));
    const revenueMonth = B.money(paid.filter(v => (v.paidAt || '').slice(0, 7) === monthKey).reduce((s, v) => s + v.total, 0));
    const payments = store.loadPayments().slice(-10).reverse();
    res.json({
      counts: { total: tenants.length, active: byStatus.active || 0, pending: byStatus.pending || 0, past_due: byStatus.past_due || 0, suspended: byStatus.suspended || 0, cancelled: byStatus.cancelled || 0 },
      mrrNet: B.money(mrrNet), mrrWithVat: B.applyVat(cfg, mrrNet).total, activeProjects,
      revenueAll, revenueMonth, storageGB: B.money(storageBytes / GB),
      currency: cfg.currency, recentPayments: payments,
      tap: { mode: cfg.tap.mode, secretKeySet: !!cfg.tap.secretKey }
    });
  });

  app.get('/api/saas/admin/tenants', auth, adminOnly, (req, res) => {
    const cfg = store.loadConfig();
    res.json(store.loadTenants().map(t => ({
      companyId: t.companyId, company: companyName(t.companyId), status: t.status, createdAt: t.createdAt,
      owner: t.contact || null, projects: (t.projects || []).length, activeProjects: B.activeProjects(t).length,
      monthlyNet: B.subscriptionNet(cfg, t), nextRenewalAt: t.billing.nextRenewalAt, graceUntil: t.billing.graceUntil,
      card: t.billing.card, storageGB: B.money((t.projects || []).reduce((s, p) => s + projectStorageBytes(p.projectId), 0) / GB)
    })).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')));
  });

  // ---- كل المشاريع عبر جميع الشركات (مُدارة بالاشتراك أو لا) — لوحة مالك المنصّة فقط ----
  app.get('/api/saas/admin/projects', auth, adminOnly, (req, res) => {
    const companies = loadCompanies();
    const users = loadUsers();
    const tenants = store.loadTenants();
    const companyName = id => { const c = companies.find(x => x.id === id); return c ? c.name : ('#' + id); };
    const userName = id => { const u = users.find(x => x.id === id); return u ? u.name : null; };
    const rows = listProjects().map(p => {
      const boq = p.boqItems || [];
      const totalValue = boq.reduce((s, i) => s + (Number(i.totalQty) || 0) * (Number(i.unitRate) || 0), 0);
      const executedValue = boq.reduce((s, i) => s + (Number(i.executedQty) || 0) * (Number(i.unitRate) || 0), 0);
      const mus = p.mustakhlasat || [];
      const tenant = tenants.find(t => t.companyId === p.companyId);
      const trec = tenant && (tenant.projects || []).find(x => x.projectId === p.id);
      return {
        id: p.id, name: (p.info || {}).name || ('#' + p.id), companyId: p.companyId, company: companyName(p.companyId),
        managerName: userName(p.managerUserId),
        boqItemsCount: boq.length,
        progressPct: totalValue > 0 ? Math.round((executedValue / totalValue) * 1000) / 10 : 0,
        mustakhlasatCount: mus.length,
        mustakhlasatApprovedValue: B.money(mus.filter(m => ['approved', 'paid'].includes(m.status)).reduce((s, m) => s + (Number(m.gross) || 0), 0)),
        subcontractorsCount: (p.subcontractors || []).length,
        subMustakhlasatCount: (p.subMustakhlasat || []).length,
        storageGB: B.money(projectStorageBytes(p.id) / GB),
        saasManaged: !!(tenant && tenant.saasManaged),
        status: trec ? trec.status : (tenant ? tenant.status : null)
      };
    }).sort((a, b) => b.id - a.id);
    res.json(rows);
  });

  app.get('/api/saas/admin/tenants/:companyId', auth, adminOnly, (req, res) => {
    const t = store.getTenant(Number(req.params.companyId));
    if (!t) return res.status(404).json({ error: 'غير موجود' });
    res.json({ tenant: { ...t, company: companyName(t.companyId) }, invoices: store.invoicesOf(t.companyId).sort((a, b) => (b.issuedAt || '').localeCompare(a.issuedAt || '')) });
  });

  app.post('/api/saas/admin/tenants/:companyId/action', auth, adminOnly, async (req, res) => {
    const t = store.getTenant(Number(req.params.companyId));
    if (!t) return res.status(404).json({ error: 'غير موجود' });
    const action = (req.body || {}).action;
    if (action === 'suspend') suspendTenant(t, 'إيقاف يدوي من المالك');
    else if (action === 'activate') { t.status = 'active'; (t.projects || []).forEach(p => { if (p.status === 'suspended') p.status = 'active'; }); if (!t.billing.cycleEnd) { t.billing.cycleStart = now(); t.billing.cycleEnd = B.addMonths(now(), 1); t.billing.nextRenewalAt = t.billing.cycleEnd; } store.upsertTenant(t); }
    else if (action === 'cancel') { t.status = 'cancelled'; (t.projects || []).forEach(p => p.status = 'suspended'); store.upsertTenant(t); }
    else if (action === 'renew-now') { const r = await renewTenant(t); return res.json({ ok: r.ok, error: r.error }); }
    else return res.status(400).json({ error: 'إجراء غير معروف' });
    res.json({ ok: true, status: store.getTenant(t.companyId).status });
  });

  app.post('/api/saas/admin/run-billing', auth, adminOnly, async (req, res) => res.json(await runBillingPass('يدوي')));

  app.get('/api/saas/admin/config', auth, adminOnly, (req, res) => {
    const c = store.loadConfig();
    res.json({ currency: c.currency, vatRate: c.vatRate, priceInclusiveVat: c.priceInclusiveVat, tiers: c.tiers, graceDays: c.graceDays, trialDays: c.trialDays, brand: c.brand, tap: { mode: c.tap.mode, baseUrl: c.tap.baseUrl, publicKey: c.tap.publicKey, secretKeySet: !!c.tap.secretKey, webhookSecretSet: !!c.tap.webhookSecret },
      erpWebhook: { enabled: c.erpWebhook.enabled, url: c.erpWebhook.url, apiKeySet: !!c.erpWebhook.apiKey, lastStatus: c.erpWebhook.lastStatus, lastAt: c.erpWebhook.lastAt } });
  });
  app.put('/api/saas/admin/config', auth, adminOnly, (req, res) => {
    const c = store.loadConfig(); const b = req.body || {};
    if (b.currency) c.currency = String(b.currency);
    if (b.vatRate !== undefined) c.vatRate = Math.max(0, Number(b.vatRate) || 0);
    if (b.priceInclusiveVat !== undefined) c.priceInclusiveVat = !!b.priceInclusiveVat;
    if (b.tiers && typeof b.tiers === 'object') { ['15', '20'].forEach(k => { if (b.tiers[k] !== undefined) c.tiers[k] = Math.max(0, Number(b.tiers[k]) || 0); }); }
    if (b.graceDays !== undefined) c.graceDays = Math.max(0, Number(b.graceDays) || 0);
    if (b.trialDays !== undefined) c.trialDays = Math.max(0, Number(b.trialDays) || 0);
    if (b.brand && typeof b.brand === 'object') c.brand = { ...c.brand, ...b.brand };
    if (b.tap && typeof b.tap === 'object') {
      if (b.tap.mode && ['sim', 'test', 'live'].includes(b.tap.mode)) c.tap.mode = b.tap.mode;
      if (b.tap.baseUrl !== undefined) c.tap.baseUrl = String(b.tap.baseUrl || 'https://api.tap.company');
      if (b.tap.publicKey !== undefined) c.tap.publicKey = String(b.tap.publicKey || '');
      if (typeof b.tap.secretKey === 'string' && b.tap.secretKey.length) c.tap.secretKey = b.tap.secretKey;
      if (typeof b.tap.webhookSecret === 'string' && b.tap.webhookSecret.length) c.tap.webhookSecret = b.tap.webhookSecret;
      if (b.tap.clearSecret) c.tap.secretKey = '';
    }
    if (b.erpWebhook && typeof b.erpWebhook === 'object') {
      if (b.erpWebhook.enabled !== undefined) c.erpWebhook.enabled = !!b.erpWebhook.enabled;
      if (b.erpWebhook.url !== undefined) c.erpWebhook.url = String(b.erpWebhook.url || '');
      if (typeof b.erpWebhook.apiKey === 'string' && b.erpWebhook.apiKey.length) c.erpWebhook.apiKey = b.erpWebhook.apiKey;
      if (b.erpWebhook.clearApiKey) c.erpWebhook.apiKey = '';
    }
    store.saveConfig(c);
    res.json({ ok: true });
  });

  // ---- صفحات SaaS الثابتة ----
  const page = f => (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'saas', f));
  app.get('/landing', page('landing.html'));
  app.get('/billing', page('billing.html'));
  app.get('/owner', page('owner.html'));

  // المجدوِل: مرور فوترة كل 5 دقائق (تفعيل/تجديد/إيقاف تلقائي)
  setInterval(() => { runBillingPass('مجدول').catch(() => {}); }, 5 * 60 * 1000);

  // ---------- صفحات HTML للمحاكاة والعودة ----------
  function simPayPage(chg, amount, back) {
    return '<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>دفع تجريبي (محاكاة)</title><style>body{font-family:system-ui,"Segoe UI",Tahoma,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}' +
      '.card{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:28px;max-width:380px;width:92%;box-shadow:0 20px 60px rgba(0,0,0,.4)}' +
      'h1{font-size:18px;margin:0 0 4px}.muted{color:#94a3b8;font-size:13px;margin:0 0 18px}.amt{font-size:30px;font-weight:800;color:#38bdf8;margin:12px 0}' +
      'button{width:100%;padding:13px;border:0;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;margin-top:10px}' +
      '.pay{background:#22c55e;color:#042f17}.fail{background:#334155;color:#e2e8f0}.badge{display:inline-block;background:#f59e0b22;color:#f59e0b;border:1px solid #f59e0b55;border-radius:999px;padding:3px 10px;font-size:11px;margin-bottom:10px}</style></head>' +
      '<body><div class="card"><span class="badge">وضع المحاكاة — لا تُخصم أموال حقيقية</span><h1>بوابة الدفع (محاكاة Tap)</h1>' +
      '<p class="muted">هذه صفحة تجريبية تُحاكي صفحة دفع Tap. المبلغ المطلوب:</p><div class="amt">' + esc(amount) + ' ر.س</div>' +
      '<form method="POST" action="/api/saas/pay/sim-complete"><input type="hidden" name="chg" value="' + esc(chg) + '">' +
      '<button class="pay" name="result" value="ok" type="submit">✅ محاكاة دفع ناجح</button>' +
      '<button class="fail" name="result" value="fail" type="submit">✖ محاكاة رفض البطاقة</button></form></div></body></html>';
  }
  function returnPage(invId) {
    return '<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>نتيجة الدفع</title><style>body{font-family:system-ui,"Segoe UI",Tahoma,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}' +
      '.card{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:32px;max-width:420px;width:92%;text-align:center}.big{font-size:48px;margin-bottom:8px}a.btn{display:inline-block;margin-top:18px;background:#38bdf8;color:#042f17;text-decoration:none;font-weight:700;padding:11px 20px;border-radius:10px}</style></head>' +
      '<body><div class="card" id="box"><div class="big">⏳</div><h2>جارٍ تأكيد الدفع…</h2><p id="msg" style="color:#94a3b8">لحظة من فضلك</p></div>' +
      '<script>var inv=' + JSON.stringify(invId) + ';var tries=0;function poll(){fetch("/api/saas/public/invoice/"+inv).then(r=>r.json()).then(d=>{tries++;var box=document.getElementById("box");if(d.status==="paid"){box.innerHTML=\'<div class=big>✅</div><h2>تم الدفع بنجاح</h2><p style="color:#94a3b8">تم تفعيل اشتراكك. يمكنك الدخول الآن.</p><a class=btn href="/">دخول النظام</a>\';return;}if(d.status==="failed"){box.innerHTML=\'<div class=big>✖</div><h2>تعذّر الدفع</h2><p style="color:#94a3b8">لم تُكمل العملية. حاول مجدداً.</p><a class=btn href="/billing">إعادة المحاولة</a>\';return;}if(tries<40)setTimeout(poll,1500);else{document.getElementById("msg").textContent="يستغرق التأكيد وقتاً أطول — حدّث الصفحة لاحقاً.";}});}poll();</script></body></html>';
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  return { store, billing: B, tap, guards, runBillingPass, renewTenant, addProjectForTenant, _internal: { applyChargeResult, doSignup, tenantOfUser } };
};
