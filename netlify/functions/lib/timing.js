// أداة تشخيصية مؤقتة فقط — لتحديد مصدر ومدة الـ504 قبل اتخاذ أي قرار حل. لا تُغيّر أي
// سلوك أو منطق أو تقسيم نداءات، مجرد سطر console.log بنيوي عند بداية/نهاية كل مرحلة —
// يظهر في سجلات Netlify Functions (Deploys → الـdeploy المعني → Function log).
function logStage(functionName, engagementId, stage, t0, extra) {
  console.log(JSON.stringify({
    tag: '[timing]',
    fn: functionName,
    engagementId: engagementId || null,
    stage,
    elapsedMs: t0 != null ? (Date.now() - t0) : null,
    at: new Date().toISOString(),
    ...(extra || {}),
  }));
}
module.exports = { logStage };
