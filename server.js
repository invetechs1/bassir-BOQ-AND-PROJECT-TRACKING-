'use strict';
/*
 * نظام إدارة المستخلصات والإنتاجية — خادم VPS
 * Node.js + Express, تخزين ملفات JSON ذري (بدون قاعدة بيانات خارجية)
 * المصادقة: JWT + bcrypt، والصلاحيات تُفرض على مستوى الخادم.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// تحميل ملف .env إن وجد (بدون مكتبات خارجية) — متغيرات البيئة الفعلية لها الأولوية
(function loadEnv(){
  const envFile = path.join(__dirname, '.env');
  if (!fs.existsSync(envFile)) return;
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined && m[2] !== '') {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  });
})();

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const PRICEDB_DIR = path.join(DATA_DIR, 'pricedb');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const COMPANIES_FILE = path.join(DATA_DIR, 'companies.json');
const INTEGRATIONS_FILE = path.join(DATA_DIR, 'integrations.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');
const SECRET_FILE = path.join(DATA_DIR, '.jwt-secret');

fs.mkdirSync(PROJECTS_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(PRICEDB_DIR, { recursive: true });

// ---------- أدوات تخزين ذرية ----------
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJSON(file, obj) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

// ---------- سر JWT ----------
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (fs.existsSync(SECRET_FILE)) JWT_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  else { JWT_SECRET = crypto.randomBytes(48).toString('hex'); fs.writeFileSync(SECRET_FILE, JWT_SECRET, { mode: 0o600 }); }
}

// ---------- المستخدمون والشركات ----------
// الأدوار: admin (أدمن النظام - كل شيء) | client (العميل - كل صلاحيات شركته)
//          pmo (مدير المشاريع - كل مشاريع شركته تشغيلياً) | pm (مدير مشروع - مشروعه المعيّن فقط)
const ROLES = ['admin', 'client', 'pmo', 'pm'];
function loadUsers() { return readJSON(USERS_FILE, []); }
function saveUsers(users) { writeJSON(USERS_FILE, users); }
function loadCompanies() { return readJSON(COMPANIES_FILE, []); }
function saveCompanies(c) { writeJSON(COMPANIES_FILE, c); }

// ---------- التكاملات الخارجية (Bassir ERP ... ) ----------
// تُخزّن على الخادم فقط ولا يُرسل المفتاح للواجهة. الهيكل: { "<companyId>": { bassir: {...} } }
function loadIntegrations() { return readJSON(INTEGRATIONS_FILE, {}); }
function saveIntegrations(o) { writeJSON(INTEGRATIONS_FILE, o); }
function companyIntegration(companyId) {
  const all = loadIntegrations();
  return (all[companyId] && all[companyId].bassir) || { enabled: false, url: '', apiKey: '', authHeader: 'Authorization', authPrefix: 'Bearer ', lastStatus: '', lastAt: '' };
}
// نسخة آمنة للواجهة: بدون المفتاح، فقط هل هو مُعيّن
function redactIntegration(cfg) {
  return { enabled: !!cfg.enabled, url: cfg.url || '', apiKeySet: !!cfg.apiKey, authHeader: cfg.authHeader || 'Authorization', authPrefix: cfg.authPrefix !== undefined ? cfg.authPrefix : 'Bearer ', lastStatus: cfg.lastStatus || '', lastAt: cfg.lastAt || '' };
}
function setIntegrationStatus(companyId, status) {
  const all = loadIntegrations();
  if (!all[companyId]) all[companyId] = { bassir: {} };
  if (!all[companyId].bassir) all[companyId].bassir = {};
  all[companyId].bassir.lastStatus = status;
  all[companyId].bassir.lastAt = new Date().toISOString();
  saveIntegrations(all);
}

// إرسال المستخلص المُنشأ إلى Bassir ERP (إن كان التكامل مفعّلاً). لا يوقف حفظ المستخلص عند الفشل.
async function pushMustakhlasToBassir(companyId, project, mus) {
  const cfg = companyIntegration(companyId);
  if (!cfg.enabled || !cfg.url) return;
  const payload = {
    event: 'mustakhlas.created',
    source: 'azoom-project-tracking',
    sentAt: new Date().toISOString(),
    project: { id: project.id, name: (project.info || {}).name || '', client: (project.info || {}).client || '' },
    mustakhlas: { no: mus.no, date: mus.date, gross: mus.gross, vat: mus.vat, net: mus.net, by: mus.by || '', status: 'delivered_to_consultant_became_mustakhlas' },
    // البنود التي سُلّمت للاستشاري وصارت مستخلص
    items: (mus.lines || []).map(l => ({
      code: l.itemId, description: l.desc, unit: l.unit, rate: l.rate,
      previousQty: l.prevQty, deliveredQty: l.currQty, cumulativeQty: l.cumQty, amount: l.amount,
      status: 'delivered_to_consultant'
    }))
  };
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers[cfg.authHeader || 'Authorization'] = (cfg.authPrefix !== undefined ? cfg.authPrefix : 'Bearer ') + cfg.apiKey;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(cfg.url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal });
    clearTimeout(t);
    setIntegrationStatus(companyId, r.ok ? ('نجح — ' + mus.no + ' (HTTP ' + r.status + ')') : ('فشل — HTTP ' + r.status));
  } catch (e) {
    setIntegrationStatus(companyId, 'فشل الإرسال: ' + (e && e.message ? e.message : 'خطأ اتصال'));
  }
}

function bootstrapAdmin() {
  const users = loadUsers();
  if (users.length) return;
  const username = process.env.ADMIN_USER || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  users.push({ id: 1, username, name: 'أدمن النظام', role: 'admin', companyId: null, hash: bcrypt.hashSync(password, 10) });
  saveUsers(users);
  const meta = readJSON(META_FILE, { nextId: 100 });
  writeJSON(META_FILE, meta);
  console.log('==============================================');
  console.log('تم إنشاء حساب أدمن النظام:');
  console.log('  اسم المستخدم: ' + username);
  console.log('  كلمة المرور : ' + password);
  if (!process.env.ADMIN_PASSWORD) console.log('  ⚠️  غيّر كلمة المرور فوراً من داخل النظام أو عيّن ADMIN_PASSWORD في .env');
  console.log('==============================================');
}
bootstrapAdmin();

// ترقية البيانات القديمة: owner→admin، وإنشاء شركة افتراضية وربط المشاريع والمستخدمين بها
function migrateData() {
  let companies = loadCompanies();
  const users = loadUsers();
  let changedUsers = false;
  const needsCompany = users.some(u => u.role !== 'admin' && !u.companyId) ||
    listProjects().some(p => !p.companyId);
  if (!companies.length && (needsCompany || users.length)) {
    companies = [{ id: 1, name: 'الشركة الرئيسية' }];
    saveCompanies(companies);
  }
  users.forEach(u => {
    if (u.role === 'owner') { u.role = 'admin'; u.companyId = null; changedUsers = true; }
    if (!ROLES.includes(u.role)) { u.role = 'pm'; changedUsers = true; }
    if (u.role !== 'admin' && !u.companyId) { u.companyId = companies[0] ? companies[0].id : 1; changedUsers = true; }
  });
  if (changedUsers) saveUsers(users);
  listProjects().forEach(p => {
    if (!p.companyId) { p.companyId = companies[0] ? companies[0].id : 1; saveProject(p); }
  });
}
migrateData();

function nextId() {
  const meta = readJSON(META_FILE, { nextId: 100 });
  meta.nextId = (meta.nextId || 100) + 1;
  writeJSON(META_FILE, meta);
  return meta.nextId;
}

// ---------- المشاريع ----------
function projectFile(id) { return path.join(PROJECTS_DIR, id + '.json'); }
function listProjects() {
  return fs.readdirSync(PROJECTS_DIR)
    .filter(f => /^\d+\.json$/.test(f))
    .map(f => readJSON(path.join(PROJECTS_DIR, f), null))
    .filter(Boolean);
}
function loadProject(id) { return readJSON(projectFile(id), null); }
function saveProject(p) { writeJSON(projectFile(p.id), p); }

const sanitizeUser = u => ({ id: u.id, username: u.username, name: u.name, role: u.role, companyId: u.companyId ?? null });

// ---------- قاعدة بيانات الأسعار والعروض (لكل شركة) ----------
function pricedbFile(companyId) { return path.join(PRICEDB_DIR, companyId + '.json'); }
function loadPricedb(companyId) {
  return readJSON(pricedbFile(companyId), { version: 0, seq: 1000, offers: [], items: [] });
}
function savePricedb(companyId, db) { writeJSON(pricedbFile(companyId), db); }

// ربط ملفات العروض الأصلية (PDF) بالعروض عند التعبئة الأولية
const SEED_ATTACHMENTS = {
  'ASF26071502': [
    { src: 'moddah-financial.pdf', name: 'العرض المالي - تجاري سكني (المودة).pdf' },
    { src: 'moddah-technical.pdf', name: 'العرض الفني - تجاري سكني (المودة).pdf' }
  ],
  '1103-52': [{ src: 'nakheel-offer.pdf', name: 'العرض المالي والفني - ذات النخيل.pdf' }],
  '1103-57': [{ src: 'qalbnajd-offer.pdf', name: 'العرض المالي - قلب نجد.pdf' }]
};

// تعبئة أولية: تحميل عروض عزوم من ملف البذور إلى شركة عند طلبها
function seedPricedb(companyId) {
  const seedFile = path.join(__dirname, 'seed-pricedb.json');
  const seed = readJSON(seedFile, null);
  if (!seed) return { error: 'ملف البيانات الأولية غير موجود' };
  const seedFilesDir = path.join(__dirname, 'seed-files');
  const destDir = path.join(UPLOADS_DIR, 'pricedb', String(companyId));
  fs.mkdirSync(destDir, { recursive: true });
  const offers = (seed.offers || []).map(o => {
    const atts = (SEED_ATTACHMENTS[o.ref] || []).map(a => {
      const srcPath = path.join(seedFilesDir, a.src);
      if (!fs.existsSync(srcPath)) return null;
      const ext = path.extname(a.src);
      const file = crypto.randomBytes(14).toString('hex') + ext;
      try { fs.copyFileSync(srcPath, path.join(destDir, file)); }
      catch (e) { return null; }
      return { url: '/uploads/pricedb/' + companyId + '/' + file, name: a.name };
    }).filter(Boolean);
    return { ...o, attachments: atts };
  });
  const db = { version: 1, seq: seed.seq || 1000, offers, items: seed.items || [] };
  savePricedb(companyId, db);
  return db;
}

// ---------- التطبيق ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));

// حد بسيط لمحاولات الدخول
const loginAttempts = new Map();
function loginLimited(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, ts: now };
  if (now - rec.ts > 10 * 60 * 1000) { rec.count = 0; rec.ts = now; }
  rec.count++;
  loginAttempts.set(ip, rec);
  return rec.count > 30;
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = loadUsers().find(u => u.id === payload.uid);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    req.user = user;
    next();
  } catch (e) { return res.status(401).json({ error: 'unauthorized' }); }
}
const isAdmin = u => u.role === 'admin';
const adminOnly = (req, res, next) => isAdmin(req.user) ? next() : res.status(403).json({ error: 'صلاحية أدمن النظام فقط' });

// من يرى المشروع؟ الأدمن: الكل · العميل ومدير المشاريع: مشاريع شركتهم · مدير المشروع: المعيّن له فقط
function canAccessProject(user, p) {
  if (isAdmin(user)) return true;
  if (user.role === 'client' || user.role === 'pmo') return !!user.companyId && p.companyId === user.companyId;
  if (user.role === 'pm') return p.managerUserId === user.id;
  return false;
}
// من يدير مشاريع الشركة (إنشاء/حذف/تعيين مدراء)؟ الأدمن أو عميل الشركة نفسها
const canAdminCompany = (user, companyId) => isAdmin(user) || (user.role === 'client' && !!user.companyId && user.companyId === companyId);
// من يدير مستخدمي الشركة؟ الأدمن (أي شركة وأي دور) أو العميل (موظفو شركته بأدوار pmo/pm فقط)
const canManageUser = (actor, target) => isAdmin(actor) ||
  (actor.role === 'client' && ['pmo','pm'].includes(target.role) && target.companyId === actor.companyId);

// ---------- المصادقة ----------
app.post('/api/auth/login', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?';
  if (loginLimited(String(ip))) return res.status(429).json({ error: 'محاولات كثيرة — انتظر 10 دقائق' });
  const { username, password } = req.body || {};
  const user = loadUsers().find(u => u.username === String(username || '').trim());
  if (!user || !bcrypt.compareSync(String(password || ''), user.hash)) {
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }
  const token = jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: sanitizeUser(user) });
});

app.get('/api/me', auth, (req, res) => res.json(sanitizeUser(req.user)));

app.put('/api/me/password', auth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) return res.status(400).json({ error: 'كلمة المرور قصيرة (4 أحرف على الأقل)' });
  const users = loadUsers();
  const u = users.find(x => x.id === req.user.id);
  if (!bcrypt.compareSync(String(oldPassword || ''), u.hash)) return res.status(400).json({ error: 'كلمة المرور الحالية غير صحيحة' });
  u.hash = bcrypt.hashSync(String(newPassword), 10);
  saveUsers(users);
  res.json({ ok: true });
});

// ---------- الحالة الكاملة ----------
function visibleUsers(actor) {
  const users = loadUsers();
  if (isAdmin(actor)) return users;
  // غير الأدمن يرى مستخدمي شركته فقط (لعرض أسماء المدراء والتوثيق)
  return users.filter(u => u.id === actor.id || (u.companyId && u.companyId === actor.companyId));
}
function visibleCompanies(actor) {
  const companies = loadCompanies();
  if (isAdmin(actor)) return companies;
  return companies.filter(c => c.id === actor.companyId);
}

app.get('/api/state', auth, (req, res) => {
  const projects = listProjects().filter(p => canAccessProject(req.user, p));
  res.json({ me: sanitizeUser(req.user), users: visibleUsers(req.user).map(sanitizeUser), companies: visibleCompanies(req.user), projects });
});

app.get('/api/state/versions', auth, (req, res) => {
  const projects = listProjects().filter(p => canAccessProject(req.user, p));
  res.json(projects.map(p => ({ id: p.id, version: p.version })));
});

// ---------- الشركات (أدمن النظام فقط) ----------
app.post('/api/companies', auth, adminOnly, (req, res) => {
  const name = String((req.body||{}).name || '').trim();
  if (!name) return res.status(400).json({ error: 'اكتب اسم الشركة' });
  const companies = loadCompanies();
  if (companies.some(c => c.name === name)) return res.status(400).json({ error: 'الشركة موجودة مسبقاً' });
  const c = { id: nextId(), name };
  companies.push(c);
  saveCompanies(companies);
  res.json(c);
});

app.put('/api/companies/:id', auth, adminOnly, (req, res) => {
  const companies = loadCompanies();
  const c = companies.find(x => x.id === Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'الشركة غير موجودة' });
  const name = String((req.body||{}).name || '').trim();
  if (name) c.name = name;
  saveCompanies(companies);
  res.json(c);
});

app.delete('/api/companies/:id', auth, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  if (listProjects().some(p => p.companyId === id)) return res.status(400).json({ error: 'لا يمكن حذف شركة لديها مشاريع — احذف أو انقل مشاريعها أولاً' });
  if (loadUsers().some(u => u.companyId === id)) return res.status(400).json({ error: 'لا يمكن حذف شركة لديها مستخدمون — احذفهم أو انقلهم أولاً' });
  saveCompanies(loadCompanies().filter(c => c.id !== id));
  res.json({ ok: true });
});

// ---------- المشاريع ----------
app.post('/api/projects', auth, (req, res) => {
  const data = req.body && req.body.data;
  if (!data || !data.info || !data.info.name) return res.status(400).json({ error: 'بيانات المشروع ناقصة' });
  // العميل ينشئ داخل شركته فقط؛ الأدمن يحدد الشركة
  const companyId = isAdmin(req.user) ? Number(data.companyId) : req.user.companyId;
  if (!companyId || !loadCompanies().some(c => c.id === companyId)) return res.status(400).json({ error: 'حدد شركة صحيحة للمشروع' });
  if (!canAdminCompany(req.user, companyId)) return res.status(403).json({ error: 'إنشاء المشاريع صلاحية أدمن النظام أو عميل الشركة' });
  const p = { ...data, companyId, id: nextId(), version: 1 };
  saveProject(p);
  res.json({ id: p.id, version: p.version });
});

app.put('/api/projects/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  const stored = loadProject(id);
  if (!stored) return res.status(404).json({ error: 'المشروع غير موجود' });
  if (!canAccessProject(req.user, stored)) return res.status(403).json({ error: 'لا تملك صلاحية على هذا المشروع' });
  const { baseVersion, data } = req.body || {};
  if (!data) return res.status(400).json({ error: 'بيانات ناقصة' });
  if (Number(baseVersion) !== stored.version) return res.status(409).json({ error: 'conflict', version: stored.version });
  // تعيين مدير المشروع: أدمن أو عميل الشركة فقط · نقل المشروع بين الشركات: الأدمن فقط
  const canAssign = canAdminCompany(req.user, stored.companyId);
  const managerUserId = canAssign ? (data.managerUserId ?? null) : stored.managerUserId;
  const companyId = isAdmin(req.user) && data.companyId && loadCompanies().some(c => c.id === Number(data.companyId))
    ? Number(data.companyId) : stored.companyId;

  // دورة اعتماد المستخلصات: مدير المشروع يرفع فقط — لا يعتمد ولا يصدر فواتير ولا يسجل دفعات
  // ولا يحذف مستخلصاً معتمداً/صادراً (يُفرض هنا حتى لو تجاوز الواجهة)
  if (req.user.role === 'pm') {
    const storedMus = stored.mustakhlasat || [];
    const incomingMus = Array.isArray(data.mustakhlasat) ? data.mustakhlasat : [];
    const inIds = new Set(incomingMus.map(m => m.id));
    for (const s of storedMus) {
      if (!inIds.has(s.id) && !['submitted','rejected'].includes(s.status || 'submitted')) {
        return res.status(403).json({ error: 'لا يمكن لمدير المشروع حذف مستخلص معتمد أو صادرت له فاتورة' });
      }
    }
    const stMap = new Map(storedMus.map(m => [m.id, m]));
    incomingMus.forEach(m => {
      const s = stMap.get(m.id);
      if (s) {
        // الحقول الاعتمادية والمالية تبقى كما اعتمدها المراجع
        m.status = s.status; m.approvedBy = s.approvedBy; m.approvedAt = s.approvedAt;
        m.rejectReason = s.rejectReason; m.invoiceNo = s.invoiceNo; m.invoiceDate = s.invoiceDate; m.invoiceBy = s.invoiceBy;
        m.payments = s.payments || [];
      } else {
        // مستخلص جديد من مدير المشروع = مرفوع للمراجعة دائماً
        m.status = 'submitted';
        delete m.approvedBy; delete m.approvedAt; delete m.invoiceNo; delete m.invoiceDate; delete m.invoiceBy;
        m.payments = [];
      }
    });
  }

  // اعتماد كميات الاستشاري: أي زيادة في الكمية المعتمدة يجب أن تُقابلها استلامات (approvals) بمرفق موقّع
  const storedItems = new Map((stored.boqItems || []).map(i => [i.id, i]));
  for (const it of (data.boqItems || [])) {
    const prev = storedItems.get(it.id);
    // ترحيل: البنود القديمة بدون approvedQty تُعامل كمعتمدة بمقدار المنفذ سابقاً (لا تتطلب استلاماً)
    const prevApproved = prev ? (prev.approvedQty !== undefined ? prev.approvedQty : (prev.executedQty || 0)) : 0;
    const newApproved = it.approvedQty || 0;
    if (newApproved > prevApproved + 0.001) {
      const approvalsSum = (it.approvals || []).reduce((s, a) => s + (Number(a.qty) || 0), 0);
      const allHaveAR = (it.approvals || []).every(a => a.ar && a.ar.url);
      if (approvalsSum + 0.01 < newApproved || !allHaveAR) {
        return res.status(400).json({ error: 'اعتماد الكمية يتطلب استلاماً موقّعاً من الاستشاري لكل كمية معتمدة (البند ' + it.id + ')' });
      }
    }
  }

  // رقابة تعديل الإنتاجية: مدير المشروع (pm) لا يعدّل/يحذف يومية قائمة ولا يغيّر الكمية المنفذة إلا عبر طلب مُعتمَد
  if (req.user.role === 'pm') {
    const storedLogs = new Map((stored.workLogs || []).map(l => [l.id, l]));
    const incomingLogs = Array.isArray(data.workLogs) ? data.workLogs : [];
    const incomingLogIds = new Set(incomingLogs.map(l => l.id));
    // لا حذف ليوميات قائمة
    for (const sid of storedLogs.keys()) {
      if (!incomingLogIds.has(sid)) return res.status(403).json({ error: 'حذف يومية الإنتاجية يتطلب موافقة العميل ومدير المشاريع' });
    }
    // لا تعديل ليومية قائمة؛ وجمع الكميات المطبّقة من اليوميات الجديدة
    const addByItem = {};
    for (const l of incomingLogs) {
      const s = storedLogs.get(l.id);
      if (s) {
        if ((s.qty || 0) !== (l.qty || 0) || (s.appliedQty || 0) !== (l.appliedQty || 0) ||
            !!s.applied !== !!l.applied || s.itemId !== l.itemId || s.date !== l.date) {
          return res.status(403).json({ error: 'تعديل يومية الإنتاجية يتطلب موافقة العميل ومدير المشاريع' });
        }
      } else if (l.applied) {
        addByItem[l.itemId] = (addByItem[l.itemId] || 0) + (Number(l.appliedQty) || 0);
      }
    }
    // الكمية المنفذة لكل بند: لا تتغير إلا بمقدار اليوميات الجديدة المطبّقة؛ البنود الجديدة تبدأ بصفر
    for (const it of (data.boqItems || [])) {
      const s = storedItems.get(it.id);
      if (!s) {
        if ((Number(it.executedQty) || 0) > 0.01) return res.status(403).json({ error: 'البند الجديد يبدأ بكمية منفذة صفر (البند ' + it.id + ')' });
        continue;
      }
      const allowed = (Number(s.executedQty) || 0) + (addByItem[it.id] || 0);
      if (Math.abs((Number(it.executedQty) || 0) - allowed) > 0.02) {
        return res.status(403).json({ error: 'تعديل الكمية المنفذة يتطلب موافقة العميل ومدير المشاريع (البند ' + it.id + ')' });
      }
    }
    // طلبات التعديل: يُضيف مدير المشروع طلبات جديدة فقط (بحالة pending وبدون اعتمادات) ولا يعدّل القائمة
    const storedReqs = new Map((stored.editRequests || []).map(r => [r.id, r]));
    for (const r of (Array.isArray(data.editRequests) ? data.editRequests : [])) {
      const s = storedReqs.get(r.id);
      if (s) {
        if (s.status !== r.status || !!s.clientApproved !== !!r.clientApproved || !!s.pmoApproved !== !!r.pmoApproved) {
          return res.status(403).json({ error: 'مدير المشروع لا يعتمد طلبات التعديل — الاعتماد للعميل ومدير المشاريع' });
        }
      } else if (r.status !== 'pending' || r.clientApproved || r.pmoApproved) {
        return res.status(403).json({ error: 'طلب التعديل الجديد يبدأ بانتظار الموافقة' });
      }
    }
  }

  const p = { ...data, managerUserId, companyId, id, version: stored.version + 1 };
  saveProject(p);
  res.json({ version: p.version });

  // تكامل خارجي: عند إنشاء مستخلص جديد، أرسله إلى Bassir ERP (لا يوقف الحفظ)
  try {
    const oldIds = new Set((stored.mustakhlasat || []).map(x => x.id));
    (p.mustakhlasat || []).forEach(mus => {
      if (!oldIds.has(mus.id)) setImmediate(() => pushMustakhlasToBassir(companyId, p, mus));
    });
  } catch (e) { /* لا يؤثر على الحفظ */ }
});

