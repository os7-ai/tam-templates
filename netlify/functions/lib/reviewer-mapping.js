// Reviewer Mapping — بيانات وقرار بشري فقط، بين Layer 4 وLayer 5. لا يحتوي أي Decision
// Logic خاص بتصنيف طبيعة المصروف (ذلك يبقى حصراً في Layer 3/AI) ولا أي قاعدة مطابقة
// أكواد جديدة (ذلك يبقى حصراً في MAIN_LINE_CODE_MAP بموافقة صريحة مسبقة).
//
// المبدأ: layer1/2/3/4.json (Baseline) لا تُعدَّل أبداً هنا. كل ما تنتجه هذه الوحدة هو
// كيانات "_reviewed" مُشتقة بالكامل من (Baseline + reviewerDecisions) في كل استدعاء —
// لا حالة داخلية تُخزَّن، فلا يمكن أن "تتقادم" عن مدخلاتها.

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ---------- القائمة الأولى: SubLine Mapping Review Queue ----------
function buildSubLineReviewQueue(layer2) {
  return layer2.trialBalanceAccounts
    .filter(a => a.mappingStatus === 'Review Required'
      && a.mappedMainLineName
      && Array.isArray(a.candidateSubLines)
      && a.candidateSubLines.length > 0)
    .map(a => ({
      accountNumber: a.accountNumber,
      accountName: a.accountName,
      amount: a.amount,
      mainLineName: a.mappedMainLineName,
      aiCandidateSubLines: a.candidateSubLines,
      reasonForReview: a.mappingReason,
    }));
}

// ---------- القائمة الثانية: Main Line Code Mapping Review Queue ----------
function buildMainLineCodeReviewQueue(layer1, mainLineCodeMap) {
  return layer1.mainLines
    .filter(ml => !mainLineCodeMap[ml.mainLineName])
    .map(ml => ({
      mainLineName: ml.mainLineName,
      totalPerIncomeStatement: ml.totalPerIncomeStatement,
    }));
}

// ---------- فحص سياق القرارات المخزَّنة مقابل الـBaseline الحالي ----------
// يعيد نسخة مُعلَّمة بحالة كل قرار: Resolved | NotResolved | Orphaned | ContextChanged
// لا يُعدِّل reviewerDecisions نفسه ولا الـBaseline.
function checkDecisionContext(reviewerDecisions, layer1, layer2) {
  const accountsByNumber = new Map(layer2.trialBalanceAccounts.map(a => [String(a.accountNumber), a]));
  const mainLineNames = new Set(layer1.mainLines.map(ml => ml.mainLineName));

  const subLineDecisions = {};
  for (const [accNum, decision] of Object.entries(reviewerDecisions.subLineDecisions || {})) {
    const current = accountsByNumber.get(String(accNum));
    if (!current) {
      subLineDecisions[accNum] = { ...decision, contextStatus: 'Orphaned' };
      continue;
    }
    const currentIds = (current.candidateSubLines || []).map(c => c.subLineId).sort().join(',');
    const snapshotIds = (decision.candidateSubLinesSnapshot || []).map(c => c.subLineId).sort().join(',');
    if (currentIds !== snapshotIds) {
      subLineDecisions[accNum] = { ...decision, contextStatus: 'ContextChanged' };
      continue;
    }
    subLineDecisions[accNum] = { ...decision, contextStatus: decision.status };
  }

  const mainLineCodeDecisions = {};
  for (const [name, decision] of Object.entries(reviewerDecisions.mainLineCodeDecisions || {})) {
    mainLineCodeDecisions[name] = mainLineNames.has(name)
      ? { ...decision, contextStatus: decision.status }
      : { ...decision, contextStatus: 'Orphaned' };
  }

  return { subLineDecisions, mainLineCodeDecisions };
}

