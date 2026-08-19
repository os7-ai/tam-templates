// المهمة الفعلية لـLayer 2 (Background Function). نفس منطق layer2-map.js حرفياً —
// Zero Balance Filter، حجم الدفعة 35 دون تغيير، نفس الاستبعاد التشغيلي الثابت (Balance
// Sheet/Parent-Subtotal) — الفرق الوحيد: المدخلات تُقرأ من لقطة محفوظة (وليس من جسم
// الطلب مباشرة، لتفادي إرسال tbRows مرتين عبر النداء الداخلي)، وتحديث تقدّم كل دفعة في
// pipeline_status.json بدل الرجوع المتزامن فقط.
const { requireUser, requireApiKey } = require('./lib/auth');
const { callClaudeForJson } = require('./lib/claude-client');
const { buildLayer2SystemPrompt } = require('./lib/prompts/layer2-prompt');
const { saveJson, loadJson, extractToken } = require('./lib/engagement-store');
const { finishStage, updateStageProgress } = require('./lib/pipeline-status');
const { logStage } = require('./lib/timing');

const BATCH_SIZE = 35;

function isZero(amount) {
  const n = Number(amount);
  return !Number.isFinite(n) || n === 0;
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

    const snapshot = await loadJson(token, user.id, engagementId, 'inputs/layer2_tb.json');
    if (!snapshot || !Array.isArray(snapshot.tbRows)) {
      throw new Error('لقطة مدخلات Layer 2 غير موجودة — لم يُستدعَ هذا الإجراء عبر layer2-start');
    }
    const { tbRows, tbScope } = snapshot;

    const layer1 = await loadJson(token, user.id, engagementId, 'layer1.json');
    if (!layer1) throw new Error('لم يُشغَّل Layer 1 لهذا الـEngagement بعد');

    logStage('layer2-map-background', engagementId, 'start', t0, { tbRows: tbRows.length, tbScope });

    // ---------- Zero Balance Filter (بلا أي تغيير) ----------
    const tbRawSource = [];
    const nonZeroRows = [];
    for (const r of tbRows) {
      const zero = isZero(r.amount);
      tbRawSource.push({
        accountNumber: r.accountNumber ?? null,
        accountName: r.accountName,
        amount: Number(r.amount) || 0,
        clientMainClassification: r.clientMainClassification ?? null,
        clientSubClassification: r.clientSubClassification ?? null,
        passedZeroBalanceFilter: !zero,
        outOfScopeReason: zero ? ['Zero Balance'] : null,
      });
      if (!zero) nonZeroRows.push(r);
    }

    const batches = [];
    for (let i = 0; i < nonZeroRows.length; i += BATCH_SIZE) batches.push(nonZeroRows.slice(i, i + BATCH_SIZE));
    if (batches.length === 0) batches.push([]);
    logStage('layer2-map-background', engagementId, 'claude_batches_start', t0, { batchCount: batches.length, batchSize: BATCH_SIZE });

    const system = buildLayer2SystemPrompt(layer1);
    let trialBalanceAccounts = [];
    for (let bi = 0; bi < batches.length; bi++) {
      await updateStageProgress(token, user.id, engagementId, 'layer2', { batchIndex: bi, batchCount: batches.length });
      logStage('layer2-map-background', engagementId, 'batch_start', t0, { batchIndex: bi, batchCount: batches.length, batchRows: batches[bi].length });
      const messages = [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(batches[bi]) }] }];
      const json = await callClaudeForJson({ apiKey, system, messages, maxTokens: 8000 });
      logStage('layer2-map-background', engagementId, 'batch_end', t0, { batchIndex: bi, batchCount: batches.length });
      if (!Array.isArray(json.trialBalanceAccounts)) throw new Error('رد Layer 2 لا يحتوي trialBalanceAccounts بالشكل المتوقع');
      trialBalanceAccounts = trialBalanceAccounts.concat(json.trialBalanceAccounts);
    }
    await updateStageProgress(token, user.id, engagementId, 'layer2', { batchIndex: batches.length, batchCount: batches.length });
    logStage('layer2-map-background', engagementId, 'claude_batches_end', t0);

    // ---------- استبعاد ثابت من التشغيلي (بلا أي تغيير) ----------
    const isNonOperational = (a) => a.mappingStatus === 'Unmapped'
      && (a.unmappedReasonCategory === 'Out of Income Statement Scope' || a.unmappedReasonCategory === 'Parent/Subtotal');
    const operationalAccounts = trialBalanceAccounts.filter(a => !isNonOperational(a));
    const nonOperationalExcludedCount = trialBalanceAccounts.length - operationalAccounts.length;

    const layer2 = { trialBalanceAccounts: operationalAccounts };
    const layer2Full = {
      trialBalanceAccounts: trialBalanceAccounts.map(a => ({ ...a, excludedFromOperationalPipeline: isNonOperational(a) })),
    };
    await saveJson(token, user.id, engagementId, 'layer2.json', layer2);
    await saveJson(token, user.id, engagementId, 'layer2_full.json', layer2Full);
    await saveJson(token, user.id, engagementId, 'tb_raw_source.json', tbRawSource);
    await saveJson(token, user.id, engagementId, 'tb_scope.json', { tbScope, recordedAt: new Date().toISOString() });

    const resultSummary = {
      zeroBalanceExcluded: tbRawSource.length - nonZeroRows.length,
      nonOperationalExcluded: nonOperationalExcludedCount,
      totalRows: tbRawSource.length,
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