app.delete('/api/projects/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  const stored = loadProject(id);
  if (!stored) return res.status(404).json({ error: 'المشروع غير موجود' });
  if (!canAdminCompany(req.user, stored.companyId)) return res.status(403).json({ error: 'حذف المشاريع صلاحية أدمن النظام أو عميل الشركة' });
  fs.unlinkSync(projectFile(id));
  res.json({ ok: true });
});

// ---------- المستخدمون ----------
app.get('/api/users', auth, (req, res) => res.json(visibleUsers(req.user).map(sanitizeUser)));

app.post('/api/users', auth, (req, res) => {
  const { username, name, role, password, companyId } = req.body || {};
  const un = String(username || '').trim();
  if (!un || !name || !password) return res.status(400).json({ error: 'أكمل: اسم المستخدم، الاسم، كلمة المرور' });
  if (String(password).length < 4) return res.status(400).json({ error: 'كلمة المرور قصيرة (4 أحرف على الأقل)' });
  let newRole = ROLES.includes(role) ? role : 'pm';
  let newCompanyId = null;
  if (isAdmin(req.user)) {
    newCompanyId = newRole === 'admin' ? null : Number(companyId) || null;
    if (newRole !== 'admin' && (!newCompanyId || !loadCompanies().some(c => c.id === newCompanyId)))
      return res.status(400).json({ error: 'حدد شركة صحيحة للمستخدم' });
  } else if (req.user.role === 'client') {
    // العميل يضيف موظفي شركته فقط (مدير مشاريع / مدير مشروع)
    if (!['pmo','pm'].includes(newRole)) return res.status(403).json({ error: 'العميل يضيف أدوار: مدير مشاريع أو مدير مشروع فقط' });
    newCompanyId = req.user.companyId;
  } else {
    return res.status(403).json({ error: 'إضافة المستخدمين صلاحية أدمن النظام أو العميل' });
  }
  const users = loadUsers();
  if (users.some(u => u.username === un)) return res.status(400).json({ error: 'اسم المستخدم موجود مسبقاً' });
  const u = { id: nextId(), username: un, name: String(name).trim(), role: newRole, companyId: newCompanyId, hash: bcrypt.hashSync(String(password), 10) };
  users.push(u);
  saveUsers(users);
  res.json(sanitizeUser(u));
});

