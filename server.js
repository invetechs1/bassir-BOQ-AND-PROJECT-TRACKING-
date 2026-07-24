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
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const COMPANIES_FILE = path.join(DATA_DIR, 'companies.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');
const SECRET_FILE = path.join(DATA_DIR, '.jwt-secret');

fs.mkdirSync(PROJECTS_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

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
const adminOnly = (req, res, next) => isAdmin(req.user) ? next() : res.status(403).json({ error: 'admin_only' });

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
  if (loginLimited(String(ip))) return res.status(429).json({ error: 'rate_limited' });
  const { username, password } = req.body || {};
  const user = loadUsers().find(u => u.username === String(username || '').trim());
  if (!user || !bcrypt.compareSync(String(password || ''), user.hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const token = jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: sanitizeUser(user) });
});

app.get('/api/me', auth, (req, res) => res.json(sanitizeUser(req.user)));

app.put('/api/me/password', auth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) return res.status(400).json({ error: 'password_too_short' });
  const users = loadUsers();
  const u = users.find(x => x.id === req.user.id);
  if (!bcrypt.compareSync(String(oldPassword || ''), u.hash)) return res.status(400).json({ error: 'wrong_current_password' });
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
  if (!name) return res.status(400).json({ error: 'company_name_required' });
  const companies = loadCompanies();
  if (companies.some(c => c.name === name)) return res.status(400).json({ error: 'company_name_taken' });
  const c = { id: nextId(), name };
  companies.push(c);
  saveCompanies(companies);
  res.json(c);
});

app.put('/api/companies/:id', auth, adminOnly, (req, res) => {
  const companies = loadCompanies();
  const c = companies.find(x => x.id === Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'company_not_found' });
  const name = String((req.body||{}).name || '').trim();
  if (name) c.name = name;
  saveCompanies(companies);
  res.json(c);
});

app.delete('/api/companies/:id', auth, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  if (listProjects().some(p => p.companyId === id)) return res.status(400).json({ error: 'company_has_projects' });
  if (loadUsers().some(u => u.companyId === id)) return res.status(400).json({ error: 'company_has_users' });
  saveCompanies(loadCompanies().filter(c => c.id !== id));
  res.json({ ok: true });
});

// ---------- المشاريع ----------
app.post('/api/projects', auth, (req, res) => {
  const data = req.body && req.body.data;
  if (!data || !data.info || !data.info.name) return res.status(400).json({ error: 'project_data_incomplete' });
  // العميل ينشئ داخل شركته فقط؛ الأدمن يحدد الشركة
  const companyId = isAdmin(req.user) ? Number(data.companyId) : req.user.companyId;
  if (!companyId || !loadCompanies().some(c => c.id === companyId)) return res.status(400).json({ error: 'invalid_company_for_project' });
  if (!canAdminCompany(req.user, companyId)) return res.status(403).json({ error: 'create_project_denied' });
  const p = { ...data, companyId, id: nextId(), version: 1 };
  saveProject(p);
  res.json({ id: p.id, version: p.version });
});

app.put('/api/projects/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  const stored = loadProject(id);
  if (!stored) return res.status(404).json({ error: 'project_not_found' });
  if (!canAccessProject(req.user, stored)) return res.status(403).json({ error: 'no_project_access' });
  const { baseVersion, data } = req.body || {};
  if (!data) return res.status(400).json({ error: 'data_incomplete' });
  if (Number(baseVersion) !== stored.version) return res.status(409).json({ error: 'conflict', version: stored.version });
  // تعيين مدير المشروع: أدمن أو عميل الشركة فقط · نقل المشروع بين الشركات: الأدمن فقط
  const canAssign = canAdminCompany(req.user, stored.companyId);
  const managerUserId = canAssign ? (data.managerUserId ?? null) : stored.managerUserId;
  const companyId = isAdmin(req.user) && data.companyId && loadCompanies().some(c => c.id === Number(data.companyId))
    ? Number(data.companyId) : stored.companyId;
  const p = { ...data, managerUserId, companyId, id, version: stored.version + 1 };
  saveProject(p);
  res.json({ version: p.version });
});

app.delete('/api/projects/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  const stored = loadProject(id);
  if (!stored) return res.status(404).json({ error: 'project_not_found' });
  if (!canAdminCompany(req.user, stored.companyId)) return res.status(403).json({ error: 'delete_project_denied' });
  fs.unlinkSync(projectFile(id));
  res.json({ ok: true });
});

// ---------- المستخدمون ----------
app.get('/api/users', auth, (req, res) => res.json(visibleUsers(req.user).map(sanitizeUser)));

