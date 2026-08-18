// Layer 5 — Template Population (code-only, no AI).
// يأخذ مخرجات Layer 1 (استخراج القائمة والإيضاحات) وLayer 2 (ربط الميزان) وLayer 3
// (تصنيف طبيعة المصروف) كمصدر بيانات وحيد، ويكتبها في ورقة "تصنيف الميزان" داخل
// القالب الرسمي عبر حقن خلايا جراحي فقط (xlsx-cells.js) — لا صيغ ولا تنسيق ولا
// صفوف/أعمدة تُضاف أو تُحذف، ولا اجتهاد: كل قرار هنا إما منقول حرفياً من الطبقات
// 1-3 أو ثابت مُعتمد صراحة (جدول الأكواد الرئيسية).

const { writeCells } = require('./xlsx-cells');

// Mapping ثابت معتمد من المستخدم — لا يُستنتج آلياً بأي شكل.
// المفتاح هو نص mainLineName كما يصدر فعلياً من Layer 1 (وليس بالضرورة نفس الصياغة
// الحرفية التي وردت في نقاش التصميم؛ إن اختلفت تسمية عميل جديد عن هذه القائمة
// فسيظهر ضمن unmappedMainLines بدل تخمين كودها).
const MAIN_LINE_CODE_MAP = {
  'تكلفة المبيعات': 'CS',
  'المصروفات العمومية والإدارية': 'GE',
  'مصروف ما قبل التشغيل': 'OTH',
  'تكلفة التمويل': 'FIN',
  'إهلاك': 'DEP',
  'خسائر': 'LOS',
  'مخصصات': 'PROV',
  'المصروفات الأخرى': 'OTH',
};

const MAIN_TABLE_ROW = { CS: 7, GE: 8, SE: 9, FIN: 10, DEP: 11, LOS: 12, PROV: 13, OTH: 14 };

// نفس ترجمة الفئات العشر المعتمدة في Layer 3 إلى القيم العربية الفعلية في قوائم
// التحقق (K/T) بالقالب — لا ترجمة آلية، تطابق حرفي مسبق الاعتماد.
const CLASSIFICATION_AR = {
  'Labor': 'القوى العاملة',
  'Goods & Services': 'السلع والخدمات',
  'Capacity Building': 'تطوير القدرات',
  'Depreciation & Amortization': 'الإستهلاك والإطفاء',
  'Government Fees': 'مصاريف حكومية',
  'Zakat / Taxes': 'الزكاة وضريبة الدخل',
  'Customs': 'مصاريف جمركية',
  'Provisions / Impairment': 'مخصصات والمعاملات الغير نقدية',
  'Non-cash Losses': 'خسائر تحويل العملة أو أي خسائر أخرى',
  'Excluded Costs': 'تكاليف غير مسموح بها',
};

const NOTES_FIRST_ROW = 18, NOTES_MAX_ROWS = 100;        // صفوف 18–117 (118 محجوز ثابتًا)
const ACCOUNTS_FIRST_ROW = 18, ACCOUNTS_MAX_ROWS = 1000; // صفوف 18–1017

function norm(s) {
  return String(s == null ? '' : s).replace(/ /g, ' ').trim();
}
function dKey(subOrMainName, code) {
  return norm(subOrMainName) + ' - ' + norm(code);
}

