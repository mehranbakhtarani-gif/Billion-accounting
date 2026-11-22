import test from 'node:test';
import assert from 'node:assert/strict';
import { shamsiToGregorianIso } from '../src/lib/format';
import {
  allocateStockFIFO,
  reconcileInventoryLotLedger,
  calculateLotReturnableQuantity,
  calculateLotReturnedQuantity,
  assertSufficientStock,
  assertFiscalPeriodOpen,
  auditTreasuryVoucherLinks,
  validateTreasuryOperationPayload,
  validateTreasuryAccountSelection,
  validateTreasuryTransferAccounts,
  validateChequeDateRange,
  validateJalaliDate,
  validatePartyTreasuryAccount,
  validateImportLandedCostPayload,
  aggregateStockReservations,
  collectActiveStockReservations,
  getChequeStatusTransitionError,
  classifySyncOperation,
  computeOpenItemAging,
  reconcileBankLines,
  parseCsvRow,
  parseCsvRecords,
  getInvoiceStockDirection,
  getInvoiceCancellationBlockReason,
  validateAtomicFinancialPlan,
  validateSyncOperation,
  validateJournalEntryPayload,
  validateSalesOrderDispatchQuantities,
  validateInvoicePaymentAllocations,
  buildInvoiceAllocationReversal,
} from '../src/lib/enterpriseControls.ts';
import { calculateLandedCostAllocation, computeReceivablesAging, computePayablesAging, computeFxRevaluationReport } from '../src/lib/enterpriseAccounting.ts';
import { buildInvoiceVoucherLines, calculateEmployeePayroll, calculateMonthlyDepreciation, computeAccountLedger, computeAuditReport, computePartyBalances, computePartyLedger, computeTrialBalance, computeInventoryValuation } from '../src/lib/accountingEngine.ts';

test('CSV parser preserves quoted commas and escaped quotes', () => {
  assert.deepEqual(parseCsvRow('1405/09/01,"کارمزد، انتقال, فوری","شناسه ""ABC""",1250,0'), ['1405/09/01', 'کارمزد، انتقال, فوری', 'شناسه "ABC"', '1250', '0']);
});

test('bank CSV parser preserves BOM, quoted multiline descriptions and rejects malformed records', () => {
  assert.deepEqual(parseCsvRecords('\uFEFF1405/09/02,"واریز, فروش",100,0,REF-1\r\n1405/09/03,"شرح ""ویژه""\nچندخطی",0,200,REF-2'), [
    ['1405/09/02', 'واریز, فروش', '100', '0', 'REF-1'],
    ['1405/09/03', 'شرح "ویژه"\nچندخطی', '0', '200', 'REF-2'],
  ]);
  assert.throws(() => parseCsvRecords('1405/09/02,"نقل قول ناقص,100'), /بسته نشده/);
});

test('invoice types apply symmetrical stock movement and cancellation directions', () => {
  assert.equal(getInvoiceStockDirection('sale'), -1);
  assert.equal(getInvoiceStockDirection('purchase_return'), -1);
  assert.equal(getInvoiceStockDirection('waste'), -1);
  assert.equal(getInvoiceStockDirection('purchase'), 1);
  assert.equal(getInvoiceStockDirection('sale_return'), 1);
  assert.equal(getInvoiceStockDirection('proforma'), 0);
  assert.throws(() => getInvoiceStockDirection('unknown'), /معتبر نیست/);
});

test('invoice cancellation blocks settled invoices and payment allocations before stock changes', () => {
  const base = { status: 'issued', paidCash: 0, paidBank: 0, paidCheque: 0, paymentAllocations: [] as unknown[] };
  assert.equal(getInvoiceCancellationBlockReason(base), null);
  assert.match(getInvoiceCancellationBlockReason({ ...base, paidCash: 100 }) || '', /دارای تسویه/);
  assert.match(getInvoiceCancellationBlockReason({ ...base, status: 'settled' }) || '', /دارای تسویه/);
  assert.match(getInvoiceCancellationBlockReason({ ...base, paymentAllocations: [{ id: 'allocation-1' }] }) || '', /تخصیص‌های دریافت/);
});

