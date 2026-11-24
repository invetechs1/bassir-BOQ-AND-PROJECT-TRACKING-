'use strict';
/*
 * وحدة المستودع (Warehouse) — تتبّع كميات المواد.
 * بعد شراء المواد تُورّد للمستودع، وتُصرف منه لكل مقاول باطن أو ذاتي مع الكمية،
 * ويظهر الرصيد الحالي، ومن سحب كم من كل مادة.
 * تخزين منفصل لكل مشروع: data/warehouse/<projectId>.json
 */
const path = require('path');

module.exports = function initWarehouse(ctx) {
  const { app, DATA_DIR, PUBLIC_DIR, readJSON, writeJSON, fs, auth, loadProject, canAccessProject } = ctx;

  const WH_DIR = path.join(DATA_DIR, 'warehouse');
  const EXP_DIR = path.join(DATA_DIR, 'expenses');
  fs.mkdirSync(WH_DIR, { recursive: true });

  const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
  const now = () => new Date().toISOString();
  const whFile = id => path.join(WH_DIR, id + '.json');
  function loadWh(pid) { const o = readJSON(whFile(pid), { version: 0, materials: [], receipts: [], issues: [] }); o.materials = o.materials || []; o.receipts = o.receipts || []; o.issues = o.issues || []; return o; }
  function saveWh(pid, o) { o.version = (o.version || 0) + 1; writeJSON(whFile(pid), o); return o; }
  const genId = pre => pre + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // الكميات المشتراة فعلاً حسب فواتير المصاريف — مجمّعة حسب صنف المستودع المربوط بها.
  // تكشف الفرق بين ما دُفع عليه (فاتورة) وما دخل المستودع فعلاً (توريد).
  function purchasedByMaterial(pid) {
    const db = readJSON(path.join(EXP_DIR, pid + '.json'), { items: [] });
    const by = {};
    (db.items || []).forEach(e => {
      if (e.type === 'material' && e.warehouseMaterialId) {
        const k = String(e.warehouseMaterialId);
        if (!by[k]) by[k] = { qty: 0, amount: 0, count: 0 };
        by[k].qty = round2(by[k].qty + (Number(e.materialQty) || 0));
        by[k].amount = round2(by[k].amount + (Number(e.amount) || 0));
        by[k].count++;
      }
    });
    return by;
  }

  // صلاحية الإدارة (أمين المستودع): أدمن/عميل/مدير مشاريع/مدير مشروع ممن يملك وصولاً للمشروع
  function canManage(user, project) { return canAccessProject(user, project) && ['admin', 'client', 'pmo', 'pm'].includes(user.role); }
  function getProjectOr(req, res) {
    const p = loadProject(Number(req.params.id));
    if (!p) { res.status(404).json({ error: 'المشروع غير موجود' }); return null; }
    if (!canAccessProject(req.user, p)) { res.status(403).json({ error: 'لا تملك صلاحية على هذا المشروع' }); return null; }
    return p;
  }

  function stockOf(db) {
    const byMat = {};
    db.materials.forEach(m => { byMat[m.id] = { materialId: m.id, name: m.name, unit: m.unit, received: 0, issued: 0, balance: 0 }; });
    db.receipts.forEach(r => { const s = byMat[r.materialId]; if (s) s.received = round2(s.received + (Number(r.qty) || 0)); });
    db.issues.forEach(x => { const s = byMat[x.materialId]; if (s) s.issued = round2(s.issued + (Number(x.qty) || 0)); });
    Object.values(byMat).forEach(s => s.balance = round2(s.received - s.issued));
    return Object.values(byMat).sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  }
  function byRecipient(db, project) {
    const subName = id => { const s = (project.subcontractors || []).find(x => x.id === id); return s ? s.name : ('#' + id); };
    const matOf = id => db.materials.find(x => x.id === id) || { name: '?', unit: '' };
    const sinks = {};
    db.issues.forEach(x => {
      const key = (x.bearer === 'sub' && x.subId) ? ('sub:' + x.subId) : 'own';
      if (!sinks[key]) sinks[key] = { key, name: key === 'own' ? 'ذاتي (على الشركة)' : subName(x.subId), lines: {} };
      sinks[key].lines[x.materialId] = round2((sinks[key].lines[x.materialId] || 0) + (Number(x.qty) || 0));
    });
    return Object.values(sinks).map(s => ({
      key: s.key, name: s.name,
      materials: Object.entries(s.lines).map(([mid, q]) => ({ materialId: mid, name: matOf(mid).name, unit: matOf(mid).unit, qty: q })).sort((a, b) => b.qty - a.qty)
    })).sort((a, b) => (a.key === 'own' ? -1 : 1));
  }

  // صفحة المستودع
  app.get('/warehouse', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'warehouse.html')));

  app.get('/api/projects/:id/warehouse', auth, (req, res) => {
    const p = getProjectOr(req, res); if (!p) return;
    const db = loadWh(p.id);
    const matName = id => { const m = db.materials.find(x => x.id === id); return m ? m.name : '?'; };
    const subName = id => { const s = (p.subcontractors || []).find(x => x.id === id); return s ? s.name : ('#' + id); };
    res.json({
      version: db.version,
      materials: db.materials,
      receipts: db.receipts.map(r => ({ ...r, materialName: matName(r.materialId) })).sort((a, b) => (b.date || '').localeCompare(a.date || '')),
      issues: db.issues.map(x => ({ ...x, materialName: matName(x.materialId), recipient: x.bearer === 'sub' ? subName(x.subId) : 'ذاتي (على الشركة)' })).sort((a, b) => (b.date || '').localeCompare(a.date || '')),
      stock: stockOf(db),
      purchasedByMaterial: purchasedByMaterial(p.id),
      byRecipient: byRecipient(db, p),
      subs: (p.subcontractors || []).map(s => ({ id: s.id, name: s.name })),
      boqItems: (p.boqItems || []).map(it => ({ id: it.id, desc: it.desc, unit: it.unit })),
      canManage: canManage(req.user, p)
    });
  });

  app.post('/api/projects/:id/warehouse/materials', auth, (req, res) => {
    const p = getProjectOr(req, res); if (!p) return;
    if (!canManage(req.user, p)) return res.status(403).json({ error: 'إدارة المستودع صلاحية فريق المشروع' });
    const name = String((req.body || {}).name || '').trim();
    const unit = String((req.body || {}).unit || '').trim();
    if (!name) return res.status(400).json({ error: 'اكتب اسم المادة' });
    const db = loadWh(p.id);
    if (db.materials.some(m => m.name === name)) return res.status(400).json({ error: 'المادة مضافة مسبقاً' });
    const m = { id: genId('mat'), name, unit, createdAt: now() };
    db.materials.push(m); saveWh(p.id, db);
    res.json({ ok: true, material: m });
  });

  app.post('/api/projects/:id/warehouse/receipts', auth, (req, res) => {
    const p = getProjectOr(req, res); if (!p) return;
    if (!canManage(req.user, p)) return res.status(403).json({ error: 'إدارة المستودع صلاحية فريق المشروع' });
    const b = req.body || {}; const db = loadWh(p.id);
    const mat = db.materials.find(m => m.id === b.materialId); if (!mat) return res.status(400).json({ error: 'اختر مادة صحيحة' });
    const qty = round2(b.qty); if (!(qty > 0)) return res.status(400).json({ error: 'أدخل كمية صحيحة' });
    const rec = { id: genId('rc'), materialId: mat.id, qty, supplier: String(b.supplier || '').trim(), date: String(b.date || '').slice(0, 10) || now().slice(0, 10), note: String(b.note || '').trim(), by: req.user.name, createdAt: now() };
    db.receipts.push(rec); saveWh(p.id, db);
    res.json({ ok: true, receipt: rec, stock: stockOf(db) });
  });

  app.post('/api/projects/:id/warehouse/issues', auth, (req, res) => {
    const p = getProjectOr(req, res); if (!p) return;
    if (!canManage(req.user, p)) return res.status(403).json({ error: 'إدارة المستودع صلاحية فريق المشروع' });
    const b = req.body || {}; const db = loadWh(p.id);
    const mat = db.materials.find(m => m.id === b.materialId); if (!mat) return res.status(400).json({ error: 'اختر مادة صحيحة' });
    const qty = round2(b.qty); if (!(qty > 0)) return res.status(400).json({ error: 'أدخل كمية صحيحة' });
    const bearer = b.bearer === 'sub' ? 'sub' : 'own';
    const subId = bearer === 'sub' ? (Number(b.subId) || null) : null;
    if (bearer === 'sub' && !((p.subcontractors || []).some(s => s.id === subId))) return res.status(400).json({ error: 'اختر مقاول باطن صحيحاً' });
    const st = stockOf(db).find(s => s.materialId === mat.id); const bal = st ? st.balance : 0;
    if (qty > bal + 0.001) return res.status(400).json({ error: 'الكمية المطلوبة (' + qty + ') أكبر من الرصيد المتاح (' + bal + ' ' + (mat.unit || '') + ') — ورّد المادة أولاً' });
    const iss = { id: genId('is'), materialId: mat.id, qty, bearer, subId, boqItemId: b.boqItemId || null, date: String(b.date || '').slice(0, 10) || now().slice(0, 10), note: String(b.note || '').trim(), by: req.user.name, createdAt: now() };
    db.issues.push(iss); saveWh(p.id, db);
    res.json({ ok: true, issue: iss, stock: stockOf(db) });
  });

  app.delete('/api/projects/:id/warehouse/:kind/:itemId', auth, (req, res) => {
    const p = getProjectOr(req, res); if (!p) return;
    if (!canManage(req.user, p)) return res.status(403).json({ error: 'غير مصرّح' });
    const db = loadWh(p.id); const kind = req.params.kind; const id = req.params.itemId;
    if (kind === 'receipts') { db.receipts = db.receipts.filter(x => x.id !== id); }
    else if (kind === 'issues') { db.issues = db.issues.filter(x => x.id !== id); }
    else if (kind === 'materials') {
      if (db.receipts.some(r => r.materialId === id) || db.issues.some(x => x.materialId === id)) return res.status(400).json({ error: 'لا يمكن حذف مادة لها حركات توريد/صرف' });
      db.materials = db.materials.filter(x => x.id !== id);
    } else return res.status(400).json({ error: 'نوع غير صحيح' });
    saveWh(p.id, db);
    res.json({ ok: true, stock: stockOf(db) });
  });

  console.log('✓ وحدة المستودع (Warehouse) مُركّبة');
  return {};
};
