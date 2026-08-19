// نقطة البدء المتزامنة لـLayer 3 (وضع full فقط — هو المستخدَم في مسار التحليل الأولي؛
// وضع targeted الخاص بـreviewer-decide.js يبقى كما هو، متزامناً، لأنه يُصنّف حسابات
// قليلة متأثرة فقط ومخاطر توقيته منخفضة، وخارج نطاق هذا التعديل). لا حاجة للقطة مدخلات
// هنا: Layer 3 يقرأ layer1.json/layer2.json المحفوظين مسبقاً مباشرة.
const { requireUser, requireApiKey } = require('./lib/auth');
const { loadJson } = require('./lib/engagement-store');
const { claimStage, finishStage } = require('./lib/pipeline-status');

function baseUrl(event) {
  if (process.env.URL) return process.env.URL;
  const host = event.headers['x-forwarded-host'] || event.headers.host;
  return `https://${host}`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const { sb, user, errorResponse } = await requireUser(event);
  if (errorResponse) return errorResponse;
  const { errorResponse: keyErr } = requireApiKey();
  if (keyErr) return keyErr;

  try {
    const body = JSON.parse(event.body || '{}');
    const { engagementId } = body;
    if (!engagementId) return { statusCode: 400, body: JSON.stringify({ error: 'engagementId مطلوب' }) };

    const layer1 = await loadJson(sb, user.id, engagementId, 'layer1.json');
    const layer2 = await loadJson(sb, user.id, engagementId, 'layer2.json');
    if (!layer1 || !layer2) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Layer 1/2 غير متوفرين لهذا الـEngagement' }) };
    }

    const { claimed } = await claimStage(sb, user.id, engagementId, 'layer3');
    if (!claimed) {
      return { statusCode: 409, body: JSON.stringify({ error: 'Layer 3 قيد التنفيذ بالفعل لهذا الـEngagement' }) };
    }

    const res = await fetch(`${baseUrl(event)}/.netlify/functions/layer3-classify-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: event.headers.authorization || event.headers.Authorization || '' },
      body: JSON.stringify({ engagementId }),
    });
    if (!res.ok && res.status !== 202) {
      await finishStage(sb, user.id, engagementId, 'layer3', { status: 'error', error: `تعذّر بدء المهمة الخلفية (HTTP ${res.status})` });
      return { statusCode: 502, body: JSON.stringify({ error: 'تعذّر بدء المهمة الخلفية لـLayer 3' }) };
    }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ started: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
