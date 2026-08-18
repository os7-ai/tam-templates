// يستقبل قرار مراجع واحد (SubLine mapping أو Main Line Code)، يُخزّنه في
// reviewerDecisions.json (Baseline لا يُعدَّل أبداً)، ثم يُعيد اشتقاق layer2_reviewed/
// layer3_reviewed/layer4_reviewed بالكامل من (Baseline + كل القرارات الحالية) — وليس
// فقط القرار الجديد — حتى لا تتراكم حالة قديمة (لا "ذاكرة" منفصلة عن الملفات نفسها).
//
// - قرار SubLine مُحسوم (chosenSubLineId) يُشغّل Targeted Re-evaluation فعلي عبر
//   Layer 3 AI (layer3-runner) على الحسابات المتأثرة فقط، ثم Targeted Reconciliation
//   حسابي بحت على كامل الشجرة (حتمي — غير المتأثر يُعيد نفس قيم الـBaseline تماماً).
// - قرار Main Line Code لا يُغيّر layer2/3/4 (لا صلة له بالربط أو التصنيف)، ويُستهلك
//   مباشرة في Layer 5 عند توليد الملف النهائي.
const { requireUser, requireApiKey } = require('./lib/auth');
const {
  checkDecisionContext,
  applySubLineDecisions,
  mergeLayer3Reevaluation,
  computeReconciliation,
  buildReviewFlags,
  diffAgainstBaseline,
} = require('./lib/reviewer-mapping');
const { classifyAccounts } = require('./lib/layer3-runner');
const { saveJson, loadJson } = require('./lib/engagement-store');

const EMPTY_DECISIONS = { subLineDecisions: {}, mainLineCodeDecisions: {} };
const FIXED_MAIN_CODES = ['CS', 'GE', 'SE', 'FIN', 'DEP', 'LOS', 'PROV', 'OTH'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const { sb, user, errorResponse } = await requireUser(event);
  if (errorResponse) return errorResponse;

  try {
    const body = JSON.parse(event.body || '{}');
    const { engagementId, decisionType } = body;
    if (!engagementId) return { statusCode: 400, body: JSON.stringify({ error: 'engagementId مطلوب' }) };
    if (decisionType !== 'subLine' && decisionType !== 'mainLineCode') {
      return { statusCode: 400, body: JSON.stringify({ error: 'decisionType يجب أن يكون "subLine" أو "mainLineCode"' }) };
    }

    const layer1 = await loadJson(sb, user.id, engagementId, 'layer1.json');
    const layer2 = await loadJson(sb, user.id, engagementId, 'layer2.json');
    const layer3 = await loadJson(sb, user.id, engagementId, 'layer3.json');
    const layer4 = await loadJson(sb, user.id, engagementId, 'layer4.json');
    if (!layer1 || !layer2 || !layer3 || !layer4) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Layer 1/2/3/4 (Baseline) غير مكتملين لهذا الـEngagement' }) };
    }

    const reviewerDecisions = (await loadJson(sb, user.id, engagementId, 'reviewerDecisions.json')) || {
      subLineDecisions: {}, mainLineCodeDecisions: {},
    };

    const now = new Date().toISOString();

    if (decisionType === 'subLine') {
      const { accountNumber, chosenSubLineId } = body;
      if (accountNumber === undefined || accountNumber === null) {
        return { statusCode: 400, body: JSON.stringify({ error: 'accountNumber مطلوب' }) };
      }
      const account = layer2.trialBalanceAccounts.find(a => String(a.accountNumber) === String(accountNumber));
      if (!account) {
        return { statusCode: 400, body: JSON.stringify({ error: 'الحساب غير موجود في Layer 2 الحالي' }) };
      }
      if (!Array.isArray(account.candidateSubLines) || account.candidateSubLines.length === 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'لا يوجد candidateSubLines لهذا الحساب — لا مجال لقرار SubLine' }) };
      }
      if (chosenSubLineId && !account.candidateSubLines.some(c => c.subLineId === chosenSubLineId)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'chosenSubLineId ليس ضمن candidateSubLines الحالية لهذا الحساب' }) };
      }
      reviewerDecisions.subLineDecisions[String(accountNumber)] = {
        status: chosenSubLineId ? 'Resolved' : 'NotResolved',
        chosenSubLineId: chosenSubLineId || null,
        candidateSubLinesSnapshot: account.candidateSubLines,
        decidedAt: now,
        decidedBy: user.id,
      };
    } else {
      const { mainLineName, chosenCode } = body;
      if (!mainLineName) return { statusCode: 400, body: JSON.stringify({ error: 'mainLineName مطلوب' }) };
      const mainLine = layer1.mainLines.find(ml => ml.mainLineName === mainLineName);
      if (!mainLine) {
        return { statusCode: 400, body: JSON.stringify({ error: 'mainLineName غير موجود في Layer 1 الحالي' }) };
      }
      if (chosenCode && !FIXED_MAIN_CODES.includes(chosenCode)) {
        return { statusCode: 400, body: JSON.stringify({ error: `chosenCode يجب أن يكون أحد: ${FIXED_MAIN_CODES.join(', ')}` }) };
      }
      reviewerDecisions.mainLineCodeDecisions[mainLineName] = {
        status: chosenCode ? 'Resolved' : 'NotResolved',
        chosenCode: chosenCode || null,
        totalPerIncomeStatementSnapshot: mainLine.totalPerIncomeStatement,
        decidedAt: now,
        decidedBy: user.id,
      };
    }

    await saveJson(sb, user.id, engagementId, 'reviewerDecisions.json', reviewerDecisions);

    // ---------- إعادة اشتقاق _reviewed كاملة من (Baseline + كل القرارات الحالية) ----------
    const checkedDecisions = checkDecisionContext(reviewerDecisions, layer1, layer2);
    const { layer2Reviewed, changedAccounts } = applySubLineDecisions(layer2, checkedDecisions);

    let reevaluatedResults = [];
    if (changedAccounts.length > 0) {
      const { apiKey, errorResponse: keyErr } = requireApiKey();
      if (keyErr) return keyErr;
      const nums = new Set(changedAccounts.map(c => String(c.accountNumber)));
      const targetAccounts = layer2Reviewed.trialBalanceAccounts.filter(a => nums.has(String(a.accountNumber)));
      reevaluatedResults = await classifyAccounts(apiKey, layer1, layer2Reviewed, targetAccounts);
    }

    const layer3Reviewed = mergeLayer3Reevaluation(layer3, reevaluatedResults);
    const threshold = layer4.reconciliationThresholdUsed.value;
    const reconciliation = computeReconciliation(layer1, layer2Reviewed, layer3Reviewed, threshold);
    const reviewFlags = buildReviewFlags(layer2Reviewed, layer3Reviewed, reconciliation);
    const diffFromBaseline = diffAgainstBaseline(reconciliation, layer4);

    const layer4Reviewed = {
      reconciliation,
      reviewFlags,
      diffFromBaseline,
      reconciliationThresholdUsed: layer4.reconciliationThresholdUsed,
    };

    await saveJson(sb, user.id, engagementId, 'layer2_reviewed.json', layer2Reviewed);
    await saveJson(sb, user.id, engagementId, 'layer3_reviewed.json', layer3Reviewed);
    await saveJson(sb, user.id, engagementId, 'layer4_reviewed.json', layer4Reviewed);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reviewerDecisions,
        checkedDecisions,
        changedAccounts,
        layer2Reviewed,
        layer3Reviewed,
        layer4Reviewed,
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
