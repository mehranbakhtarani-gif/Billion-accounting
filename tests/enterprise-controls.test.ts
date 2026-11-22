import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateStockFIFO,
  assertSufficientStock,
  assertFiscalPeriodOpen,
  auditTreasuryVoucherLinks,
  classifySyncOperation,
  computeOpenItemAging,
  reconcileBankLines,
  parseCsvRow,
  validateAtomicFinancialPlan,
  validateSyncOperation,
} from '../src/lib/enterpriseControls.ts';
import { calculateLandedCostAllocation, computeReceivablesAging, computePayablesAging, computeFxRevaluationReport } from '../src/lib/enterpriseAccounting.ts';
import { calculateEmployeePayroll, calculateMonthlyDepreciation, computeAccountLedger, computeAuditReport, computePartyBalances, computePartyLedger, computeTrialBalance } from '../src/lib/accountingEngine.ts';

test('CSV parser preserves quoted commas and escaped quotes', () => {
  assert.deepEqual(parseCsvRow('1405/09/01,"کارمزد، انتقال, فوری","شناسه ""ABC""",1250,0'), ['1405/09/01', 'کارمزد، انتقال, فوری', 'شناسه "ABC"', '1250', '0']);
});

test('fiscal period rejects closed periods and overlapping ranges', () => {
  assert.throws(() => assertFiscalPeriodOpen('2026-03-20', [
    { id: 'p1', startDate: '2026-03-01', endDate: '2026-03-31', status: 'closed' },
  ]), /بسته‌شده/);
  assert.throws(() => assertFiscalPeriodOpen('2026-03-20', [
    { id: 'p1', startDate: '2026-03-01', endDate: '2026-03-31', status: 'open' },
    { id: 'p2', startDate: '2026-03-15', endDate: '2026-04-15', status: 'open' },
  ]), /هم‌پوشانی/);
});

test('sync envelope validates identity and classifies duplicate operations', () => {
  const operation = {
    schemaVersion: 1 as const, operationId: 'op-1', idempotencyKey: 'idem-1',
    companyId: 'company-1', actorId: 'actor-1', deviceId: 'device-1',
    entityType: 'invoice', entityId: 'invoice-1', operation: 'create' as const,
    baseVersion: 0, createdAt: '2026-11-22T10:00:00.000Z', payload: {},
  };
  validateSyncOperation(operation);
  assert.deepEqual(classifySyncOperation(operation, 0, new Set()), {
    kind: 'safe', reason: 'same-base-version',
  });
  assert.deepEqual(classifySyncOperation(operation, 1, new Set(['idem-1'])), {
    kind: 'duplicate', operationId: 'op-1',
  });
  assert.equal(classifySyncOperation(operation, 2, new Set()).kind, 'conflict');
  assert.throws(() => validateSyncOperation({ ...operation, deviceId: '' }), /deviceId/);
});

test('FIFO allocates oldest eligible lots and excludes expired lots', () => {
  const lots = [
    { id: 'new', productId: 'p1', warehouse: 'w1', lotNumber: 'L2', receivedDate: '2026-02-01', quantityReceived: 10, quantityRemaining: 10, unitCost: 140 },
    { id: 'old', productId: 'p1', warehouse: 'w1', lotNumber: 'L1', receivedDate: '2026-01-01', expiryDate: '2026-12-31', quantityReceived: 5, quantityRemaining: 5, unitCost: 100 },
    { id: 'expired', productId: 'p1', warehouse: 'w1', lotNumber: 'L0', receivedDate: '2025-12-01', expiryDate: '2026-01-01', quantityReceived: 7, quantityRemaining: 7, unitCost: 80 },
  ];
  const result = allocateStockFIFO(lots, 8, { productId: 'p1', warehouse: 'w1', asOfDate: '2026-11-22' });
  assert.deepEqual(result.allocations.map((x) => [x.lotId, x.quantity]), [['old', 5], ['new', 3]]);
  assert.equal(result.totalCost, 920);
  assert.equal(result.weightedUnitCost, 115);
  assert.equal(result.remainingLots.find((x) => x.id === 'old')?.quantityRemaining, 0);
  assert.equal(result.remainingLots.find((x) => x.id === 'expired')?.quantityRemaining, 7);
  assert.throws(() => allocateStockFIFO(lots, 30, { productId: 'p1', warehouse: 'w1', asOfDate: '2026-11-22' }), /کافی نیست/);
  assert.throws(() => allocateStockFIFO([...lots, { ...lots[0] }], 1, {
    productId: 'p1', warehouse: 'w1', asOfDate: '2026-11-22',
  }), /تکراری/);
  assert.throws(() => allocateStockFIFO([{ ...lots[0], quantityRemaining: 11 }], 1, {
    productId: 'p1', warehouse: 'w1', asOfDate: '2026-11-22',
  }), /مقدار دریافتی/);
  assert.throws(() => allocateStockFIFO([{ ...lots[0], unitCost: Number.NaN }], 1, {
    productId: 'p1', warehouse: 'w1', asOfDate: '2026-11-22',
  }), /بهای واحد/);
});