app.put('/api/users/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  const users = loadUsers();
  const u = users.find(x => x.id === id);
  if (!u) return res.status(404).json({ error: 'المستخدم غير موجود' });
  if (!canManageUser(req.user, u)) return res.status(403).json({ error: 'لا تملك صلاحية على هذا المستخدم' });
  const { name, role, password } = req.body || {};
  if (name) u.name = String(name).trim();
  if (role && ROLES.includes(role)) {
    const allowed = isAdmin(req.user) ? ROLES : ['pmo','pm'];
    if (!allowed.includes(role)) return res.status(403).json({ error: 'لا يمكنك منح هذا الدور' });
    if (u.role === 'admin' && role !== 'admin' && users.filter(x => x.role === 'admin').length <= 1)
      return res.status(400).json({ error: 'لا يمكن تنزيل صلاحية آخر أدمن' });
    u.role = role;
    if (role === 'admin') u.companyId = null;
  }
  if (password) {
    if (String(password).length < 4) return res.status(400).json({ error: 'كلمة المرور قصيرة' });
    u.hash = bcrypt.hashSync(String(password), 10);
  }
  saveUsers(users);
  res.json(sanitizeUser(u));
});

app.delete('/api/users/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  const users = loadUsers();
  const u = users.find(x => x.id === id);
  if (!u) return res.status(404).json({ error: 'المستخدم غير موجود' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'لا يمكنك حذف نفسك' });
  if (!canManageUser(req.user, u)) return res.status(403).json({ error: 'لا تملك صلاحية على هذا المستخدم' });
  if (u.role === 'admin' && users.filter(x => x.role === 'admin').length <= 1)
    return res.status(400).json({ error: 'لا يمكن حذف آخر أدمن' });
  listProjects().forEach(p => {
    if (p.managerUserId === id) { p.managerUserId = null; p.version++; saveProject(p); }
  });
  saveUsers(users.filter(x => x.id !== id));
  res.json({ ok: true });
});

