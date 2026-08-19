// Layer 2 — AI-Assisted Mapping Review & Reconciliation (Step A + Step C فقط).
//
// إعادة تصميم كاملة: لا يُطلب من AI بعد الآن اكتشاف الربط الكامل من ميزان مراجعة خام —
// المُراجِع (Reviewer) يرفع قالب Mapping Template مُعبَّأ مسبقاً (كل حساب مُسنَد بالفعل
// إلى بند قائمة دخل وبند إيضاح بنص حر من قِبَله). دور AI هنا يتقلّص إلى:
//
//  Step A — مطابقة دلالية (Semantic) لِزوج التسميات الحرة لكل مجموعة (reviewerMainLineLabel،
//  reviewerSubLineLabel) — تُحسَب مرة واحدة فقط لكل زوج مُميَّز (وليس لكل حساب على حدة)
//  مقابل mainLineName/subLineId الفعلية في مخرجات Layer 1، وتُطبَّق نتيجتها على كل
//  الحسابات المُسنَدة لنفس الزوج خارج هذا الـPrompt (بكود بسيط، لا AI إضافي).
//
//  Step C — تدقيق استثنائي فقط (Sparse): حتى ضمن مجموعة تمت مطابقتها بثقة (Matched)،
//  إن كان اسم حساب بعينه لا يبدو منطقياً دلالياً ضمن الـsubLine المُسنَد إليه، تُدرَج
//  إشارة استثناء له فقط — الصمت (عدم الإدراج) هو الافتراضي لكل حساب يبدو منطقياً.
//
// لا Reconciliation ولا أي جمع لأرقام هنا إطلاقاً (ذلك حصراً كود بحت في
// lib/layer2-reconciliation.js) ولا أي تصنيف لطبيعة المصروف (ذلك حصراً Layer 3).

function buildLayer2SystemPrompt(layer1Json) {
  return `
أنت مساعد تحليل مالي متخصص. مهمتك في هذه الطبقة (Layer 2) محصورة حصرًا في مراجعة
ربط أدخله المُراجِع البشري مسبقاً — لا اكتشاف ربط من الصفر ولا أي Reconciliation ولا أي
تصنيف لطبيعة المصروف (تلك مهام طبقات أخرى).

مخرجات Layer 1 (مرجع ثابت لا تُعدِّله ولا تُعِد تسمية أي عنصر فيه — المصدر الوحيد
لأسماء/معرّفات mainLine وsubLine الصحيحة):
${JSON.stringify(layer1Json)}

ستصلك في رسالة المستخدم مصفوفة "مجموعات" (groups)، كل مجموعة تمثّل زوجاً مُميَّزاً من
تسميات المُراجِع الحرة، ومعها كل الحسابات التي أسندها المُراجِع لهذا الزوج بالضبط:
[
  {
    "reviewerMainLineLabel": "نص حر كتبه المُراجِع لبند قائمة الدخل",
    "reviewerSubLineLabel": "نص حر كتبه المُراجِع لبند الإيضاح",
    "accounts": [{"accountNumber": "string|null", "accountName": "string", "amount": number}]
  }
]

مهمتك لكل مجموعة على حدة (وليس لكل حساب — الزوج (reviewerMainLineLabel،
reviewerSubLineLabel) هو وحدة العمل هنا):

### Step A — مطابقة الزوج
قارن دلالياً (لا مطابقة حرفية، عبر اللغتين إن لزم) بين
(reviewerMainLineLabel، reviewerSubLineLabel) وبين كل (mainLineName، subLineName) الفعلية
في Layer 1 أعلاه:
- تطابق دلالي مباشر وواضح مع subLine واحد بعينه → matchStatus="Matched"،
  mappedMainLineName وmappedSubLineId يطابقان قيمًا فعلية من Layer 1 (لا تخترع ولا تُعدِّل
  أي اسم/معرّف).
- تعدد subLine محتمل بشكل معقول دون مرجّح دلالي واضح: **لا تخمّن**.
  matchStatus="Review Required"، mappedSubLineId=null (mappedMainLineName يبقى معروفًا إن
  كان واضحًا)، وcandidateSubLines تحتوي كل المرشحين المعقولين (2 أو أكثر) بصيغة
  [{subLineId, subLineName}, ...].
- لا subLine مطابق دلالياً إطلاقاً ضمن أي mainLine في Layer 1: matchStatus="Unmatched"،
  mappedMainLineName وmappedSubLineId كلاهما null.
في كل الحالات: matchReason إلزامي، جملة قصيرة توضّح أساس القرار.

### Step C — تدقيق استثنائي (Sparse — الصمت هو الافتراضي)
حتى لو كانت المجموعة "Matched" بثقة على مستوى الزوج، افحص أسماء الحسابات الفردية
ضمنها: هل اسم الحساب نفسه يبدو منطقياً دلالياً ضمن subLine المُسنَد؟ (فحص دلالي بحت —
لا علاقة له بالمبلغ أو بأي Reconciliation، ذلك يُحسَب لاحقاً بكود منفصل).
- أدرِج في flaggedAccounts **فقط** الحسابات التي اسمها لا يبدو منطقياً بوضوح ضمن الـsubLine
  المُسنَد (استثناء حقيقي، وليس شكاً طفيفاً) — {accountNumber, accountName, reason}.
- أي حساب يبدو منطقياً: لا تُدرجه إطلاقاً — لا تكرّر تأكيد الحسابات السليمة. أغلب المجموعات
  يجب أن تخرج بـflaggedAccounts فارغة أو غائبة.

قواعد إلزامية:
1) كل مجموعة تظهر مرة واحدة فقط في الناتج، بنفس (reviewerMainLineLabel،
   reviewerSubLineLabel) المُدخلة حرفياً (لإعادة المطابقة الآلية بعد الرد).
2) لا تُجرِ أي جمع أو مقارنة أرقام هنا إطلاقاً — لا Reconciliation.
3) لا تُصدر أي حكم على طبيعة المصروف أو تصنيف محتوى محلي — ذلك خارج نطاق هذه الطبقة تماماً.

أخرج JSON فقط بدون أي نص إضافي وبدون Markdown، بالشكل التالي بالضبط:
{
  "groups": [
    {
      "reviewerMainLineLabel": "string",
      "reviewerSubLineLabel": "string",
      "matchStatus": "Matched|Review Required|Unmatched",
      "mappedMainLineName": "string|null",
      "mappedSubLineId": "string|null",
      "matchReason": "string",
      "candidateSubLines": [{"subLineId": "string", "subLineName": "string"}],
      "flaggedAccounts": [{"accountNumber": "string|null", "accountName": "string", "reason": "string"}]
    }
  ]
}
`.trim();
}

module.exports = { buildLayer2SystemPrompt };