test('sale and purchase returns create balanced reversal-side accounting entries', () => {
  const base = {
    invoiceNumber: 'RET-1', date: '1405/09/01', dueDate: '1405/09/01', partyId: 'party-1',
    partyName: 'طرف حساب آزمایشی', warehouse: 'انبار مرکزی', subtotal: 100, discount: 0,
    vatAmount: 10, grandTotal: 110, paidCash: 110, paidBank: 0, paidCheque: 0,
    creditAmount: 0, status: 'issued', items: [],
  };
  const saleReturn = buildInvoiceVoucherLines({ ...base, invoiceType: 'sale_return' } as any, 60);
  assert.deepEqual(saleReturn.filter((line) => ['60201','30301','10101','10501','70101'].includes(line.accountCode))
    .map((line) => [line.accountCode, line.debit, line.credit]), [
      ['60201', 100, 0], ['30301', 10, 0], ['10101', 0, 110], ['10501', 60, 0], ['70101', 0, 60],
    ]);
  assert.equal(saleReturn.reduce((sum, line) => sum + line.debit, 0), saleReturn.reduce((sum, line) => sum + line.credit, 0));

  const purchaseReturn = buildInvoiceVoucherLines({ ...base, invoiceType: 'purchase_return' } as any, 0);
  assert.deepEqual(purchaseReturn.map((line) => [line.accountCode, line.debit, line.credit]), [
    ['10101', 110, 0], ['10501', 0, 100], ['30302', 0, 10],
  ]);
  assert.equal(purchaseReturn.reduce((sum, line) => sum + line.debit, 0), purchaseReturn.reduce((sum, line) => sum + line.credit, 0));

  const fifoPurchaseReturn = buildInvoiceVoucherLines({ ...base, invoiceType: 'purchase_return' } as any, 60);
  assert.deepEqual(fifoPurchaseReturn.map((line) => [line.accountCode, line.debit, line.credit]), [
    ['10101', 110, 0], ['10501', 0, 60], ['60301', 0, 40], ['30302', 0, 10],
  ]);
  assert.equal(fifoPurchaseReturn.reduce((sum, line) => sum + line.debit, 0), fifoPurchaseReturn.reduce((sum, line) => sum + line.credit, 0));

  const adversePurchaseReturn = buildInvoiceVoucherLines({ ...base, invoiceType: 'purchase_return' } as any, 120);
  assert.deepEqual(adversePurchaseReturn.map((line) => [line.accountCode, line.debit, line.credit]), [
    ['10101', 110, 0], ['10501', 0, 120], ['80401', 20, 0], ['30302', 0, 10],
  ]);
  assert.equal(adversePurchaseReturn.reduce((sum, line) => sum + line.debit, 0), adversePurchaseReturn.reduce((sum, line) => sum + line.credit, 0));
});