// ---------- تطبيق قرارات SubLine المحسومة على نسخة من Layer 2 ----------
// يعيد layer2Reviewed (نسخة كاملة، متطابقة حرفياً مع الـBaseline إلا للحسابات المتأثرة)
// و changedAccounts: قائمة الحسابات التي تغيّر ربطها فعلياً (لتُغذّي Targeted Re-evaluation).
function applySubLineDecisions(layer2Baseline, checkedDecisions) {
  const layer2Reviewed = deepClone(layer2Baseline);
  const changedAccounts = [];

  for (const acc of layer2Reviewed.trialBalanceAccounts) {
    const d = checkedDecisions.subLineDecisions[String(acc.accountNumber)];
    if (!d || d.contextStatus !== 'Resolved' || !d.chosenSubLineId) continue;

    const oldSubLineId = acc.mappedSubLineId;
    if (oldSubLineId !== d.chosenSubLineId) {
      changedAccounts.push({
        accountNumber: acc.accountNumber,
        accountName: acc.accountName,
        mainLineName: acc.mappedMainLineName,
        oldSubLineId,
        newSubLineId: d.chosenSubLineId,
      });
    }
    acc.mappedSubLineId = d.chosenSubLineId;
    acc.mappingStatus = 'Mapped';
    acc.mappingReason = null;
    acc.mappingBasis = `Resolved by reviewer decision (decidedAt=${d.decidedAt || 'n/a'}); ` + (acc.mappingBasis || '');
  }

  return { layer2Reviewed, changedAccounts };
}

// ---------- دمج نتائج Targeted Re-evaluation (Layer 3) ----------
// reevaluatedResults تُزوَّد من خارج هذه الوحدة (نداء AI حقيقي لـLayer 3 Prompt، مُقيَّد
// بالحسابات المتأثرة فقط) — هذه الوحدة لا تحتوي أي Decision Logic بذاتها، فقط دمج نتيجة
// جاهزة في نسخة من الـBaseline.
function mergeLayer3Reevaluation(layer3Baseline, reevaluatedResults) {
  const layer3Reviewed = deepClone(layer3Baseline);
  const byNumber = new Map(reevaluatedResults.map(r => [String(r.accountNumber), r]));

  for (const acc of layer3Reviewed.classifiedAccounts) {
    const r = byNumber.get(String(acc.accountNumber));
    if (!r) continue;
    acc.mappedSubLineId = r.mappedSubLineId;
    acc.layer1PreliminaryClassification = r.layer1PreliminaryClassification;
    acc.finalLocalContentClassification = r.finalLocalContentClassification;
    acc.confidence = r.confidence;
    acc.reviewRequired = r.reviewRequired;
    acc.reviewReason = r.reviewReason;
    acc.classificationBasis = r.classificationBasis;
  }

  return layer3Reviewed;
}

