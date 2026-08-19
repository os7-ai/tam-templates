// يُرجع layer2_reconciliation.json المحفوظ (نتيجة Step B — حسابي بحت، بلا AI) لِـEngagement
// معيّن، لعرضه في شاشة النتائج الجديدة (مستوى subLine، قبل أي قرار مراجع). قراءة فقط.
const { requireUser } = require('./lib/auth');
const { loadJson, extractToken } = require('./lib/engagement-store');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const { user, errorResponse } = await requireUser(event);
  if (errorResponse) return errorResponse;
  const token = extractToken(event);

  try {
    const { engagementId } = JSON.parse(event.body || '{}');
    if (!engagementId) return { statusCode: 400, body: JSON.stringify({ error: 'engagementId مطلوب' }) };

    const layer2Reconciliation = await loadJson(token, user.id, engagementId, 'layer2_reconciliation.json');
    if (!layer2Reconciliation) {
      return { statusCode: 400, body: JSON.stringify({ error: 'لم تُنفَّذ مطابقة Layer 2 لهذا الـEngagement بعد' }) };
    }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(layer2Reconciliation) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