// ---------- قاعدة بيانات الأسعار والعروض ----------
// نطاق: كل شركة لها قاعدتها. الأدمن يحدد الشركة عبر ?companyId، وغيره شركته.
function pricedbCompanyOf(req) {
  if (isAdmin(req.user)) {
    const q = Number(req.query.companyId || req.body && req.body.companyId);
    return q || (loadCompanies()[0] ? loadCompanies()[0].id : null);
  }
  return req.user.companyId || null;
}
const canEditPricedb = u => ['admin', 'client', 'pmo'].includes(u.role);

app.get('/api/pricedb', auth, (req, res) => {
  const companyId = pricedbCompanyOf(req);
  if (!companyId) return res.json({ companyId: null, version: 0, seq: 1000, offers: [], items: [], canEdit: false });
  res.json({ ...loadPricedb(companyId), companyId, canEdit: canEditPricedb(req.user) });
});

app.put('/api/pricedb', auth, (req, res) => {
  if (!canEditPricedb(req.user)) return res.status(403).json({ error: 'تعديل قاعدة الأسعار صلاحية مدير المشاريع فأعلى' });
  const companyId = pricedbCompanyOf(req);
  if (!companyId) return res.status(400).json({ error: 'لا توجد شركة محددة' });
  const { baseVersion, data } = req.body || {};
  if (!data) return res.status(400).json({ error: 'بيانات ناقصة' });
  const stored = loadPricedb(companyId);
  if (Number(baseVersion) !== stored.version) return res.status(409).json({ error: 'conflict', version: stored.version });
  const db = { version: stored.version + 1, seq: data.seq || stored.seq, offers: data.offers || [], items: data.items || [] };
  savePricedb(companyId, db);
  res.json({ version: db.version });
});

