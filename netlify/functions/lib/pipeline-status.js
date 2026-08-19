// حالة الـPipeline (Layer 1-4) لكل Engagement — metadata ومراجع فقط، بلا أي حمولة ثقيلة
// (لا صور Base64 ولا مصفوفات حسابات) حتى يبقى الاستطلاع (Polling) من الواجهة خفيفاً
// وسريعاً دائماً بصرف النظر عن حجم المدخلات. المدخلات الفعلية تُحفظ بملفات منفصلة تحت
// inputs/ عبر engagement-store.js، وهذا الملف يحمل فقط مرجع/رقم إشارة إليها ضمنياً
// (كل مرحلة تعرف مسار لقطتها الخاصة بها بنفسها).
const { saveJson, loadJson } = require('./engagement-store');
const crypto = require('crypto');

const STAGES = ['layer1', 'layer2', 'layer3', 'layer4'];

function emptyStatus() {
  const stages = {};
  for (const s of STAGES) stages[s] = { status: 'pending', attempt: 0 };
  return { stages, updatedAt: null };
}

async function getPipelineStatus(sb, userId, engagementId) {
  const existing = await loadJson(sb, userId, engagementId, 'pipeline_status.json');
  return existing || emptyStatus();
}

// يحاول "حجز" مرحلة قبل بدء العمل الثقيل عليها — حماية من التنفيذ المزدوج قدر الإمكان
// (قراءة-ثم-كتابة على Supabase Storage، وليس قفلاً ذرّياً حقيقياً؛ يغلق الغالبية العظمى
// من حالات النقر المزدوج/إعادة المحاولة المتزامنة، كما اتُّفق عليه صراحة كحل كافٍ الآن).
async function claimStage(sb, userId, engagementId, stage) {
  const pipelineStatus = await getPipelineStatus(sb, userId, engagementId);
  const current = pipelineStatus.stages[stage] || { status: 'pending', attempt: 0 };
  if (current.status === 'running') {
    return { claimed: false, pipelineStatus };
  }
  const attemptId = crypto.randomUUID();
  pipelineStatus.stages[stage] = {
    status: 'running',
    attempt: (current.attempt || 0) + 1,
    attemptId,
    startedAt: new Date().toISOString(),
    endedAt: null,
    error: null,
    result: current.result || null,
    progress: null,
  };
  pipelineStatus.updatedAt = new Date().toISOString();
  await saveJson(sb, userId, engagementId, 'pipeline_status.json', pipelineStatus);
  return { claimed: true, pipelineStatus, attemptId };
}

async function finishStage(sb, userId, engagementId, stage, patch) {
  const pipelineStatus = await getPipelineStatus(sb, userId, engagementId);
  pipelineStatus.stages[stage] = {
    ...pipelineStatus.stages[stage],
    ...patch,
    endedAt: new Date().toISOString(),
  };
  pipelineStatus.updatedAt = new Date().toISOString();
  await saveJson(sb, userId, engagementId, 'pipeline_status.json', pipelineStatus);
  return pipelineStatus;
}

async function updateStageProgress(sb, userId, engagementId, stage, progress) {
  const pipelineStatus = await getPipelineStatus(sb, userId, engagementId);
  if (!pipelineStatus.stages[stage]) pipelineStatus.stages[stage] = { status: 'running', attempt: 1 };
  pipelineStatus.stages[stage].progress = progress;
  pipelineStatus.updatedAt = new Date().toISOString();
  await saveJson(sb, userId, engagementId, 'pipeline_status.json', pipelineStatus);
}

module.exports = { STAGES, emptyStatus, getPipelineStatus, claimStage, finishStage, updateStageProgress };
