const { createClient } = require('@supabase/supabase-js');
const AdmZip = require('adm-zip');

const SURL = process.env.SUPABASE_URL;
const SKEY = process.env.SUPABASE_KEY;

const ALLOWED = new Set(['invoice-request.xlsx']);

function escXml(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
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
    if (!ALLOWED.has(templateFile)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'قالب غير مسموح' }) };
    }

    const { data, error } = await sb.storage.from('templates').download(templateFile);
    if (error) throw new Error('فشل تحميل القالب: ' + error.message);

    const buffer = Buffer.from(await data.arrayBuffer());
    const zip = new AdmZip(buffer);

    // Replace {{variable}} placeholders in shared strings (covers all text cells)
    const ssEntry = zip.getEntry('xl/sharedStrings.xml');
    if (ssEntry) {
      let xml = zip.readAsText(ssEntry, 'utf8');
      for (const [key, val] of Object.entries(vars)) {
        xml = xml.split('{{' + key + '}}').join(escXml(String(val)));
      }
      zip.updateFile('xl/sharedStrings.xml', Buffer.from(xml, 'utf8'));
    }

    // Also replace in worksheets (covers inline strings)
    zip.getEntries()
      .filter(e => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.entryName))
      .forEach(entry => {
        let xml = zip.readAsText(entry, 'utf8');
        let changed = false;
        for (const [key, val] of Object.entries(vars)) {
          const ph = '{{' + key + '}}';
          if (xml.includes(ph)) {
            xml = xml.split(ph).join(escXml(String(val)));
            changed = true;
          }
        }
        if (changed) zip.updateFile(entry.entryName, Buffer.from(xml, 'utf8'));
      });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment',
      },
      body: zip.toBuffer().toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.log('ERROR:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
