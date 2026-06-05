const { createClient } = require('@supabase/supabase-js');
const ExcelJS = require('exceljs');

const SURL = process.env.SUPABASE_URL;
const SKEY = process.env.SUPABASE_KEY;

const ALLOWED = new Set(['invoice-request.xlsx']);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  if (!SURL || !SKEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error' }) };
  }
  try {
    const { templateFile, vars } = JSON.parse(event.body);
    if (!ALLOWED.has(templateFile)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'قالب غير مسموح' }) };
    }

    const sb = createClient(SURL, SKEY);
    const { data, error } = await sb.storage.from('templates').download(templateFile);
    if (error) throw new Error('فشل تحميل القالب: ' + error.message);

    const buffer = Buffer.from(await data.arrayBuffer());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    // Replace {{variable_name}} placeholders in all sheets
    workbook.eachSheet((sheet) => {
      sheet.eachRow((row) => {
        row.eachCell({ includeEmpty: false }, (cell) => {
          if (cell.type !== ExcelJS.ValueType.String) return;
          const m = String(cell.value).trim().match(/^\{\{(\w+)\}\}$/);
          if (!m) return;
          const key = m[1];
          if (key in vars) cell.value = vars[key];
        });
      });
    });

    const outBuffer = await workbook.xlsx.writeBuffer();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment',
      },
      body: Buffer.from(outBuffer).toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.log('ERROR:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