app.post('/api/pricedb/seed', auth, (req, res) => {
  if (!canEditPricedb(req.user)) return res.status(403).json({ error: 'صلاحية مدير المشاريع فأعلى' });
  const companyId = pricedbCompanyOf(req);
  if (!companyId) return res.status(400).json({ error: 'لا توجد شركة محددة' });
  const existing = loadPricedb(companyId);
  if ((existing.offers || []).length || (existing.items || []).length) {
    if (!req.body || !req.body.force) return res.status(400).json({ error: 'قاعدة الأسعار غير فارغة — استخدم force للاستبدال' });
  }
  const db = seedPricedb(companyId);
  if (db.error) return res.status(500).json(db);
  res.json({ ...db, companyId, canEdit: true });
});

// رفع ملفات العروض (PDF/صور) لقاعدة الأسعار — تخزن تحت uploads/pricedb/<companyId>
app.post('/api/pricedb/upload', auth, (req, res) => {
  if (!canEditPricedb(req.user)) return res.status(403).json({ error: 'صلاحية مدير المشاريع فأعلى' });
  const companyId = pricedbCompanyOf(req);
  if (!companyId) return res.status(400).json({ error: 'لا توجد شركة محددة' });
  const dataUrl = req.body && req.body.dataUrl;
  const m = /^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || '').slice(0, 16 * 1024 * 1024));
  if (!m) return res.status(400).json({ error: 'الصيغة غير مدعومة (PDF أو صور)' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'الملف كبير جداً (الحد 10MB)' });
  const ext = m[1] === 'application/pdf' ? 'pdf' : (m[1] === 'image/jpeg' ? 'jpg' : m[1].split('/')[1]);
  const file = crypto.randomBytes(14).toString('hex') + '.' + ext;
  const dir = path.join(UPLOADS_DIR, 'pricedb', String(companyId));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), buf);
  res.json({ url: '/uploads/pricedb/' + companyId + '/' + file });
});