test('stock issue preflight aggregates repeated product lines and rejects overselling', () => {
  assert.doesNotThrow(() => assertSufficientStock(
    new Map([['p1', 10], ['p2', 4]]),
    [{ productId: 'p1', quantity: 3 }, { productId: 'p1', quantity: 7 }, { productId: 'p2', quantity: 4 }],
  ));
  assert.throws(() => assertSufficientStock(
    new Map([['p1', 9]]),
    [{ productId: 'p1', quantity: 5 }, { productId: 'p1', quantity: 5 }],
  ), /موجودی کالا/);
  assert.throws(() => assertSufficientStock(new Map([['p1', 10]]), [
    { productId: 'p1', quantity: 0 },
  ]), /مقدار نامعتبر/);
  assert.throws(() => assertSufficientStock(new Map(), [
    { productId: 'missing', quantity: 1 },
  ]), /موجودی کالا/);
});

test('open-item aging uses invoice outstanding amounts and due dates', () => {
  const daysBetween = (from: string, to: string) =>
    Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
  const rows = computeOpenItemAging([
    { invoiceId: 'i1', invoiceNumber: '1', partyId: 'c1', partyName: 'مشتری', dueDate: '2026-11-22', outstanding: 100 },
    { invoiceId: 'i2', invoiceNumber: '2', partyId: 'c1', partyName: 'مشتری', dueDate: '2026-10-10', outstanding: 200 },
    { invoiceId: 'i3', invoiceNumber: '3', partyId: 'c1', partyName: 'مشتری', dueDate: '2026-07-01', outstanding: 300 },
  ], '2026-11-22', daysBetween);
  assert.equal(rows[0].totalOutstanding, 600);
  assert.equal(rows[0].current, 100);
  assert.equal(rows[0].days31to60, 200);
  assert.equal(rows[0].over90, 300);
});

