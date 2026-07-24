const { createClient } = require('@supabase/supabase-js');

// نفس مفتاح Supabase العام المستخدم في باقي الدوال (آمن للكشف) — مع تفضيل متغيرات البيئة
const SURL = process.env.SUPABASE_URL || 'https://ghpjrvnyrlcqsfcjyiuq.supabase.co';
const SKEY = process.env.SUPABASE_KEY || 'sb_publishable_WkOLENVn0HqysJetM6H6NA_tQe3Cn0n';

const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS_CAP = 2000;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  // 1) التحقق من هوية المستخدم — حماية المفتاح من الاستهلاك المباشر
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

  // 2) التأكد من وجود مفتاح Anthropic في متغيرات البيئة
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY غير مُعدّ في بيئة Netlify' }) };
  }

  // 3) تمرير الطلب إلى Anthropic (الموديل ثابت من طرف الخادم)
  try {
    const body = JSON.parse(event.body || '{}');
    const payload = {
      model: MODEL,
      max_tokens: Math.min(Number(body.max_tokens) || 1000, MAX_TOKENS_CAP),
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
      const msg = (data && data.error && data.error.message) || 'خطأ في خدمة التصنيف';
      return { statusCode: res.status, body: JSON.stringify({ error: msg }) };
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