// ---------- صور الموقع ----------
// الرفع: JSON بصيغة dataURL (الواجهة تضغط الصورة قبل الإرسال)
// أسماء الملفات عشوائية غير قابلة للتخمين، وتُخدم من /uploads
app.post('/api/projects/:id/photos', auth, (req, res) => {
  const id = Number(req.params.id);
  const stored = loadProject(id);
  if (!stored) return res.status(404).json({ error: 'المشروع غير موجود' });
  if (!canAccessProject(req.user, stored)) return res.status(403).json({ error: 'لا تملك صلاحية على هذا المشروع' });
  const dataUrl = req.body && req.body.dataUrl;
  const m = /^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || '').slice(0, 16 * 1024 * 1024));
  if (!m) return res.status(400).json({ error: 'الصيغة غير مدعومة (صور jpeg/png/webp أو PDF)' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'الملف كبير جداً (الحد 10MB)' });
  const ext = m[1] === 'application/pdf' ? 'pdf' : (m[1] === 'image/jpeg' ? 'jpg' : m[1].split('/')[1]);
  const file = crypto.randomBytes(14).toString('hex') + '.' + ext;
  const dir = path.join(UPLOADS_DIR, String(id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), buf);
  res.json({ url: '/uploads/' + id + '/' + file });
});

