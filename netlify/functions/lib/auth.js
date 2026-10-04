const { createClient } = require('@supabase/supabase-js');

const SURL = process.env.SUPABASE_URL;
const SKEY = process.env.SUPABASE_KEY;

// يتحقق من جلسة المستخدم عبر Supabase ويُعيد {sb, user} أو يرمي استجابة خطأ جاهزة
// (نفس نمط claude.js/income-call.js في هذا المشروع).
async function requireUser(event) {
  if (!SURL || !SKEY) {
    return { errorResponse: { statusCode: 500, body: JSON.stringify({ error: 'SUPABASE_URL / SUPABASE_KEY غير مُعدّة في بيئة Netlify' }) } };
  }
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) {
    return { errorResponse: { statusCode: 401, body: JSON.stringify({ error: 'يتطلب تسجيل الدخول' }) } };
  }
  const sb = createClient(SURL, SKEY);
  try {
    const { data: { user } = {}, error } = await sb.auth.getUser(token);
    if (error || !user) {
      return { errorResponse: { statusCode: 401, body: JSON.stringify({ error: 'جلسة غير صالحة' }) } };
    }
    return { sb, user };
  } catch (e) {
    return { errorResponse: { statusCode: 401, body: JSON.stringify({ error: 'فشل التحقق من الجلسة' }) } };
  }
}

function requireApiKey() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { errorResponse: { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY غير مُعدّ في بيئة Netlify' }) } };
  }
  return { apiKey };
}

module.exports = { requireUser, requireApiKey, SURL, SKEY };
