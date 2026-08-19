const { createClient } = require('@supabase/supabase-js');
const AdmZip = require('adm-zip');
const { writeCells } = require('./lib/xlsx-cells');

const SURL = process.env.SUPABASE_URL;
const SKEY = process.env.SUPABASE_KEY;

const ALLOWED_TEMPLATES = new Set(['income-statement-analysis.xlsx']);
const TARGET_SHEET_NAME = 'تصنيف الميزان';

// نفس القوائم المعتمدة فعلياً داخل قوائم التحقق (data validation) بورقة "تصنيف الميزان"
// بالقالب الرسمي — أي قيمة خارج هذه القوائم تُرفض بدل ما تُكتب بصيغة تكسر قوائم الإكسل.
const MAIN_CODES = new Set(['CS', 'GE', 'SE', 'FIN', 'DEP', 'LOS', 'PROV', 'OTH']);
const LOCAL_CONTENT_NOTES = new Set([
  'القوى العاملة', 'السلع والخدمات', 'تطوير القدرات', 'الإستهلاك والإطفاء',
  'مصاريف حكومية', 'الزكاة وضريبة الدخل', 'مخصصات والمعاملات الغير نقدية',
  'مصاريف جمركية', 'خسائر تحويل العملة أو أي خسائر أخرى',
  'ملحق أ - 1', 'ملحق أ - 2', 'ملحق أ - 3', 'ملحق أ - 4'
]);
const LOCAL_CONTENT_ACCOUNTS = new Set([...LOCAL_CONTENT_NOTES, 'تكاليف غير مسموح بها']);

const NOTES_FIRST_ROW = 18, NOTES_MAX_ROWS = 100;     // صفوف 18–117
const ACCOUNTS_FIRST_ROW = 18, ACCOUNTS_MAX_ROWS = 1000; // صفوف 18–1017

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
    const { templateFile, notes, accounts } = JSON.parse(event.body || '{}');
    if (!ALLOWED_TEMPLATES.has(templateFile)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'قالب غير مسموح' }) };
    }
    if (!Array.isArray(notes) || !Array.isArray(accounts)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'بيانات غير مكتملة' }) };
    }

    const { data, error } = await sb.storage.from('templates').download(templateFile);
    if (error) throw new Error('فشل تحميل القالب: ' + error.message);

    const buffer = Buffer.from(await data.arrayBuffer());
    const zip = new AdmZip(buffer);

    const sheetFile = findSheetFile(zip, TARGET_SHEET_NAME);
    if (!sheetFile) throw new Error('تعذر إيجاد ورقة "' + TARGET_SHEET_NAME + '" داخل القالب');
    const entry = zip.getEntry(sheetFile);
    if (!entry) throw new Error('ورقة "' + TARGET_SHEET_NAME + '" غير موجودة داخل الأرشيف');
    const sheetXml = zip.readAsText(entry, 'utf8');

    const writesByRow = new Map();
    let truncatedNotes = 0, truncatedAccounts = 0, skippedNotes = 0, skippedAccounts = 0;

    const notesCapped = notes.slice(0, NOTES_MAX_ROWS);
    truncatedNotes = notes.length - notesCapped.length;
    notesCapped.forEach((n, i) => {
      const subItem = String(n.subItem || '').trim();
      const mainCode = String(n.mainCode || '').trim();
      if (!subItem || !MAIN_CODES.has(mainCode)) { skippedNotes++; return; }
      const row = NOTES_FIRST_ROW + i;
      const writes = [
        { col: 'F', type: 'str', value: subItem },
        { col: 'G', type: 'str', value: mainCode },
      ];
      if (n.total !== undefined && n.total !== null && n.total !== '') {
        writes.push({ col: 'H', type: 'n', value: n.total });
      }
      const localContent = String(n.localContent || '').trim();
      if (LOCAL_CONTENT_NOTES.has(localContent)) writes.push({ col: 'K', type: 'str', value: localContent });
      writesByRow.set(row, writes);
    });

    const accountsCapped = accounts.slice(0, ACCOUNTS_MAX_ROWS);
    truncatedAccounts = accounts.length - accountsCapped.length;
    accountsCapped.forEach((a, i) => {
      const name = String(a.name || '').trim();
      if (!name) { skippedAccounts++; return; }
      const row = ACCOUNTS_FIRST_ROW + i;
      const writes = writesByRow.get(row) || [];
      if (a.number !== undefined && a.number !== null && a.number !== '') {
        writes.push({ col: 'N', type: 'str', value: a.number });
      }
      writes.push({ col: 'O', type: 'str', value: name });
      if (a.total !== undefined && a.total !== null && a.total !== '') {
        writes.push({ col: 'P', type: 'n', value: a.total });
      }
      // تصنيف الحساب على البنود الرئيسة/الفرعية "كما في الميزان" — منقول حرفياً من ملف
      // ميزان المراجعة نفسه (لا قائمة تحقق مقيّدة له في القالب)، وليس تصنيفاً من الذكاء الاصطناعي
      const mainClassInFile = String(a.mainClassInFile || '').trim();
      if (mainClassInFile) writes.push({ col: 'Q', type: 'str', value: mainClassInFile });
      const subClassInFile = String(a.subClassInFile || '').trim();
      if (subClassInFile) writes.push({ col: 'R', type: 'str', value: subClassInFile });
      const linkSubItem = String(a.linkSubItem || '').trim();
      const linkMainCode = String(a.linkMainCode || '').trim();
      if (linkSubItem && MAIN_CODES.has(linkMainCode)) {
        writes.push({ col: 'S', type: 'str', value: linkSubItem + ' - ' + linkMainCode });
      }
      const localContent = String(a.localContent || '').trim();
      if (LOCAL_CONTENT_ACCOUNTS.has(localContent)) writes.push({ col: 'T', type: 'str', value: localContent });
      writesByRow.set(row, writes);
    });

    const newSheetXml = writeCells(sheetXml, writesByRow);
    zip.updateFile(sheetFile, Buffer.from(newSheetXml, 'utf8'));

    const outBuffer = zip.toBuffer();
    const path = 'income-analysis/' + user.id + '/' + Date.now() + '.xlsx';
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
        truncatedNotes, truncatedAccounts, skippedNotes, skippedAccounts,
      }),
    };
  } catch (err) {
    console.log('ERROR:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
