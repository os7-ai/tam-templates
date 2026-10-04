// نقطة البدء المتزامنة لـLayer 2 (سريعة، أقل من ثانية): تحقق + حجز المرحلة (Idempotency)
// + حفظ لقطة المدخلات (rows من Mapping Template وreconciliationThreshold) في Storage،
// ثم تُرجع فوراً. لا تستدعي layer2-map-background داخلياً إطلاقاً — نفس السبب المثبت عملياً
// في layer1-start.js (الانتظار الداخلي لاستجابة دالة خلفية كاملة يصطدم بسقف التنفيذ
// المتزامن ~30 ثانية ويُنتج 504 حتى لو أكملت الدالة الخلفية عملها فعلياً). الواجهة (لا هذه
// الدالة) هي من تُطلق layer2-map-background مباشرة بعد نجاح هذا الاستدعاء، دون انتظار
// اكتمالها — راجع income-analysis-v2.html.
const { requireUser, requireApiKey } = require('./lib/auth');
const { saveJson, loadJson, extractToken } = require('./lib/engagement-store');
const { claimStage } = require('./lib/pipeline-status');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const { user, errorResponse } = await requireUser(event);
  if (errorResponse) return errorResponse;
  const { errorResponse: keyErr } = requireApiKey(); // تحقق إعداد فقط؛ المفتاح نفسه يُستخدم داخل الدالة الخلفية
  if (keyErr) return keyErr;
  const token = extractToken(event);

  try {
    const body = JSON.parse(event.body || '{}');
    const { engagementId, rows, reconciliationThreshold } = body;
    if (!engagementId || !Array.isArray(rows) || rows.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'engagementId وrows (Mapping Template) مطلوبة' }) };
    }
    if (reconciliationThreshold === undefined || reconciliationThreshold === null) {
      return { statusCode: 400, body: JSON.stringify({ error: 'reconciliationThreshold مطلوب — لا يُخترع من الخادم.' }) };
    }
    for (const r of rows) {
      if (!r.accountName || r.amount === undefined || r.amount === null || !r.reviewerMainLineLabel || !r.reviewerSubLineLabel) {
        return { statusCode: 400, body: JSON.stringify({ error: 'كل صف يجب أن يحتوي accountName وamount وreviewerMainLineLabel وreviewerSubLineLabel' }) };
      }
    }

    const layer1 = await loadJson(token, user.id, engagementId, 'layer1.json');
    if (!layer1) {
      return { statusCode: 400, body: JSON.stringify({ error: 'لم يُشغَّل Layer 1 لهذا الـEngagement بعد' }) };
    }

    const { claimed } = await claimStage(token, user.id, engagementId, 'layer2');
    if (!claimed) {
      return { statusCode: 409, body: JSON.stringify({ error: 'Layer 2 قيد التنفيذ بالفعل لهذا الـEngagement' }) };
    }

    await saveJson(token, user.id, engagementId, 'inputs/layer2_mapping_template.json', { rows, reconciliationThreshold: Number(reconciliationThreshold) });

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ claimed: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
