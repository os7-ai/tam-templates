// Layer 3 — يستدعي Claude فعلياً لتصنيف طبيعة كل حساب (10 فئات ثابتة). يدعم وضعين:
//  - full (افتراضي): يصنّف كل trialBalanceAccounts في Layer 2 الحالي، ويحفظ layer3.json Baseline.
//  - targeted: يصنّف فقط accountNumbers المحدَّدة (بعد قرار مراجع يغيّر subLine حساب ما)
//    ويُرجع النتيجة للمُستدعي (reviewer-decide.js) ليدمجها هو في layer3_reviewed — لا
//    يكتب على layer3.json الأساس أبداً في هذا الوضع.
const { requireUser, requireApiKey } = require('./lib/auth');
const { callClaudeForJson } = require('./lib/claude-client');
const { buildLayer3SystemPrompt } = require('./lib/prompts/layer3-prompt');
const { saveJson, loadJson } = require('./lib/engagement-store');
const { logStage } = require('./lib/timing');

const BATCH_SIZE = 35;

async function classifyBatches(apiKey, layer1, layer2, accounts, engagementId, t0) {
  const batches = [];
  for (let i = 0; i < accounts.length; i += BATCH_SIZE) batches.push(accounts.slice(i, i + BATCH_SIZE));
  if (batches.length === 0) batches.push([]);
  logStage('layer3-classify', engagementId, 'claude_batches_start', t0, { batchCount: batches.length, batchSize: BATCH_SIZE });
  const system = buildLayer3SystemPrompt(layer1, { trialBalanceAccounts: accounts });
  let classifiedAccounts = [];
  for (let bi = 0; bi < batches.length; bi++) {
    logStage('layer3-classify', engagementId, 'batch_start', t0, { batchIndex: bi, batchCount: batches.length, batchRows: batches[bi].length });
    const messages = [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(batches[bi]) }] }];
    const json = await callClaudeForJson({ apiKey, system, messages, maxTokens: 8000 });
    logStage('layer3-classify', engagementId, 'batch_end', t0, { batchIndex: bi, batchCount: batches.length });
    if (!Array.isArray(json.classifiedAccounts)) throw new Error('رد Layer 3 لا يحتوي classifiedAccounts بالشكل المتوقع');
    classifiedAccounts = classifiedAccounts.concat(json.classifiedAccounts);
  }
  logStage('layer3-classify', engagementId, 'claude_batches_end', t0);
  return classifiedAccounts;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const { sb, user, errorResponse } = await requireUser(event);
  if (errorResponse) return errorResponse;
  const { apiKey, errorResponse: keyErr } = requireApiKey();
  if (keyErr) return keyErr;

  const t0 = Date.now();
  let engagementId;
  try {
    const body = JSON.parse(event.body || '{}');
    const { mode, accountNumbers, layer2Override } = body;
    engagementId = body.engagementId;
    logStage('layer3-classify', engagementId, 'start', t0, { mode: mode || 'full' });

    const layer1 = await loadJson(sb, user.id, engagementId, 'layer1.json');
    const layer2 = layer2Override || await loadJson(sb, user.id, engagementId, 'layer2.json');
    if (!layer1 || !layer2) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Layer 1/2 غير متوفرين لهذا الـEngagement' }) };
    }

    if (mode === 'targeted') {
      if (!Array.isArray(accountNumbers) || accountNumbers.length === 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'accountNumbers مطلوبة في الوضع المُستهدف' }) };
      }
      const nums = new Set(accountNumbers.map(String));
      const targetAccounts = layer2.trialBalanceAccounts.filter(a => nums.has(String(a.accountNumber)));
      const classified = await classifyBatches(apiKey, layer1, layer2, targetAccounts, engagementId, t0);
      logStage('layer3-classify', engagementId, 'end', t0);
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ classifiedAccounts: classified }) };
    }

    // الوضع الكامل — يُنتج Baseline جديد فقط عند أول تشغيل لهذا الـEngagement
    const classifiedAccounts = await classifyBatches(apiKey, layer1, layer2, layer2.trialBalanceAccounts, engagementId, t0);
    const layer3 = { classifiedAccounts };
    await saveJson(sb, user.id, engagementId, 'layer3.json', layer3);
    logStage('layer3-classify', engagementId, 'end', t0);
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(layer3) };
  } catch (err) {
    logStage('layer3-classify', engagementId, 'error', t0, { message: err.message });
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
