// Layer 2 — Zero Balance Filter (كود بحت) ثم استدعاء Claude فعلياً لربط الحسابات
// غير الصفرية بمخرجات Layer 1. يحفظ tb_raw_source (Audit Trail الكامل) وlayer2.json
// (Baseline التشغيلي، بلا حسابات صفرية) بشكل منفصل تماماً.
const { requireUser, requireApiKey } = require('./lib/auth');
const { callClaudeForJson } = require('./lib/claude-client');
const { buildLayer2SystemPrompt } = require('./lib/prompts/layer2-prompt');
const { saveJson, loadJson } = require('./lib/engagement-store');

const BATCH_SIZE = 35;

function isZero(amount) {
  const n = Number(amount);
  return !Number.isFinite(n) || n === 0;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const { sb, user, errorResponse } = await requireUser(event);
  if (errorResponse) return errorResponse;
  const { apiKey, errorResponse: keyErr } = requireApiKey();
  if (keyErr) return keyErr;

  try {
    const body = JSON.parse(event.body || '{}');
    const { engagementId, tbRows, tbScope } = body; // tbRows: [{accountNumber, accountName, amount, clientMainClassification?, clientSubClassification?}]
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

    // ---------- Zero Balance Filter (قبل Layer 2 — نفس القاعدة المعتمدة) ----------
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
        outOfScopeReason: zero ? ['Zero Balance'] : null, // أي أسباب أخرى (BS/Parent-Subtotal) تُحدَّد لاحقاً من Layer 2 لغير الصفري فقط
      });
      if (!zero) nonZeroRows.push(r);
    }

    const batches = [];
    for (let i = 0; i < nonZeroRows.length; i += BATCH_SIZE) batches.push(nonZeroRows.slice(i, i + BATCH_SIZE));
    if (batches.length === 0) batches.push([]);

    const system = buildLayer2SystemPrompt(layer1);
    let trialBalanceAccounts = [];
    for (const batch of batches) {
      const messages = [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(batch) }] }];
      const json = await callClaudeForJson({ apiKey, system, messages, maxTokens: 8000 });
      if (!Array.isArray(json.trialBalanceAccounts)) throw new Error('رد Layer 2 لا يحتوي trialBalanceAccounts بالشكل المتوقع');
      trialBalanceAccounts = trialBalanceAccounts.concat(json.trialBalanceAccounts);
    }

    const layer2 = { trialBalanceAccounts };
    await saveJson(sb, user.id, engagementId, 'layer2.json', layer2);
    await saveJson(sb, user.id, engagementId, 'tb_raw_source.json', tbRawSource);
    await saveJson(sb, user.id, engagementId, 'tb_scope.json', { tbScope, recordedAt: new Date().toISOString() });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        layer2,
        zeroBalanceExcluded: tbRawSource.length - nonZeroRows.length,
        totalRows: tbRawSource.length,
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
