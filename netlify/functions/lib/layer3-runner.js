// منطق استدعاء Claude لتصنيف مجموعة حسابات عبر Layer 3 Prompt، بالدفعات — مُشترك بين
// layer3-classify.js (تشغيل كامل) وreviewer-decide.js (Targeted Re-evaluation بعد
// قرار مراجع)، لضمان استخدام نفس الـPrompt والمنطق حرفياً في كل مكان.
const { callClaudeForJson } = require('./claude-client');
const { buildLayer3SystemPrompt } = require('./prompts/layer3-prompt');

const BATCH_SIZE = 35;

async function classifyAccounts(apiKey, layer1, layer2, accounts) {
  const batches = [];
  for (let i = 0; i < accounts.length; i += BATCH_SIZE) batches.push(accounts.slice(i, i + BATCH_SIZE));
  if (batches.length === 0) return [];
  const system = buildLayer3SystemPrompt(layer1, { trialBalanceAccounts: accounts });
  let classifiedAccounts = [];
  for (const batch of batches) {
    const messages = [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(batch) }] }];
    const json = await callClaudeForJson({ apiKey, system, messages, maxTokens: 8000 });
    if (!Array.isArray(json.classifiedAccounts)) throw new Error('رد Layer 3 لا يحتوي classifiedAccounts بالشكل المتوقع');
    classifiedAccounts = classifiedAccounts.concat(json.classifiedAccounts);
  }
  return classifiedAccounts;
}

module.exports = { classifyAccounts };
