const { createClient } = require('@supabase/supabase-js');
const AdmZip = require('adm-zip');

const SURL = 'https://ghpjrvnyrlcqsfcjyiuq.supabase.co';
const SKEY = 'sb_publishable_WkOLENVn0HqysJetM6H6NA_tQe3Cn0n';

function repVars(text, vars) {
  let r = text;
  for (const [k, v] of Object.entries(vars)) {
    const sv = v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const tagStr = '<w:tag w:val="' + k + '"/>';
    let pos = 0;
    while (true) {
      const tagIdx = r.indexOf(tagStr, pos);
      if (tagIdx === -1) break;
      const sdtStart = r.lastIndexOf('<w:sdt', tagIdx);
      if (sdtStart === -1) { pos = tagIdx + 1; continue; }
      const sdtEnd = r.indexOf('</w:sdt>', tagIdx);
      if (sdtEnd === -1) { pos = tagIdx + 1; continue; }
      const sdtFull = r.substring(sdtStart, sdtEnd + 8);
      const scStart = sdtFull.indexOf('<w:sdtContent>');
      if (scStart === -1) { pos = tagIdx + 1; continue; }
      const scEnd = sdtFull.indexOf('</w:sdtContent>');
      if (scEnd === -1) { pos = tagIdx + 1; continue; }
      const sdtContent = sdtFull.substring(scStart, scEnd + 15);
      const wtStart = sdtContent.indexOf('<w:t');
      if (wtStart === -1) { pos = tagIdx + 1; continue; }
      const wtClose = sdtContent.indexOf('>', wtStart);
      if (wtClose === -1) { pos = tagIdx + 1; continue; }
      const wtEnd = sdtContent.indexOf('</w:t>', wtClose);
      if (wtEnd === -1) { pos = tagIdx + 1; continue; }
      const absWtStart = sdtStart + scStart + wtClose + 1;
      const absWtEnd = sdtStart + scStart + wtEnd;
      r = r.substring(0, absWtStart) + sv + r.substring(absWtEnd);
      pos = absWtStart + sv.length;
    }
  }
  return r;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { templateFile, vars } = JSON.parse(event.body);

    const sb = createClient(SURL, SKEY);
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
      const content = zip.readAsText(entry, 'utf8');
      const after = repVars(content, vars);
      if (xmlFile === 'word/document.xml') {
        const tagStr = '<w:tag w:val="' + Object.keys(vars)[0] + '"/>';
        const tagIdx = after.indexOf(tagStr);
        const sdtStart = after.lastIndexOf('<w:sdt', tagIdx);
        const sdtEnd = after.indexOf('</w:sdt>', tagIdx) + 8;
        console.log('BEFORE:', content.substring(sdtStart, sdtEnd));
        console.log('AFTER:', after.substring(sdtStart, sdtEnd));
      }
      zip.updateFile(xmlFile, Buffer.from(after, 'utf8'));
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
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
