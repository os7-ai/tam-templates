// نداء موحّد لـAnthropic لكل دوال الطبقات الذكية (Layer 1/2/3) — غير مبثوث (نفس
// القرار المعتمد في income-call.js: البث كان ينقطع فعلياً عبر طبقة وسيطة بعد بداية
// كتلة "thinking")، مع استخراج JSON من الرد وتحقق أساسي من صحته.

const MODEL = 'claude-sonnet-5';
const MAX_TOKENS_CAP = 16000;

async function callClaude({ apiKey, system, messages, maxTokens }) {
  const payload = {
    model: MODEL,
    max_tokens: Math.min(Number(maxTokens) || 8000, MAX_TOKENS_CAP),
    system: [{ type: 'text', text: system }],
    messages,
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || 'خطأ في خدمة التحليل';
    throw new Error(msg);
  }
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text || '').join('');
  if (!text.trim()) {
    throw new Error('لم يصل نص فعلي من النموذج. سبب التوقف: ' + (data.stop_reason || 'غير معروف'));
  }
  return { text, stop_reason: data.stop_reason || '' };
}

function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const s = cleaned.indexOf('{');
  const e = cleaned.lastIndexOf('}');
  if (s === -1 || e === -1 || e < s) {
    throw new Error('رد النموذج لم يتضمن JSON صالحاً. أول 300 حرف: ' + cleaned.slice(0, 300));
  }
  try {
    return JSON.parse(cleaned.slice(s, e + 1));
  } catch (err) {
    throw new Error('تعذّر قراءة نتيجة التحليل (' + err.message + '). آخر 200 حرف: ' + cleaned.slice(-200));
  }
}

async function callClaudeForJson(opts) {
  const { text } = await callClaude(opts);
  return extractJson(text);
}

module.exports = { callClaude, callClaudeForJson, extractJson, MODEL };
