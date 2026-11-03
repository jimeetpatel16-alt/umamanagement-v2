/* ============================================================
   Excel engine — builds/reads the workbook in the shape of the
   original "Weekly Driver Payment" template, extended for
   multiple companies with different rate types, plus a Labour roster,
   rostered shifts, work logs and invoices:
     Instructions | Driver Payments | Companies | Driver Summary |
     Company Summary | Sheet1 | Daily Summary |
     Labour | Labour Shifts | Labour Logs | Invoices | Rate Cards | Audit Log |
     Deliveries | Delivery Blocks
     (each only when present)
   Columns A-D of "Driver Payments" (Date/Blocks/Driver Name/Vehicle)
   match the original template exactly. Company (E), Parcels (F) and
   everything from Bonus onward are additive columns this app adds
   on top, so the original layout is never altered — only extended.
   ============================================================ */
const XL = (function () {
  const CURRENCY_FMT = '"$"#,##0.00';
  const DATE_FMT = 'yyyy-mm-dd';

  function colLetter(n) {
    let s = '';
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function styleTitle(cell) {
    cell.font = { bold: true, size: 12 };
  }
  function styleSub(cell) {
    cell.font = { size: 10, italic: false, color: { argb: 'FF555555' } };
  }
  function styleHeader(cell) {
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9EAF7' } };
  }
  function styleTotal(cell) {
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  }

  const RATE_TYPE_LABEL = { fixed: 'Fixed', per_parcel: 'Per Parcel' };

  function companyRate(company, vehicle, parcels) {
    if (!company) return 0;
    const field = { Car: 'carRate', Van: 'vanRate', Other: 'otherRate' }[vehicle] || 'otherRate';
    const rate = Number(company[field]) || 0;
    if (company.rateType === 'per_parcel') return rate * (Number(parcels) || 0);
    return rate;
  }

  // Timestamps (clock in/out, audit times) are stored as UTC instants, but a
  // workbook cell has no timezone — ExcelJS would show the raw UTC clock time
  // (e.g. 10 hours behind in Sydney) instead of what the app displays. Shift by
  // the exporting browser's own offset so the cell shows the same local time.
  function toExcelLocalDateTime(iso) {
    const d = new Date(iso);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  }

  function toExcelDate(dateStr) {
    // dateStr: 'YYYY-MM-DD' -> a Date built from UTC components. ExcelJS turns a
    // Date into a workbook serial number via d.getTime()/86400000 (a raw,
    // timezone-agnostic UTC-day count) — building the Date at LOCAL midnight
    // instead would shift every exported date backward by a day for anyone in
    // a positive UTC-offset timezone (e.g. Australia), since local midnight on
    // the 16th is still the 15th in UTC. Using UTC midnight makes the serial an
    // exact whole number that displays as the intended calendar date no matter
    // what timezone opens (or built) the file.
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }

  /**
   * payload = {
   *   days: [{ date:'YYYY-MM-DD', records:[{block,driverName,vehicle,companyName,parcels,baseRate,bonus,adjustment,paymentRef,status,notes}] }, ...] sorted asc by date,
   *   drivers: ['Name', ...]  (roster for Driver Summary, includes inactive),
   *   companies: [{ name, type:'delivery'|'labour', rateType:'fixed'|'per_parcel', carRate, vanRate, otherRate,
   *                 rate (a Labour-type company's single hourly BILL rate — what it's charged, regardless of work type) }, ...] (roster, includes inactive),
   *   settings: { businessName, prefixFormat, nextPaymentNumber },
   *   labour: [{ labourRef, name, mobile, labourTypes:['delivery_person'|'warehouse', ...], companyId,
   *              payRate (this person's own single hourly PAY rate — separate from the company's bill rate), active }, ...] (optional),
   *   labourShifts: [{ date, labourName, companyName, workType, category, startTime, endTime, estHours, estLines (tier breakdown), estBillCost, estPayCost, published }, ...] (optional, rostered shifts),
   *   labourLogs: [{ date, labourName, companyName, workType, category, scheduledStart, scheduledFinish, clockInAt, clockOutAt,
   *                  hours, tierLines (tier breakdown from the rate card, or null if a flat fallback rate was used),
   *                  rate, amount (bill — used for invoicing), payRate, payAmount (worker's own pay), overridden, status, notes }, ...] (optional),
   *   invoices: [{ invoiceRef, companyName, periodFrom, periodTo, lineItems (each with amount + payAmount), total, payTotal, status }, ...] (optional),
   *   rateCards: [{ companyId, companyName, category, effectiveDate,
   *                 payStandard/payOvertime/paySaturday/paySunday/payPublicHoliday/payNight/payCasual (worker pay tiers),
   *                 billStandard/billOvertime/billSaturday/billSunday/billPublicHoliday/billNight/billCasual (client billing tiers),
   *                 minimumShiftHours, breakMinutes, otherAllowances, otherCharges, createdBy }, ...] (optional, one row per rate-history version),
   *   auditLog: [{ changedAt, changedBy, entityType, entityId, field, oldValue, newValue, reason }, ...] (optional, manual rate overrides),
   *   driverSubmissions: [{ date, driverName, companyName, blockName, startTime, finishTime, delivered, failed, attempted,
   *                         failureReason, submissionRef, status, notes }, ...] (optional, every status — Start Work/Finish Work Delivery Performance records),
   *   deliveryBlocks: [{ blockRef, name, companyName, notes, active }, ...] (optional, named routes/zones roster)
   * }
   */
  async function buildWorkbook(payload) {
    const { days, settings } = payload;
    // The summary sheets total up records by NAME (COUNTIF/SUMIF), so a name
    // listed twice — a driver accidentally created twice, or an old inactive
    // company kept alongside its replacement — made every one of its jobs and
    // dollars count twice in Driver Summary / Company Summary. List each name
    // once (preferring the active company, case/space-insensitive like Excel).
    const nameKey = (n) => String(n == null ? '' : n).trim().toLowerCase();
    const uniqueDrivers = [];
    const seenDrivers = new Set();
    (payload.drivers || []).forEach((n) => { const k = nameKey(n); if (!seenDrivers.has(k)) { seenDrivers.add(k); uniqueDrivers.push(n); } });
    const drivers = uniqueDrivers;
    const companyPick = new Map();
    (payload.companies || []).forEach((c) => {
      const k = nameKey(c.name);
      const cur = companyPick.get(k);
      if (!cur || (cur.active === false && c.active !== false)) companyPick.set(k, c);
    });
    const companies = Array.from(companyPick.values());
    const wb = new ExcelJS.Workbook();
    wb.creator = settings.businessName || 'UMA Management';
    wb.created = new Date();

    // ---------------- Instructions ----------------
    const ins = wb.addWorksheet('Instructions');
    ins.getColumn(1).width = 100;
    const lines = [
      ['HOW TO USE', true],
      ['', false],
      ['Enter new records in the UMA Management web app (Daily Entry screen) — not directly in this file.', false],
      ['Each record belongs to a Company. A company either pays a Fixed rate per block, or a rate Per Parcel (rate × number of parcels).', false],
      ['Each company can set a different rate for Car, Van and Other — That Day Pay looks up the right rate for the row\'s Company AND Vehicle automatically from the Companies sheet.', false],
      ['Driver Summary and Company Summary automatically calculate jobs and total pay.', false],
      ['Daily Summary automatically calculates totals for every date.', false],
      ['Columns E-M on Driver Payments (Company, Parcels, Bonus, Adjustment, Final Payment, Payment Ref, Payment Status, Notes) were added by the web app — the original Date/Blocks/Driver Name/Vehicle columns are unchanged.', false],
      ['This workbook is a full export of the app\'s database and is regenerated each time you export — historical dates are never lost.', false],
    ];
    lines.forEach((row, i) => {
      const c = ins.getCell(i + 1, 1);
      c.value = row[0];
      if (row[1]) c.font = { bold: true };
    });

    // ---------------- Companies (rate lookup table — rates vary by vehicle) ----------------
    const comp = wb.addWorksheet('Companies');
    ['Company Name', 'Company Type', 'Rate Type', 'Car Rate', 'Van Rate', 'Other Rate', 'Bill Rate (Labour, $/hr)'].forEach((h, i) => {
      const c = comp.getRow(1).getCell(i + 1);
      c.value = h;
      styleHeader(c);
    });
    (companies.length ? companies : []).forEach((cpy, i) => {
      const row = comp.getRow(i + 2);
      row.getCell(1).value = cpy.name;
      row.getCell(2).value = (cpy.type || 'delivery') === 'labour' ? 'Labour' : 'Delivery Contract';
      row.getCell(3).value = RATE_TYPE_LABEL[cpy.rateType] || 'Fixed';
      row.getCell(4).value = Number(cpy.carRate) || 0;
      row.getCell(4).numFmt = CURRENCY_FMT;
      row.getCell(5).value = Number(cpy.vanRate) || 0;
      row.getCell(5).numFmt = CURRENCY_FMT;
      row.getCell(6).value = Number(cpy.otherRate) || 0;
      row.getCell(6).numFmt = CURRENCY_FMT;
      // `rate` is the current single-hourly-bill-rate field; deliveryRate/warehouseRate
      // is a fallback for companies saved before that model (a per-work-type split).
      const billRate = cpy.rate !== undefined ? (Number(cpy.rate) || 0) : (Number(cpy.deliveryRate) || Number(cpy.warehouseRate) || 0);
      row.getCell(7).value = billRate;
      row.getCell(7).numFmt = CURRENCY_FMT;
    });
    const compLastRow = Math.max(2, 1 + companies.length);
    [22, 16, 14, 12, 12, 12, 20].forEach((w, i) => (comp.getColumn(i + 1).width = w));

    // ---------------- Driver Payments ----------------
    const dp = wb.addWorksheet('Driver Payments');
    const dpHeaders = ['Date', 'Blocks', 'Driver Name', 'Vehicle', 'Company', 'Parcels', 'That Day Pay', 'Bonus', 'Adjustment', 'Final Payment', 'Payment Ref', 'Payment Status', 'Notes'];
    dp.mergeCells('A1:M1');
    dp.getCell('A1').value = 'WEEKLY DRIVER PAYMENT SHEET';
    styleTitle(dp.getCell('A1'));
    dp.mergeCells('A2:M2');
    dp.getCell('A2').value = 'That Day Pay is the amount actually recorded for that row — it stays fixed even if a company\'s rate is changed later (see the Companies sheet for today\'s rates)';
    styleSub(dp.getCell('A2'));

    const headerRowIdx = 4;
    dpHeaders.forEach((h, i) => {
      const cell = dp.getRow(headerRowIdx).getCell(i + 1);
      cell.value = h;
      styleHeader(cell);
    });

    let r = headerRowIdx + 1;
    (days || []).forEach((day) => {
      (day.records || []).forEach((rec) => {
        const row = dp.getRow(r);
        row.getCell(1).value = toExcelDate(day.date);
        row.getCell(1).numFmt = DATE_FMT;
        row.getCell(2).value = rec.block || '';
        row.getCell(3).value = rec.driverName || '';
        row.getCell(4).value = rec.vehicle || '';
        row.getCell(5).value = rec.companyName || '';
        row.getCell(6).value = Number(rec.parcels) || 0;

        // "That Day Pay" is written as the actual value the app computed and
        // saved for this record at the time (rec.baseRate) — NOT a live
        // VLOOKUP against the Companies sheet. A live lookup here used to mean
        // every exported row silently recalculated using TODAY's company
        // rates (and ignored any manual base-pay override made in the app),
        // so editing a company's rate later — or two companies ever sharing a
        // name (VLOOKUP matches the first one) — quietly rewrote historical
        // pay amounts on export. Writing the stored value keeps the export an
        // accurate record of what was actually paid, matching the app exactly.
        const base = Number(rec.baseRate) || 0;
        row.getCell(7).value = base;
        row.getCell(7).numFmt = CURRENCY_FMT;

        row.getCell(8).value = Number(rec.bonus) || 0;
        row.getCell(8).numFmt = CURRENCY_FMT;
        row.getCell(9).value = Number(rec.adjustment) || 0;
        row.getCell(9).numFmt = CURRENCY_FMT;
        row.getCell(10).value = { formula: `G${r}+H${r}+I${r}` };
        row.getCell(10).numFmt = CURRENCY_FMT;
        row.getCell(11).value = rec.paymentRef || '';
        row.getCell(12).value = rec.status || 'Pending';
        row.getCell(13).value = rec.notes || '';
        r++;
      });
    });
    const lastDataRow = Math.max(r - 1, headerRowIdx + 1);
    [11, 12, 20, 10, 18, 9, 13, 11, 12, 13, 13, 14, 28].forEach((w, i) => (dp.getColumn(i + 1).width = w));

    // ---------------- Driver Summary ----------------
    const ds = wb.addWorksheet('Driver Summary');
    ds.mergeCells('A1:I1');
    ds.getCell('A1').value = 'WEEKLY DRIVER SUMMARY';
    styleTitle(ds.getCell('A1'));
    const dsHeaders = ['Driver Name', 'Total Jobs', 'Car Jobs', 'Van Jobs', 'Total Pay', 'Avg Pay / Job', 'Total Bonus', 'Total Adjustment', 'Total Final Payment'];
    dsHeaders.forEach((h, i) => {
      const cell = ds.getRow(3).getCell(i + 1);
      cell.value = h;
      styleHeader(cell);
    });
    let dr = 4;
    const driverStart = dr;
    const roster = (drivers && drivers.length ? drivers : []).slice();
    roster.forEach((name) => {
      const row = ds.getRow(dr);
      row.getCell(1).value = name;
      row.getCell(2).value = { formula: `IF(A${dr}="","",COUNTIF('Driver Payments'!$C$${headerRowIdx + 1}:$C$${lastDataRow},A${dr}))` };
      row.getCell(3).value = { formula: `IF(A${dr}="","",COUNTIFS('Driver Payments'!$C$${headerRowIdx + 1}:$C$${lastDataRow},A${dr},'Driver Payments'!$D$${headerRowIdx + 1}:$D$${lastDataRow},"Car"))` };
      row.getCell(4).value = { formula: `IF(A${dr}="","",COUNTIFS('Driver Payments'!$C$${headerRowIdx + 1}:$C$${lastDataRow},A${dr},'Driver Payments'!$D$${headerRowIdx + 1}:$D$${lastDataRow},"Van"))` };
      row.getCell(5).value = { formula: `IF(A${dr}="","",SUMIF('Driver Payments'!$C$${headerRowIdx + 1}:$C$${lastDataRow},A${dr},'Driver Payments'!$G$${headerRowIdx + 1}:$G$${lastDataRow}))` };
      row.getCell(5).numFmt = CURRENCY_FMT;
      row.getCell(6).value = { formula: `IF(A${dr}="","",IF(B${dr}=0,0,E${dr}/B${dr}))` };
      row.getCell(6).numFmt = CURRENCY_FMT;
      row.getCell(7).value = { formula: `IF(A${dr}="","",SUMIF('Driver Payments'!$C$${headerRowIdx + 1}:$C$${lastDataRow},A${dr},'Driver Payments'!$H$${headerRowIdx + 1}:$H$${lastDataRow}))` };
      row.getCell(7).numFmt = CURRENCY_FMT;
      row.getCell(8).value = { formula: `IF(A${dr}="","",SUMIF('Driver Payments'!$C$${headerRowIdx + 1}:$C$${lastDataRow},A${dr},'Driver Payments'!$I$${headerRowIdx + 1}:$I$${lastDataRow}))` };
      row.getCell(8).numFmt = CURRENCY_FMT;
      row.getCell(9).value = { formula: `IF(A${dr}="","",SUMIF('Driver Payments'!$C$${headerRowIdx + 1}:$C$${lastDataRow},A${dr},'Driver Payments'!$J$${headerRowIdx + 1}:$J$${lastDataRow}))` };
      row.getCell(9).numFmt = CURRENCY_FMT;
      dr++;
    });
    const dsTotalRow = dr;
    ds.getCell(dsTotalRow, 1).value = 'TOTAL';
    [2, 3, 4, 5, 7, 8, 9].forEach((col) => {
      const L = colLetter(col);
      const cell = ds.getRow(dsTotalRow).getCell(col);
      cell.value = { formula: `SUM(${L}${driverStart}:${L}${dsTotalRow - 1})` };
      if ([5, 7, 8, 9].includes(col)) cell.numFmt = CURRENCY_FMT;
      styleTotal(cell);
    });
    const totB = ds.getRow(dsTotalRow).getCell(6);
    totB.value = { formula: `IF(B${dsTotalRow}=0,0,E${dsTotalRow}/B${dsTotalRow})` };
    totB.numFmt = CURRENCY_FMT;
    styleTotal(totB);
    styleTotal(ds.getRow(dsTotalRow).getCell(1));
    [11, 20, 10, 10, 13, 13, 12, 14, 16].forEach((w, i) => (ds.getColumn(i + 1).width = w));

    // ---------------- Company Summary ----------------
    const cs = wb.addWorksheet('Company Summary');
    cs.mergeCells('A1:H1');
    cs.getCell('A1').value = 'COMPANY SUMMARY';
    styleTitle(cs.getCell('A1'));
    const csHeaders = ['Company Name', 'Rate Type', 'Total Jobs', 'Total Parcels', 'Total Pay', 'Bonus', 'Adjustment', 'Final Payment'];
    csHeaders.forEach((h, i) => {
      const cell = cs.getRow(3).getCell(i + 1);
      cell.value = h;
      styleHeader(cell);
    });
    let cr = 4;
    const compStart = cr;
    companies.forEach((cpy) => {
      const row = cs.getRow(cr);
      row.getCell(1).value = cpy.name;
      row.getCell(2).value = RATE_TYPE_LABEL[cpy.rateType] || 'Fixed';
      row.getCell(3).value = { formula: `IF(A${cr}="","",COUNTIF('Driver Payments'!$E$${headerRowIdx + 1}:$E$${lastDataRow},A${cr}))` };
      row.getCell(4).value = { formula: `IF(A${cr}="","",SUMIF('Driver Payments'!$E$${headerRowIdx + 1}:$E$${lastDataRow},A${cr},'Driver Payments'!$F$${headerRowIdx + 1}:$F$${lastDataRow}))` };
      row.getCell(5).value = { formula: `IF(A${cr}="","",SUMIF('Driver Payments'!$E$${headerRowIdx + 1}:$E$${lastDataRow},A${cr},'Driver Payments'!$G$${headerRowIdx + 1}:$G$${lastDataRow}))` };
      row.getCell(5).numFmt = CURRENCY_FMT;
      row.getCell(6).value = { formula: `IF(A${cr}="","",SUMIF('Driver Payments'!$E$${headerRowIdx + 1}:$E$${lastDataRow},A${cr},'Driver Payments'!$H$${headerRowIdx + 1}:$H$${lastDataRow}))` };
      row.getCell(6).numFmt = CURRENCY_FMT;
      row.getCell(7).value = { formula: `IF(A${cr}="","",SUMIF('Driver Payments'!$E$${headerRowIdx + 1}:$E$${lastDataRow},A${cr},'Driver Payments'!$I$${headerRowIdx + 1}:$I$${lastDataRow}))` };
      row.getCell(7).numFmt = CURRENCY_FMT;
      row.getCell(8).value = { formula: `IF(A${cr}="","",SUMIF('Driver Payments'!$E$${headerRowIdx + 1}:$E$${lastDataRow},A${cr},'Driver Payments'!$J$${headerRowIdx + 1}:$J$${lastDataRow}))` };
      row.getCell(8).numFmt = CURRENCY_FMT;
      cr++;
    });
    const csTotalRow = cr;
    cs.getCell(csTotalRow, 1).value = 'TOTAL';
    [3, 4, 5, 6, 7, 8].forEach((col) => {
      const L = colLetter(col);
      const cell = cs.getRow(csTotalRow).getCell(col);
      cell.value = { formula: `SUM(${L}${compStart}:${L}${csTotalRow - 1})` };
      if ([5, 6, 7, 8].includes(col)) cell.numFmt = CURRENCY_FMT;
      styleTotal(cell);
    });
    styleTotal(cs.getRow(csTotalRow).getCell(1));
    [22, 12, 11, 13, 13, 12, 14, 15].forEach((w, i) => (cs.getColumn(i + 1).width = w));

    // ---------------- Sheet1 (legacy, unused — kept for continuity with the original template) ----------------
    const legacy = wb.addWorksheet('Sheet1');
    ['Driver Name', 'Total Jobs', 'Car Jobs', 'Van Jobs', 'Total Pay', 'Avg Pay / Job'].forEach((h, i) => {
      const c = legacy.getRow(1).getCell(i + 1);
      c.value = h;
      styleHeader(c);
    });
    legacy.getRow(2).getCell(1).value = 'This sheet was unused in the original template and is kept only for layout continuity — see Driver Summary / Company Summary for live data.';
    legacy.getColumn(1).width = 70;

    // ---------------- Daily Summary ----------------
    const dsum = wb.addWorksheet('Daily Summary');
    dsum.mergeCells('A1:H1');
    dsum.getCell('A1').value = 'DAILY SUMMARY';
    styleTitle(dsum.getCell('A1'));
    const dailyHeaders = ['Date', 'Total Jobs', 'Car Jobs', 'Van Jobs', 'Total Pay', 'Total Bonus', 'Total Adjustment', 'Total Final Payment'];
    dailyHeaders.forEach((h, i) => {
      const c = dsum.getRow(3).getCell(i + 1);
      c.value = h;
      styleHeader(c);
    });
    let dd = 4;
    const dateStart = dd;
    (days || []).forEach((day) => {
      const row = dsum.getRow(dd);
      row.getCell(1).value = toExcelDate(day.date);
      row.getCell(1).numFmt = DATE_FMT;
      row.getCell(2).value = { formula: `COUNTIF('Driver Payments'!$A$${headerRowIdx + 1}:$A$${lastDataRow},A${dd})` };
      row.getCell(3).value = { formula: `COUNTIFS('Driver Payments'!$A$${headerRowIdx + 1}:$A$${lastDataRow},A${dd},'Driver Payments'!$D$${headerRowIdx + 1}:$D$${lastDataRow},"Car")` };
      row.getCell(4).value = { formula: `COUNTIFS('Driver Payments'!$A$${headerRowIdx + 1}:$A$${lastDataRow},A${dd},'Driver Payments'!$D$${headerRowIdx + 1}:$D$${lastDataRow},"Van")` };
      row.getCell(5).value = { formula: `SUMIF('Driver Payments'!$A$${headerRowIdx + 1}:$A$${lastDataRow},A${dd},'Driver Payments'!$G$${headerRowIdx + 1}:$G$${lastDataRow})` };
      row.getCell(5).numFmt = CURRENCY_FMT;
      row.getCell(6).value = { formula: `SUMIF('Driver Payments'!$A$${headerRowIdx + 1}:$A$${lastDataRow},A${dd},'Driver Payments'!$H$${headerRowIdx + 1}:$H$${lastDataRow})` };
      row.getCell(6).numFmt = CURRENCY_FMT;
      row.getCell(7).value = { formula: `SUMIF('Driver Payments'!$A$${headerRowIdx + 1}:$A$${lastDataRow},A${dd},'Driver Payments'!$I$${headerRowIdx + 1}:$I$${lastDataRow})` };
      row.getCell(7).numFmt = CURRENCY_FMT;
      row.getCell(8).value = { formula: `SUMIF('Driver Payments'!$A$${headerRowIdx + 1}:$A$${lastDataRow},A${dd},'Driver Payments'!$J$${headerRowIdx + 1}:$J$${lastDataRow})` };
      row.getCell(8).numFmt = CURRENCY_FMT;
      dd++;
    });
    const dailyTotalRow = dd;
    dsum.getCell(dailyTotalRow, 1).value = 'TOTAL';
    [2, 3, 4, 5, 6, 7, 8].forEach((col) => {
      const L = colLetter(col);
      const cell = dsum.getRow(dailyTotalRow).getCell(col);
      cell.value = { formula: `SUM(${L}${dateStart}:${L}${dailyTotalRow - 1})` };
      if ([5, 6, 7, 8].includes(col)) cell.numFmt = CURRENCY_FMT;
      styleTotal(cell);
    });
    styleTotal(dsum.getRow(dailyTotalRow).getCell(1));
    [11, 11, 10, 10, 13, 12, 14, 16].forEach((w, i) => (dsum.getColumn(i + 1).width = w));

    // ---------------- Labour roster / logs / invoices sheets (additive) ----------------
    // Each is guarded on the payload actually containing that data, so a
    // payload without it produces the same output as before these features
    // existed — nothing above is touched by any of this.
    if (payload.labour && payload.labour.length) buildLabourSheet(wb, payload.labour, payload.companies || []);
    if (payload.labourShifts && payload.labourShifts.length) buildLabourShiftsSheet(wb, payload.labourShifts);
    if (payload.labourLogs && payload.labourLogs.length) buildLabourLogsSheet(wb, payload.labourLogs);
    if (payload.invoices && payload.invoices.length) buildInvoicesSheet(wb, payload.invoices);
    if (payload.rateCards && payload.rateCards.length) buildRateCardsSheet(wb, payload.rateCards);
    if (payload.auditLog && payload.auditLog.length) buildAuditLogSheet(wb, payload.auditLog);
    if (payload.driverSubmissions && payload.driverSubmissions.length) buildDeliveriesSheet(wb, payload.driverSubmissions);
    if (payload.deliveryBlocks && payload.deliveryBlocks.length) buildDeliveryBlocksSheet(wb, payload.deliveryBlocks);

    return wb;
  }

  const LABOUR_TYPE_LABEL = { delivery_person: 'Delivery Person', warehouse: 'Warehouse' };

  function buildLabourSheet(wb, labour, companies) {
    const sh = wb.addWorksheet('Labour');
    const companyById = {}; (companies || []).forEach((c) => { companyById[c.id] = c; });
    ['Labour ID', 'Name', 'Mobile', 'Type', 'Company', 'Bill Rate ($/hr)', 'Pay Rate ($/hr)', 'Status'].forEach((h, i) => { const c = sh.getRow(1).getCell(i + 1); c.value = h; styleHeader(c); });
    labour.forEach((l, i) => {
      const row = sh.getRow(i + 2);
      const company = companyById[l.companyId];
      const types = l.labourTypes || (l.labourType ? [l.labourType] : []);
      row.getCell(1).value = l.labourRef || '';
      row.getCell(2).value = l.name || '';
      row.getCell(3).value = l.mobile || '';
      row.getCell(4).value = types.map((t) => LABOUR_TYPE_LABEL[t] || t).join(' + ');
      row.getCell(5).value = company ? company.name : '';
      if (company && (company.type || 'delivery') === 'labour') {
        const billRate = company.rate !== undefined ? (Number(company.rate) || 0) : (Number(company.deliveryRate) || Number(company.warehouseRate) || 0);
        row.getCell(6).value = billRate;
        row.getCell(6).numFmt = CURRENCY_FMT;
      }
      const payRate = l.payRate !== undefined ? (Number(l.payRate) || 0) : (Number(l.deliveryPayRate) || Number(l.warehousePayRate) || 0);
      row.getCell(7).value = payRate;
      row.getCell(7).numFmt = CURRENCY_FMT;
      row.getCell(8).value = l.active !== false ? 'Active' : 'Inactive';
    });
    [14, 22, 16, 24, 22, 15, 15, 10].forEach((w, i) => (sh.getColumn(i + 1).width = w));
  }

  function tierSummaryText(lines) {
    if (!lines || !lines.length) return '';
    const TIER_LABEL = { standard: 'Standard', overtime: 'Overtime', saturday: 'Saturday', sunday: 'Sunday', publicHoliday: 'Public Holiday', night: 'Night', casual: 'Casual' };
    return lines.map((l) => `${TIER_LABEL[l.tier] || l.tier} ${l.hours}h`).join(' + ');
  }

  function buildLabourShiftsSheet(wb, shifts) {
    const sh = wb.addWorksheet('Labour Shifts');
    ['Date', 'Labour', 'Company', 'Type', 'Category', 'Start', 'End', 'Est Hours', 'Tier Breakdown', 'Est Bill', 'Est Pay', 'Est Margin', 'Published'].forEach((h, i) => { const c = sh.getRow(1).getCell(i + 1); c.value = h; styleHeader(c); });
    shifts.forEach((s, i) => {
      const row = sh.getRow(i + 2);
      if (s.date) { row.getCell(1).value = toExcelDate(s.date); row.getCell(1).numFmt = DATE_FMT; }
      row.getCell(2).value = s.labourName || '';
      row.getCell(3).value = s.companyName || '';
      row.getCell(4).value = LABOUR_TYPE_LABEL[s.workType] || s.workType || '';
      row.getCell(5).value = s.category || 'Standard';
      row.getCell(6).value = s.startTime || '';
      row.getCell(7).value = s.endTime || '';
      row.getCell(8).value = Number(s.estHours) || 0;
      row.getCell(9).value = tierSummaryText(s.estLines);
      row.getCell(10).value = Number(s.estBillCost) || 0;
      row.getCell(10).numFmt = CURRENCY_FMT;
      row.getCell(11).value = Number(s.estPayCost) || 0;
      row.getCell(11).numFmt = CURRENCY_FMT;
      row.getCell(12).value = (Number(s.estBillCost) || 0) - (Number(s.estPayCost) || 0);
      row.getCell(12).numFmt = CURRENCY_FMT;
      row.getCell(13).value = s.published ? 'Published' : 'Draft';
    });
    [11, 20, 22, 18, 18, 9, 9, 10, 24, 12, 12, 12, 11].forEach((w, i) => (sh.getColumn(i + 1).width = w));
  }

  function buildLabourLogsSheet(wb, logs) {
    const sh = wb.addWorksheet('Labour Logs');
    ['Date', 'Labour', 'Company', 'Type', 'Category', 'Scheduled Start', 'Scheduled Finish', 'Clock In', 'Clock Out', 'Hours', 'Tier Breakdown', 'Bill Rate', 'Bill Amount', 'Pay Rate', 'Pay Amount', 'Margin', 'Status', 'Overridden', 'Notes'].forEach((h, i) => { const c = sh.getRow(1).getCell(i + 1); c.value = h; styleHeader(c); });
    logs.forEach((g, i) => {
      const row = sh.getRow(i + 2);
      if (g.date) { row.getCell(1).value = toExcelDate(g.date); row.getCell(1).numFmt = DATE_FMT; }
      row.getCell(2).value = g.labourName || '';
      row.getCell(3).value = g.companyName || '';
      row.getCell(4).value = LABOUR_TYPE_LABEL[g.workType] || g.workType || '';
      row.getCell(5).value = g.category || 'Standard';
      row.getCell(6).value = g.scheduledStart || '';
      row.getCell(7).value = g.scheduledFinish || '';
      row.getCell(8).value = g.clockInAt ? toExcelLocalDateTime(g.clockInAt) : '';
      if (g.clockInAt) row.getCell(8).numFmt = 'hh:mm AM/PM';
      row.getCell(9).value = g.clockOutAt ? toExcelLocalDateTime(g.clockOutAt) : '';
      if (g.clockOutAt) row.getCell(9).numFmt = 'hh:mm AM/PM';
      row.getCell(10).value = Number(g.hours) || 0;
      row.getCell(11).value = tierSummaryText(g.tierLines);
      row.getCell(12).value = Number(g.rate) || 0;
      row.getCell(12).numFmt = CURRENCY_FMT;
      row.getCell(13).value = Number(g.amount) || 0;
      row.getCell(13).numFmt = CURRENCY_FMT;
      row.getCell(14).value = Number(g.payRate) || 0;
      row.getCell(14).numFmt = CURRENCY_FMT;
      row.getCell(15).value = Number(g.payAmount) || 0;
      row.getCell(15).numFmt = CURRENCY_FMT;
      row.getCell(16).value = (Number(g.amount) || 0) - (Number(g.payAmount) || 0);
      row.getCell(16).numFmt = CURRENCY_FMT;
      row.getCell(17).value = g.status || 'Pending';
      row.getCell(18).value = g.overridden ? 'Yes' : '';
      row.getCell(19).value = g.notes || '';
    });
    [11, 20, 22, 18, 18, 15, 16, 11, 11, 9, 24, 11, 13, 11, 13, 12, 12, 11, 28].forEach((w, i) => (sh.getColumn(i + 1).width = w));
  }

  function buildRateCardsSheet(wb, rateCards) {
    const sh = wb.addWorksheet('Rate Cards');
    const TIER_KEYS = ['Standard', 'Overtime', 'Saturday', 'Sunday', 'PublicHoliday', 'Night', 'Casual'];
    const TIER_LABEL = { Standard: 'Standard', Overtime: 'Overtime', Saturday: 'Saturday', Sunday: 'Sunday', PublicHoliday: 'Public Holiday', Night: 'Night', Casual: 'Casual' };
    const headers = ['Company', 'Category', 'Effective Date'];
    TIER_KEYS.forEach((t) => { headers.push('Pay ' + TIER_LABEL[t]); headers.push('Bill ' + TIER_LABEL[t]); });
    headers.push('Min Shift Hrs', 'Break (min)', 'Other Allowances', 'Other Charges', 'Changed By');
    headers.forEach((h, i) => { const c = sh.getRow(1).getCell(i + 1); c.value = h; styleHeader(c); });
    const sorted = rateCards.slice().sort((a, b) => (a.companyName + a.category).localeCompare(b.companyName + b.category) || (a.effectiveDate || '').localeCompare(b.effectiveDate || ''));
    sorted.forEach((r, i) => {
      const row = sh.getRow(i + 2);
      let col = 1;
      row.getCell(col++).value = r.companyName || '';
      row.getCell(col++).value = r.category || 'Standard';
      if (r.effectiveDate) { row.getCell(col).value = toExcelDate(r.effectiveDate); row.getCell(col).numFmt = DATE_FMT; }
      col++;
      TIER_KEYS.forEach((t) => {
        row.getCell(col).value = Number(r['pay' + t]) || 0; row.getCell(col).numFmt = CURRENCY_FMT; col++;
        row.getCell(col).value = Number(r['bill' + t]) || 0; row.getCell(col).numFmt = CURRENCY_FMT; col++;
      });
      row.getCell(col++).value = Number(r.minimumShiftHours) || 0;
      row.getCell(col++).value = Number(r.breakMinutes) || 0;
      row.getCell(col).value = Number(r.otherAllowances) || 0; row.getCell(col).numFmt = CURRENCY_FMT; col++;
      row.getCell(col).value = Number(r.otherCharges) || 0; row.getCell(col).numFmt = CURRENCY_FMT; col++;
      row.getCell(col++).value = r.createdBy || '';
    });
    const widths = [22, 18, 14];
    TIER_KEYS.forEach(() => { widths.push(12, 12); });
    widths.push(13, 12, 15, 13, 16);
    widths.forEach((w, i) => (sh.getColumn(i + 1).width = w));
  }

  function buildAuditLogSheet(wb, auditLog) {
    const sh = wb.addWorksheet('Audit Log');
    ['When', 'Changed By', 'Entity Type', 'Entity ID', 'Field', 'Old Value', 'New Value', 'Reason'].forEach((h, i) => { const c = sh.getRow(1).getCell(i + 1); c.value = h; styleHeader(c); });
    const sorted = auditLog.slice().sort((a, b) => (b.changedAt || '').localeCompare(a.changedAt || ''));
    sorted.forEach((a, i) => {
      const row = sh.getRow(i + 2);
      row.getCell(1).value = a.changedAt ? toExcelLocalDateTime(a.changedAt) : '';
      if (a.changedAt) row.getCell(1).numFmt = 'yyyy-mm-dd hh:mm AM/PM';
      row.getCell(2).value = a.changedBy || '';
      row.getCell(3).value = a.entityType || '';
      row.getCell(4).value = a.entityId || '';
      row.getCell(5).value = a.field || '';
      row.getCell(6).value = Number.isFinite(Number(a.oldValue)) ? Number(a.oldValue) : (a.oldValue || '');
      row.getCell(7).value = Number.isFinite(Number(a.newValue)) ? Number(a.newValue) : (a.newValue || '');
      row.getCell(8).value = a.reason || '';
    });
    [20, 20, 14, 16, 22, 12, 12, 34].forEach((w, i) => (sh.getColumn(i + 1).width = w));
  }

  function successRatePctXl(delivered, attempted) {
    const a = Number(attempted) || 0;
    if (!a) return 0;
    return Math.round(((Number(delivered) || 0) / a) * 1000) / 10;
  }

  function buildDeliveriesSheet(wb, submissions) {
    const sh = wb.addWorksheet('Deliveries');
    ['Date', 'Driver', 'Company', 'Block', 'Start Time', 'Finish Time', 'Delivered', 'Failed', 'Attempted', 'Success Rate', 'Failure Reason', 'Submission Ref', 'Status', 'Notes'].forEach((h, i) => { const c = sh.getRow(1).getCell(i + 1); c.value = h; styleHeader(c); });
    const sorted = submissions.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    sorted.forEach((s, i) => {
      const row = sh.getRow(i + 2);
      if (s.date) { row.getCell(1).value = toExcelDate(s.date); row.getCell(1).numFmt = DATE_FMT; }
      row.getCell(2).value = s.driverName || '';
      row.getCell(3).value = s.companyName || '';
      row.getCell(4).value = s.blockName || '';
      row.getCell(5).value = s.startTime ? toExcelLocalDateTime(s.startTime) : '';
      if (s.startTime) row.getCell(5).numFmt = 'hh:mm AM/PM';
      row.getCell(6).value = s.finishTime ? toExcelLocalDateTime(s.finishTime) : '';
      if (s.finishTime) row.getCell(6).numFmt = 'hh:mm AM/PM';
      const delivered = Number(s.delivered) || 0;
      const failed = Number(s.failed) || 0;
      const attempted = s.attempted != null ? Number(s.attempted) || 0 : delivered + failed;
      row.getCell(7).value = delivered;
      row.getCell(8).value = failed;
      row.getCell(9).value = attempted;
      row.getCell(10).value = (s.status === 'InProgress') ? '' : successRatePctXl(delivered, attempted) / 100;
      row.getCell(10).numFmt = '0.0%';
      row.getCell(11).value = s.failureReason || '';
      row.getCell(12).value = s.submissionRef || '';
      row.getCell(13).value = s.status || 'Pending';
      row.getCell(14).value = s.notes || '';
    });
    [11, 20, 22, 18, 12, 12, 10, 8, 10, 12, 26, 14, 12, 28].forEach((w, i) => (sh.getColumn(i + 1).width = w));
  }

  function buildDeliveryBlocksSheet(wb, blocks) {
    const sh = wb.addWorksheet('Delivery Blocks');
    ['Ref', 'Name', 'Company', 'Notes', 'Active'].forEach((h, i) => { const c = sh.getRow(1).getCell(i + 1); c.value = h; styleHeader(c); });
    blocks.forEach((b, i) => {
      const row = sh.getRow(i + 2);
      row.getCell(1).value = b.blockRef || '';
      row.getCell(2).value = b.name || '';
      row.getCell(3).value = b.companyName || '';
      row.getCell(4).value = b.notes || '';
      row.getCell(5).value = b.active !== false ? 'Active' : 'Inactive';
    });
    [14, 24, 22, 34, 10].forEach((w, i) => (sh.getColumn(i + 1).width = w));
  }

  function buildInvoicesSheet(wb, invoices) {
    const sh = wb.addWorksheet('Invoices');
    ['Invoice Ref', 'Company', 'Period From', 'Period To', 'Lines', 'Total', 'Worker Cost', 'Margin', 'Status'].forEach((h, i) => { const c = sh.getRow(1).getCell(i + 1); c.value = h; styleHeader(c); });
    invoices.forEach((inv, i) => {
      const row = sh.getRow(i + 2);
      row.getCell(1).value = inv.invoiceRef || '';
      row.getCell(2).value = inv.companyName || '';
      if (inv.periodFrom) { row.getCell(3).value = toExcelDate(inv.periodFrom); row.getCell(3).numFmt = DATE_FMT; }
      if (inv.periodTo) { row.getCell(4).value = toExcelDate(inv.periodTo); row.getCell(4).numFmt = DATE_FMT; }
      row.getCell(5).value = (inv.lineItems || []).length;
      row.getCell(6).value = Number(inv.total) || 0;
      row.getCell(6).numFmt = CURRENCY_FMT;
      const payTotal = inv.payTotal != null ? Number(inv.payTotal) || 0 : (inv.lineItems || []).reduce((s, li) => s + (Number(li.payAmount) || 0), 0);
      row.getCell(7).value = payTotal;
      row.getCell(7).numFmt = CURRENCY_FMT;
      row.getCell(8).value = (Number(inv.total) || 0) - payTotal;
      row.getCell(8).numFmt = CURRENCY_FMT;
      row.getCell(9).value = inv.status || 'Draft';
    });
    [16, 22, 13, 13, 8, 13, 13, 13, 10].forEach((w, i) => (sh.getColumn(i + 1).width = w));
  }

  async function workbookToBlob(wb) {
    const buf = await wb.xlsx.writeBuffer();
    return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  /**
   * Best-effort import: reads the "Driver Payments" sheet (or first sheet)
   * of an uploaded workbook, locates the header row by matching known
   * column names, and returns plain row objects for a preview step.
   */
  async function parseImportWorkbook(arrayBuffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(arrayBuffer);
    const sheet = wb.getWorksheet('Driver Payments') || wb.worksheets[0];
    if (!sheet) throw new Error('No sheets found in this file.');

    let headerRowIdx = null;
    let colTexts = {};
    const scanMax = Math.min(15, sheet.rowCount || 15);
    for (let i = 1; i <= scanMax; i++) {
      const row = sheet.getRow(i);
      const vals = {};
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        vals[colNumber] = String(cell.value == null ? '' : cell.value).trim().toLowerCase();
      });
      if (Object.values(vals).some((v) => v.includes('driver name') || v === 'driver')) {
        headerRowIdx = i;
        colTexts = vals;
        break;
      }
    }
    if (!headerRowIdx) throw new Error('Could not find a header row containing "Driver Name" in this file.');

    const fieldFor = (text) => {
      const t = text;
      if (t.includes('final') && t.includes('pay')) return 'finalPay';
      if (t.includes('parcel')) return 'parcels';
      if (t.includes('compan')) return 'companyName';
      if (t.includes('bonus')) return 'bonus';
      if (t.includes('adjustment')) return 'adjustment';
      if (t.includes('ref')) return 'paymentRef';
      if (t.includes('status')) return 'status';
      if (t.includes('note')) return 'notes';
      if (t.includes('date')) return 'date';
      if (t.includes('block')) return 'block';
      if (t.includes('driver')) return 'driverName';
      if (t.includes('vehicle')) return 'vehicle';
      if (t.includes('pay')) return 'basePay';
      return null;
    };
    const fieldCols = {};
    Object.entries(colTexts).forEach(([colNum, text]) => {
      const f = fieldFor(text);
      if (f && !(f in fieldCols)) fieldCols[f] = Number(colNum);
    });
    if (!fieldCols.driverName) throw new Error('Could not find a Driver Name column in this file.');

    const excelSerialToDate = (n) => {
      const utcDays = Math.floor(n - 25569);
      const utcMs = utcDays * 86400000;
      return new Date(utcMs);
    };
    const cellNumber = (v) => {
      if (v == null) return 0;
      if (typeof v === 'number') return v;
      if (typeof v === 'object' && 'result' in v) return Number(v.result) || 0;
      const n = parseFloat(v);
      return isNaN(n) ? 0 : n;
    };

    const rows = [];
    for (let i = headerRowIdx + 1; i <= (sheet.rowCount || 0); i++) {
      const row = sheet.getRow(i);
      const get = (f) => (fieldCols[f] ? row.getCell(fieldCols[f]).value : undefined);
      const driverNameRaw = get('driverName');
      if (driverNameRaw == null || String(driverNameRaw).trim() === '') continue;

      let dateStr = null;
      const dv = get('date');
      if (dv instanceof Date) dateStr = dv.toISOString().slice(0, 10);
      else if (typeof dv === 'number') dateStr = excelSerialToDate(dv).toISOString().slice(0, 10);
      else if (typeof dv === 'string' && dv.trim()) {
        const d = new Date(dv);
        if (!isNaN(d.getTime())) dateStr = d.toISOString().slice(0, 10);
      }

      rows.push({
        sourceRow: i,
        date: dateStr,
        block: get('block') ? String(get('block')).trim() : '',
        driverName: String(driverNameRaw).trim(),
        vehicle: get('vehicle') ? String(get('vehicle')).trim() : '',
        companyName: get('companyName') ? String(get('companyName')).trim() : '',
        parcels: fieldCols.parcels ? cellNumber(get('parcels')) : 0,
        basePay: fieldCols.basePay ? cellNumber(get('basePay')) : null,
        bonus: fieldCols.bonus ? cellNumber(get('bonus')) : 0,
        adjustment: fieldCols.adjustment ? cellNumber(get('adjustment')) : 0,
        paymentRef: get('paymentRef') ? String(get('paymentRef')).trim() : '',
        status: get('status') ? String(get('status')).trim() : '',
        notes: get('notes') ? String(get('notes')).trim() : '',
      });
    }
    return { headerRowIdx, fieldCols, rows };
  }

  return { buildWorkbook, workbookToBlob, parseImportWorkbook, companyRate, colLetter };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = XL;