// ---------- Targeted Reconciliation (Layer 4) ----------
// نفس صيغ الحساب الحسابية البحتة المعتمدة في Layer 4 (لا منطق جديد)، تُعاد كاملة على
// layer2Reviewed/layer3Reviewed. بما أن الحساب حتمي (deterministic)، فإن أي subLine/
// mainLine غير متأثر يُعيد إنتاج نفس قيم الـBaseline تماماً — لا حاجة لـpatch يدوي؛
// نتحقق من ذلك صريحاً عبر diffAgainstBaseline أدناه لأغراض الشفافية والـAudit.
function computeReconciliation(layer1, layer2Reviewed, layer3Reviewed, threshold) {
  const statusOf = (variance) => {
    if (variance === null || variance === undefined) return null;
    const a = Math.abs(variance);
    if (a === 0) return 'Matched';
    if (a <= threshold) return 'Minor Rounding Difference';
    return 'Material Variance';
  };

  const round2 = (n) => Math.round(n * 100) / 100;

  const mainLines = layer1.mainLines.map(ml => {
    const tbAccs = layer3Reviewed.classifiedAccounts.filter(a => a.mappedMainLineName === ml.mainLineName);
    const trialBalanceTotal = tbAccs.length ? -tbAccs.reduce((s, a) => s + Math.abs(a.amount), 0) : null;

    const isVsNotesVar = ml.variance; // منقول من Layer 1 كما هو، لا يُعاد حسابه
    const notesVsTBVar = (ml.subLinesTotal != null && trialBalanceTotal != null)
      ? round2(ml.subLinesTotal - trialBalanceTotal) : null;
    const isVsTBVar = (trialBalanceTotal != null)
      ? round2(ml.totalPerIncomeStatement - trialBalanceTotal) : null;

    const subLines = (ml.subLines || []).map(sl => {
      const subAccs = layer3Reviewed.classifiedAccounts.filter(a => a.mappedSubLineId === sl.subLineId);
      const tbLinked = subAccs.length ? -subAccs.reduce((s, a) => s + Math.abs(a.amount), 0) : null;
      const variance = (tbLinked != null) ? round2(sl.amount - tbLinked) : null;

      // مرشحون غير محسومين (Review Required) لهذا subLine تحديداً، لأغراض تشخيصية فقط
      const candidates = layer2Reviewed.trialBalanceAccounts.filter(a =>
        a.mappingStatus === 'Review Required'
        && Array.isArray(a.candidateSubLines)
        && a.candidateSubLines.some(c => c.subLineId === sl.subLineId));
      const candidateAmount = round2(candidates.reduce((s, a) => s + a.amount, 0));

      let varianceClassification = null;
      let hypotheticalResidual = null;
      const status = statusOf(variance);
      if (status === 'Matched' || status === 'Minor Rounding Difference' || variance === null) {
        varianceClassification = status;
      } else if (candidateAmount === 0) {
        varianceClassification = 'Source Variance';
      } else {
        hypotheticalResidual = round2(variance + candidateAmount);
        varianceClassification = (Math.abs(hypotheticalResidual) <= threshold)
          ? 'Mapping Review'
          : 'Mixed (Mapping Review + Source Variance)';
      }

      return {
        subLineId: sl.subLineId, subLineName: sl.subLineName, amountPerNote: sl.amount,
        trialBalanceLinkedAmount: tbLinked, variance, reconciliationStatus: status,
        unresolvedCandidateAccounts: candidates.map(c => ({
          accountNumber: c.accountNumber, accountName: c.accountName, amount: c.amount,
          layer2MappingReason: c.mappingReason,
        })),
        unresolvedCandidateAmount: candidateAmount,
        varianceClassification,
        hypotheticalResidualIfCandidatesLinked: hypotheticalResidual,
      };
    });

    return {
      mainLineName: ml.mainLineName,
      totalPerIncomeStatement: ml.totalPerIncomeStatement,
      subLinesTotal: ml.subLinesTotal,
      trialBalanceTotal,
      incomeStatementVsNotes: { variance: isVsNotesVar, reconciliationStatus: statusOf(isVsNotesVar) },
      notesVsTrialBalance: { variance: notesVsTBVar, reconciliationStatus: statusOf(notesVsTBVar) },
      incomeStatementVsTrialBalance: { variance: isVsTBVar, reconciliationStatus: statusOf(isVsTBVar) },
      subLines,
    };
  });

  return { mainLines };
}

// يقارن reconciliation جديد بـLayer 4 baseline، يعيد فقط أسماء subLines/mainLines التي
// اختلفت فعلياً — للتحقق الصريح من أن غير المتأثر يبقى مطابقاً حرفياً، وللعرض على المستخدم.
function diffAgainstBaseline(reconciliationNew, layer4Baseline) {
  const changed = [];
  const baseByName = new Map(layer4Baseline.reconciliation.mainLines.map(m => [m.mainLineName, m]));
  for (const m of reconciliationNew.mainLines) {
    const base = baseByName.get(m.mainLineName);
    if (!base) { changed.push({ level: 'mainLine', name: m.mainLineName, reason: 'new' }); continue; }
    const baseSubByName = new Map(base.subLines.map(s => [s.subLineId, s]));
    const round2 = (n) => (n === null || n === undefined) ? n : Math.round(n * 100) / 100;
    for (const s of m.subLines) {
      const baseS = baseSubByName.get(s.subLineId);
      if (!baseS || round2(baseS.variance) !== round2(s.variance)
        || round2(baseS.trialBalanceLinkedAmount) !== round2(s.trialBalanceLinkedAmount)) {
        changed.push({
          level: 'subLine', mainLineName: m.mainLineName, subLineId: s.subLineId, subLineName: s.subLineName,
          before: baseS ? { variance: baseS.variance, trialBalanceLinkedAmount: baseS.trialBalanceLinkedAmount } : null,
          after: { variance: s.variance, trialBalanceLinkedAmount: s.trialBalanceLinkedAmount },
        });
      }
    }
  }
  return changed;
}

module.exports = {
  buildSubLineReviewQueue,
  buildMainLineCodeReviewQueue,
  checkDecisionContext,
  applySubLineDecisions,
  mergeLayer3Reevaluation,
  computeReconciliation,
  diffAgainstBaseline,
};
