// المهمة الفعلية لـLayer 3 (Background Function، وضع full فقط). نفس منطق الدفعات في
// layer3-classify.js حرفياً — حجم الدفعة 35 دون تغيير، نفس buildLayer3SystemPrompt —
// فقط بتحديث تقدّم كل دفعة في pipeline_status.json.
const { requireUser, requireApiKey } = require('./lib/auth');
const { callClaudeForJson } = require('./lib/claude-client');
const { buildLayer3SystemPrompt } = require('./lib/prompts/layer3-prompt');
const { saveJson, loadJson, extractToken } = require('./lib/engagement-store');
const { finishStage, updateStageProgress } = require('./lib/pipeline-status');
const { logStage } = require('./lib/timing');

const BATCH_SIZE = 35;

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

    const layer1 = await loadJson(token, user.id, engagementId, 'layer1.json');
    const layer2 = await loadJson(token, user.id, engagementId, 'layer2.json');
    if (!layer1 || !layer2) throw new Error('Layer 1/2 غير متوفرين لهذا الـEngagement');

    logStage('layer3-classify-background', engagementId, 'start', t0, { mode: 'full' });

    const accounts = layer2.trialBalanceAccounts;
    const batches = [];
    for (let i = 0; i < accounts.length; i += BATCH_SIZE) batches.push(accounts.slice(i, i + BATCH_SIZE));
    if (batches.length === 0) batches.push([]);
    logStage('layer3-classify-background', engagementId, 'claude_batches_start', t0, { batchCount: batches.length, batchSize: BATCH_SIZE });

    const system = buildLayer3SystemPrompt(layer1, { trialBalanceAccounts: accounts });
    let classifiedAccounts = [];
    for (let bi = 0; bi < batches.length; bi++) {
      await updateStageProgress(token, user.id, engagementId, 'layer3', { batchIndex: bi, batchCount: batches.length });
      logStage('layer3-classify-background', engagementId, 'batch_start', t0, { batchIndex: bi, batchCount: batches.length, batchRows: batches[bi].length });
      const messages = [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(batches[bi]) }] }];
      const json = await callClaudeForJson({ apiKey, system, messages, maxTokens: 16000 });
      logStage('layer3-classify-background', engagementId, 'batch_end', t0, { batchIndex: bi, batchCount: batches.length });
      if (!Array.isArray(json.classifiedAccounts)) throw new Error('رد Layer 3 لا يحتوي classifiedAccounts بالشكل المتوقع');
      classifiedAccounts = classifiedAccounts.concat(json.classifiedAccounts);
    }
    await updateStageProgress(token, user.id, engagementId, 'layer3', { batchIndex: batches.length, batchCount: batches.length });
    logStage('layer3-classify-background', engagementId, 'claude_batches_end', t0);

    const layer3 = { classifiedAccounts };
    await saveJson(token, user.id, engagementId, 'layer3.json', layer3);
    await finishStage(token, user.id, engagementId, 'layer3', { status: 'done', error: null, result: { classifiedCount: classifiedAccounts.length } });
    logStage('layer3-classify-background', engagementId, 'end', t0);

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(layer3) };
  } catch (err) {
    logStage('layer3-classify-background', engagementId, 'error', t0, { message: err.message });
    if (engagementId) await finishStage(token, user.id, engagementId, 'layer3', { status: 'error', error: err.message }).catch(() => {});
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