app.delete('/api/projects/:id/photos/:file', auth, (req, res) => {
  const id = Number(req.params.id);
  const stored = loadProject(id);
  if (!stored) return res.status(404).json({ error: 'المشروع غير موجود' });
  if (!canAccessProject(req.user, stored)) return res.status(403).json({ error: 'لا تملك صلاحية' });
  const file = String(req.params.file);
  if (!/^[a-f0-9]{28}\.(jpg|png|webp|pdf)$/.test(file)) return res.status(400).json({ error: 'اسم ملف غير صالح' });
  const fp = path.join(UPLOADS_DIR, String(id), file);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  res.json({ ok: true });
});

app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '30d', immutable: true }));

// ---------- تكامل Bassir ERP ----------
function integrationCompanyOf(req) {
  if (isAdmin(req.user)) return Number(req.query.companyId || (req.body && req.body.companyId)) || (loadCompanies()[0] ? loadCompanies()[0].id : null);
  return req.user.companyId || null;
}
app.get('/api/integration', auth, (req, res) => {
  if (!['admin', 'client', 'pmo'].includes(req.user.role)) return res.status(403).json({ error: 'صلاحية مدير المشاريع فأعلى' });
  const companyId = integrationCompanyOf(req);
  if (!companyId) return res.json({ companyId: null, bassir: redactIntegration({}) });
  res.json({ companyId, bassir: redactIntegration(companyIntegration(companyId)), canEdit: canAdminCompany(req.user, companyId) });
});
app.put('/api/integration', auth, (req, res) => {
  const companyId = integrationCompanyOf(req);
  if (!companyId) return res.status(400).json({ error: 'لا توجد شركة' });
  if (!canAdminCompany(req.user, companyId)) return res.status(403).json({ error: 'تعديل التكامل صلاحية أدمن النظام أو عميل الشركة' });
  const body = (req.body && req.body.bassir) || {};
  const all = loadIntegrations();
  if (!all[companyId]) all[companyId] = { bassir: {} };
  const cur = all[companyId].bassir || {};
  cur.enabled = !!body.enabled;
  if (body.url !== undefined) cur.url = String(body.url || '').trim();
  if (body.authHeader !== undefined) cur.authHeader = String(body.authHeader || 'Authorization').trim() || 'Authorization';
  if (body.authPrefix !== undefined) cur.authPrefix = String(body.authPrefix || '');
  // تحديث المفتاح فقط إذا أُرسل نص جديد (فارغ = إبقاء القديم)
  if (typeof body.apiKey === 'string' && body.apiKey.length) cur.apiKey = body.apiKey;
  if (body.clearKey) cur.apiKey = '';
  all[companyId].bassir = cur;
  saveIntegrations(all);
  res.json({ ok: true, bassir: redactIntegration(cur) });
});
// إرسال طلب تجريبي للتأكد من الاتصال
app.post('/api/integration/test', auth, async (req, res) => {
  const companyId = integrationCompanyOf(req);
  if (!companyId || !canAdminCompany(req.user, companyId)) return res.status(403).json({ error: 'صلاحية أدمن النظام أو عميل الشركة' });
  const cfg = companyIntegration(companyId);
  if (!cfg.url) return res.status(400).json({ error: 'لم يتم إدخال رابط API' });
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers[cfg.authHeader || 'Authorization'] = (cfg.authPrefix !== undefined ? cfg.authPrefix : 'Bearer ') + cfg.apiKey;
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(cfg.url, { method: 'POST', headers, body: JSON.stringify({ event: 'ping', source: 'azoom-project-tracking', sentAt: new Date().toISOString() }), signal: ctrl.signal });
    clearTimeout(t);
    setIntegrationStatus(companyId, (r.ok ? 'اختبار ناجح' : 'اختبار — HTTP ' + r.status) + ' @ ' + new Date().toLocaleString('en-GB'));
    res.json({ ok: r.ok, status: r.status });
  } catch (e) {
    setIntegrationStatus(companyId, 'فشل الاختبار: ' + (e && e.message ? e.message : 'خطأ'));
    res.status(502).json({ error: 'تعذر الاتصال: ' + (e && e.message ? e.message : 'خطأ') });
  }
});

