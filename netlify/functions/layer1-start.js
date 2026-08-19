// نقطة البدء المتزامنة لـLayer 1 (سريعة، أقل من ثانية): تحقق + حجز المرحلة (Idempotency)
// + حفظ لقطة المدخلات في Storage (بلا Base64 داخل pipeline_status.json — المرجع فقط)
// + تشغيل الدالة الخلفية الفعلية (layer1-extract-background) دون انتظار اكتمالها. أي
// خطأ تحقق/مصادقة/تنفيذ مزدوج يصل للمتصفح فوراً من هنا مباشرة — بخلاف الدالة الخلفية
// نفسها التي لا تستطيع إيصال أي استجابة حقيقية للمتصفح بعد أن يُرجع Netlify رد 202 عند
// نجاح جدولة الاستدعاء غير المتزامن (لذلك التحقق كله هنا، قبل الجدولة، لا هناك).
const { requireUser, requireApiKey } = require('./lib/auth');
const { saveJson, extractToken } = require('./lib/engagement-store');
const { claimStage, finishStage } = require('./lib/pipeline-status');

function baseUrl(event) {
  if (process.env.URL) return process.env.URL;
  const host = event.headers['x-forwarded-host'] || event.headers.host;
  return `https://${host}`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const { user, errorResponse } = await requireUser(event);
  if (errorResponse) return errorResponse;
  const { errorResponse: keyErr } = requireApiKey(); // تحقق إعداد فقط؛ المفتاح نفسه يُستخدم داخل الدالة الخلفية
  if (keyErr) return keyErr;
  const token = extractToken(event);

  try {
    const body = JSON.parse(event.body || '{}');
    const { engagementId, images } = body;
    if (!engagementId || !Array.isArray(images) || images.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'engagementId وimages مطلوبة' }) };
    }

    const { claimed } = await claimStage(token, user.id, engagementId, 'layer1');
    if (!claimed) {
      return { statusCode: 409, body: JSON.stringify({ error: 'Layer 1 قيد التنفيذ بالفعل لهذا الـEngagement' }) };
    }

    await saveJson(token, user.id, engagementId, 'inputs/layer1_images.json', { images });

    const res = await fetch(`${baseUrl(event)}/.netlify/functions/layer1-extract-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: event.headers.authorization || event.headers.Authorization || '' },
      body: JSON.stringify({ engagementId }),
    });
    if (!res.ok && res.status !== 202) {
      await finishStage(token, user.id, engagementId, 'layer1', { status: 'error', error: `تعذّر بدء المهمة الخلفية (HTTP ${res.status})` });
      return { statusCode: 502, body: JSON.stringify({ error: 'تعذّر بدء المهمة الخلفية لـLayer 1' }) };
    }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ started: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
