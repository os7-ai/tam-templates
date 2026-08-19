// Layer 1 — يستدعي Claude فعلياً بصورة/PDF قائمة الدخل والإيضاحات، يتحقق من شكل
// الرد، ويحفظ الـBaseline في مخزن الـEngagement (لا يُعدَّل بعد ذلك أبداً).
const { requireUser, requireApiKey } = require('./lib/auth');
const { callClaudeForJson } = require('./lib/claude-client');
const { LAYER1_SYSTEM_PROMPT } = require('./lib/prompts/layer1-prompt');
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

    const content = [
      { type: 'text', text: 'صور/صفحات قائمة الدخل والإيضاحات المالية مرفقة أدناه بالترتيب.' },
      ...images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } })),
    ];

    logStage('layer1-extract', engagementId, 'claude_call_start', t0);
    const json = await callClaudeForJson({
      apiKey, system: LAYER1_SYSTEM_PROMPT, messages: [{ role: 'user', content }], maxTokens: 8000,
    });
    logStage('layer1-extract', engagementId, 'claude_call_end', t0);
    if (!Array.isArray(json.mainLines)) {
      throw new Error('رد Layer 1 لا يحتوي mainLines بالشكل المتوقع');
    }

    await saveJson(sb, user.id, engagementId, 'layer1.json', json);
    logStage('layer1-extract', engagementId, 'end', t0);
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) };
  } catch (err) {
    logStage('layer1-extract', engagementId, 'error', t0, { message: err.message });
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
