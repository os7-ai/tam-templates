// المهمة الفعلية لـLayer 1 (Netlify Background Function — تنفيذ غير متزامن حتى 15 دقيقة).
// لا تُستدعى مباشرة من المتصفح؛ تُستدعى فقط من layer1-start.js بعد نجاح الحجز وحفظ لقطة
// المدخلات. تستخدم lib/layer1-runner.js بلا أي تغيير — نفس الصور، نفس الـPrompt، نفس
// max_tokens، نفس منطق القرار. الفرق الوحيد هنا هو آلية التشغيل غير المتزامنة، التي
// تُزيل سقف تنفيذ Netlify المتزامن (~30 ثانية) المسؤول عن الـ504 السابق.
const { requireUser, requireApiKey } = require('./lib/auth');
const { runLayer1 } = require('./lib/layer1-runner');
const { saveJson, loadJson } = require('./lib/engagement-store');
const { finishStage } = require('./lib/pipeline-status');
const { logStage } = require('./lib/timing');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const { sb, user, errorResponse } = await requireUser(event);
  if (errorResponse) return errorResponse;
  const { apiKey, errorResponse: keyErr } = requireApiKey();
  if (keyErr) return keyErr;

  const t0 = Date.now();
  let engagementId;
  try {
    const body = JSON.parse(event.body || '{}');
    engagementId = body.engagementId;
    if (!engagementId) return { statusCode: 400, body: JSON.stringify({ error: 'engagementId مطلوب' }) };

    const snapshot = await loadJson(sb, user.id, engagementId, 'inputs/layer1_images.json');
    if (!snapshot || !Array.isArray(snapshot.images)) {
      throw new Error('لقطة مدخلات Layer 1 غير موجودة — لم يُستدعَ هذا الإجراء عبر layer1-start');
    }

    logStage('layer1-extract-background', engagementId, 'start', t0, { images: snapshot.images.length });
    const json = await runLayer1(apiKey, snapshot.images);
    logStage('layer1-extract-background', engagementId, 'claude_call_end', t0);

    await saveJson(sb, user.id, engagementId, 'layer1.json', json);
    await finishStage(sb, user.id, engagementId, 'layer1', {
      status: 'done', error: null, result: { mainLinesCount: json.mainLines.length },
    });
    logStage('layer1-extract-background', engagementId, 'end', t0);
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) };
  } catch (err) {
    logStage('layer1-extract-background', engagementId, 'error', t0, { message: err.message });
    if (engagementId) {
      await finishStage(sb, user.id, engagementId, 'layer1', { status: 'error', error: err.message }).catch(() => {});
    }
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
