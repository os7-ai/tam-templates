// أداة مشتركة: كتابة قيم خام داخل خلايا محددة (رقم/نص) في ورقة إكسل موجودة،
// عبر تعديل XML مباشرة بدون لمس أي صيغة (formula) أو تنسيق أو خلية أخرى في الملف.
// مبنية لتُستخدم على ملفات قوالب رسمية ضخمة (مئات آلاف الصفوف/الصيغ) حيث تحميلها
// وإعادة حفظها بمكتبة إكسل عامة قد يُفسد صيغًا أو تحققًا من البيانات (data validation).

function escXml(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function colToIdx(col) {
  let n = 0;
  for (let i = 0; i < col.length; i++) n = n * 26 + (col.charCodeAt(i) - 64);
  return n;
}

function buildCellXml(ref, col, write) {
  const styleAttr = write.styleIdx != null ? ` s="${write.styleIdx}"` : '';
  if (write.type === 'n') {
    const num = Number(write.value);
    if (!Number.isFinite(num)) return null;
    return `<c r="${ref}"${styleAttr}><v>${num}</v></c>`;
  }
  const text = write.value == null ? '' : String(write.value);
  return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${escXml(text)}</t></is></c>`;
}

// يعيد بناء صف واحد بدمج الخلايا الجديدة مع الخلايا الموجودة (الصيغ) دون المساس بها،
// مرتّبة حسب ترتيب الأعمدة كما يتطلب معيار OOXML.
function mergeRow(rowXml, rowNum, writes) {
  const openTagMatch = rowXml.match(/^<row\b[^>]*>/);
  const openTag = openTagMatch ? openTagMatch[0] : `<row r="${rowNum}">`;
  const isSelfClosing = /\/>$/.test(openTag);
  const inner = isSelfClosing ? '' : rowXml.slice(openTag.length, rowXml.length - '</row>'.length);

  const cells = [];
  const cellRe = /<c\b[^>]*\br="([A-Z]+)\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g;
  let m;
  while ((m = cellRe.exec(inner)) !== null) {
    cells.push({ col: m[1], xml: m[0] });
  }

  for (const w of writes) {
    const ref = w.col + rowNum;
    let styleIdx = null;
    const existingIdx = cells.findIndex(c => c.col === w.col);
    if (existingIdx !== -1) {
      const sMatch = cells[existingIdx].xml.match(/\ss="(\d+)"/);
      if (sMatch) styleIdx = sMatch[1];
    }
    const cellXml = buildCellXml(ref, w.col, { ...w, styleIdx });
    if (cellXml == null) continue;
    if (existingIdx !== -1) {
      cells[existingIdx] = { col: w.col, xml: cellXml };
    } else {
      cells.push({ col: w.col, xml: cellXml });
    }
  }

  cells.sort((a, b) => colToIdx(a.col) - colToIdx(b.col));

  const openTagFixed = isSelfClosing ? openTag.replace(/\/>$/, '>') : openTag;
  return openTagFixed + cells.map(c => c.xml).join('') + '</row>';
}

/**
 * writesByRow: Map<number, Array<{col:'F', type:'str'|'n', value}>>
 * يعدّل sheetXml في المكان ويعيد النص الجديد الكامل للورقة.
 * أي صف مطلوب غير موجود أصلاً في sheetData يُنشأ من جديد ويُدرَج بترتيبه الرقمي الصحيح.
 */
function writeCells(sheetXml, writesByRow) {
  const sdOpenIdx = sheetXml.indexOf('<sheetData');
  const sdOpenEnd = sheetXml.indexOf('>', sdOpenIdx) + 1;
  const sdCloseIdx = sheetXml.indexOf('</sheetData>');
  if (sdOpenIdx === -1 || sdCloseIdx === -1) throw new Error('sheetData غير موجود في الورقة');

  const before = sheetXml.slice(0, sdOpenEnd);
  const sheetDataInner = sheetXml.slice(sdOpenEnd, sdCloseIdx);
  const after = sheetXml.slice(sdCloseIdx);

  const rowRe = /<row\b[^>]*\br="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g;
  const rowsFound = new Map(); // rowNum -> {start, end, xml}
  let m;
  while ((m = rowRe.exec(sheetDataInner)) !== null) {
    rowsFound.set(Number(m[1]), { start: m.index, end: m.index + m[0].length, xml: m[0] });
  }

  const targetRows = [...writesByRow.keys()].sort((a, b) => a - b);
  const missingRows = targetRows.filter(r => !rowsFound.has(r));

  // نبني نص الصفوف الجديدة مباشرة عبر استبدال المدى الأصلي لكل صف موجود بنسخته المدمجة،
  // ثم إدراج أي صفوف غير موجودة في موضعها الرقمي الصحيح بين الصفوف المجاورة.
  const allRowNums = new Set([...rowsFound.keys(), ...missingRows]);
  const sortedRowNums = [...allRowNums].sort((a, b) => a - b);

  const chunks = [];
  let cursor = 0;
  for (const rn of sortedRowNums) {
    const writes = writesByRow.get(rn);
    if (rowsFound.has(rn)) {
      const info = rowsFound.get(rn);
      chunks.push(sheetDataInner.slice(cursor, info.start));
      chunks.push(writes ? mergeRow(info.xml, rn, writes) : info.xml);
      cursor = info.end;
    } else if (writes) {
      // صف مفقود بالكامل: ندرجه كصف جديد فارغ ثم نملؤه — يُحقن قبل أقرب صف موجود لاحق له
      const newRowXml = mergeRow(`<row r="${rn}"></row>`, rn, writes);
      // يُدرج عند موضع المؤشر الحالي (بعد آخر صف تمت معالجته وقبل أي نص تالٍ)
      chunks.push(newRowXml);
    }
  }
  chunks.push(sheetDataInner.slice(cursor));

  return before + chunks.join('') + after;
}

module.exports = { writeCells, escXml };
