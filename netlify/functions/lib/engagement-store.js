// تخزين حالة "الملف/Engagement" الواحد — Baseline (layer1-4)، pipeline_status،
// المدخلات الخام، tb_raw_source، reviewerDecisions، ونطاق TB المُختار — في Supabase
// Storage. يُستخدم bucket "generated" الموجود فعلياً والمُستخدَم بنجاح مسبقاً من
// generate-final-excel.js (بدل الاعتماد على إنشاء bucket منفصل "engagements" تلقائياً؛
// تبيّن عبر اختبار حقيقي أن ذلك الـbucket لم يكن موجوداً فعلياً أصلاً).
//
// العميل المستخدم هنا لعمليات Storage يعمل بهوية المستخدم الفعلي (JWT مُمرَّر كـheader)
// وليس بهوية SUPABASE_KEY العامة — ضروري لتفعيل auth.uid() داخل Storage RLS Policy
// المخصصة لمسار generated/engagements/{userId}/... (نص الـSQL في نهاية هذا الملف كتعليق
// مرجعي، ويُطبَّق يدوياً من Supabase SQL Editor). هذا التغيير محصور في هذه الوحدة فقط —
// auth.js وبقية buckets المشروع (templates/logos) لا تتأثران إطلاقاً؛ العميل sb المُعاد
// من requireUser() يبقى كما هو تماماً لكل استخدام آخر خارج saveJson/loadJson هنا.
const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'generated';
const SURL = process.env.SUPABASE_URL;
const SKEY = process.env.SUPABASE_KEY;

// يستخرج الـBearer token من event.headers — نفس المنطق المستخدَم في auth.js تماماً،
// لكن مكرَّر هنا عمداً بدل الاستيراد من هناك حتى لا يتأثر auth.js أو سلوكه العام بأي
// تعديل يخص هذه الوحدة فقط.
function extractToken(event) {
  const h = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  return h.replace('Bearer ', '').trim();
}

function storageClientForUser(token) {
  return createClient(SURL, SKEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

async function ensureBucket(sbForUser) {
  try {
    const { data } = await sbForUser.storage.getBucket(BUCKET);
    if (data) return;
  } catch (e) { /* تابع لمحاولة الإنشاء */ }
  try {
    await sbForUser.storage.createBucket(BUCKET, { public: false });
  } catch (e) {
    // best-effort كما كان سابقاً — bucket "generated" موجود فعلياً في العادة، فهذا
    // المسار نادراً ما يُنفَّذ فعلياً.
  }
}

function path(userId, engagementId, filename) {
  return `engagements/${userId}/${engagementId}/${filename}`;
}

async function saveJson(token, userId, engagementId, filename, obj) {
  const sbForUser = storageClientForUser(token);
  await ensureBucket(sbForUser);
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const { error } = await sbForUser.storage.from(BUCKET).upload(path(userId, engagementId, filename), body, {
    contentType: 'application/json',
    upsert: true,
  });
  if (error) {
    if (/bucket not found/i.test(error.message || '')) {
      throw new Error(`Bucket "${BUCKET}" غير موجود أو غير مُتاح لمفتاح الخادم الحالي. أنشئه يدوياً من لوحة Supabase (Storage → New bucket → الاسم "${BUCKET}" → Private) إن لم يكن موجوداً. (فشل حفظ ${filename}: ${error.message})`);
    }
    if (/row-level security|RLS/i.test(error.message || '')) {
      throw new Error(`Storage RLS منعت الكتابة على ${BUCKET}/${path(userId, engagementId, filename)}. يلزم تطبيق Storage Policies المخصصة لمسار "engagements/" (راجع تعليق SQL في نهاية engagement-store.js) من Supabase SQL Editor. (فشل حفظ ${filename}: ${error.message})`);
    }
    throw new Error(`فشل حفظ ${filename}: ${error.message}`);
  }
}

async function loadJson(token, userId, engagementId, filename) {
  const sbForUser = storageClientForUser(token);
  const { data, error } = await sbForUser.storage.from(BUCKET).download(path(userId, engagementId, filename));
  if (error) return null;
  const text = await data.text();
  return JSON.parse(text);
}

module.exports = { saveJson, loadJson, extractToken, BUCKET };

/*
SQL المطلوب تطبيقه يدوياً في Supabase SQL Editor (مرة واحدة فقط) — يمنح المستخدم
المُصادَق عليه (authenticated) صلاحية القراءة/الكتابة على بياناته الخاصة فقط ضمن
generated/engagements/{auth.uid()}/... — لا صلاحية على أي مسار آخر في نفس الـbucket
(بما فيها income-analysis/ التي يستخدمها generate-final-excel.js للملف النهائي —
تلك خارج نطاق هذا الإصلاح عمداً)، ولا صلاحية لأي مستخدم آخر غير صاحب البيانات، ولا
Public، ولا تعطيل لـRLS نفسه:

create policy "engagements_select_own"
on storage.objects for select
to authenticated
using (
  bucket_id = 'generated'
  and (storage.foldername(name))[1] = 'engagements'
  and (storage.foldername(name))[2] = auth.uid()::text
);

create policy "engagements_insert_own"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'generated'
  and (storage.foldername(name))[1] = 'engagements'
  and (storage.foldername(name))[2] = auth.uid()::text
);

create policy "engagements_update_own"
on storage.objects for update
to authenticated
using (
  bucket_id = 'generated'
  and (storage.foldername(name))[1] = 'engagements'
  and (storage.foldername(name))[2] = auth.uid()::text
)
with check (
  bucket_id = 'generated'
  and (storage.foldername(name))[1] = 'engagements'
  and (storage.foldername(name))[2] = auth.uid()::text
);
*/
