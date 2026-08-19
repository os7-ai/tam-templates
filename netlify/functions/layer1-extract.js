// Layer 1 — نسخة متزامنة (تُبقى للاختبار اليدوي المباشر فقط). المسار الفعلي المُستخدَم
// من الواجهة الآن هو layer1-start.js + layer1-extract-background.js (Background Job)،
// تفادياً لسقف تنفيذ Netlify المتزامن. كلا المسارين يستخدمان lib/layer1-runner.js نفسه
// — نفس الصور، نفس الـPrompt، نفس max_tokens، بلا أي اختلاف في الاستدعاء نفسه.
const { requireUser, requireApiKey } = require('./lib/auth');
const { runLayer1 } = require('./lib/layer1-runner');
const { saveJson } = require('./lib/engagement-store');
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
    const { images } = body; // images: [{mediaType, base64}] — قائمة الدخل + كل ملفات الإيضاحات
    engagementId = body.engagementId;
    logStage('layer1-extract', engagementId, 'start', t0, { images: (images || []).length });
    if (!engagementId || !Array.isArray(images) || images.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'engagementId وimages مطلوبة' }) };
    }

    logStage('layer1-extract', engagementId, 'claude_call_start', t0);
    const json = await runLayer1(apiKey, images);
    logStage('layer1-extract', engagementId, 'claude_call_end', t0);

    await saveJson(sb, user.id, engagementId, 'layer1.json', json);
    logStage('layer1-extract', engagementId, 'end', t0);
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) };
  } catch (err) {
    logStage('layer1-extract', engagementId, 'error', t0, { message: err.message });
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
