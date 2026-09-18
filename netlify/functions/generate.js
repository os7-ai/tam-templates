const { createClient } = require('@supabase/supabase-js');
const AdmZip = require('adm-zip');

const SURL = process.env.SUPABASE_URL;
const SKEY = process.env.SUPABASE_KEY;

const ALLOWED_TEMPLATES = new Set([
  'entity-engagement.docx',
  'contract-engagement.docx',
  'confirmation-letter.docx',
  'confirmation-letter-contract.docx',
  'work-completion-certificate.docx',
]);

function escXml(v) {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// يحذف صف الجدول بالكامل (وليس فقط تفريغ خلاياه) عندما لا يُستخدم — لشهادة إنجاز الأعمال، الصفوف 2 و3 اختيارية
// ملاحظة: البحث عن بداية الصف لازم يتأكد إنه <w:tr فعلاً (وليس <w:trPr> أو أي عنصر آخر يبدأ بنفس الحروف)
function lastRowOpenIndex(xml, beforeIdx) {
  const re = /<w:tr(?=[\s>])/g;
  let m, last = -1;
  while ((m = re.exec(xml)) !== null && m.index < beforeIdx) {
    last = m.index;
  }
  return last;
}
function removeTableRow(xml, tag) {
  const tagStr = '<w:tag w:val="' + tag + '"/>';
  const tagIdx = xml.indexOf(tagStr);
  if (tagIdx === -1) return xml;
  const trStart = lastRowOpenIndex(xml, tagIdx);
  if (trStart === -1) return xml;
  const trEndTagIdx = xml.indexOf('</w:tr>', tagIdx);
  if (trEndTagIdx === -1) return xml;
  const trEnd = trEndTagIdx + '</w:tr>'.length;
  return xml.substring(0, trStart) + xml.substring(trEnd);
}

function removeEmptyWccRows(xml, vars) {
  let r = xml;
  for (let i = 2; i <= 3; i++) {
    if (!vars['Description_' + i] && !vars['Quantity_' + i] && !vars['Taxable_Amount_' + i]) {
      r = removeTableRow(r, 'Description_' + i);
    }
  }
  return r;
}

function repVars(text, vars) {
  let r = text;
  for (const [k, v] of Object.entries(vars)) {
    const sv = escXml(v);
    const tagStr = '<w:tag w:val="' + k + '"/>';
    let pos = 0;
    while (true) {
      const tagIdx = r.indexOf(tagStr, pos);
      if (tagIdx === -1) break;
      const sdtStart = r.lastIndexOf('<w:sdt>', tagIdx);
      if (sdtStart === -1) { pos = tagIdx + 1; continue; }
      const sdtEnd = r.indexOf('</w:sdt>', tagIdx);
      if (sdtEnd === -1) { pos = tagIdx + 1; continue; }
      const sdtFull = r.substring(sdtStart, sdtEnd + 8);
      const scStart = sdtFull.indexOf('<w:sdtContent>');
      if (scStart === -1) { pos = tagIdx + 1; continue; }
      const scEnd = sdtFull.indexOf('</w:sdtContent>');
      if (scEnd === -1) { pos = tagIdx + 1; continue; }
      // نستبدل sdtContent بالكامل بتشغيلة واحدة، لأن وورد أحياناً يقسّم نص العنصر النائب على عدة <w:r>
      // (بسبب التدقيق الإملائي) — والاستبدال الجزئي كان يترك بقايا النص الأصلي (مثل "No"/"Number") ظاهرة
      const oldContent = sdtFull.substring(scStart, scEnd + 15);
      const innerContent = sdtFull.substring(scStart + 14, scEnd);
      const rprStart = innerContent.indexOf('<w:rPr>');
      const rprEnd = innerContent.indexOf('</w:rPr>');
      const rpr = rprStart !== -1 && rprEnd !== -1 ? innerContent.substring(rprStart, rprEnd + 8) : '';
      const newContent = '<w:sdtContent><w:r>' + rpr + '<w:t xml:space="preserve">' + sv + '</w:t></w:r></w:sdtContent>';
      const replaceAt = sdtStart + sdtFull.indexOf(oldContent);
      r = r.substring(0, replaceAt) + newContent + r.substring(replaceAt + oldContent.length);
      pos = replaceAt + newContent.length;
    }
  }
  return r;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  if (!SURL || !SKEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  const token = (event.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  const sb = createClient(SURL, SKEY);
  const { data: { user }, error: authError } = await sb.auth.getUser(token);
  if (authError || !user) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const { templateFile, vars } = JSON.parse(event.body);

    if (!ALLOWED_TEMPLATES.has(templateFile)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'قالب غير مسموح' }) };
    }
    const { data, error } = await sb.storage.from('templates').download(templateFile);
    if (error) throw new Error('فشل تحميل القالب: ' + error.message);

    const buffer = Buffer.from(await data.arrayBuffer());
    const zip = new AdmZip(buffer);

    const xmlFiles = [
      'word/document.xml',
      'word/header1.xml',
      'word/footer1.xml',
      'word/header2.xml',
      'word/footer2.xml'
    ];

    for (const xmlFile of xmlFiles) {
      const entry = zip.getEntry(xmlFile);
      if (!entry) continue;
      let content = zip.readAsText(entry, 'utf8');
      if (templateFile === 'work-completion-certificate.docx') {
        content = removeEmptyWccRows(content, vars);
      }
      zip.updateFile(xmlFile, Buffer.from(repVars(content, vars), 'utf8'));
    }

    const result = zip.toBuffer();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': 'attachment',
      },
      body: result.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.log('ERROR:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
