// Layer 2 — Zero Balance Filter (كود بحت) ثم استدعاء Claude فعلياً لربط الحسابات
// غير الصفرية بمخرجات Layer 1. يحفظ tb_raw_source (Audit Trail الكامل) وlayer2.json
// (Baseline التشغيلي) بشكل منفصل تماماً.
//
// تعريف "Operational Layer 2" (ثابت، غير مشروط بـtbScope — بقرار صريح لاحق يُلغي
// الربط السابق بين الاستبعاد واختيار الـtbScope): يقتصر layer2.json التشغيلي على
// حسابات غير صفرية، حسابات فعلية فقط (وليس Parent/Subtotal)، وداخل نطاق قائمة الدخل.
// أي حساب داخل النطاق يبقى Mapped/Review Required/Unmapped(No Matching SubLine) —
// كلها تبقى في Layer 2 كما هي، فقط سبباً "Unmapped" الناتج عن كونه خارج النطاق أصلاً
// (Balance Sheet/إيراد خارج النطاق/زكاة) أو Parent/Subtotal يُستبعدان من التشغيلي.
// tbScope يبقى مُدخلاً إلزامياً ويُسجَّل في tb_scope.json (سياق تدقيق عن محتوى الملف
// المرفوع نفسه) لكنه لا يُغيّر هذا الاستبعاد بعد الآن. السجل الكامل غير المُصفّى (كل ما
// أعادته Layer 2 فعلاً) يُحفظ دائماً كاملاً في layer2_full.json للتدقيق — لا فقدان بيانات.
const { requireUser, requireApiKey } = require('./lib/auth');
const { callClaudeForJson } = require('./lib/claude-client');
const { buildLayer2SystemPrompt } = require('./lib/prompts/layer2-prompt');
const { saveJson, loadJson, extractToken } = require('./lib/engagement-store');
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
    const { tbRows, tbScope } = body; // tbRows: [{accountNumber, accountName, amount, clientMainClassification?, clientSubClassification?}]
    engagementId = body.engagementId;
    logStage('layer2-map', engagementId, 'start', t0, { tbRows: (tbRows || []).length, tbScope });
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
    logStage('layer2-map', engagementId, 'claude_batches_start', t0, { batchCount: batches.length, batchSize: BATCH_SIZE });

    const system = buildLayer2SystemPrompt(layer1);
    let trialBalanceAccounts = [];
    for (let bi = 0; bi < batches.length; bi++) {
      logStage('layer2-map', engagementId, 'batch_start', t0, { batchIndex: bi, batchCount: batches.length, batchRows: batches[bi].length });
      const messages = [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(batches[bi]) }] }];
      const json = await callClaudeForJson({ apiKey, system, messages, maxTokens: 8000 });
      logStage('layer2-map', engagementId, 'batch_end', t0, { batchIndex: bi, batchCount: batches.length });
      if (!Array.isArray(json.trialBalanceAccounts)) throw new Error('رد Layer 2 لا يحتوي trialBalanceAccounts بالشكل المتوقع');
      trialBalanceAccounts = trialBalanceAccounts.concat(json.trialBalanceAccounts);
    }
    logStage('layer2-map', engagementId, 'claude_batches_end', t0);

    // ---------- استبعاد ثابت من التشغيلي (بعد تصنيف Layer 2 الدلالي الكامل) ----------
    // غير مشروط بـtbScope إطلاقاً — ينطبق دائماً بغض النظر عن اختيار المراجع.
    const isNonOperational = (a) => a.mappingStatus === 'Unmapped'
      && (a.unmappedReasonCategory === 'Out of Income Statement Scope' || a.unmappedReasonCategory === 'Parent/Subtotal');
    const operationalAccounts = trialBalanceAccounts.filter(a => !isNonOperational(a));
    const nonOperationalExcludedCount = trialBalanceAccounts.length - operationalAccounts.length;

    const layer2 = { trialBalanceAccounts: operationalAccounts };
    const layer2Full = {
      trialBalanceAccounts: trialBalanceAccounts.map(a => ({
        ...a,
        excludedFromOperationalPipeline: isNonOperational(a),
      })),
    };
    await saveJson(token, user.id, engagementId, 'layer2.json', layer2);
    await saveJson(token, user.id, engagementId, 'layer2_full.json', layer2Full);
    await saveJson(token, user.id, engagementId, 'tb_raw_source.json', tbRawSource);
    await saveJson(token, user.id, engagementId, 'tb_scope.json', { tbScope, recordedAt: new Date().toISOString() });
    logStage('layer2-map', engagementId, 'end', t0);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        layer2,
        zeroBalanceExcluded: tbRawSource.length - nonZeroRows.length,
        nonOperationalExcluded: nonOperationalExcludedCount,
        totalRows: tbRawSource.length,
      }),
    };
  } catch (err) {
    logStage('layer2-map', engagementId, 'error', t0, { message: err.message });
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
