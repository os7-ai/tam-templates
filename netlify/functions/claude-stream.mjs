import { createClient } from '@supabase/supabase-js';

// دالة Netlify Functions v2 (ESM + Web Streams) — تبث رد Anthropic أول بأول بدل انتظار الرد الكامل
const SURL = process.env.SUPABASE_URL;
const SKEY = process.env.SUPABASE_KEY;

const MODEL = 'claude-opus-5-5';
// التفكير دائماً مفعّل في هذا الموديل ويُحسب ضمن max_tokens، فالسقف يتسع للتفكير + الرد
const MAX_TOKENS_CAP = 16000;
const EFFORT = 'medium';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export default async (req) => {
  if (req.method !== 'POST') {
    return jsonError('Method Not Allowed', 405);
  }

  if (!SURL || !SKEY) {
    return jsonError('SUPABASE_URL / SUPABASE_KEY غير مُعدّة في بيئة Netlify', 500);
  }

  // 1) التحقق من هوية المستخدم — حماية المفتاح من الاستهلاك المباشر
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) {
    return jsonError('يتطلب تسجيل الدخول', 401);
  }
  try {
    const sb = createClient(SURL, SKEY);
    const { data: { user } = {}, error } = await sb.auth.getUser(token);
    if (error || !user) {
      return jsonError('جلسة غير صالحة', 401);
    }
  } catch (e) {
    return jsonError('فشل التحقق من الجلسة', 401);
  }

  // 2) التأكد من وجود مفتاح Anthropic
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return jsonError('ANTHROPIC_API_KEY غير مُعدّ في بيئة Netlify', 500);
  }

  // 3) بناء الطلب وتمريره مبثوثاً (stream) إلى Anthropic
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return jsonError('طلب غير صالح', 400);
  }

  // warm: تسخين الكاش بـ max_tokens: 0 — يكتب البادئة في الكاش دون توليد؛ يرفضه الـ API مع stream،
  // ويجب أن يطابق effort الطلبات الفعلية وإلا كُتب مدخل كاش لا تقرؤه
  const warm = body.warm === true;
  const payload = {
    model: MODEL,
    max_tokens: warm ? 0 : Math.min(Number(body.max_tokens) || 8000, MAX_TOKENS_CAP),
    messages: Array.isArray(body.messages) ? body.messages : [],
    output_config: { effort: EFFORT }
  };
  if (!warm) {
    payload.fallbacks = 'default';
    payload.stream = true;
  }
  if (body.system) payload.system = body.system;

  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  };
  if (!warm) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';

  let upstream;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
  } catch (e) {
    return jsonError('تعذّر الاتصال بخدمة التصنيف', 502);
  }

  if (!upstream.ok) {
    const errData = await upstream.json().catch(() => ({}));
    const msg = (errData && errData.error && errData.error.message) || 'خطأ في خدمة التصنيف';
    return jsonError(msg, upstream.status);
  }

  if (warm) {
    const data = await upstream.json().catch(() => ({}));
    return new Response(JSON.stringify({ usage: data.usage || null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // تمرير مباشر (passthrough) لتيار SSE من Anthropic — يُقرأ ويُفكّك على المتصفح
  return new Response(upstream.body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' }
  });
};