// يقرأ القيم الحالية الموجودة فعلاً في عمود واحد ضمن مدى صفوف — يُستخدم لإيجاد
// رقم حساب موجود مسبقاً (upsert) أو أول صف فارغ، دون الاعتماد على ترتيب الكتابة.
// يقرأ inlineStr/رقم مباشرة؛ خلية بنوع shared-string (t="s") تُعتبر "مشغولة" بلا
// قراءة قيمتها الفعلية (نادر الحدوث لأن هذه الخلايا مُعدّة كإدخال فارغ أصلاً).
function readColumnValues(sheetXml, col, firstRow, lastRow) {
  const sdOpenIdx = sheetXml.indexOf('<sheetData');
  const sdCloseIdx = sheetXml.indexOf('</sheetData>');
  const sheetDataInner = sheetXml.slice(sdOpenIdx, sdCloseIdx);
  const rowRe = /<row\b[^>]*\br="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g;
  const values = new Map(); // rowNum -> {text, occupied}
  let m;
  while ((m = rowRe.exec(sheetDataInner)) !== null) {
    const rowNum = Number(m[1]);
    if (rowNum < firstRow || rowNum > lastRow) continue;
    const rowXml = m[0];
    const cellRe = new RegExp('<c\\b[^>]*\\br="' + col + rowNum + '"[^>]*?(?:/>|>([\\s\\S]*?)</c>)');
    const cm = rowXml.match(cellRe);
    if (!cm) continue;
    const cellXmlFull = cm[0];
    const typeMatch = cellXmlFull.match(/\st="([^"]+)"/);
    const type = typeMatch ? typeMatch[1] : 'n';
    let text = null;
    if (type === 'inlineStr') {
      const tMatch = cellXmlFull.match(/<t[^>]*>([\s\S]*?)<\/t>/);
      text = tMatch ? tMatch[1]
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'").replace(/&amp;/g, '&') : '';
    } else if (type === 'n' || !typeMatch) {
      const vMatch = cellXmlFull.match(/<v>([\s\S]*?)<\/v>/);
      text = vMatch ? vMatch[1] : null;
    }
    if (cm[1] !== undefined || /\/>$/.test(cellXmlFull)) {
      values.set(rowNum, { text, occupied: true });
    }
  }
  return values;
}

/**
 * populateTemplate
 * @param {string} sheetXml - نص XML الحالي لورقة "تصنيف الميزان" كما هو في القالب/آخر تشغيل.
 * @param {object} layer1 - مخرجات Layer 1 كاملة { mainLines: [...] }.
 * @param {object} layer2 - مخرجات Layer 2 كاملة { trialBalanceAccounts: [...] }.
 * @param {object} layer3 - مخرجات Layer 3 كاملة { classifiedAccounts: [...] }.
 * @returns {{ sheetXml: string, unmappedMainLines: string[], truncatedNotes: number,
 *             truncatedAccounts: number, notesRowsUsed: number, accountsRowsUsed: number }}
 */
