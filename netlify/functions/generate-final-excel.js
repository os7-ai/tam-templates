// Layer 5 — يستهلك مخرجات الطبقات السابقة لِـEngagement معيّن (يُفضّل الأدلة
// المُراجَعة _reviewed إن وُجدت، وإلا يقع على Baseline) ويكتبها في القالب الرسمي عبر
// populateTemplate() (كود بحت، بلا AI)، ثم يرفع الملف الناتج ويُعيد رابطاً موقّعاً —
// نفس نمط generate-income-analysis.js (Phase 1) لكن بمصدر بيانات الطبقات الخمس الجديد.
const AdmZip = require('adm-zip');
const { requireUser } = require('./lib/auth');
const { populateTemplate } = require('./lib/layer5-populate');
const { loadJson } = require('./lib/engagement-store');

const ALLOWED_TEMPLATES = new Set(['income-statement-analysis.xlsx']);
const TARGET_SHEET_NAME = 'تصنيف الميزان';

function findSheetFile(zip, sheetName) {
  const wbXml = zip.readAsText('xl/workbook.xml', 'utf8');
  const relsXml = zip.readAsText('xl/_rels/workbook.xml.rels', 'utf8');
  const sheetRe = /<sheet\b[^>]*\bname="([^"]+)"[^>]*\br:id="([^"]+)"/g;
  let m, rid = null;
  while ((m = sheetRe.exec(wbXml)) !== null) {
    if (m[1] === sheetName) { rid = m[2]; break; }
  }
  if (!rid) return null;
  const relRe = new RegExp('Id="' + rid + '"[^>]*Target="([^"]+)"');
  const relMatch = relsXml.match(relRe);
  if (!relMatch) return null;
  return 'xl/' + relMatch[1].replace(/^\/?xl\//, '');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const { sb, user, errorResponse } = await requireUser(event);
  if (errorResponse) return errorResponse;

  try {
    const body = JSON.parse(event.body || '{}');
    const { engagementId, templateFile } = body;
    if (!engagementId) return { statusCode: 400, body: JSON.stringify({ error: 'engagementId مطلوب' }) };
    const tf = templateFile || 'income-statement-analysis.xlsx';
    if (!ALLOWED_TEMPLATES.has(tf)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'قالب غير مسموح' }) };
    }

    const layer1 = await loadJson(sb, user.id, engagementId, 'layer1.json');
    // الأولوية لِـ_reviewed (بعد قرارات المراجع) إن وُجد، وإلا Baseline — كلاهما بنفس
    // الشكل تماماً (مُشتق من applySubLineDecisions/mergeLayer3Reevaluation)، فلا فرق
    // في طريقة الاستهلاك هنا.
    const layer2Reviewed = await loadJson(sb, user.id, engagementId, 'layer2_reviewed.json');
    const layer3Reviewed = await loadJson(sb, user.id, engagementId, 'layer3_reviewed.json');
    const layer2 = layer2Reviewed || (await loadJson(sb, user.id, engagementId, 'layer2.json'));
    const layer3 = layer3Reviewed || (await loadJson(sb, user.id, engagementId, 'layer3.json'));
    const reviewerDecisions = (await loadJson(sb, user.id, engagementId, 'reviewerDecisions.json'))
      || { subLineDecisions: {}, mainLineCodeDecisions: {} };

    if (!layer1 || !layer2 || !layer3) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Layer 1/2/3 غير مكتملين لهذا الـEngagement — شغّل التحليل أولاً' }) };
    }

    const { data, error } = await sb.storage.from('templates').download(tf);
    if (error) throw new Error('فشل تحميل القالب: ' + error.message);

    const buffer = Buffer.from(await data.arrayBuffer());
    const zip = new AdmZip(buffer);

    const sheetFile = findSheetFile(zip, TARGET_SHEET_NAME);
    if (!sheetFile) throw new Error('تعذر إيجاد ورقة "' + TARGET_SHEET_NAME + '" داخل القالب');
    const entry = zip.getEntry(sheetFile);
    if (!entry) throw new Error('ورقة "' + TARGET_SHEET_NAME + '" غير موجودة داخل الأرشيف');
    const sheetXml = zip.readAsText(entry, 'utf8');

    const result = populateTemplate(sheetXml, layer1, layer2, layer3, reviewerDecisions);
    zip.updateFile(sheetFile, Buffer.from(result.sheetXml, 'utf8'));

    const outBuffer = zip.toBuffer();
    const path = 'income-analysis/' + user.id + '/' + engagementId + '/' + Date.now() + '.xlsx';
    const { error: upErr } = await sb.storage.from('generated').upload(path, outBuffer, {
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      upsert: false,
    });
    if (upErr) throw new Error('فشل رفع الملف الناتج: ' + upErr.message);

    const { data: signed, error: signErr } = await sb.storage.from('generated').createSignedUrl(path, 300);
    if (signErr) throw new Error('فشل إنشاء رابط التحميل: ' + signErr.message);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: signed.signedUrl,
        unmappedMainLines: result.unmappedMainLines,
        truncatedNotes: result.truncatedNotes,
        truncatedAccounts: result.truncatedAccounts,
        notesRowsUsed: result.notesRowsUsed,
        accountsRowsUsed: result.accountsRowsUsed,
        usedReviewedData: {
          layer2Reviewed: !!layer2Reviewed,
          layer3Reviewed: !!layer3Reviewed,
        },
      }),
    };
  } catch (err) {
    console.log('ERROR:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
