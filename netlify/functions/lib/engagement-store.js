// تخزين حالة "الملف/Engagement" الواحد — Baseline (layer1-4)، pipeline_status،
// المدخلات الخام، tb_raw_source، reviewerDecisions، ونطاق TB المُختار — في Supabase
// Storage. يُستخدم bucket "generated" الموجود فعلياً والمُستخدَم بنجاح مسبقاً من
// generate-final-excel.js (بدل الاعتماد على إنشاء bucket منفصل "engagements" تلقائياً؛
// تبيّن عبر اختبار حقيقي — أول ظهور صريح لخطأ "Bucket not found" عند حفظ
// pipeline_status.json — أن ذلك الـbucket لم يكن موجوداً فعلياً أصلاً، وأن هذا كان
// مقنَّعاً سابقاً لأن loadJson كانت تُعيد null بصمت في كل مكان آخر بغض النظر عن السبب
// الحقيقي: bucket غير موجود، أم ملف غير موجود). كل بيانات الـEngagement تُخزَّن هنا تحت
// مسار فرعي "engagements/" لتفادي أي تداخل مع مخرجات Excel المُخزَّنة في نفس الـbucket
// تحت "income-analysis/".
const BUCKET = 'generated';

async function ensureBucket(sb) {
  try {
    const { data } = await sb.storage.getBucket(BUCKET);
    if (data) return;
  } catch (e) { /* تابع لمحاولة الإنشاء */ }
  try {
    await sb.storage.createBucket(BUCKET, { public: false });
  } catch (e) {
    // قد يفشل لعدم توفر صلاحيات إدارية للمفتاح المُستخدم — غير متوقَّع عملياً هنا لأن
    // BUCKET أصبح bucket موجوداً ومُستخدَماً فعلياً مسبقاً (generate-final-excel.js)،
    // لكن يبقى best-effort كما كان.
  }
}

function path(userId, engagementId, filename) {
  return `engagements/${userId}/${engagementId}/${filename}`;
}

async function saveJson(sb, userId, engagementId, filename, obj) {
  await ensureBucket(sb);
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const { error } = await sb.storage.from(BUCKET).upload(path(userId, engagementId, filename), body, {
    contentType: 'application/json',
    upsert: true,
  });
  if (error) {
    if (/bucket not found/i.test(error.message || '')) {
      throw new Error(`Bucket "${BUCKET}" غير موجود أو غير مُتاح لمفتاح الخادم الحالي. أنشئه يدوياً من لوحة Supabase (Storage → New bucket → الاسم "${BUCKET}" → Private) إن لم يكن موجوداً. (فشل حفظ ${filename}: ${error.message})`);
    }
    throw new Error(`فشل حفظ ${filename}: ${error.message}`);
  }
}

async function loadJson(sb, userId, engagementId, filename) {
  const { data, error } = await sb.storage.from(BUCKET).download(path(userId, engagementId, filename));
  if (error) return null;
  const text = await data.text();
  return JSON.parse(text);
}

module.exports = { saveJson, loadJson, BUCKET };
