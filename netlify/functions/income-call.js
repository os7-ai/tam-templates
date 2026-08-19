const { createClient } = require('@supabase/supabase-js');

// دالة غير مبثوثة (non-streaming) مخصصة لقسم "تحليل مصاريف قائمة الدخل" — تنتظر الرد
// الكامل من Anthropic وترجعه دفعة واحدة، بدل تمرير الرد كـ SSE (income-stream.mjs).
// تحوّلنا لهذا النمط لأن الرد المبثوث كان ينقطع عملياً بعد بداية كتلة "thinking" قبل
// وصول أي نص فعلي للمتصفح (على الأغلب بسبب طبقة وسيطة/CDN لا تدعم بث هذا النوع من
// المحتوى بشكل صحيح) رغم أن الطلب كان يكتمل بنجاح من طرف الخادم دائماً.
const SURL = process.env.SUPABASE_URL;
const SKEY = process.env.SUPABASE_KEY;

const MODEL = 'claude-sonnet-5';
const MAX_TOKENS_CAP = 16000;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
  if (!SURL || !SKEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'SUPABASE_URL / SUPABASE_KEY غير مُعدّة في بيئة Netlify' }) };
  }

  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: 'يتطلب تسجيل الدخول' }) };
  }
  try {
    const sb = createClient(SURL, SKEY);
    const { data: { user } = {}, error } = await sb.auth.getUser(token);
    if (error || !user) {
      return { statusCode: 401, body: JSON.stringify({ error: 'جلسة غير صالحة' }) };
    }
  } catch (e) {
    return { statusCode: 401, body: JSON.stringify({ error: 'فشل التحقق من الجلسة' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY غير مُعدّ في بيئة Netlify' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const payload = {
      model: MODEL,
      max_tokens: Math.min(Number(body.max_tokens) || 4000, MAX_TOKENS_CAP),
      messages: Array.isArray(body.messages) ? body.messages : [],
    };
    if (body.system) payload.system = body.system;

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
      return { statusCode: res.status, body: JSON.stringify({ error: msg }) };
    }

    // نلتقط كتل النص فقط ونتجاهل أي كتل أخرى (مثل "thinking") — الرد هنا كامل غير
    // مبثوث فلا داعي لأي منطق أحداث، فقط تصفية نوع الكتلة
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text || '').join('');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, stop_reason: data.stop_reason || '' }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
