const { createClient } = require('@supabase/supabase-js');
const AdmZip = require('adm-zip');

const SURL = 'https://ghpjrvnyrlcqsfcjyiuq.supabase.co';
const SKEY = 'sb_publishable_WkOLENVn0HqysJetM6H6NA_tQe3Cn0n';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { templateFile } = JSON.parse(event.body);

    const sb = createClient(SURL, SKEY);
    const { data, error } = await sb.storage.from('templates').download(templateFile);
    if (error) throw new Error('فشل تحميل القالب: ' + error.message);

    const buffer = Buffer.from(await data.arrayBuffer());
    const zip = new AdmZip(buffer);

    // TEST MODE: بدون أي تعديل XML
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
