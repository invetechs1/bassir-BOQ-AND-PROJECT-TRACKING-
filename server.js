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

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');
const SECRET_FILE = path.join(DATA_DIR, '.jwt-secret');

fs.mkdirSync(PROJECTS_DIR, { recursive: true });

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

// ---------- المستخدمون ----------
function loadUsers() { return readJSON(USERS_FILE, []); }
function saveUsers(users) { writeJSON(USERS_FILE, users); }

function bootstrapAdmin() {
  const users = loadUsers();
  if (users.length) return;
  const username = process.env.ADMIN_USER || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  users.push({ id: 1, username, name: 'المالك - الإدارة العامة', role: 'owner', hash: bcrypt.hashSync(password, 10) });
  saveUsers(users);
  const meta = readJSON(META_FILE, { nextId: 100 });
  writeJSON(META_FILE, meta);
  console.log('==============================================');
  console.log('تم إنشاء حساب المالك الأول:');
  console.log('  اسم المستخدم: ' + username);
  console.log('  كلمة المرور : ' + password);
  if (!process.env.ADMIN_PASSWORD) console.log('  ⚠️  غيّر كلمة المرور فوراً من داخل النظام أو عيّن ADMIN_PASSWORD في .env');
  console.log('==============================================');
}
bootstrapAdmin();

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

const sanitizeUser = u => ({ id: u.id, username: u.username, name: u.name, role: u.role });

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
const ownerOnly = (req, res, next) => req.user.role === 'owner' ? next() : res.status(403).json({ error: 'صلاحية المالك فقط' });
const canAccessProject = (user, p) => user.role === 'owner' || p.managerUserId === user.id;

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
app.get('/api/state', auth, (req, res) => {
  const projects = listProjects().filter(p => canAccessProject(req.user, p));
  res.json({ me: sanitizeUser(req.user), users: loadUsers().map(sanitizeUser), projects });
});

app.get('/api/state/versions', auth, (req, res) => {
  const projects = listProjects().filter(p => canAccessProject(req.user, p));
  res.json(projects.map(p => ({ id: p.id, version: p.version })));
});

// ---------- المشاريع ----------
app.post('/api/projects', auth, ownerOnly, (req, res) => {
  const data = req.body && req.body.data;
  if (!data || !data.info || !data.info.name) return res.status(400).json({ error: 'بيانات المشروع ناقصة' });
  const p = { ...data, id: nextId(), version: 1 };
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
  // مدير المشروع لا يستطيع إعادة تعيين نفسه أو غيره
  const managerUserId = req.user.role === 'owner' ? (data.managerUserId ?? null) : stored.managerUserId;
  const p = { ...data, managerUserId, id, version: stored.version + 1 };
  saveProject(p);
  res.json({ version: p.version });
});

app.delete('/api/projects/:id', auth, ownerOnly, (req, res) => {
  const id = Number(req.params.id);
  if (!loadProject(id)) return res.status(404).json({ error: 'المشروع غير موجود' });
  fs.unlinkSync(projectFile(id));
  res.json({ ok: true });
});

// ---------- المستخدمون ----------
app.get('/api/users', auth, (req, res) => res.json(loadUsers().map(sanitizeUser)));

app.post('/api/users', auth, ownerOnly, (req, res) => {
  const { username, name, role, password } = req.body || {};
  const un = String(username || '').trim();
  if (!un || !name || !password) return res.status(400).json({ error: 'أكمل: اسم المستخدم، الاسم، كلمة المرور' });
  if (String(password).length < 4) return res.status(400).json({ error: 'كلمة المرور قصيرة (4 أحرف على الأقل)' });
  const users = loadUsers();
  if (users.some(u => u.username === un)) return res.status(400).json({ error: 'اسم المستخدم موجود مسبقاً' });
  const u = { id: nextId(), username: un, name: String(name).trim(), role: role === 'owner' ? 'owner' : 'pm', hash: bcrypt.hashSync(String(password), 10) };
  users.push(u);
  saveUsers(users);
  res.json(sanitizeUser(u));
});

app.put('/api/users/:id', auth, ownerOnly, (req, res) => {
  const id = Number(req.params.id);
  const users = loadUsers();
  const u = users.find(x => x.id === id);
  if (!u) return res.status(404).json({ error: 'المستخدم غير موجود' });
  const { name, role, password } = req.body || {};
  if (name) u.name = String(name).trim();
  if (role && (role === 'owner' || role === 'pm')) {
    if (u.role === 'owner' && role !== 'owner' && users.filter(x => x.role === 'owner').length <= 1)
      return res.status(400).json({ error: 'لا يمكن تنزيل صلاحية آخر مالك' });
    u.role = role;
  }
  if (password) {
    if (String(password).length < 4) return res.status(400).json({ error: 'كلمة المرور قصيرة' });
    u.hash = bcrypt.hashSync(String(password), 10);
  }
  saveUsers(users);
  res.json(sanitizeUser(u));
});

app.delete('/api/users/:id', auth, ownerOnly, (req, res) => {
  const id = Number(req.params.id);
  const users = loadUsers();
  const u = users.find(x => x.id === id);
  if (!u) return res.status(404).json({ error: 'المستخدم غير موجود' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'لا يمكنك حذف نفسك' });
  if (u.role === 'owner' && users.filter(x => x.role === 'owner').length <= 1)
    return res.status(400).json({ error: 'لا يمكن حذف آخر مالك' });
  listProjects().forEach(p => {
    if (p.managerUserId === id) { p.managerUserId = null; p.version++; saveProject(p); }
  });
  saveUsers(users.filter(x => x.id !== id));
  res.json({ ok: true });
});

// ---------- نسخ احتياطي واستعادة ----------
app.get('/api/backup', auth, ownerOnly, (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="azoom-backup-' + new Date().toISOString().slice(0, 10) + '.json"');
  res.json({ exportedAt: new Date().toISOString(), projects: listProjects(), users: loadUsers().map(sanitizeUser) });
});

app.post('/api/restore', auth, ownerOnly, (req, res) => {
  const incoming = req.body && req.body.projects;
  if (!Array.isArray(incoming) || !incoming.length) return res.status(400).json({ error: 'لا توجد مشاريع في الملف' });
  const userIds = new Set(loadUsers().map(u => u.id));
  // حذف المشاريع الحالية ثم إنشاء المستوردة بمعرفات جديدة
  listProjects().forEach(p => fs.unlinkSync(projectFile(p.id)));
  const created = incoming.map(raw => {
    const { id, version, ...data } = raw;
    if (data.managerUserId && !userIds.has(data.managerUserId)) data.managerUserId = null;
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
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('نظام إدارة المستخلصات يعمل على المنفذ ' + PORT);
  console.log('مجلد البيانات: ' + DATA_DIR + ' (خذ منه نسخاً احتياطية دورية)');
});