test('inventory valuation uses moving weighted average and reconciles current stock', () => {
  const product = {
    id: 'p-1', ownerId: 'u-1', sku: 'YARN-1', name: 'نخ آزمایشی', category: 'نخ',
    warehouse: 'انبار مرکزی', unit: 'کیلوگرم', buyPrice: 100, sellPrice: 300,
    stock: 15, reorderPoint: 0, vatExempt: false,
  };
  const base = {
    ownerId: 'u-1', date: '1405/01/01', dueDate: '1405/01/01', partyId: 'v-1',
    partyName: 'تأمین‌کننده', warehouse: 'انبار مرکزی', subtotal: 0, discount: 0,
    vatAmount: 0, grandTotal: 0, paidCash: 0, paidBank: 0, paidCheque: 0,
    creditAmount: 0, status: 'issued', items: [],
  };
  const invoices = [
    { ...base, id: 'i-1', invoiceNumber: '1', invoiceType: 'purchase', items: [{ productId: 'p-1', sku: 'YARN-1', productName: 'نخ آزمایشی', unit: 'کیلوگرم', quantity: 10, unitPrice: 200, discount: 0, vatAmount: 0, lineTotal: 2000 }] },
    { ...base, id: 'i-2', invoiceNumber: '2', invoiceType: 'sale', date: '1405/01/02', items: [{ productId: 'p-1', sku: 'YARN-1', productName: 'نخ آزمایشی', unit: 'کیلوگرم', quantity: 5, unitPrice: 300, discount: 0, vatAmount: 0, lineTotal: 1500 }] },
  ] as any;
  const [row] = computeInventoryValuation([product], invoices);
  assert.equal(row.currentStock, 15);
  assert.equal(row.averageUnitCost, 150);
  assert.equal(row.inventoryValue, 2250);
  assert.equal(row.estimatedCogs, 750);
  assert.equal(row.netSalesRevenue, 1500);
  assert.equal(row.grossProfit, 750);
  assert.equal(row.reconciliationQty, 0);
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
    { id: 'future', productId: 'p1', warehouse: 'w1', lotNumber: 'L3', receivedDate: '2027-01-01', quantityReceived: 20, quantityRemaining: 20, unitCost: 90 },
  ];
  const result = allocateStockFIFO(lots, 8, { productId: 'p1', warehouse: 'w1', asOfDate: '2026-11-22' });
  assert.deepEqual(result.allocations.map((x) => [x.lotId, x.quantity]), [['old', 5], ['new', 3]]);
  assert.equal(result.totalCost, 920);
  assert.equal(result.weightedUnitCost, 115);
  assert.equal(result.remainingLots.find((x) => x.id === 'old')?.quantityRemaining, 0);
  assert.equal(result.remainingLots.find((x) => x.id === 'expired')?.quantityRemaining, 7);
  assert.equal(result.remainingLots.find((x) => x.id === 'future')?.quantityRemaining, 20);
  const wasteResult = allocateStockFIFO(lots, 1, { productId: 'p1', warehouse: 'w1', asOfDate: '2026-06-01', allowExpired: true });
  assert.equal(wasteResult.allocations[0].lotId, 'expired');
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

test('Jalali dates convert to Gregorian ISO for FIFO transaction chronology', () => {
  assert.equal(shamsiToGregorianIso('1405/09/01'), '2026-11-22');
  assert.equal(shamsiToGregorianIso('1405/01/01'), '2026-03-21');
  assert.equal(shamsiToGregorianIso('1404/01/01'), '2025-03-21');
  assert.throws(() => shamsiToGregorianIso('1405/13/01'), /معتبر/);
  assert.throws(() => shamsiToGregorianIso('1405/12/30'), /معتبر/);
});

test('sales returns cannot exceed net sold quantity of the source lot', () => {
  const movements = [
    { id: 'sale-issue', lotId: 'lot-a', movementType: 'issue', referenceId: 'inv_sale_1', quantity: -5 },
    { id: 'return-in', lotId: 'return-lot-1', movementType: 'return', quantity: 2, sourceLotId: 'lot-a' },
  ];
  assert.equal(calculateLotReturnableQuantity('lot-a', movements), 3);
  assert.equal(calculateLotReturnableQuantity('lot-a', [
    { id: 'sub-issue', lotId: 'lot-a', movementType: 'issue', referenceId: 'sub_job_1', quantity: -10 },
  ]), 0);
  assert.equal(calculateLotReturnedQuantity('lot-a', movements), 2);
  assert.equal(calculateLotReturnableQuantity('lot-a', [
    ...movements,
    { id: 'return-reversal', lotId: 'return-lot-1', movementType: 'reversal', quantity: -2, sourceLotId: 'lot-a' },
  ]), 5);
  assert.equal(calculateLotReturnedQuantity('lot-a', [...movements, { id: 'return-reversal', lotId: 'return-lot-1', movementType: 'reversal', quantity: -2, sourceLotId: 'lot-a' }]), 0);
  assert.equal(calculateLotReturnableQuantity('lot-a', [
    ...movements,
    { id: 'sale-reversal', lotId: 'lot-a', movementType: 'reversal', quantity: 5, reversalOfMovementId: 'sale-issue' },
  ]), 0);
  assert.equal(calculateLotReturnableQuantity('lot-a', [
    { id: 'sale-issue', lotId: 'lot-a', movementType: 'issue', referenceId: 'inv_sale_1', quantity: -5 },
    { id: 'return-in', lotId: 'return-lot-1', movementType: 'return', quantity: 5, sourceLotId: 'lot-a' },
  ]), 0);
});

test('inventory lot balances reconcile to append-only receipts, issues and reversals', () => {
  const lots = [
    { id: 'lot-a', productId: 'p1', warehouse: 'w1', lotNumber: 'A', receivedDate: '2026-01-01', quantityReceived: 10, quantityRemaining: 8, unitCost: 100 },
    { id: 'lot-b', productId: 'p1', warehouse: 'w1', lotNumber: 'B', receivedDate: '2026-02-01', quantityReceived: 4, quantityRemaining: 4, unitCost: 120 },
  ];
  const movements = [
    { id: 'm1', lotId: 'lot-a', movementType: 'receipt' as const, quantity: 10 },
    { id: 'm2', lotId: 'lot-a', movementType: 'issue' as const, quantity: -3 },
    { id: 'm3', lotId: 'lot-a', movementType: 'reversal' as const, quantity: 1 },
    { id: 'm4', lotId: 'lot-b', movementType: 'receipt' as const, quantity: 4 },
  ];
  assert.deepEqual(reconcileInventoryLotLedger(lots, movements), []);
  assert.deepEqual(reconcileInventoryLotLedger([{ ...lots[0], quantityRemaining: 7 }, lots[1]], movements), [
    { lotId: 'lot-a', expectedRemaining: 8, actualRemaining: 7, difference: -1 },
  ]);
  assert.throws(() => reconcileInventoryLotLedger(lots, [...movements, { id: 'm1', lotId: 'lot-a', movementType: 'issue', quantity: -1 }]), /تکراری/);
  assert.throws(() => reconcileInventoryLotLedger(lots, [{ id: 'bad', lotId: 'lot-a', movementType: 'issue', quantity: 1 }]), /منفی/);
  assert.throws(() => reconcileInventoryLotLedger(lots, [{ id: 'orphan', lotId: 'missing', movementType: 'receipt', quantity: 1 }]), /ناشناخته/);
  assert.throws(() => reconcileInventoryLotLedger([lots[0]], []), /گردش ورود اولیه/);
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
  assert.equal(rows[0].ledgerDifference, 0);
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
  assert.equal(rows[0].ledgerDifference, 0);
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
  const bankReferenceWithoutLedgerReference = reconcileBankLines(
    [{ id: 's-bank-ref', accountId: 'bank', date: '2026-11-20', amount: 500, reference: 'bank-trace-1' }],
    [{ id: 'l-no-ref', accountId: 'bank', date: '2026-11-20', amount: 500 }],
    0, daysBetween,
  );
  assert.deepEqual(bankReferenceWithoutLedgerReference.matches, [
    { statementLineId: 's-bank-ref', ledgerLineId: 'l-no-ref', matchType: 'exact-amount-date' },
  ]);
  const duplicateStatement = reconcileBankLines(
    [{ id: 's1', accountId: 'bank', date: '2026-11-20', amount: 500 }, { id: 's2', accountId: 'bank', date: '2026-11-20', amount: 500 }],
    [{ id: 'l1', accountId: 'bank', date: '2026-11-20', amount: 500 }],
    0, daysBetween,
  );
  assert.deepEqual(duplicateStatement.matches, []);
  assert.deepEqual(duplicateStatement.unmatchedStatementIds, []);
  assert.deepEqual(duplicateStatement.ambiguousStatementIds, ['s1', 's2']);
  assert.deepEqual(duplicateStatement.unmatchedLedgerIds, ['l1']);
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
  assert.deepEqual(duplicateStatement.matches, []);
  assert.deepEqual(duplicateStatement.unmatchedStatementIds, []);
  assert.deepEqual(duplicateStatement.ambiguousStatementIds, ['s1', 's2']);
  assert.deepEqual(duplicateStatement.unmatchedLedgerIds, ['l1']);
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


test('journal payload validation rejects invalid dates, lines and one-sided entries', () => {
  const valid = {
    date: '1405/08/22',
    description: 'سند آزمایشی',
    lines: [
      { accountCode: '10201', debit: 100, credit: 0 },
      { accountCode: '40101', debit: 0, credit: 100 },
    ],
  };
  assert.doesNotThrow(() => validateJournalEntryPayload(valid));
  assert.throws(() => validateJournalEntryPayload({ ...valid, lines: [{ accountCode: '10201', debit: 100, credit: 0 }, { accountCode: '40101', debit: 0, credit: 90 }] }), /تراز نیست/);
  assert.throws(() => validateJournalEntryPayload({ ...valid, date: '1405/13/01' }), /تاریخ/);
  assert.throws(() => validateJournalEntryPayload({ ...valid, description: ' ' }), /شرح/);
  assert.throws(() => validateJournalEntryPayload({ ...valid, lines: [{ accountCode: '10201', debit: 0, credit: 0 }, valid.lines[1]] }), /معتبر نیست/);
  assert.throws(() => validateJournalEntryPayload({ ...valid, lines: [{ accountCode: '10201', debit: -1, credit: 0 }, valid.lines[1]] }), /معتبر نیست/);
  assert.throws(() => validateJournalEntryPayload({ ...valid, lines: [{ accountCode: '10201', debit: 100, credit: 100 }, valid.lines[1]] }), /معتبر نیست/);
  assert.throws(() => validateJournalEntryPayload({ ...valid, lines: Array.from({ length: 101 }, () => valid.lines[0]) }), /۱۰۰ ردیف/);
});

test('cheque status transitions reject financially unsupported paths', () => {
  assert.equal(getChequeStatusTransitionError('receivable', 'in_box', 'deposited'), null);
  assert.equal(getChequeStatusTransitionError('receivable', 'deposited', 'cleared'), null);
  assert.equal(getChequeStatusTransitionError('receivable', 'bounced', 'in_box'), null);
  assert.equal(getChequeStatusTransitionError('payable', 'cleared', 'in_box'), null);
  assert.match(getChequeStatusTransitionError('receivable', 'endorsed', 'cleared') || '', /واگذارشده/);
  assert.match(getChequeStatusTransitionError('payable', 'in_box', 'endorsed') || '', /مجاز نیست/);
  assert.match(getChequeStatusTransitionError('receivable', 'cancelled', 'in_box') || '', /مجاز نیست/);
});

test('bank reconciliation resolves forced matches independent of statement order', () => {
  const days = (from: string, to: string) => Math.abs(Date.parse(to) - Date.parse(from)) / 86400000;
  const statement = [
    { id: 's-ambiguous', accountId: 'bank', date: '2026-11-20', amount: 500 },
    { id: 's-forced', accountId: 'bank', date: '2026-11-20', amount: 500, reference: 'unique-ref' },
  ];
  const ledger = [
    { id: 'l-shared', accountId: 'bank', date: '2026-11-20', amount: 500, reference: 'other-ref' },
    { id: 'l-forced', accountId: 'bank', date: '2026-11-20', amount: 500, reference: 'unique-ref' },
  ];
  const result = reconcileBankLines(statement, ledger, 0, days);
  assert.deepEqual(result.matches, [
    { statementLineId: 's-forced', ledgerLineId: 'l-forced', matchType: 'reference' },
    { statementLineId: 's-ambiguous', ledgerLineId: 'l-shared', matchType: 'exact-amount-date' },
  ]);
  assert.deepEqual(result.ambiguousStatementIds, []);
});

test('bank reconciliation does not arbitrarily choose between competing singleton rows', () => {
  const days = (from: string, to: string) => from === to ? 0 : 1;
  const result = reconcileBankLines(
    [
      { id: 's1', accountId: 'bank', date: '2026-11-20', amount: 500 },
      { id: 's2', accountId: 'bank', date: '2026-11-20', amount: 500 },
    ],
    [{ id: 'l1', accountId: 'bank', date: '2026-11-20', amount: 500 }],
    0, days,
  );
  assert.deepEqual(result.matches, []);
  assert.deepEqual(result.ambiguousStatementIds, ['s1', 's2']);
});

test('bank reconciliation validates input and prevents duplicate line identities', () => {
  const statement = [{ id: 's1', accountId: '10201', date: '1405/08/01', amount: 100 }];
  const ledger = [{ id: 'l1', accountId: '10201', date: '1405/08/01', amount: 100 }];
  const days = (from: string, to: string) => from === to ? 0 : 1;
  assert.equal(reconcileBankLines(statement, ledger, 0, days).matches.length, 1);
  assert.throws(() => reconcileBankLines([...statement, ...statement], ledger, 0, days), /شناسه تکراری/);
  assert.throws(() => reconcileBankLines(statement, [...ledger, ...ledger], 0, days), /شناسه تکراری/);
  assert.throws(() => reconcileBankLines(statement, ledger, -1, days), /عدد صحیح و نامنفی/);
  assert.throws(() => reconcileBankLines([{ ...statement[0], amount: Number.NaN }], ledger, 0, days), /معتبر نیست/);
});


test('treasury operation validation rejects invalid date, amount and description', () => {
  const valid = { date: '1405/08/22', amount: 250, description: 'دریافت بابت فروش' };
  assert.doesNotThrow(() => validateTreasuryOperationPayload(valid));
  assert.doesNotThrow(() => validateTreasuryOperationPayload({ ...valid, date: '1403/12/30' }));
  assert.throws(() => validateTreasuryOperationPayload({ ...valid, date: '1405/12/30' }), /تاریخ/);
  assert.throws(() => validateTreasuryOperationPayload({ ...valid, date: '1405/12/31' }), /تاریخ/);
  assert.throws(() => validateTreasuryOperationPayload({ ...valid, amount: 0 }), /مبلغ/);
  assert.throws(() => validateTreasuryOperationPayload({ ...valid, amount: Number.NaN }), /مبلغ/);
  assert.throws(() => validateTreasuryOperationPayload({ ...valid, description: '  ' }), /شرح/);
});

test('Jalali date validation accepts leap Esfand and rejects invalid month days', () => {
  assert.doesNotThrow(() => validateJalaliDate('1403/12/30', 'تاریخ خرید'));
  assert.throws(() => validateJalaliDate('1405/12/30', 'تاریخ خرید'), /تاریخ خرید شمسی معتبر نیست/);
  assert.throws(() => validateJalaliDate('1405/13/01', 'تاریخ خرید'), /تاریخ خرید شمسی معتبر نیست/);
});

test('cheque dates validate Jalali leap days and issue-before-due ordering', () => {
  assert.doesNotThrow(() => validateChequeDateRange('1403/12/30', '1404/01/02'));
  assert.throws(() => validateChequeDateRange('1405/12/30', '1406/01/02'), /شمسی معتبر نیست/);
  assert.throws(() => validateChequeDateRange('1405/08/10', '1405/08/09'), /قبل از تاریخ صدور/);
});

test('stock reservations aggregate across sales orders and subcontract jobs', () => {
  const reserved = aggregateStockReservations([
    { productId: 'raw-1', quantity: 30 },
    { productId: 'raw-1', quantity: 20 },
    { productId: 'raw-2', quantity: 7.5 },
  ]);
  assert.equal(reserved.get('raw-1'), 50);
  assert.equal(reserved.get('raw-2'), 7.5);
  assert.throws(() => aggregateStockReservations([{ productId: 'raw-1', quantity: -1 }]), /رزرو موجودی/);
  assert.throws(() => aggregateStockReservations([{ productId: '', quantity: 1 }]), /رزرو موجودی/);
});

test('active stock reservations include dispatched sales and sent subcontract jobs with operation exclusions', () => {
  const reserved = collectActiveStockReservations(
    [
      { id: 'so-1', status: 'dispatched', items: [{ productId: 'raw-1', actualWeighedKg: 12.5, orderedWeightKg: 15 }] },
      { id: 'so-2', status: 'dispatched', items: [{ productId: 'raw-1', actualWeighedKg: 0, orderedWeightKg: 8 }] },
      { id: 'so-3', status: 'open', items: [{ productId: 'raw-2', actualWeighedKg: 5, orderedWeightKg: 5 }] },
    ],
    [
      { id: 'sub-1', status: 'sent', rawProductId: 'raw-1', sentWeightKg: 10 },
      { id: 'sub-2', status: 'completed', rawProductId: 'raw-2', sentWeightKg: 4 },
    ],
  );
  assert.equal(reserved.get('raw-1'), 30.5);
  assert.equal(reserved.has('raw-2'), false);

  const excludingCurrentSale = collectActiveStockReservations(
    [{ id: 'so-1', status: 'dispatched', items: [{ productId: 'raw-1', actualWeighedKg: 12.5, orderedWeightKg: 15 }] }],
    [{ id: 'sub-1', status: 'sent', rawProductId: 'raw-1', sentWeightKg: 10 }],
    { salesOrderId: 'so-1' },
  );
  assert.equal(excludingCurrentSale.get('raw-1'), 10);

  const excludingCurrentSubcontract = collectActiveStockReservations(
    [{ id: 'so-1', status: 'dispatched', items: [{ productId: 'raw-1', actualWeighedKg: 12.5, orderedWeightKg: 15 }] }],
    [{ id: 'sub-1', status: 'sent', rawProductId: 'raw-1', sentWeightKg: 10 }],
    { subcontractJobId: 'sub-1' },
  );
  assert.equal(excludingCurrentSubcontract.get('raw-1'), 12.5);
});

test('import landed cost ties foreign value, settlement costs and inventory item values', () => {
  const valid = {
    totalForeignAmount: 100,
    exchangeRate: 500000,
    totalFobIrr: 50000000,
    totalLandedCostsIrr: 5000000,
    grandTotalLandedIrr: 55000000,
    costs: [{ amountIrr: 3000000 }, { amountIrr: 2000000 }],
    items: [{ weightKg: 1000, finalUnitCostIrr: 55000 }],
  };
  assert.doesNotThrow(() => validateImportLandedCostPayload(valid));
  assert.throws(() => validateImportLandedCostPayload({ ...valid, totalFobIrr: 49000000 }), /نرخ تبدیل/);
  assert.throws(() => validateImportLandedCostPayload({ ...valid, grandTotalLandedIrr: 56000000 }), /هزینه‌های جانبی/);
  assert.throws(() => validateImportLandedCostPayload({ ...valid, items: [{ weightKg: 1000, finalUnitCostIrr: 54000 }] }), /ارزش ریالی اقلام/);
});

test('party treasury postings require a valid debtor or creditor moein account', () => {
  assert.doesNotThrow(() => validatePartyTreasuryAccount({ code: '10401', level: 'moein' }));
  assert.doesNotThrow(() => validatePartyTreasuryAccount({ code: '30101', level: 'moein' }));
  assert.throws(() => validatePartyTreasuryAccount(undefined), /حساب معین تفصیلی/);
  assert.throws(() => validatePartyTreasuryAccount({ code: '10201', level: 'moein' }), /حساب معین تفصیلی/);
  assert.throws(() => validatePartyTreasuryAccount({ code: '10401', level: 'kol' }), /حساب معین تفصیلی/);
});

test('treasury account validation requires an existing cash or bank moein account', () => {
  assert.doesNotThrow(() => validateTreasuryAccountSelection({ code: '10201', level: 'moein' }));
  assert.throws(() => validateTreasuryAccountSelection(undefined), /معتبر نیست/);
  assert.throws(() => validateTreasuryAccountSelection({ code: '30101', level: 'moein' }), /صندوق\/بانک/);
  assert.throws(() => validateTreasuryAccountSelection({ code: '10201', level: 'kol' }), /صندوق\/بانک/);
  assert.throws(() => validateTreasuryTransferAccounts(
    { code: '10201', level: 'moein' }, { code: '10201', level: 'moein' }
  ), /متفاوت باشند/);
});

test('journal validation uses exact Jalali month lengths and leap-year rules', () => {
  const valid = {
    date: '1405/08/22',
    description: 'سند آزمایشی',
    lines: [
      { accountCode: '10201', debit: 100, credit: 0 },
      { accountCode: '40101', debit: 0, credit: 100 },
    ],
  };
  assert.doesNotThrow(() => validateJournalEntryPayload(valid));
  assert.doesNotThrow(() => validateJournalEntryPayload({ ...valid, date: '1403/12/30' }));
  assert.throws(() => validateJournalEntryPayload({ ...valid, date: '1405/12/30' }), /تاریخ سند حسابداری شمسی معتبر نیست/);
  assert.throws(() => validateJournalEntryPayload({ ...valid, date: '1405/07/31' }), /تاریخ سند حسابداری شمسی معتبر نیست/);
});

test('sales dispatch cannot exceed ordered weight or hide negative and invalid scale weights', () => {
  const order = [
    { productId: 'yarn-1', orderedWeightKg: 100, actualWeighedKg: 0 },
    { productId: 'yarn-1', orderedWeightKg: 50, actualWeighedKg: 0 },
    { productId: 'yarn-2', orderedWeightKg: 20, actualWeighedKg: 0 },
  ];
  assert.deepEqual(validateSalesOrderDispatchQuantities(order, [
    { productId: 'yarn-1', orderedWeightKg: 80, actualWeighedKg: 80 },
    { productId: 'yarn-1', orderedWeightKg: 70, actualWeighedKg: 0 },
  ]), [{ productId: 'yarn-1', quantity: 150 }]);
  assert.throws(() => validateSalesOrderDispatchQuantities(order, [
    { productId: 'yarn-1', orderedWeightKg: 100, actualWeighedKg: 151 },
  ]), /وزن حواله کالا از وزن سفارش بیشتر است/);
  assert.throws(() => validateSalesOrderDispatchQuantities(order, [
    { productId: 'yarn-1', orderedWeightKg: 100, actualWeighedKg: -1 },
  ]), /وزن آن نامعتبر است/);
  assert.throws(() => validateSalesOrderDispatchQuantities(order, [
    { productId: 'unknown', orderedWeightKg: 1, actualWeighedKg: 1 },
  ]), /با سفارش اصلی تطابق ندارد/);
});


test('explicit invoice payment allocation validation supports partial and multi-invoice settlement', () => {
  const invoices = [
    { id: 's1', partyId: 'p1', invoiceType: 'sale', status: 'issued', creditAmount: 600 },
    { id: 's2', partyId: 'p1', invoiceType: 'sale', status: 'issued', creditAmount: 500 },
    { id: 'p1-inv', partyId: 'p1', invoiceType: 'purchase', status: 'issued', creditAmount: 900 },
  ];
  assert.deepEqual(validateInvoicePaymentAllocations({
    direction: 'receipt', partyId: 'p1', amount: 700,
    allocations: [{ invoiceId: 's1', amount: 200 }, { invoiceId: 's2', amount: 500 }],
    invoices,
  }), [{ invoiceId: 's1', amount: 200 }, { invoiceId: 's2', amount: 500 }]);
  assert.deepEqual(validateInvoicePaymentAllocations({
    direction: 'receipt', partyId: 'p1', amount: 300,
    allocations: [{ invoiceId: 's1', amount: 300 }], invoices,
  }), [{ invoiceId: 's1', amount: 300 }]);
});

test('invoice payment allocations reject duplicates, wrong party/type and over-settlement', () => {
  const invoices = [
    { id: 's1', partyId: 'p1', invoiceType: 'sale', status: 'issued', creditAmount: 100 },
    { id: 'p1-inv', partyId: 'p1', invoiceType: 'purchase', status: 'issued', creditAmount: 100 },
    { id: 's2', partyId: 'p2', invoiceType: 'sale', status: 'issued', creditAmount: 100 },
    { id: 's3', partyId: 'p1', invoiceType: 'sale', status: 'issued', creditAmount: 100 },
    { id: 'cancelled', partyId: 'p1', invoiceType: 'sale', status: 'cancelled', creditAmount: 100 },
  ];
  const base = { direction: 'receipt' as const, partyId: 'p1', amount: 100, invoices };
  assert.throws(() => validateInvoicePaymentAllocations({ ...base, allocations: [{ invoiceId: 's1', amount: 50 }, { invoiceId: 's1', amount: 50 }] }), /تکراری/);
  assert.throws(() => validateInvoicePaymentAllocations({ ...base, allocations: [{ invoiceId: 's2', amount: 50 }] }), /متعلق به این طرف‌حساب/);
  assert.throws(() => validateInvoicePaymentAllocations({ ...base, allocations: [{ invoiceId: 'p1-inv', amount: 50 }] }), /فاکتور فروش/);
  assert.throws(() => validateInvoicePaymentAllocations({ ...base, allocations: [{ invoiceId: 'cancelled', amount: 50 }] }), /فاکتور فروش/);
  assert.throws(() => validateInvoicePaymentAllocations({ ...base, allocations: [{ invoiceId: 's1', amount: 101 }] }), /مانده باز/);
  assert.throws(() => validateInvoicePaymentAllocations({ ...base, allocations: [{ invoiceId: 's1', amount: 80 }, { invoiceId: 's3', amount: 30 }] }), /جمع تخصیص‌ها/);
  assert.throws(() => validateInvoicePaymentAllocations({ ...base, allocations: [{ invoiceId: 's1', amount: Number.NaN }] }), /مثبت و معتبر/);
  assert.throws(() => validateInvoicePaymentAllocations({ ...base, allocations: [{ invoiceId: 's1', amount: -1 }] }), /مثبت و معتبر/);
  assert.throws(() => validateInvoicePaymentAllocations({ ...base, direction: 'payment', allocations: [{ invoiceId: 's1', amount: 50 }] }), /فاکتور خرید/);
});


test('aging report exposes ledger-to-invoice differences instead of forcing FIFO attribution', () => {
  const party = { id: 'p1', ownerId: 'o1', code: 'C1', name: 'مشتری', partyType: 'customer', creditLimit: 0, openingBalance: 0, accountCode: '10401' };
  const invoice = { id: 'i1', ownerId: 'o1', invoiceNumber: 'S-1', invoiceType: 'sale', date: '1405/08/01', dueDate: '1405/08/01',
    partyId: 'p1', partyName: 'مشتری', warehouse: 'انبار', subtotal: 250, discount: 0, vatAmount: 0, grandTotal: 250,
    paidCash: 0, paidBank: 0, paidCheque: 0, creditAmount: 250, status: 'issued', items: [] };
  const rows = computeReceivablesAging([party] as any, [invoice] as any, new Map([['p1', 300]]), '1405/09/01');
  assert.equal(rows[0].totalReceivable, 250);
  assert.equal(rows[0].ledgerBalance, 300);
  assert.equal(rows[0].ledgerDifference, 50);
  assert.equal(rows[0].bucket0to30 + rows[0].bucket31to60 + rows[0].bucket61to90 + rows[0].bucketOver90, 250);
});


test('allocated treasury voucher reversal restores invoice balances and removes its allocations', () => {
  const invoices = [
    { id: 'i1', creditAmount: 400, paidCash: 600, paidBank: 0, status: 'issued',
      paymentAllocations: [{ id: 'a1', voucherId: 'v1', date: '1405/08/01', direction: 'receipt', amount: 200 }, { id: 'a2', voucherId: 'v2', date: '1405/08/02', direction: 'receipt', amount: 100 }] },
    { id: 'i2', creditAmount: 300, paidCash: 200, paidBank: 0, status: 'settled',
      paymentAllocations: [{ id: 'a3', voucherId: 'v1', date: '1405/08/01', direction: 'receipt', amount: 200 }] },
  ];
  const cash = buildInvoiceAllocationReversal(invoices as any, 'v1', '10101');
  assert.deepEqual(cash, [
    { invoiceId: 'i1', creditAmount: 600, paidCash: 400, paidBank: 0, status: 'issued',
      paymentAllocations: [{ id: 'a2', voucherId: 'v2', date: '1405/08/02', direction: 'receipt', amount: 100 }] },
    { invoiceId: 'i2', creditAmount: 500, paidCash: 0, paidBank: 0, status: 'issued',
      paymentAllocations: [] },
  ]);
  const bank = buildInvoiceAllocationReversal([{
    id: 'i3', creditAmount: 0, paidCash: 0, paidBank: 500, status: 'settled',
    paymentAllocations: [{ id: 'a4', voucherId: 'v3', date: '1405/08/03', direction: 'payment', amount: 500 }],
  }] as any, 'v3', '10201');
  assert.equal(bank[0].paidBank, 0);
  assert.equal(bank[0].creditAmount, 500);
  assert.throws(() => buildInvoiceAllocationReversal(invoices as any, 'missing', '10101'), /یافت نشد/);
  assert.throws(() => buildInvoiceAllocationReversal([{
    id: 'bad', creditAmount: 0, paidCash: 10, paidBank: 0, status: 'issued',
    paymentAllocations: [{ id: 'a5', voucherId: 'v4', date: '1405/08/04', direction: 'receipt', amount: 50 }],
  }] as any, 'v4', '10101'), /تطبیق ندارد/);
});
