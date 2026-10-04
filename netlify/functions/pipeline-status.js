// نقطة استطلاع خفيفة (Polling) — قراءة pipeline_status.json فقط، لا AI ولا خطر توقيت
// إطلاقاً. الواجهة تستدعيها كل بضع ثوانٍ لمتابعة حالة Layer 1-4 لحظياً.
const { requireUser } = require('./lib/auth');
const { getPipelineStatus } = require('./lib/pipeline-status');
const { extractToken } = require('./lib/engagement-store');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const { user, errorResponse } = await requireUser(event);
  if (errorResponse) return errorResponse;
  const token = extractToken(event);
  try {
    const { engagementId } = JSON.parse(event.body || '{}');
    if (!engagementId) return { statusCode: 400, body: JSON.stringify({ error: 'engagementId مطلوب' }) };
    const status = await getPipelineStatus(token, user.id, engagementId);
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(status) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