// ---------- نسخ احتياطي واستعادة ----------
app.get('/api/backup', auth, adminOnly, (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="azoom-backup-' + new Date().toISOString().slice(0, 10) + '.json"');
  const pricedbs = loadCompanies().map(c => ({ companyId: c.id, db: loadPricedb(c.id) }));
  res.json({ exportedAt: new Date().toISOString(), projects: listProjects(), users: loadUsers().map(sanitizeUser), companies: loadCompanies(), pricedbs });
});

app.post('/api/restore', auth, adminOnly, (req, res) => {
  const incoming = req.body && req.body.projects;
  if (!Array.isArray(incoming) || !incoming.length) return res.status(400).json({ error: 'لا توجد مشاريع في الملف' });
  const userIds = new Set(loadUsers().map(u => u.id));
  // حذف المشاريع الحالية ثم إنشاء المستوردة بمعرفات جديدة
  listProjects().forEach(p => fs.unlinkSync(projectFile(p.id)));
  const companyIds = new Set(loadCompanies().map(c => c.id));
  const fallbackCompany = loadCompanies()[0] ? loadCompanies()[0].id : 1;
  const created = incoming.map(raw => {
    const { id, version, ...data } = raw;
    if (data.managerUserId && !userIds.has(data.managerUserId)) data.managerUserId = null;
    if (!data.companyId || !companyIds.has(data.companyId)) data.companyId = fallbackCompany;
    const p = { ...data, id: nextId(), version: 1 };
    saveProject(p);
    return p.id;
  });
  res.json({ ok: true, count: created.length });
});

// ---------- الواجهة ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
  if (req.path.startsWith('/uploads/')) return res.status(404).end();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('نظام إدارة المستخلصات يعمل على المنفذ ' + PORT);
  console.log('مجلد البيانات: ' + DATA_DIR + ' (خذ منه نسخاً احتياطية دورية)');
});
