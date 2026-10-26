/*
 * مساعدات مشتركة لصفحات SaaS (landing / billing / owner / expenses)
 * — توحيد للأدوات المكرَّرة سابقاً في كل صفحة على حدة.
 */
var TOKEN = localStorage.getItem('azoom_token') || '';

// ---------- ثنائية اللغة (عربي/إنجليزي) ----------
// نفس مفتاح التفضيل (azoom_lang) المستخدم في النظام الرئيسي، حتى يبقى اختيار اللغة متّسقاً
// بين التطبيق الرئيسي وصفحات SaaS على نفس المتصفح. كل صفحة تملأ I18N_EN بقاموسها الخاص،
// وتضيف data-i18n لكل نص ثابت، ثم تستدعي applyDir()+translateStaticDOM() عند التحميل.
var LANG = localStorage.getItem('azoom_lang') || 'ar';
var I18N_EN = {};
function T(s){
  if (LANG !== 'en') return s;
  return Object.prototype.hasOwnProperty.call(I18N_EN, s) ? I18N_EN[s] : s;
}
function applyDir(){
  document.documentElement.lang = LANG;
  document.documentElement.dir = LANG === 'en' ? 'ltr' : 'rtl';
  var btn = document.getElementById('lang-switch');
  if (btn) btn.textContent = LANG === 'en' ? '🌐 العربية' : '🌐 English';
  if (document.title) document.title = T(document.title);
}
function translateStaticDOM(){
  document.querySelectorAll('[data-i18n]').forEach(function(el){ el.textContent = T(el.getAttribute('data-i18n')); });
  document.querySelectorAll('[data-i18n-ph]').forEach(function(el){ el.placeholder = T(el.getAttribute('data-i18n-ph')); });
}
// كل صفحة قد تُعرّف window.onLangChange لإعادة رسم محتواها الديناميكي (جداول/بطاقات) عند التبديل
function toggleLang(){
  LANG = LANG === 'ar' ? 'en' : 'ar';
  localStorage.setItem('azoom_lang', LANG);
  applyDir();
  translateStaticDOM();
  if (typeof window.onLangChange === 'function') window.onLangChange();
}

function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function money(n){return Number(n||0).toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:2})}
function fmtDate(iso){ if(!iso) return '—'; try{return new Date(iso).toLocaleDateString('ar-SA-u-nu-latn',{year:'numeric',month:'short',day:'numeric'})}catch(e){return String(iso).slice(0,10)} }
function toast(m){
  var t=document.getElementById('toast'); if(!t) return;
  t.querySelector('span').textContent=m; t.setAttribute('aria-live','polite');
  t.classList.add('show'); clearTimeout(t._h); t._h=setTimeout(function(){t.classList.remove('show')},2800);
}
function show(el,on){ var e=document.getElementById(el); if(e) e.classList[on?'remove':'add']('hide'); }

// طلب API موحّد — لا يرفض أبداً (reject)، يُعيد دائماً {status, ok, d, networkError?}
// حتى تتمكن كل صفحة من عرض خطأ واضح + زر إعادة محاولة بدل بقاء الصفحة فارغة للأبد.
function api(method, path, body){
  return fetch(path, {
    method: method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: body ? JSON.stringify(body) : undefined
  }).then(function(r){
    return r.json().then(function(d){ return { status: r.status, ok: r.ok, d: d }; })
      .catch(function(){ return { status: r.status, ok: false, d: { error: 'استجابة غير صالحة من الخادم' } }; });
  }).catch(function(){
    return { status: 0, ok: false, d: { error: 'تعذّر الاتصال بالخادم — تحقّق من اتصالك بالإنترنت' }, networkError: true };
  });
}

// opts: {requireRole, roleError, onSuccess}
function doLogin(opts){
  opts = opts || {};
  var uEl = document.getElementById('lg-user'), pEl = document.getElementById('lg-pass');
  var u = uEl ? uEl.value.trim() : '', p = pEl ? pEl.value : '';
  var errEl = document.getElementById('login-err');
  function fail(msg){ if(errEl){ errEl.textContent = msg; errEl.classList.remove('hide'); } }
  fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })
    .then(function(r){ return r.json().then(function(d){ return { ok: r.ok, d: d }; }); })
    .then(function(res){
      if (!res.ok) return fail((res.d && res.d.error) || 'فشل الدخول');
      if (opts.requireRole && res.d.user.role !== opts.requireRole) return fail(opts.roleError || 'هذه الصفحة غير متاحة لهذا الحساب');
      TOKEN = res.d.token; localStorage.setItem('azoom_token', TOKEN);
      if (errEl) errEl.classList.add('hide');
      if (opts.onSuccess) opts.onSuccess(); else location.reload();
    })
    .catch(function(){ fail('تعذّر الاتصال بالخادم'); });
}
function logout(){ localStorage.removeItem('azoom_token'); location.href='/app'; }

// حالة تحميل/خطأ قابلة لإعادة المحاولة — تُستخدم أثناء جلب البيانات الأولى لصفحة كاملة
function renderLoading(containerEl){
  containerEl.innerHTML = '<div class="page-loading"><span class="spin"></span><span>جارٍ التحميل…</span></div>';
}
function renderError(containerEl, message, retryFn){
  containerEl.innerHTML = '<div class="page-error">'+
    '<div style="font-size:30px">⚠️</div>'+
    '<div class="msg">'+esc(message||'حدث خطأ غير متوقع')+'</div>'+
    '<button class="btn btn-primary btn-sm" id="pe-retry">إعادة المحاولة</button>'+
    '</div>';
  var b = containerEl.querySelector('#pe-retry');
  if (b) b.onclick = retryFn;
}
