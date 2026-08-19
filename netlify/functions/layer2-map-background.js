// المهمة الفعلية لـLayer 2 (Background Function) — العمارة الجديدة: AI-Assisted Mapping
// Review & Reconciliation. المدخل لم يعد ميزان مراجعة خام بل Mapping Template مُعبَّأ
// مسبقاً من المُراجِع (كل حساب مُسنَد فعلياً إلى بند قائمة دخل وبند إيضاح بنص حر). دور AI
// يتقلّص إلى Step A (مطابقة دلالية لكل زوج تسميات مُميَّز مرة واحدة فقط، مُطبَّقة على كل
// الحسابات المشتركة في نفس الزوج) وStep C (تدقيق استثنائي شحيح لأسماء حسابات فردية).
// الـReconciliation (Step B) كود بحت بالكامل عبر lib/layer2-reconciliation.js، بلا أي AI.
const { requireUser, requireApiKey } = require('./lib/auth');
const { callClaudeForJson } = require('./lib/claude-client');
const { buildLayer2SystemPrompt } = require('./lib/prompts/layer2-prompt');
const { computeLayer2Reconciliation } = require('./lib/layer2-reconciliation');
const { saveJson, loadJson, extractToken } = require('./lib/engagement-store');
const { finishStage, updateStageProgress } = require('./lib/pipeline-status');
const { logStage } = require('./lib/timing');

const GROUP_BATCH_SIZE = 40;