test('receivables aging uses due dates and actual outstanding invoice balances', () => {
  const party = { id: 'p1', ownerId: 'o1', code: 'C1', name: 'مشتری نمونه', partyType: 'customer', creditLimit: 0, openingBalance: 0, accountCode: '1103', phone: '09120000000' };
  const invoice = (id: string, date: string, dueDate: string, creditAmount: number, grandTotal: number) => ({
    id, ownerId: 'o1', invoiceNumber: id, invoiceType: 'sale', date, dueDate, partyId: 'p1', partyName: 'مشتری نمونه',
    warehouse: 'انبار', subtotal: grandTotal, discount: 0, vatAmount: 0, grandTotal, paidCash: grandTotal - creditAmount,
    paidBank: 0, paidCheque: 0, creditAmount, status: 'issued', items: [],
  });
  const rows = computeReceivablesAging(
    [party] as any,
    [invoice('old', '1405/07/15', '1405/07/15', 200, 1000), invoice('new', '1405/08/30', '1405/08/30', 100, 1000)] as any,
    new Map([['p1', 300]]),
    '1405/09/01',
  );
  assert.equal(rows[0].totalReceivable, 300);
  assert.equal(rows[0].bucket0to30, 100);
  assert.equal(rows[0].bucket31to60, 200);
  assert.equal(rows[0].bucketOver90, 0);
});
test('FX revaluation uses permanent vouchers only and computes the current-rate difference', () => {
  const voucher = (id: string, status: 'draft' | 'permanent', debit: number) => ({
    id, ownerId: 'o1', voucherNumber: 1, date: '1405/08/01', description: 'ارزی', voucherType: 'general', status,
    totalDebit: debit, totalCredit: debit, currencyCode: 'USD', exchangeRate: 500000,
    lines: [{ accountCode: '10201', accountTitle: 'بانک ارزی', description: 'واریز', debit, credit: 0, foreignDebit: 10, foreignCredit: 0 }],
  });
  const rows = computeFxRevaluationReport(
    [voucher('draft', 'draft', 5000000), voucher('posted', 'permanent', 5000000)] as any,
    [], [{ id: 'usd', ownerId: 'o1', code: 'USD', name: 'دلار', symbol: '$', isBase: false, decimalPlaces: 2, defaultRateToIrr: 600000, active: true }] as any,
    '1405/09/01',
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].netForeignBalance, 10);
  assert.equal(rows[0].revaluationDiffIrr, 1000000);
});
test('straight-line depreciation never exceeds depreciable base or salvage value', () => {
  const asset = { id: 'a1', ownerId: 'o1', assetCode: 'FA-1', title: 'تجهیزات', purchaseDate: '1405/01/01', purchaseCost: 1200, salvageValue: 120, usefulLifeYears: 5, accumulatedDepreciation: 1070 };
  assert.equal(calculateMonthlyDepreciation(asset as any), 10);
  assert.equal(calculateMonthlyDepreciation({ ...asset, accumulatedDepreciation: 1080 } as any), 0);
  assert.equal(calculateMonthlyDepreciation({ ...asset, salvageValue: 1300 } as any), 0);
  assert.equal(calculateMonthlyDepreciation({ ...asset, usefulLifeYears: 0 } as any), 0);
});
test('payables aging uses supplier balances, purchase invoices and due dates', () => {
  const supplier = { id: 's1', ownerId: 'o1', code: 'S1', name: 'تأمین‌کننده نمونه', partyType: 'supplier', creditLimit: 0, openingBalance: 0, accountCode: '2101' };
  const purchase = { id: 'buy1', ownerId: 'o1', invoiceNumber: 'P-1', invoiceType: 'purchase', date: '1405/07/15', dueDate: '1405/07/15',
    partyId: 's1', partyName: 'تأمین‌کننده نمونه', warehouse: 'انبار', subtotal: 900, discount: 0, vatAmount: 0, grandTotal: 900,
    paidCash: 700, paidBank: 0, paidCheque: 0, creditAmount: 200, status: 'issued', items: [] };
  const rows = computePayablesAging([supplier] as any, [purchase] as any, new Map([['s1', -200]]), '1405/09/01');
  assert.equal(rows[0].totalPayable, 200);
  assert.equal(rows[0].bucket31to60, 200);
  assert.equal(rows[0].bucketOver90, 0);
});
test('atomic financial plan rejects unbalanced and duplicate side effects', () => {
  const valid = { operationId: 'op', idempotencyKey: 'idem', debitTotal: 100, creditTotal: 100,
    stockMovements: [{ id: 'move-1', productId: 'p1', quantityDelta: -2 }], documentIds: ['invoice-1'] };
  assert.doesNotThrow(() => validateAtomicFinancialPlan(valid));
  assert.throws(() => validateAtomicFinancialPlan({ ...valid, creditTotal: 99 }), /تراز نیست/);
  assert.throws(() => validateAtomicFinancialPlan({ ...valid, documentIds: ['move-1'] }), /تکراری/);
});

test('bank reconciliation leaves ambiguous matches for manual review', () => {
  const daysBetween = (a: string, b: string) =>
    Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  const result = reconcileBankLines(
    [{ id: 's1', accountId: 'bank1', date: '2026-11-20', amount: 500 }],
    [
      { id: 'l1', accountId: 'bank1', date: '2026-11-20', amount: 500 },
      { id: 'l2', accountId: 'bank1', date: '2026-11-21', amount: 500 },
    ],
    2, daysBetween,
  );
  assert.deepEqual(result.ambiguousStatementIds, ['s1']);
  assert.equal(result.matches.length, 0);
  assert.deepEqual(result.unmatchedLedgerIds, ['l1', 'l2']);
});