function populateTemplate(sheetXml, layer1, layer2, layer3) {
  const writesByRow = new Map();
  const unmappedMainLines = [];

  // ---------- المرحلة 1: تخصيص الأكواد الرئيسية + تجميع G7:G14 ----------
  const codeTotals = {}; // code -> sum(totalPerIncomeStatement)
  const mainLineCode = new Map(); // mainLineName -> code

  for (const ml of layer1.mainLines) {
    const code = MAIN_LINE_CODE_MAP[ml.mainLineName];
    if (!code) { unmappedMainLines.push(ml.mainLineName); continue; }
    mainLineCode.set(ml.mainLineName, code);
    codeTotals[code] = (codeTotals[code] || 0) + Number(ml.totalPerIncomeStatement || 0);
  }
  for (const [code, total] of Object.entries(codeTotals)) {
    const row = MAIN_TABLE_ROW[code];
    if (!row) continue;
    const w = writesByRow.get(row) || [];
    // كل مبالغ المصروفات تُكتب بإشارة موجبة في القالب (طلب صريح) — القيمة الأصلية
    // في Layer 1 تبقى سالبة كما هي، هذا تطبيع عرض داخل Layer 5 فقط. الصيغ القائمة
    // (H7=SUMIFS(...)، I7=G7-H7، I3=H3-G2) تبقى متوافقة لأنها تفترض أصلاً مصروفات
    // موجبة لحساب صافي الربح = الإيرادات - المصروفات.
    w.push({ col: 'G', type: 'n', value: Math.abs(total) });
    writesByRow.set(row, w);
  }

  // ---------- المرحلة 2: بناء جدول الإيضاحات (صفوف 18-117) ----------
  // subLineRowKey: subLineId -> dKey (لاستخدامه لاحقاً في S)
  // mainOnlyRowKey: mainLineName -> dKey (للصف التمثيلي عند غياب الإيضاح)
  const subLineRowKey = new Map();
  const mainOnlyRowKey = new Map();
  let notesRow = NOTES_FIRST_ROW;
  let truncatedNotes = 0;

  for (const ml of layer1.mainLines) {
    const code = mainLineCode.get(ml.mainLineName);
    if (!code) continue; // mainLine غير مُخصَّص لكود — لا يُكتب، ظهر في unmappedMainLines

    if (Array.isArray(ml.subLines) && ml.subLines.length > 0) {
      for (const sl of ml.subLines) {
        if (notesRow > NOTES_FIRST_ROW + NOTES_MAX_ROWS - 1) { truncatedNotes++; continue; }
        const w = [
          { col: 'F', type: 'str', value: sl.subLineName },
          { col: 'G', type: 'str', value: code },
        ];
        if (sl.amount !== undefined && sl.amount !== null) {
          w.push({ col: 'H', type: 'n', value: Math.abs(Number(sl.amount)) });
        }
        const arClass = sl.preliminaryLocalContentClassification
          ? CLASSIFICATION_AR[sl.preliminaryLocalContentClassification]
          : null;
        if (arClass) w.push({ col: 'K', type: 'str', value: arClass });
        writesByRow.set(notesRow, w);
        subLineRowKey.set(sl.subLineId, dKey(sl.subLineName, code));
        notesRow++;
      }
    } else {
      // noteStatus = "Not Found" (أو أي حالة بلا subLines فعلية) — صف تمثيلي واحد
      // يحمل بيانات Layer 1 نفسها (اسم البند + إجماليه) فقط لإتاحة الربط بعمود S،
      // وليس اختراعاً لإيضاح غير موجود (K تبقى فارغة عمداً).
      if (notesRow > NOTES_FIRST_ROW + NOTES_MAX_ROWS - 1) { truncatedNotes++; continue; }
      const w = [
        { col: 'F', type: 'str', value: ml.mainLineName },
        { col: 'G', type: 'str', value: code },
      ];
      if (ml.totalPerIncomeStatement !== undefined && ml.totalPerIncomeStatement !== null) {
        w.push({ col: 'H', type: 'n', value: Math.abs(Number(ml.totalPerIncomeStatement)) });
      }
      writesByRow.set(notesRow, w);
      mainOnlyRowKey.set(ml.mainLineName, dKey(ml.mainLineName, code));
      notesRow++;
    }
  }
  const notesRowsUsed = notesRow - NOTES_FIRST_ROW;

  // ---------- المرحلة 3: upsert لصفوف الحسابات بمفتاح accountNumber ----------
  const existingN = readColumnValues(sheetXml, 'N', ACCOUNTS_FIRST_ROW, ACCOUNTS_FIRST_ROW + ACCOUNTS_MAX_ROWS - 1);
  const accountRowByNumber = new Map(); // accountNumber(string) -> row
  const occupiedRows = new Set();
  for (const [row, info] of existingN.entries()) {
    if (info.occupied && info.text !== null && info.text !== '') {
      accountRowByNumber.set(norm(info.text), row);
      occupiedRows.add(row);
    }
  }
  let nextFreeRow = ACCOUNTS_FIRST_ROW;
  function allocateRow(accountNumberKey) {
    if (accountNumberKey && accountRowByNumber.has(accountNumberKey)) {
      return accountRowByNumber.get(accountNumberKey);
    }
    while (occupiedRows.has(nextFreeRow) || writesByRow.has(nextFreeRow) && writesByRow.get(nextFreeRow).some(w => w.col === 'N')) {
      nextFreeRow++;
    }
    const row = nextFreeRow;
    occupiedRows.add(row);
    if (accountNumberKey) accountRowByNumber.set(accountNumberKey, row);
    nextFreeRow++;
    return row;
  }

  // فهرسة Layer 3 حسب accountNumber لسحب التصنيف النهائي أثناء المرور على Layer 2.
  const l3ByAccount = new Map();
  for (const a of (layer3.classifiedAccounts || [])) {
    l3ByAccount.set(norm(a.accountNumber), a);
  }

  let truncatedAccounts = 0;
  let accountsRowsUsed = 0;
  const accounts = layer2.trialBalanceAccounts || [];

  for (const acc of accounts) {
    // نطاق الجدول النهائي: فقط الحسابات المرتبطة فعلياً ببند من قائمة الدخل (عبر
    // subLine حقيقي أو mainLine بلا إيضاح). حسابات Unmapped (ميزانية عمومية/إيراد/
    // بعد الزكاة) لا تُكتب في جدول الحسابات إطلاقاً — تبقى فقط في مخرجات Layer 2/4
    // كسجل تدقيق داخلي (Audit Trail)، دون أي صف مقابل لها في القالب النهائي.
    let sValue = null;
    if (acc.mappedSubLineId && subLineRowKey.has(acc.mappedSubLineId)) {
      sValue = subLineRowKey.get(acc.mappedSubLineId);
    } else if (acc.mappedMainLineName && mainOnlyRowKey.has(acc.mappedMainLineName)) {
      sValue = mainOnlyRowKey.get(acc.mappedMainLineName);
    } else {
      continue; // خارج نطاق قائمة الدخل — لا يُكتب.
    }

    if (accountsRowsUsed >= ACCOUNTS_MAX_ROWS && !accountRowByNumber.has(norm(acc.accountNumber))) {
      truncatedAccounts++;
      continue;
    }
    const key = norm(acc.accountNumber);
    const row = allocateRow(key);
    if (row > ACCOUNTS_FIRST_ROW + ACCOUNTS_MAX_ROWS - 1) { truncatedAccounts++; continue; }
    accountsRowsUsed++;

    const w = [];
    if (acc.accountNumber !== undefined && acc.accountNumber !== null && acc.accountNumber !== '') {
      w.push({ col: 'N', type: 'str', value: acc.accountNumber });
    }
    w.push({ col: 'O', type: 'str', value: acc.accountName });
    w.push({ col: 'S', type: 'str', value: sValue });

    if (acc.amount !== undefined && acc.amount !== null) {
      // كل مبالغ المصروفات تُكتب بإشارة موجبة في القالب (طلب صريح، يطابق اتفاقية
      // G/H أعلاه) — القيمة الأصلية في Layer 2/3 تبقى كما هي، هذا تطبيع عرض داخل
      // Layer 5 فقط. بما أن كل حساب هنا مرتبط فعلياً ببند مصروف (وإلا لكان تخطّاه
      // الشرط أعلاه)، لا حاجة لأي شرط إضافي على نوع الحساب.
      w.push({ col: 'P', type: 'n', value: Math.abs(Number(acc.amount)) });
    }
    if (acc.clientMainClassification) w.push({ col: 'Q', type: 'str', value: acc.clientMainClassification });
    if (acc.clientSubClassification) w.push({ col: 'R', type: 'str', value: acc.clientSubClassification });

    // عمود T — تصنيف المحتوى المحلي النهائي (Layer 3)، حصراً وفق confidence:
    //  - Excluded          → لا يُكتب شيء (لا تُكتب كلمة "Excluded" إطلاقاً بالقالب).
    //  - Review Required    → يُكتب نص "Review Required" حرفياً (خارج قائمة التحقق عمداً).
    //  - High Confidence     → القيمة العربية المقابلة من CLASSIFICATION_AR.
    const l3 = l3ByAccount.get(key);
    if (l3) {
      if (l3.confidence === 'Review Required') {
        w.push({ col: 'T', type: 'str', value: 'Review Required' });
      } else if (l3.confidence === 'High Confidence' && l3.finalLocalContentClassification) {
        const arClass = CLASSIFICATION_AR[l3.finalLocalContentClassification];
        if (arClass) w.push({ col: 'T', type: 'str', value: arClass });
      }
      // confidence === 'Excluded' → تعمداً لا يُضاف أي write لعمود T.
    }

    const existing = writesByRow.get(row) || [];
    writesByRow.set(row, existing.concat(w));
  }

  const newSheetXml = writeCells(sheetXml, writesByRow);

  return {
    sheetXml: newSheetXml,
    unmappedMainLines,
    truncatedNotes,
    truncatedAccounts,
    notesRowsUsed,
    accountsRowsUsed,
  };
}

module.exports = { populateTemplate, MAIN_LINE_CODE_MAP, CLASSIFICATION_AR };
