// تخزين حالة "الملف/Engagement" الواحد — Baseline (layer1-4)، tb_raw_source،
// reviewerDecisions، وnطاق TB المُختار — في Supabase Storage (bucket واحد خاص، منفصل
// عن buckets القوالب/الملفات الناتجة). كل شيء مفتاحه engagementId + اسم الملف.

const BUCKET = 'engagements';

async function ensureBucket(sb) {
  try {
    const { data } = await sb.storage.getBucket(BUCKET);
    if (data) return;
  } catch (e) { /* تابع لمحاولة الإنشاء */ }
  try {
    await sb.storage.createBucket(BUCKET, { public: false });
  } catch (e) {
    // قد يفشل لعدم توفر صلاحيات إدارية للمفتاح المُستخدم — يُترك للمستخدم إنشاؤه يدوياً
    // من لوحة Supabase إن استمر الفشل عند أول استخدام فعلي (نفس أسلوب buckets السابقة).
  }
}

function path(userId, engagementId, filename) {
  return `${userId}/${engagementId}/${filename}`;
}

async function saveJson(sb, userId, engagementId, filename, obj) {
  await ensureBucket(sb);
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const { error } = await sb.storage.from(BUCKET).upload(path(userId, engagementId, filename), body, {
    contentType: 'application/json',
    upsert: true,
  });
  if (error) throw new Error(`فشل حفظ ${filename}: ${error.message}`);
}

async function loadJson(sb, userId, engagementId, filename) {
  const { data, error } = await sb.storage.from(BUCKET).download(path(userId, engagementId, filename));
  if (error) return null;
  const text = await data.text();
  return JSON.parse(text);
}

module.exports = { saveJson, loadJson, BUCKET };
