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
  return { text, stop_reason: data.stop_reason || '', usage: data.usage || null };
}

// meta تشخيصي فقط (stop_reason/usage من نفس نداء Claude) — لا يُغيّر أي منطق استخراج أو
// تحقق، فقط يُغني رسالة الخطأ عند فشل قراءة JSON بما يكفي للتفريق بين اقتطاع بسبب
// max_tokens وJSON مُشوَّه رغم اكتمال الرد، دون الحاجة لسجلات Netlify.
function diagSuffix(meta) {
  if (!meta) return '';
  const outTok = (meta.usage && meta.usage.output_tokens) || 'غير معروف';
  return `[stop_reason=${meta.stop_reason || 'غير معروف'}, output_tokens=${outTok}]`;
}

function extractJson(text, meta) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const s = cleaned.indexOf('{');
  const e = cleaned.lastIndexOf('}');
  if (s === -1 || e === -1 || e < s) {
    throw new Error('رد النموذج لم يتضمن JSON صالحاً. ' + diagSuffix(meta) + ' أول 300 حرف: ' + cleaned.slice(0, 300));
  }
  const jsonSlice = cleaned.slice(s, e + 1);
  try {
    return JSON.parse(jsonSlice);
  } catch (err) {
    // موضع الخطأ كما يُبلغه JSON.parse نفسه (ضمن jsonSlice) — نبني مقتطفاً حوله مباشرة
    // بدل إظهار ذيل النص فقط، ونحسب بُعده عن نهاية النص المُستخرج (مؤشر اقتطاع محتمل).
    const posMatch = /position (\d+)/.exec(err.message);
    const pos = posMatch ? Number(posMatch[1]) : jsonSlice.length;
    const windowStart = Math.max(0, pos - 400);
    const windowEnd = Math.min(jsonSlice.length, pos + 400);
    const excerpt = jsonSlice.slice(windowStart, windowEnd);
    const distanceFromEnd = jsonSlice.length - pos;
    throw new Error(
      'تعذّر قراءة نتيجة التحليل (' + err.message + '). ' + diagSuffix(meta)
      + ` نص_الطول=${jsonSlice.length} موضع_الخطأ_يبعد_عن_النهاية=${distanceFromEnd} حرفاً.`
      + ` مقتطف حول الموضع [${windowStart}:${windowEnd}]: ...${excerpt}...`
    );
  }
}

async function callClaudeForJson(opts) {
  const { text, stop_reason, usage } = await callClaude(opts);
  return extractJson(text, { stop_reason, usage });
}

module.exports = { callClaude, callClaudeForJson, extractJson, MODEL };
