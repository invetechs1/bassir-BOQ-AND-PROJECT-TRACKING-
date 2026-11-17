'use strict';
/*
 * طبقة تخزين SaaS: الإعدادات، المستأجرون (tenants)، الفواتير، المدفوعات.
 * تُخزّن كملفات JSON ذرية ضمن مجلد البيانات نفسه الذي يستخدمه الخادم.
 * tenant = شركة (company). المالك = مستخدم بدور client.
 */
const path = require('path');

module.exports = function createStore(ctx) {
  const { dataDir, readJSON, writeJSON } = ctx;
  const CONFIG_FILE = path.join(dataDir, 'saas-config.json');
  const TENANTS_FILE = path.join(dataDir, 'tenants.json');
  const INVOICES_FILE = path.join(dataDir, 'invoices.json');
  const PAYMENTS_FILE = path.join(dataDir, 'payments.json');
  const COUNTERS_FILE = path.join(dataDir, 'saas-counters.json');

  // ---------- الإعداد العام للمنصّة ----------
  const DEFAULT_CONFIG = {
    currency: 'SAR',
    vatRate: 15,               // ضريبة القيمة المضافة %
    priceInclusiveVat: false,  // هل السعر شامل الضريبة؟ (false = تُضاف فوقه)
    tiers: { '15': 750, '20': 900 }, // سعة (جيجابايت) → السعر الشهري للمشروع (الموديل القديم لكل مشروع — يبقى كما هو لعملاء Tap الحاليين)
    graceDays: 3,              // مهلة بعد فشل الدفع قبل الإيقاف
    trialDays: 0,              // أيام تجربة مجانية (0 = لا تجربة، الدفع يفعّل مباشرة)
    brand: { name: 'إدارة المشاريع والمستخلصات', supportPhone: '0558338548', supportEmail: '' },
    tap: {
      mode: 'sim',             // 'sim' (محاكاة للتجربة) | 'test' | 'live'
      baseUrl: 'https://api.tap.company',
      secretKey: '',           // سرّي — لا يُرسل للواجهة أبداً
      publicKey: '',           // عام — يُستخدم في الواجهة لترميز البطاقة
      webhookSecret: ''        // لتوقيع إشعارات tap (hashstring)
    },
    // باقات جديدة (حزم) مبنية على عدد المشاريع + سعة مجمّعة — موديل جديد يعمل جنباً إلى جنب مع tiers
    // القديم؛ المستأجرون الحاليون على tiers لا يتأثرون، والتسجيل الجديد عبر صفحة /plans فقط يستخدمها.
    bundles: {
      starter: { id: 'starter', name: 'Starter', nameAr: 'الأساسية', maxProjects: 1, storageGB: 5, price: 750 },
      growth: { id: 'growth', name: 'Growth', nameAr: 'النمو', maxProjects: 2, storageGB: 10, price: 1200 },
      team: { id: 'team', name: 'Team', nameAr: 'الفريق', maxProjects: 5, storageGB: 20, price: 2000 }
      // Enterprise: بلا تسعير ذاتي ثابت — "تواصل مع المبيعات" فقط (معروضة في الواجهة من كود الصفحة لا من هنا)
    },
    moyasar: {
      mode: 'sim',             // 'sim' (محاكاة للتجربة) | 'test' | 'live'
      secretKey: '',           // سرّي (sk_live_/sk_test_) — Basic Auth، لا يُرسل للواجهة أبداً
      publishableKey: '',      // عام (pk_live_/pk_test_) — يُستخدم في نافذة moyasar.js بالواجهة
      webhookSecret: ''        // secret_token نقارنه مع حقل secret_token في كل إشعار Webhook
    },
    // تكامل مستوى المنصّة مع Bassir ERP — لتغذية إيرادات الاشتراكات (SaaS) في حساباتكم الخاصة،
    // منفصل تماماً عن تكامل كل شركة بحساباتها الخاصة (companyIntegration في server.js)
    erpWebhook: { enabled: false, url: '', apiKey: '', lastStatus: '', lastAt: '' },
    updatedAt: null
  };
  function loadConfig() {
    const c = readJSON(CONFIG_FILE, null);
    if (!c) return { ...DEFAULT_CONFIG };
    // دمج دفاعي مع الافتراضيات (لإضافة الحقول الجديدة)
    return {
      ...DEFAULT_CONFIG, ...c,
      tiers: { ...DEFAULT_CONFIG.tiers, ...(c.tiers || {}) },
      brand: { ...DEFAULT_CONFIG.brand, ...(c.brand || {}) },
      tap: { ...DEFAULT_CONFIG.tap, ...(c.tap || {}) },
      bundles: { ...DEFAULT_CONFIG.bundles, ...(c.bundles || {}) },
      moyasar: { ...DEFAULT_CONFIG.moyasar, ...(c.moyasar || {}) },
      erpWebhook: { ...DEFAULT_CONFIG.erpWebhook, ...(c.erpWebhook || {}) }
    };
  }
  function saveConfig(c) { c.updatedAt = new Date().toISOString(); writeJSON(CONFIG_FILE, c); return c; }
  // نسخة آمنة للواجهة: بلا مفاتيح سرّية
  function publicConfig() {
    const c = loadConfig();
    return {
      currency: c.currency, vatRate: c.vatRate, priceInclusiveVat: c.priceInclusiveVat,
      tiers: c.tiers, bundles: c.bundles, graceDays: c.graceDays, trialDays: c.trialDays, brand: c.brand,
      tap: { mode: c.tap.mode, publicKey: c.tap.publicKey || '', secretKeySet: !!c.tap.secretKey, webhookSecretSet: !!c.tap.webhookSecret },
      moyasar: { mode: c.moyasar.mode, publishableKey: c.moyasar.publishableKey || '', secretKeySet: !!c.moyasar.secretKey, webhookSecretSet: !!c.moyasar.webhookSecret }
    };
  }

  // ---------- المستأجرون ----------
  function loadTenants() { return readJSON(TENANTS_FILE, []); }
  function saveTenants(t) { writeJSON(TENANTS_FILE, t); }
  function getTenant(companyId) { return loadTenants().find(t => t.companyId === Number(companyId)) || null; }
  function upsertTenant(tenant) {
    const all = loadTenants();
    const i = all.findIndex(t => t.companyId === tenant.companyId);
    if (i >= 0) all[i] = tenant; else all.push(tenant);
    saveTenants(all);
    return tenant;
  }

  // ---------- الفواتير ----------
  function loadInvoices() { return readJSON(INVOICES_FILE, []); }
  function saveInvoices(v) { writeJSON(INVOICES_FILE, v); }
  function addInvoice(inv) { const all = loadInvoices(); all.push(inv); saveInvoices(all); return inv; }
  function updateInvoice(id, patch) {
    const all = loadInvoices(); const i = all.findIndex(x => x.id === id);
    if (i < 0) return null; all[i] = { ...all[i], ...patch }; saveInvoices(all); return all[i];
  }
  function invoicesOf(companyId) { return loadInvoices().filter(v => v.tenantCompanyId === Number(companyId)); }
  function getInvoice(id) { return loadInvoices().find(v => v.id === id) || null; }

  // ---------- المدفوعات (سجل مسطّح للوحة التحكم) ----------
  function loadPayments() { return readJSON(PAYMENTS_FILE, []); }
  function savePayments(p) { writeJSON(PAYMENTS_FILE, p); }
  function addPayment(p) { const all = loadPayments(); all.push(p); savePayments(all); return p; }

  // ---------- عدّادات تسلسلية (أرقام الفواتير والمعرفات) ----------
  function nextCounter(name) {
    const c = readJSON(COUNTERS_FILE, {});
    c[name] = (c[name] || 0) + 1;
    writeJSON(COUNTERS_FILE, c);
    return c[name];
  }
  function invoiceNo() { return 'INV-' + String(nextCounter('invoice')).padStart(5, '0'); }
  function saasId(prefix) { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  return {
    files: { CONFIG_FILE, TENANTS_FILE, INVOICES_FILE, PAYMENTS_FILE, COUNTERS_FILE },
    DEFAULT_CONFIG,
    loadConfig, saveConfig, publicConfig,
    loadTenants, saveTenants, getTenant, upsertTenant,
    loadInvoices, saveInvoices, addInvoice, updateInvoice, invoicesOf, getInvoice,
    loadPayments, savePayments, addPayment,
    nextCounter, invoiceNo, saasId
  };
};
