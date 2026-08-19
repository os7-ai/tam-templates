// يبني قائمتي المراجعة (SubLine Mapping + Main Line Code) لِـEngagement معيّن، ويُرجع
// حالة كل قرار مخزَّن مسبقاً (Resolved/NotResolved/Orphaned/ContextChanged) مقابل الـ
// Baseline الحالي. لا يُعدِّل أي شيء — قراءة فقط.
const { requireUser } = require('./lib/auth');
const { buildSubLineReviewQueue, buildMainLineCodeReviewQueue, checkDecisionContext } = require('./lib/reviewer-mapping');
const { MAIN_LINE_CODE_MAP } = require('./lib/layer5-populate');
const { loadJson, extractToken } = require('./lib/engagement-store');

const EMPTY_DECISIONS = { subLineDecisions: {}, mainLineCodeDecisions: {} };

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const { user, errorResponse } = await requireUser(event);
  if (errorResponse) return errorResponse;
  const token = extractToken(event);

  try {
    const { engagementId } = JSON.parse(event.body || '{}');
    if (!engagementId) return { statusCode: 400, body: JSON.stringify({ error: 'engagementId مطلوب' }) };

    const layer1 = await loadJson(token, user.id, engagementId, 'layer1.json');
    const layer2 = await loadJson(token, user.id, engagementId, 'layer2.json');
    if (!layer1 || !layer2) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Layer 1/2 غير متوفرين لهذا الـEngagement' }) };
    }
    const reviewerDecisions = (await loadJson(token, user.id, engagementId, 'reviewerDecisions.json')) || EMPTY_DECISIONS;

    const subLineQueue = buildSubLineReviewQueue(layer2);
    const mainLineCodeQueue = buildMainLineCodeReviewQueue(layer1, MAIN_LINE_CODE_MAP);
    const checkedDecisions = checkDecisionContext(reviewerDecisions, layer1, layer2);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subLineQueue, mainLineCodeQueue, checkedDecisions }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