function pairKey(mainLabel, subLabel) {
  return `${(mainLabel || '').trim()}|${(subLabel || '').trim()}`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const { user, errorResponse } = await requireUser(event);
  if (errorResponse) return errorResponse;
  const { apiKey, errorResponse: keyErr } = requireApiKey();
  if (keyErr) return keyErr;
  const token = extractToken(event);

  const t0 = Date.now();
  let engagementId;
  try {
    const body = JSON.parse(event.body || '{}');
    engagementId = body.engagementId;
    if (!engagementId) return { statusCode: 400, body: JSON.stringify({ error: 'engagementId مطلوب' }) };

    const snapshot = await loadJson(token, user.id, engagementId, 'inputs/layer2_mapping_template.json');
    if (!snapshot || !Array.isArray(snapshot.rows)) {
      throw new Error('لقطة مدخلات Layer 2 غير موجودة — لم يُستدعَ هذا الإجراء عبر layer2-start');
    }
    const { rows, reconciliationThreshold } = snapshot;
    if (reconciliationThreshold === undefined || reconciliationThreshold === null) {
      throw new Error('reconciliationThreshold مفقود في لقطة مدخلات Layer 2');
    }

    const layer1 = await loadJson(token, user.id, engagementId, 'layer1.json');
    if (!layer1) throw new Error('لم يُشغَّل Layer 1 لهذا الـEngagement بعد');

    logStage('layer2-map-background', engagementId, 'start', t0, { rows: rows.length });

    // ---------- تجميع الحسابات في مجموعات بحسب زوج (reviewerMainLineLabel, reviewerSubLineLabel) ----------
    const tbRawSource = rows.map(r => ({
      accountNumber: r.accountNumber ?? null,
      accountName: r.accountName,
      amount: Number(r.amount) || 0,
      reviewerMainLineLabel: r.reviewerMainLineLabel,
      reviewerSubLineLabel: r.reviewerSubLineLabel,
    }));

    const groupsByKey = new Map();
    for (const r of tbRawSource) {
      const key = pairKey(r.reviewerMainLineLabel, r.reviewerSubLineLabel);
      if (!groupsByKey.has(key)) {
        groupsByKey.set(key, {
          reviewerMainLineLabel: r.reviewerMainLineLabel,
          reviewerSubLineLabel: r.reviewerSubLineLabel,
          accounts: [],
        });
      }
      groupsByKey.get(key).accounts.push({ accountNumber: r.accountNumber, accountName: r.accountName, amount: r.amount });
    }
    const groups = Array.from(groupsByKey.values());

    const batches = [];
    for (let i = 0; i < groups.length; i += GROUP_BATCH_SIZE) batches.push(groups.slice(i, i + GROUP_BATCH_SIZE));
    if (batches.length === 0) batches.push([]);
    logStage('layer2-map-background', engagementId, 'claude_batches_start', t0, { batchCount: batches.length, distinctGroups: groups.length });

    const system = buildLayer2SystemPrompt(layer1);
    const groupResultByKey = new Map();
    for (let bi = 0; bi < batches.length; bi++) {
      await updateStageProgress(token, user.id, engagementId, 'layer2', { batchIndex: bi, batchCount: batches.length });
      logStage('layer2-map-background', engagementId, 'batch_start', t0, { batchIndex: bi, batchCount: batches.length, batchGroups: batches[bi].length });
      const messages = [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(batches[bi]) }] }];
      const json = await callClaudeForJson({ apiKey, system, messages, maxTokens: 16000 });
      logStage('layer2-map-background', engagementId, 'batch_end', t0, { batchIndex: bi, batchCount: batches.length });
      if (!Array.isArray(json.groups)) throw new Error('رد Layer 2 لا يحتوي groups بالشكل المتوقع');
      for (const g of json.groups) {
        groupResultByKey.set(pairKey(g.reviewerMainLineLabel, g.reviewerSubLineLabel), g);
      }
    }
    await updateStageProgress(token, user.id, engagementId, 'layer2', { batchIndex: batches.length, batchCount: batches.length });
    logStage('layer2-map-background', engagementId, 'claude_batches_end', t0);

    // ---------- تطبيق نتيجة كل زوج على كل حساباته (كود بسيط، بلا AI إضافي) ----------
    const trialBalanceAccounts = [];
    const layer2FullAccounts = [];
    const unmatchedReviewerLabels = [];
    let flaggedAccountCount = 0;

    for (const group of groups) {
      const key = pairKey(group.reviewerMainLineLabel, group.reviewerSubLineLabel);
      const result = groupResultByKey.get(key);
      if (!result) throw new Error(`لم يصل رد AI لزوج التسميات: "${group.reviewerMainLineLabel}" / "${group.reviewerSubLineLabel}"`);

      const flaggedByAccountNumber = new Map(
        (result.flaggedAccounts || []).map(f => [String(f.accountNumber ?? ''), f])
      );

      let mappingStatus, unmappedReasonCategory;
      if (result.matchStatus === 'Matched') {
        mappingStatus = 'Mapped'; unmappedReasonCategory = null;
      } else if (result.matchStatus === 'Review Required') {
        mappingStatus = 'Review Required'; unmappedReasonCategory = null;
      } else {
        mappingStatus = 'Unmapped'; unmappedReasonCategory = 'No Matching SubLine';
        unmatchedReviewerLabels.push({
          reviewerMainLineLabel: group.reviewerMainLineLabel,
          reviewerSubLineLabel: group.reviewerSubLineLabel,
          reason: result.matchReason,
          accounts: group.accounts.map(a => ({ accountNumber: a.accountNumber, accountName: a.accountName, amount: a.amount })),
        });
      }

      for (const acc of group.accounts) {
        const flag = flaggedByAccountNumber.get(String(acc.accountNumber ?? '')) || null;
        if (flag) flaggedAccountCount++;

        const base = {
          accountNumber: acc.accountNumber,
          accountName: acc.accountName,
          amount: acc.amount,
          clientMainClassification: group.reviewerMainLineLabel,
          clientSubClassification: group.reviewerSubLineLabel,
          mappedMainLineName: result.mappedMainLineName ?? null,
          mappedSubLineId: result.mappedSubLineId ?? null,
          mappingStatus,
          mappingReason: result.matchReason ?? null,
          unmappedReasonCategory,
          mappingBasis: `Matched via reviewer label pair ("${group.reviewerMainLineLabel}" / "${group.reviewerSubLineLabel}") — resolved once, applied to ${group.accounts.length} account(s) sharing this pair.`,
          candidateSubLines: result.candidateSubLines || [],
          aiPlausibilityFlag: flag ? { flagged: true, reason: flag.reason } : null,
        };
        trialBalanceAccounts.push(base);

        layer2FullAccounts.push({
          accountNumber: acc.accountNumber,
          accountName: acc.accountName,
          amount: acc.amount,
          reviewerInput: { reviewerMainLineLabel: group.reviewerMainLineLabel, reviewerSubLineLabel: group.reviewerSubLineLabel },
          aiMapping: {
            matchStatus: result.matchStatus,
            mappedMainLineName: result.mappedMainLineName ?? null,
            mappedSubLineId: result.mappedSubLineId ?? null,
            matchReason: result.matchReason ?? null,
            candidateSubLines: result.candidateSubLines || [],
          },
          aiReviewFlag: flag ? { flagged: true, reason: flag.reason } : { flagged: false, reason: null },
          reviewerDecision: null,
        });
      }
    }

    // ---------- استبعاد ثابت من التشغيلي (نفس نمط Layer 2 القديم — خارج نطاق قائمة الدخل/Parent-Subtotal) ----------
    const isNonOperational = (a) => a.mappingStatus === 'Unmapped'
      && (a.unmappedReasonCategory === 'Out of Income Statement Scope' || a.unmappedReasonCategory === 'Parent/Subtotal');
    const operationalAccounts = trialBalanceAccounts.filter(a => !isNonOperational(a));
    const nonOperationalExcludedCount = trialBalanceAccounts.length - operationalAccounts.length;

    // ---------- Step B — Reconciliation (كود بحت، بلا AI) ----------
    const reconciliation = computeLayer2Reconciliation(layer1, trialBalanceAccounts, Number(reconciliationThreshold));

    const layer2 = { trialBalanceAccounts: operationalAccounts };
    const layer2Full = {
      trialBalanceAccounts: layer2FullAccounts.map((a, i) => ({ ...a, excludedFromOperationalPipeline: isNonOperational(trialBalanceAccounts[i]) })),
    };
    const flaggedAccounts = trialBalanceAccounts
      .filter(a => a.aiPlausibilityFlag && a.aiPlausibilityFlag.flagged)
      .map(a => ({
        accountNumber: a.accountNumber, accountName: a.accountName, amount: a.amount,
        mainLineName: a.mappedMainLineName, subLineId: a.mappedSubLineId,
        reviewerMainLineLabel: a.clientMainClassification, reviewerSubLineLabel: a.clientSubClassification,
        reason: a.aiPlausibilityFlag.reason,
      }));

    const layer2Reconciliation = {
      ...reconciliation,
      unmatchedReviewerLabels,
      flaggedAccounts,
      recordedAt: new Date().toISOString(),
    };

    await saveJson(token, user.id, engagementId, 'layer2.json', layer2);
    await saveJson(token, user.id, engagementId, 'layer2_full.json', layer2Full);
    await saveJson(token, user.id, engagementId, 'layer2_reconciliation.json', layer2Reconciliation);
    await saveJson(token, user.id, engagementId, 'tb_raw_source.json', tbRawSource);

    const materialVarianceCount = reconciliation.subLines.filter(s => s.reconciliationStatus === 'Material Variance').length;
    const resultSummary = {
      totalRows: tbRawSource.length,
      distinctGroups: groups.length,
      nonOperationalExcluded: nonOperationalExcludedCount,
      matchedCount: trialBalanceAccounts.filter(a => a.mappingStatus === 'Mapped').length,
      reviewRequiredCount: trialBalanceAccounts.filter(a => a.mappingStatus === 'Review Required').length,
      unmatchedCount: trialBalanceAccounts.filter(a => a.mappingStatus === 'Unmapped').length,
      flaggedAccountCount,
      materialVarianceCount,
      opposingPatternCount: reconciliation.opposingVariancePatterns.length,
      noLinkedAccountsCount: reconciliation.notesWithNoLinkedAccounts.length,
    };
    await finishStage(token, user.id, engagementId, 'layer2', { status: 'done', error: null, result: resultSummary });
    logStage('layer2-map-background', engagementId, 'end', t0);

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ layer2, ...resultSummary }) };
  } catch (err) {
    logStage('layer2-map-background', engagementId, 'error', t0, { message: err.message });
    if (engagementId) await finishStage(token, user.id, engagementId, 'layer2', { status: 'error', error: err.message }).catch(() => {});
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
