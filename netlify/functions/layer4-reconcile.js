// Layer 4 — حسابي بحت، بلا أي استدعاء AI. يستهلك computeReconciliation() الجاهزة في
// reviewer-mapping.js (نفس الدالة المستخدَمة لاحقاً في Targeted Reconciliation بعد
// قرارات المراجع، لضمان نفس المنطق حرفياً في كل مكان).
const { requireUser } = require('./lib/auth');
const { computeReconciliation, buildReviewFlags } = require('./lib/reviewer-mapping');
const { saveJson, loadJson } = require('./lib/engagement-store');
const { logStage } = require('./lib/timing');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const { sb, user, errorResponse } = await requireUser(event);
  if (errorResponse) return errorResponse;

  const t0 = Date.now();
  let engagementId;
  try {
    const body = JSON.parse(event.body || '{}');
    const { reconciliationThreshold } = body;
    engagementId = body.engagementId;
    logStage('layer4-reconcile', engagementId, 'start', t0);
    if (reconciliationThreshold === undefined || reconciliationThreshold === null) {
      return { statusCode: 400, body: JSON.stringify({ error: 'reconciliationThreshold مطلوب — لا يُخترع من الخادم.' }) };
    }

    const layer1 = await loadJson(sb, user.id, engagementId, 'layer1.json');
    const layer2 = await loadJson(sb, user.id, engagementId, 'layer2.json');
    const layer3 = await loadJson(sb, user.id, engagementId, 'layer3.json');
    if (!layer1 || !layer2 || !layer3) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Layer 1/2/3 غير متوفرين لهذا الـEngagement' }) };
    }

    const reconciliation = computeReconciliation(layer1, layer2, layer3, Number(reconciliationThreshold));
    const reviewFlags = buildReviewFlags(layer2, layer3, reconciliation);
    const layer4 = {
      reconciliation,
      reviewFlags,
      reconciliationThresholdUsed: { value: Number(reconciliationThreshold), recordedAt: new Date().toISOString() },
    };
    await saveJson(sb, user.id, engagementId, 'layer4.json', layer4);
    logStage('layer4-reconcile', engagementId, 'end', t0);
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(layer4) };
  } catch (err) {
    logStage('layer4-reconcile', engagementId, 'error', t0, { message: err.message });
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
