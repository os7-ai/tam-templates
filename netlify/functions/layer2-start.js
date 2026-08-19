// نقطة البدء المتزامنة لـLayer 2 (سريعة): تحقق + حجز المرحلة + حفظ لقطة المدخلات
// (tbRows وtbScope) في Storage (مرجع فقط في pipeline_status.json) + تشغيل الدالة
// الخلفية (layer2-map-background) دون انتظار اكتمالها. نفس مبدأ layer1-start.js.
const { requireUser, requireApiKey } = require('./lib/auth');
const { saveJson, loadJson } = require('./lib/engagement-store');
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
    const { engagementId, tbRows, tbScope } = body;
    if (!engagementId || !Array.isArray(tbRows)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'engagementId وtbRows مطلوبة' }) };
    }
    if (tbScope !== 'full' && tbScope !== 'incomeStatementOnly') {
      return { statusCode: 400, body: JSON.stringify({ error: 'tbScope يجب أن يكون "full" أو "incomeStatementOnly"' }) };
    }
    const layer1 = await loadJson(sb, user.id, engagementId, 'layer1.json');
    if (!layer1) {
      return { statusCode: 400, body: JSON.stringify({ error: 'لم يُشغَّل Layer 1 لهذا الـEngagement بعد' }) };
    }

    const { claimed } = await claimStage(sb, user.id, engagementId, 'layer2');
    if (!claimed) {
      return { statusCode: 409, body: JSON.stringify({ error: 'Layer 2 قيد التنفيذ بالفعل لهذا الـEngagement' }) };
    }

    await saveJson(sb, user.id, engagementId, 'inputs/layer2_tb.json', { tbRows, tbScope });

    const res = await fetch(`${baseUrl(event)}/.netlify/functions/layer2-map-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: event.headers.authorization || event.headers.Authorization || '' },
      body: JSON.stringify({ engagementId }),
    });
    if (!res.ok && res.status !== 202) {
      await finishStage(sb, user.id, engagementId, 'layer2', { status: 'error', error: `تعذّر بدء المهمة الخلفية (HTTP ${res.status})` });
      return { statusCode: 502, body: JSON.stringify({ error: 'تعذّر بدء المهمة الخلفية لـLayer 2' }) };
    }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ started: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
