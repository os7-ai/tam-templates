// Layer 2 Reconciliation (Step B) — حسابي بحت، بلا أي استدعاء AI. يُطبَّق على مستوى
// subLine فقط (Note Amount من Layer 1 مقابل إجمالي حسابات Mapping Template المرتبطة
// به فعلياً)، بنفس نمط التصنيف الثابت المعتمد في computeReconciliation (Layer 4):
// Matched / Minor Rounding Difference / Material Variance حسب threshold خارجي، مع عدم
// إخفاء أي Variance فعلي أبداً — الـthreshold يُغيّر التصنيف/الحالة فقط لا القيمة المخزَّنة.
// لا يمسّ Layer 4 ولا يستبدله؛ هذا فحص مبكر على مستوى Layer 2 نفسه فقط.

function round2(n) {
  return (n === null || n === undefined) ? n : Math.round(n * 100) / 100;
}

function statusOf(variance, threshold) {
  if (variance === null || variance === undefined) return null;
  const a = Math.abs(variance);
  if (a === 0) return 'Matched';
  if (a <= threshold) return 'Minor Rounding Difference';
  return 'Material Variance';
}

// trialBalanceAccounts: كل حسابات Mapping Template بعد تطبيق نتيجة الـStep A (matchStatus
// لكل مجموعة مُطبَّقة على حساباتها) — بنفس شكل حقول layer2.json الكامل (غير المُصفّى).
function computeLayer2Reconciliation(layer1, trialBalanceAccounts, threshold) {
  const th = Number(threshold);

  const subLineMeta = [];
  for (const ml of layer1.mainLines) {
    for (const sl of (ml.subLines || [])) {
      subLineMeta.push({ mainLineName: ml.mainLineName, subLineId: sl.subLineId, subLineName: sl.subLineName, amountPerNote: sl.amount });
    }
  }

  const subLines = subLineMeta.map(meta => {
    const linkedAccounts = trialBalanceAccounts.filter(a => a.mappingStatus === 'Mapped' && a.mappedSubLineId === meta.subLineId);
    const trialBalanceLinkedAmount = linkedAccounts.length ? linkedAccounts.reduce((s, a) => s + Math.abs(a.amount), 0) : null;
    const variance = (trialBalanceLinkedAmount != null) ? round2(meta.amountPerNote - trialBalanceLinkedAmount) : null;
    const status = statusOf(variance, th);

    const unresolvedCandidateAccounts = trialBalanceAccounts.filter(a =>
      a.mappingStatus === 'Review Required'
      && Array.isArray(a.candidateSubLines)
      && a.candidateSubLines.some(c => c.subLineId === meta.subLineId));
    const unresolvedCandidateAmount = round2(unresolvedCandidateAccounts.reduce((s, a) => s + a.amount, 0));

    let varianceClassification = null;
    let hypotheticalResidualIfCandidatesLinked = null;
    if (status === 'Matched' || status === 'Minor Rounding Difference' || variance === null) {
      varianceClassification = status;
    } else if (unresolvedCandidateAmount === 0) {
      varianceClassification = 'Source Variance';
    } else {
      hypotheticalResidualIfCandidatesLinked = round2(variance - unresolvedCandidateAmount);
      varianceClassification = (Math.abs(hypotheticalResidualIfCandidatesLinked) <= th)
        ? 'Mapping Review'
        : 'Mixed (Mapping Review + Source Variance)';
    }

    return {
      mainLineName: meta.mainLineName,
      subLineId: meta.subLineId,
      subLineName: meta.subLineName,
      amountPerNote: meta.amountPerNote,
      trialBalanceLinkedAmount,
      linkedAccountsCount: linkedAccounts.length,
      variance,
      reconciliationStatus: status,
      unresolvedCandidateAccounts: unresolvedCandidateAccounts.map(a => ({
        accountNumber: a.accountNumber, accountName: a.accountName, amount: a.amount, mappingReason: a.mappingReason,
      })),
      unresolvedCandidateAmount,
      varianceClassification,
      hypotheticalResidualIfCandidatesLinked,
    };
  });

  const notesWithNoLinkedAccounts = subLines
    .filter(s => s.linkedAccountsCount === 0)
    .map(s => ({ subLineId: s.subLineId, subLineName: s.subLineName, mainLineName: s.mainLineName, amountPerNote: s.amountPerNote }));

  // أنماط الفروقات المتقابلة — Pairwise فقط (V1، بلا بحث تركيبي كامل)، ومقصور على
  // subLines المصنَّفة Material Variance فقط (الأصغر/المطابقة ليست موضع اهتمام هنا).
  // لا يُستخدم هذا لإلغاء عرض أي Variance فردي — كلاهما يبقى ظاهراً في subLines أعلاه.
  const materialSubLines = subLines.filter(s => s.reconciliationStatus === 'Material Variance' && s.variance !== null);
  const opposingVariancePatterns = [];
  for (let i = 0; i < materialSubLines.length; i++) {
    for (let j = i + 1; j < materialSubLines.length; j++) {
      const a = materialSubLines[i], b = materialSubLines[j];
      if (Math.sign(a.variance) !== 0 && Math.sign(a.variance) === -Math.sign(b.variance)) {
        const netResidual = round2(a.variance + b.variance);
        if (Math.abs(netResidual) <= th) {
          opposingVariancePatterns.push({
            subLineA: { subLineId: a.subLineId, subLineName: a.subLineName, mainLineName: a.mainLineName, variance: a.variance },
            subLineB: { subLineId: b.subLineId, subLineName: b.subLineName, mainLineName: b.mainLineName, variance: b.variance },
            netResidual,
          });
        }
      }
    }
  }

  return { subLines, notesWithNoLinkedAccounts, opposingVariancePatterns, thresholdUsed: th };
}

module.exports = { computeLayer2Reconciliation };
