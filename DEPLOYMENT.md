# نشر النظام عبر Docker

خطوات بناء صورة Docker جديدة ونشرها على سيرفر VPS.

**معلومات السيرفر:**

| العنصر | القيمة |
|---|---|
| السيرفر | `13.140.138.252` |
| المستخدم | `root` |
| مجلد النشر على السيرفر | `/root/boq-and-site-work` |
| اسم الحاوية | `azoom-boq-app` |
| المنفذ على السيرفر | `3005` |
| الدومين | `https://boq.bassir.net/` |

> كلمة مرور SSH لا تُكتب هنا أبداً — أدخلها يدوياً عند الطلب في كل أمر `scp`/`ssh`. **لا تضع كلمة مرور السيرفر داخل أي ملف يُرفع لـ git.**

## نشر سريع (بعد بناء `azoom-boq.tar` محلياً)

إن كانت الصورة مبنية ومُصدَّرة مسبقاً إلى `azoom-boq.tar` في جذر المشروع (الخطوات 1-3 أدناه)، هذه هي الأوامر الثلاثة فقط لرفعها وتشغيلها:

```bash
cd "E:\Projects\Bassir\BOQ-AND-PROJECT-TRACKING-"
scp azoom-boq.tar root@13.140.138.252:/root/boq-and-site-work/
scp scripts/run.sh root@13.140.138.252:/root/boq-and-site-work/
ssh root@13.140.138.252 "cd /root/boq-and-site-work && chmod +x run.sh && bash run.sh"
```

ثم تحقق (الخطوة 6 أدناه):

```bash
ssh root@13.140.138.252 "docker ps --filter name=azoom-boq-app"
curl -s -o /dev/null -w 'HTTP %{http_code}\n' https://boq.bassir.net/
```

## 1. حذف الصورة القديمة لهذا المشروع (محلياً)

```bash
docker rmi -f azoom-boq:latest 2>/dev/null || true
```

## 2. بناء صورة جديدة (محلياً)

```bash
docker build -t azoom-boq:latest .
```

اختياري لكن يُنصح به قبل التصدير — تشغيل سريع محلي للتأكد أن الصورة سليمة:

```bash
docker rm -f azoom-boq-smoketest 2>/dev/null
docker run -d --name azoom-boq-smoketest -p 3093:3000 -e ADMIN_USER=admin -e ADMIN_PASSWORD=smoketest123 azoom-boq:latest
curl -s -o /dev/null -w "root HTTP %{http_code}\n" http://localhost:3093/
docker rm -f azoom-boq-smoketest
```

## 3. تصدير الصورة إلى ملف tar

```bash
docker save azoom-boq:latest -o azoom-boq.tar
```

## 4. نقل ملف tar وسكربت التشغيل إلى السيرفر

انقل الصورة (`azoom-boq.tar`) **و** سكربت التشغيل (`scripts/run.sh`) معاً في كل نشر — `run.sh` قد يتغيّر بين نسخة وأخرى، فالأسلم رفعه دائماً وليس فقط أول مرة:

```bash
scp azoom-boq.tar root@13.140.138.252:/root/boq-and-site-work/
scp scripts/run.sh root@13.140.138.252:/root/boq-and-site-work/
```

## 5. على السيرفر: تحميل الصورة وتشغيلها

سكربت `run.sh` (نسخة من `scripts/run.sh` في هذا المستودع) يقوم بـ:

1. تحميل الصورة من ملف tar (`docker load`)
2. إيقاف/حذف أي حاوية سابقة بنفس الاسم
3. تشغيل حاوية جديدة على المنفذ **3005** (المنافذ 3000-3004 و3010 محجوزة لمشاريع أخرى على نفس السيرفر — تحقق دائماً بـ `ss -tlnp` قبل اختيار منفذ على سيرفر مشترك)
4. ربط مجلد بيانات دائم (`azoom-boq-data` volume) حتى لا تُفقد المشاريع عند إعادة النشر

تنفيذ الخطوة عن بُعد بأمر واحد (بدل الدخول بـ ssh تفاعلياً):

```bash
ssh root@13.140.138.252 "cd /root/boq-and-site-work && chmod +x run.sh && bash run.sh"
```

النظام يصبح متاحاً على: `http://13.140.138.252:3005` أو دومين الإنتاج `https://boq.bassir.net/`.

## 6. التحقق بعد النشر (مهم على سيرفر مشترك)

هذا السيرفر يستضيف عشرات الحاويات لمشاريع أخرى — تحقق دائماً أن النشر لم يؤثر عليها:

```bash
# عدد الحاويات قبل وبعد run.sh يجب أن يتطابق (لا حاويات أخرى تأثرت)
ssh root@13.140.138.252 "docker ps --format '{{.Names}}' | wc -l"

# الحاوية تعمل على المنفذ الصحيح
ssh root@13.140.138.252 "docker ps --filter name=azoom-boq-app"

# الموقع يستجيب
curl -s -o /dev/null -w 'HTTP %{http_code}\n' https://boq.bassir.net/
```

## إعادة النشر (تحديث)

كرر الخطوات 1–6. بيانات المشاريع محفوظة في الـ volume `azoom-boq-data` ولا تتأثر بإعادة بناء أو تشغيل الحاوية.

## متغيرات البيئة المهمة

| المتغير | الوصف |
|---|---|
| `PORT` | المنفذ داخل الحاوية (افتراضي 3000 — لا تغيّره، بدّل منفذ الاستضافة في `-p`) |
| `ADMIN_USER` | اسم مستخدم المالك الأول (افتراضي admin) |
| `ADMIN_PASSWORD` | كلمة مرور المالك الأول — **غيّرها فوراً** بعد أول دخول |
| `JWT_SECRET` | سر توقيع الجلسات (اختياري، يتولد ويُحفظ تلقائياً في `data/.jwt-secret` إن تُرك فارغاً) |

## البنية

- `Dockerfile` — صورة Node.js 20 (alpine)، تثبت الاعتماديات فقط (`npm ci --omit=dev`)، بدون `node_modules`/`data`/`.env` (مستثناة عبر `.dockerignore`).
- `/app/data` داخل الحاوية = volume خارجي، يحوي كل بيانات المشاريع والمستخدمين والصور المرفوعة.
- المنفذ الداخلي للحاوية دائماً 3000؛ منفذ الاستضافة (host) هو ما يتغير حسب توفر المنافذ على السيرفر.
