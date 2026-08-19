// نقطة البدء المتزامنة لـLayer 2 (سريعة): تحقق + حجز المرحلة + حفظ لقطة المدخلات
// (tbRows وtbScope) في Storage (مرجع فقط في pipeline_status.json) + تشغيل الدالة
// الخلفية (layer2-map-background) دون انتظار اكتمالها. نفس مبدأ layer1-start.js.
const { requireUser, requireApiKey } = require('./lib/auth');
const { saveJson, loadJson, extractToken } = require('./lib/engagement-store');
const { claimStage, finishStage } = require('./lib/pipeline-status');

// الأولوية لِـhost الطلب الفعلي نفسه (يعكس بدقة Preview أو Production حسب من استدعى
// فعلاً) — process.env.URL على Netlify يشير دائماً للدومين الأساسي للموقع (mdadalpha.com)
// بصرف النظر عن الـdeploy الفعلي، فاستخدامه أولاً كان يُرسِل نداءات الدوال الخلفية من أي
// Preview إلى دومين الإنتاج فيرجع 404. DEPLOY_PRIME_URL/URL يبقيان احتياطاً فقط إن غابت
// الـheaders لأي سبب.
function baseUrl(event) {
  const host = event.headers['x-forwarded-host'] || event.headers.host;
  if (host) return `https://${host}`;
  return process.env.DEPLOY_PRIME_URL || process.env.URL;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const { user, errorResponse } = await requireUser(event);
  if (errorResponse) return errorResponse;
  const { errorResponse: keyErr } = requireApiKey();
  if (keyErr) return keyErr;
  const token = extractToken(event);

  try {
    const body = JSON.parse(event.body || '{}');
    const { engagementId, tbRows, tbScope } = body;
    if (!engagementId || !Array.isArray(tbRows)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'engagementId وtbRows مطلوبة' }) };
    }
    if (tbScope !== 'full' && tbScope !== 'incomeStatementOnly') {
      return { statusCode: 400, body: JSON.stringify({ error: 'tbScope يجب أن يكون "full" أو "incomeStatementOnly"' }) };
    }
    const layer1 = await loadJson(token, user.id, engagementId, 'layer1.json');
    if (!layer1) {
      return { statusCode: 400, body: JSON.stringify({ error: 'لم يُشغَّل Layer 1 لهذا الـEngagement بعد' }) };
    }

    const { claimed } = await claimStage(token, user.id, engagementId, 'layer2');
    if (!claimed) {
      return { statusCode: 409, body: JSON.stringify({ error: 'Layer 2 قيد التنفيذ بالفعل لهذا الـEngagement' }) };
    }

    await saveJson(token, user.id, engagementId, 'inputs/layer2_tb.json', { tbRows, tbScope });

    const res = await fetch(`${baseUrl(event)}/.netlify/functions/layer2-map-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: event.headers.authorization || event.headers.Authorization || '' },
      body: JSON.stringify({ engagementId }),
    });
    if (!res.ok && res.status !== 202) {
      await finishStage(token, user.id, engagementId, 'layer2', { status: 'error', error: `تعذّر بدء المهمة الخلفية (HTTP ${res.status})` });
      return { statusCode: 502, body: JSON.stringify({ error: 'تعذّر بدء المهمة الخلفية لـLayer 2' }) };
    }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ started: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