test('bank reconciliation never reuses a ledger line and prefers an exact reference', () => {
  const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  const referenced = reconcileBankLines(
    [{ id: 's-ref', accountId: 'bank', date: '2026-11-30', amount: 750, reference: 'trace-9' }],
    [{ id: 'l-ref', accountId: 'bank', date: '2026-11-20', amount: 750, reference: 'trace-9' }],
    1, daysBetween,
  );
  assert.deepEqual(referenced.matches, [{ statementLineId: 's-ref', ledgerLineId: 'l-ref', matchType: 'reference' }]);
  const duplicateStatement = reconcileBankLines(
    [{ id: 's1', accountId: 'bank', date: '2026-11-20', amount: 500 }, { id: 's2', accountId: 'bank', date: '2026-11-20', amount: 500 }],
    [{ id: 'l1', accountId: 'bank', date: '2026-11-20', amount: 500 }],
    0, daysBetween,
  );
  assert.equal(duplicateStatement.matches.length, 1);
  assert.equal(duplicateStatement.unmatchedStatementIds.length, 1);
  assert.deepEqual(duplicateStatement.unmatchedLedgerIds, []);
});
test('treasury audit detects missing, duplicate and mismatched vouchers', () => {
  const issues = auditTreasuryVoucherLinks(
    [{ id: 't1', amount: 100 }, { id: 't2', amount: 200 }, { id: 't3', amount: 300 }],
    [
      { id: 'v2a', referenceId: 't2', totalDebit: 200, totalCredit: 200 },
      { id: 'v2b', referenceId: 't2', totalDebit: 200, totalCredit: 200 },
      { id: 'v3', referenceId: 't3', totalDebit: 300, totalCredit: 299 },
    ],
  );
  assert.deepEqual(issues, [
    { transactionId: 't1', kind: 'missing-voucher' },
    { transactionId: 't2', kind: 'duplicate-voucher' },
    { transactionId: 't3', kind: 'amount-mismatch' },
  ]);
});

test('straight-line depreciation never exceeds depreciable base or salvage value', () => {
  const asset = { id: 'a1', ownerId: 'o1', assetCode: 'FA-1', title: 'تجهیزات', purchaseDate: '2026/01/01', purchaseCost: 1200, salvageValue: 120, usefulLifeYears: 5, accumulatedDepreciation: 1070 };
  assert.equal(calculateMonthlyDepreciation(asset as any), 10);
  assert.equal(calculateMonthlyDepreciation({ ...asset, accumulatedDepreciation: 1080 } as any), 0);
  assert.equal(calculateMonthlyDepreciation({ ...asset, salvageValue: 1300 } as any), 0);
});
test('payables aging uses supplier balances, purchase invoices and due dates', () => {
  const supplier = { id: 's1', ownerId: 'o1', code: 'S1', name: 'تأمین‌کننده نمونه', partyType: 'supplier', creditLimit: 0, openingBalance: 0, accountCode: '2101' };
  const purchase = { id: 'buy1', ownerId: 'o1', invoiceNumber: 'P-1', invoiceType: 'purchase', date: '1405/07/15', dueDate: '1405/07/15',
    partyId: 's1', partyName: 'تأمین‌کننده نمونه', warehouse: 'انبار', subtotal: 900, discount: 0, vatAmount: 0, grandTotal: 900,
    paidCash: 700, paidBank: 0, paidCheque: 0, creditAmount: 200, status: 'issued', items: [] };
  const rows = computePayablesAging([supplier] as any, [purchase] as any, new Map([['s1', -200]]), '1405/09/01');
  assert.equal(rows[0].totalPayable, 200);
  assert.equal(rows[0].bucket31to60, 200);
  assert.equal(rows[0].bucketOver90, 0);
});
test('atomic financial plan rejects unbalanced and duplicate side effects', () => {
  const valid = { operationId: 'op', idempotencyKey: 'idem', debitTotal: 100, creditTotal: 100,
    stockMovements: [{ id: 'move-1', productId: 'p1', quantityDelta: -2 }], documentIds: ['invoice-1'] };
  assert.doesNotThrow(() => validateAtomicFinancialPlan(valid));
  assert.throws(() => validateAtomicFinancialPlan({ ...valid, creditTotal: 99 }), /تراز نیست/);
  assert.throws(() => validateAtomicFinancialPlan({ ...valid, documentIds: ['move-1'] }), /تکراری/);
});