app.post('/api/users', auth, (req, res) => {
  const { username, name, role, password, companyId } = req.body || {};
  const un = String(username || '').trim();
  if (!un || !name || !password) return res.status(400).json({ error: 'fill_username_name_password' });
  if (String(password).length < 4) return res.status(400).json({ error: 'password_too_short' });
  let newRole = ROLES.includes(role) ? role : 'pm';
  let newCompanyId = null;
  if (isAdmin(req.user)) {
    newCompanyId = newRole === 'admin' ? null : Number(companyId) || null;
    if (newRole !== 'admin' && (!newCompanyId || !loadCompanies().some(c => c.id === newCompanyId)))
      return res.status(400).json({ error: 'invalid_company_for_user' });
  } else if (req.user.role === 'client') {
    // العميل يضيف موظفي شركته فقط (مدير مشاريع / مدير مشروع)
    if (!['pmo','pm'].includes(newRole)) return res.status(403).json({ error: 'client_role_restriction' });
    newCompanyId = req.user.companyId;
  } else {
    return res.status(403).json({ error: 'create_user_denied' });
  }
  const users = loadUsers();
  if (users.some(u => u.username === un)) return res.status(400).json({ error: 'username_taken' });
  const u = { id: nextId(), username: un, name: String(name).trim(), role: newRole, companyId: newCompanyId, hash: bcrypt.hashSync(String(password), 10) };
  users.push(u);
  saveUsers(users);
  res.json(sanitizeUser(u));
});

app.put('/api/users/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  const users = loadUsers();
  const u = users.find(x => x.id === id);
  if (!u) return res.status(404).json({ error: 'user_not_found' });
  if (!canManageUser(req.user, u)) return res.status(403).json({ error: 'no_user_access' });
  const { name, role, password } = req.body || {};
  if (name) u.name = String(name).trim();
  if (role && ROLES.includes(role)) {
    const allowed = isAdmin(req.user) ? ROLES : ['pmo','pm'];
    if (!allowed.includes(role)) return res.status(403).json({ error: 'cannot_grant_role' });
    if (u.role === 'admin' && role !== 'admin' && users.filter(x => x.role === 'admin').length <= 1)
      return res.status(400).json({ error: 'cannot_demote_last_admin' });
    u.role = role;
    if (role === 'admin') u.companyId = null;
  }
  if (password) {
    if (String(password).length < 4) return res.status(400).json({ error: 'password_too_short' });
    u.hash = bcrypt.hashSync(String(password), 10);
  }
  saveUsers(users);
  res.json(sanitizeUser(u));
});

app.delete('/api/users/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  const users = loadUsers();
  const u = users.find(x => x.id === id);
  if (!u) return res.status(404).json({ error: 'user_not_found' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'cannot_delete_self' });
  if (!canManageUser(req.user, u)) return res.status(403).json({ error: 'no_user_access' });
  if (u.role === 'admin' && users.filter(x => x.role === 'admin').length <= 1)
    return res.status(400).json({ error: 'cannot_delete_last_admin' });
  listProjects().forEach(p => {
    if (p.managerUserId === id) { p.managerUserId = null; p.version++; saveProject(p); }
  });
  saveUsers(users.filter(x => x.id !== id));
  res.json({ ok: true });
});

// ---------- صور الموقع ----------
// الرفع: JSON بصيغة dataURL (الواجهة تضغط الصورة قبل الإرسال)
// أسماء الملفات عشوائية غير قابلة للتخمين، وتُخدم من /uploads
app.post('/api/projects/:id/photos', auth, (req, res) => {
  const id = Number(req.params.id);
  const stored = loadProject(id);
  if (!stored) return res.status(404).json({ error: 'project_not_found' });
  if (!canAccessProject(req.user, stored)) return res.status(403).json({ error: 'no_project_access' });
  const dataUrl = req.body && req.body.dataUrl;
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || '').slice(0, 12 * 1024 * 1024));
  if (!m) return res.status(400).json({ error: 'unsupported_image_format' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 8 * 1024 * 1024) return res.status(400).json({ error: 'image_too_large' });
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const file = crypto.randomBytes(14).toString('hex') + '.' + ext;
  const dir = path.join(UPLOADS_DIR, String(id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), buf);
  res.json({ url: '/uploads/' + id + '/' + file });
});

app.delete('/api/projects/:id/photos/:file', auth, (req, res) => {
  const id = Number(req.params.id);
  const stored = loadProject(id);
  if (!stored) return res.status(404).json({ error: 'project_not_found' });
  if (!canAccessProject(req.user, stored)) return res.status(403).json({ error: 'no_access' });
  const file = String(req.params.file);
  if (!/^[a-f0-9]{28}\.(jpg|png|webp)$/.test(file)) return res.status(400).json({ error: 'invalid_filename' });
  const fp = path.join(UPLOADS_DIR, String(id), file);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  res.json({ ok: true });
});

app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '30d', immutable: true }));

// ---------- نسخ احتياطي واستعادة ----------
app.get('/api/backup', auth, adminOnly, (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="azoom-backup-' + new Date().toISOString().slice(0, 10) + '.json"');
  res.json({ exportedAt: new Date().toISOString(), projects: listProjects(), users: loadUsers().map(sanitizeUser), companies: loadCompanies() });
});

app.post('/api/restore', auth, adminOnly, (req, res) => {
  const incoming = req.body && req.body.projects;
  if (!Array.isArray(incoming) || !incoming.length) return res.status(400).json({ error: 'no_projects_in_file' });
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
