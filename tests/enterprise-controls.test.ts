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
  validateAtomicFinancialPlan,
  validateSyncOperation,
} from '../src/lib/enterpriseControls.ts';
import { computeReceivablesAging, computePayablesAging } from '../src/lib/enterpriseAccounting.ts';
import { calculateMonthlyDepreciation } from '../src/lib/accountingEngine.ts';

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