test('bank reconciliation leaves ambiguous matches for manual review', () => {
  const daysBetween = (a: string, b: string) =>
    Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  const result = reconcileBankLines(
    [{ id: 's1', accountId: 'bank1', date: '2026-11-20', amount: 500 }],
    [
      { id: 'l1', accountId: 'bank1', date: '2026-11-20', amount: 500 },
      { id: 'l2', accountId: 'bank1', date: '2026-11-21', amount: 500 },
    ],
    2, daysBetween,
  );
  assert.deepEqual(result.ambiguousStatementIds, ['s1']);
  assert.equal(result.matches.length, 0);
  assert.deepEqual(result.unmatchedLedgerIds, ['l1', 'l2']);
});

test('bank reconciliation never reuses a ledger line and prefers an exact reference', () => {
  const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  const referenced = reconcileBankLines(
    [{ id: 's-ref', accountId: 'bank', date: '2026-11-30', amount: 750, reference: 'trace-9' }],
    [{ id: 'l-ref', accountId: 'bank', date: '2026-11-20', amount: 750, reference: 'trace-9' }],
    1, daysBetween,
  );
  assert.deepEqual(referenced.matches, [{ statementLineId: 's-ref', ledgerLineId: 'l-ref', matchType: 'reference' }]);
  const duplicateStatement = reconcileBankLines(
    [{ id: 's1', accountId: 'bank', date: '2026-11-20', amount: 500 }, { id: 's2', accountId: 'bank', date: '2026-11-20', amount: 500 }],
    [{ id: 'l1', accountId: 'bank', date: '2026-11-20', amount: 500 }],
    0, daysBetween,
  );
  assert.equal(duplicateStatement.matches.length, 1);
  assert.equal(duplicateStatement.unmatchedStatementIds.length, 1);
  assert.deepEqual(duplicateStatement.unmatchedLedgerIds, []);
});
test('treasury audit detects missing, duplicate and mismatched vouchers', () => {
  const issues = auditTreasuryVoucherLinks(
    [{ id: 't1', amount: 100 }, { id: 't2', amount: 200 }, { id: 't3', amount: 300 }],
    [
      { id: 'v2a', referenceId: 't2', totalDebit: 200, totalCredit: 200 },
      { id: 'v2b', referenceId: 't2', totalDebit: 200, totalCredit: 200 },
      { id: 'v3', referenceId: 't3', totalDebit: 300, totalCredit: 299 },
    ],
  );
  assert.deepEqual(issues, [
    { transactionId: 't1', kind: 'missing-voucher' },
    { transactionId: 't2', kind: 'duplicate-voucher' },
    { transactionId: 't3', kind: 'amount-mismatch' },
  ]);
});


test('payroll calculation applies insurance, exemption and progressive tax consistently', () => {
  const employee = {
    id: 'e1', ownerId: 'o1', personnelCode: 'P001', fullName: 'کارمند نمونه',
    department: 'مالی', baseSalary: 400_000_000, housingAllowance: 0,
    foodAllowance: 0, childrenCount: 0, overtimeHours: 0, active: true,
  };
  const result = calculateEmployeePayroll(employee);
  assert.equal(result.grossPay, 400_000_000);
  assert.equal(result.employeeInsurance, 28_000_000);
  assert.equal(result.employerInsurance, 92_000_000);
  assert.equal(result.incomeTax, 14_800_000);
  assert.equal(result.netPay, 357_200_000);
  assert.equal(result.totalEmployerCost, 492_000_000);
});

test('payroll calculation rejects invalid negative, non-finite and fractional employee inputs', () => {
  const employee = {
    id: 'e1', ownerId: 'o1', personnelCode: 'P001', fullName: 'کارمند نمونه',
    department: 'مالی', baseSalary: 220_000_000, housingAllowance: 0,
    foodAllowance: 0, childrenCount: 0, overtimeHours: 0, active: true,
  };
  assert.throws(() => calculateEmployeePayroll({ ...employee, baseSalary: -1 }), /حقوق پایه/);
  assert.throws(() => calculateEmployeePayroll({ ...employee, overtimeHours: Number.NaN }), /اضافه‌کاری/);
  assert.throws(() => calculateEmployeePayroll({ ...employee, housingAllowance: Number.POSITIVE_INFINITY }), /مسکن/);
  assert.throws(() => calculateEmployeePayroll({ ...employee, childrenCount: 1.5 }), /عدد صحیح/);
});


