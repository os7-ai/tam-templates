// منطق Layer 1 الفعلي (استدعاء Claude) — مصدر وحيد يستخدمه كل من الدالة الخلفية
// (layer1-extract-background) ونسخة الاختبار اليدوي المتزامنة (layer1-extract)، لضمان
// تطابق الاستدعاء حرفياً في كل مكان: نفس الصور، نفس الـPrompt، نفس max_tokens، نفس
// عدم البث. هذا الملف لا يُعدَّل كجزء من مهمة تحويل التشغيل إلى Background Job.
const { callClaudeForJson } = require('./claude-client');
const { LAYER1_SYSTEM_PROMPT } = require('./prompts/layer1-prompt');

async function runLayer1(apiKey, images) {
  const content = [
    { type: 'text', text: 'صور/صفحات قائمة الدخل والإيضاحات المالية مرفقة أدناه بالترتيب.' },
    ...images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } })),
  ];
  const json = await callClaudeForJson({
    apiKey, system: LAYER1_SYSTEM_PROMPT, messages: [{ role: 'user', content }], maxTokens: 16000,
  });
  if (!Array.isArray(json.mainLines)) {
    throw new Error('رد Layer 1 لا يحتوي mainLines بالشكل المتوقع');
  }
  return json;
}

module.exports = { runLayer1 };
