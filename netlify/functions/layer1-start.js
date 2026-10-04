// نقطة البدء المتزامنة لـLayer 1 (سريعة، أقل من ثانية): تحقق + حجز المرحلة (Idempotency)
// + حفظ لقطة المدخلات في Storage (بلا Base64 داخل pipeline_status.json — المرجع فقط)،
// ثم تُرجع فوراً. لا تستدعي layer1-extract-background داخلياً إطلاقاً — ثبت عملياً
// (باختبار حي: pipeline_status أظهر endedAt بعد ~109 ثانية بينما مات هذا الاستدعاء عند
// ~30 ثانية) أن الانتظار الداخلي لاستجابة الدالة الخلفية الكاملة كان هو سبب الـ504،
// وليس أي مشكلة في الدالة الخلفية نفسها (التي أثبتت أنها تُكمل وتحفظ layer1.json فعلاً
// حتى بعد موت هذا الاستدعاء). الواجهة (لا هذه الدالة) هي من تُطلق layer1-extract-background
// مباشرة بعد نجاح هذا الاستدعاء، دون انتظار اكتمالها — راجع income-analysis-v2.html.
const { requireUser, requireApiKey } = require('./lib/auth');
const { saveJson, extractToken } = require('./lib/engagement-store');
const { claimStage } = require('./lib/pipeline-status');

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

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ claimed: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