test('import landed-cost allocation reconciles exact overhead and rejects malformed inputs', () => {
  const items = [
    { productId: 'p1', sku: 'Y-1', productName: 'نخ یک', lotNumber: 'L1', weightKg: 60, cartonCount: 3, foreignUnitPrice: 2 },
    { productId: 'p2', sku: 'Y-2', productName: 'نخ دو', lotNumber: 'L2', weightKg: 40, cartonCount: 2, foreignUnitPrice: 3 },
  ];
  const costs = [{ id: 'c1', title: 'حمل', amountIrr: 1000, accountCode: '10201' }];
  const result = calculateLandedCostAllocation(items as any, costs as any, 500_000, 'weight');
  assert.equal(result.totalLandedCostsIrr, 1000);
  assert.equal(result.computedItems.reduce((sum, item) => sum + item.allocatedLandedCostIrr, 0), 1000);
  assert.equal(result.grandTotalLandedIrr, result.totalFobIrr + 1000);
  assert.throws(() => calculateLandedCostAllocation(items as any, costs as any, 0, 'weight'), /نرخ تبدیل/);
  assert.throws(() => calculateLandedCostAllocation([{ ...items[0], weightKg: -1 }] as any, costs as any, 500_000, 'weight'), /وزن/);
  assert.throws(() => calculateLandedCostAllocation(items as any, [{ ...costs[0], amountIrr: -1 }] as any, 500_000, 'weight'), /هزینه‌های جانبی/);
});


test('draft vouchers never affect posted trial balance, general ledger or party balances', () => {
  const voucher = (id: string, status: 'draft' | 'permanent', amount: number) => ({
    id, ownerId: 'o1', voucherNumber: id === 'draft' ? 2 : 1, date: '1405/08/01',
    description: id, voucherType: 'general', status, totalDebit: amount, totalCredit: amount,
    lines: [
      { accountCode: '10201', accountTitle: 'بانک', description: id, debit: amount, credit: 0 },
      { accountCode: '10401', accountTitle: 'مشتری', partyId: 'p1', partyName: 'مشتری', description: id, debit: 0, credit: amount },
    ],
  });
  const vouchers = [voucher('posted', 'permanent', 100), voucher('draft', 'draft', 900)] as any;
  const trial = computeTrialBalance([], vouchers);
  assert.equal(trial.find((row) => row.accountCode === '10201')?.periodDebit, 100);
  assert.equal(computeAccountLedger('10201', vouchers).length, 1);
  assert.equal(computePartyLedger('p1', vouchers).length, 1);
  assert.equal(computePartyBalances([{ id: 'p1' }] as any, vouchers).get('p1'), -100);
});


test('audit ignores draft party postings in GL reconciliation and flags duplicate cheque IDs', () => {
  const draft = {
    id: 'draft', ownerId: 'o1', voucherNumber: 1, date: '1405/08/01', description: 'پیش‌نویس',
    voucherType: 'general', status: 'draft', totalDebit: 100, totalCredit: 100,
    lines: [{ accountCode: '10401', accountTitle: 'مشتریان', partyId: 'p1', partyName: 'مشتری', description: 'پیش‌نویس', debit: 100, credit: 0 },
      { accountCode: '30101', accountTitle: 'تأمین‌کنندگان', partyId: 'p1', partyName: 'مشتری', description: 'پیش‌نویس', debit: 0, credit: 100 }],
  };
  const report = computeAuditReport({
    accounts: [], vouchers: [draft] as any, invoices: [], parties: [], products: [],
    cheques: [
      { id: 'c1', sayadiId: 'SAY-1', serial: '1', amount: 0, partyId: 'p1', partyName: 'مشتری', status: 'in_box' },
      { id: 'c2', sayadiId: 'SAY-1', serial: '2', amount: 100, partyId: 'p1', partyName: 'مشتری', status: 'in_box' },
    ] as any,
    trialBalance: [], balanceSheet: {
      isBalanced: true, difference: 0, totalAssets: 0, totalLiabilities: 0, totalEquity: 0,
      assets: [], liabilities: [], equity: [], currentPeriodProfit: 0,
    } as any,
    partyBalances: new Map(),
  });
  assert.equal(report.checks.find((check) => check.id === 'sub-gl-reconcile')?.status, 'pass');
  const operational = report.checks.find((check) => check.id === 'operational-controls');
  assert.ok(operational?.details.some((detail) => detail.includes('SAY-1')));
  assert.ok(operational?.details.some((detail) => detail.includes('مبلغ معتبر')));
});
