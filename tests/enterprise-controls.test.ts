import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateStockFIFO,
  assertFiscalPeriodOpen,
  auditTreasuryVoucherLinks,
  classifySyncOperation,
  computeOpenItemAging,
  reconcileBankLines,
  validateAtomicFinancialPlan,
  validateSyncOperation,
} from '../src/lib/enterpriseControls.ts';

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
