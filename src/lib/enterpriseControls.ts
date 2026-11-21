/**
 * Enterprise controls foundation.
 *
 * Pure domain functions only: these helpers deliberately do not persist data or
 * post accounting entries. UI/context integration is performed in later stages
 * after migration and compatibility tests are in place.
 */

export type FiscalPeriodStatus = 'open' | 'closed';

export interface FiscalPeriod {
  id: string;
  startDate: string;
  endDate: string;
  status: FiscalPeriodStatus;
  closedAt?: string;
  closedBy?: string;
}

export function assertFiscalPeriodOpen(date: string, periods: FiscalPeriod[]): FiscalPeriod {
  if (!date) throw new Error('تاریخ عملیات مشخص نشده است.');
  const matches = periods.filter((period) => date >= period.startDate && date <= period.endDate);
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? 'برای تاریخ انتخاب‌شده دوره مالی تعریف نشده است.'
      : 'بازه‌های دوره مالی هم‌پوشانی دارند؛ ابتدا تنظیمات دوره‌ها را اصلاح کنید.');
  }
  if (matches[0].status !== 'open') {
    throw new Error('ثبت یا اصلاح عملیات در دوره مالی بسته‌شده مجاز نیست.');
  }
  return matches[0];
}

export interface SyncOperationEnvelope<TPayload = unknown> {
  schemaVersion: 1;
  operationId: string;
  idempotencyKey: string;
  companyId: string;
  actorId: string;
  deviceId: string;
  entityType: string;
  entityId: string;
  operation: 'create' | 'update' | 'delete';
  baseVersion: number;
  createdAt: string;
  payload: TPayload;
}

export function validateSyncOperation<T>(operation: SyncOperationEnvelope<T>): void {
  const required: Array<keyof SyncOperationEnvelope<T>> = [
    'operationId', 'idempotencyKey', 'companyId', 'actorId', 'deviceId',
    'entityType', 'entityId', 'operation', 'createdAt',
  ];
  for (const key of required) {
    const value = operation[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`فیلد ${String(key)} در عملیات همگام‌سازی معتبر نیست.`);
    }
  }
  if (operation.schemaVersion !== 1) throw new Error('نسخه ساختار عملیات همگام‌سازی پشتیبانی نمی‌شود.');
  if (!Number.isInteger(operation.baseVersion) || operation.baseVersion < 0) {
    throw new Error('نسخه مبنای رکورد معتبر نیست.');
  }
  if (!['create', 'update', 'delete'].includes(operation.operation)) {
    throw new Error('نوع عملیات همگام‌سازی معتبر نیست.');
  }
}

export type SyncConflict =
  | { kind: 'duplicate'; operationId: string }
  | { kind: 'safe'; reason: 'same-base-version' | 'already-applied' }
  | { kind: 'conflict'; reason: 'stale-base-version' | 'different-operation-same-entity' };

export function classifySyncOperation(
  incoming: SyncOperationEnvelope,
  currentVersion: number,
  appliedOperationIds: ReadonlySet<string>,
): SyncConflict {
  if (appliedOperationIds.has(incoming.operationId) || appliedOperationIds.has(incoming.idempotencyKey)) {
    return { kind: 'duplicate', operationId: incoming.operationId };
  }
  if (incoming.baseVersion === currentVersion) {
    return { kind: 'safe', reason: 'same-base-version' };
  }
  if (incoming.baseVersion < currentVersion) {
    return { kind: 'conflict', reason: 'stale-base-version' };
  }
  return { kind: 'conflict', reason: 'different-operation-same-entity' };
}

export interface StockLot {
  id: string;
  productId: string;
  warehouse: string;
  lotNumber: string;
  receivedDate: string;
  expiryDate?: string;
  quantityReceived: number;
  quantityRemaining: number;
  unitCost: number;
}

export interface FifoAllocation {
  lotId: string;
  lotNumber: string;
  quantity: number;
  unitCost: number;
  totalCost: number;
}

export interface FifoResult {
  allocations: FifoAllocation[];
  remainingLots: StockLot[];
  totalCost: number;
  weightedUnitCost: number;
}

export interface StockIssueLine {
  productId: string;
  quantity: number;
}

/** Rejects an entire stock issue before any side effect if aggregate stock is insufficient. */
export function assertSufficientStock(
  availableByProduct: ReadonlyMap<string, number>,
  lines: StockIssueLine[],
): void {
  const requiredByProduct = new Map<string, number>();
  for (const line of lines) {
    if (!line.productId.trim() || !Number.isFinite(line.quantity) || line.quantity <= 0) {
      throw new Error('ردیف خروج انبار دارای کالا یا مقدار نامعتبر است.');
    }
    requiredByProduct.set(line.productId, (requiredByProduct.get(line.productId) ?? 0) + line.quantity);
  }
  for (const [productId, required] of requiredByProduct) {
    const available = availableByProduct.get(productId);
    if (!Number.isFinite(available) || (available as number) + 1e-9 < required) {
      throw new Error(`موجودی کالا برای خروج کافی نیست. کالا: ${productId}، موجود: ${Number(available) || 0}، موردنیاز: ${required}`);
    }
  }
}

export function allocateStockFIFO(
  lots: StockLot[],
  requestedQuantity: number,
  options: { productId: string; warehouse: string; asOfDate: string },
): FifoResult {
  if (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0) {
    throw new Error('مقدار خروج کالا باید عددی مثبت باشد.');
  }
  if (!options.productId.trim() || !options.warehouse.trim() || !/^\\d{4}-\\d{2}-\\d{2}$/.test(options.asOfDate)) {
    throw new Error('مشخصات کالا، انبار یا تاریخ تخصیص FIFO معتبر نیست.');
  }
  const lotIds = new Set<string>();
  for (const lot of lots) {
    if (!lot.id.trim() || lotIds.has(lot.id)) {
      throw new Error('شناسه بچ انبار خالی یا تکراری است.');
    }
    lotIds.add(lot.id);
    if (!lot.productId.trim() || !lot.warehouse.trim() || !lot.lotNumber.trim()) {
      throw new Error('مشخصات بچ انبار ناقص است.');
    }
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(lot.receivedDate) ||
        (lot.expiryDate !== undefined && !/^\\d{4}-\\d{2}-\\d{2}$/.test(lot.expiryDate))) {
      throw new Error('تاریخ دریافت یا انقضای بچ معتبر نیست.');
    }
    if (!Number.isFinite(lot.quantityReceived) || !Number.isFinite(lot.quantityRemaining) ||
        lot.quantityReceived < 0 || lot.quantityRemaining < 0 ||
        lot.quantityRemaining - lot.quantityReceived > 1e-9) {
      throw new Error('مقدار دریافتی یا مانده بچ انبار معتبر نیست.');
    }
    if (!Number.isFinite(lot.unitCost) || lot.unitCost < 0) {
      throw new Error('بهای واحد بچ انبار معتبر نیست.');
    }
  }
  const candidates = lots
    .filter((lot) =>
      lot.productId === options.productId &&
      lot.warehouse === options.warehouse &&
      lot.quantityRemaining > 0 &&
      (!lot.expiryDate || lot.expiryDate >= options.asOfDate)
    )
    .sort((a, b) => a.receivedDate.localeCompare(b.receivedDate) || a.id.localeCompare(b.id));

  const available = candidates.reduce((sum, lot) => sum + lot.quantityRemaining, 0);
  if (available + 1e-9 < requestedQuantity) {
    throw new Error(`موجودی قابل برداشت کافی نیست. موجودی قابل استفاده: ${available}`);
  }

  let remaining = requestedQuantity;
  const allocations: FifoAllocation[] = [];
  const remainingLots = lots.map((lot) => ({ ...lot }));
  const byId = new Map(remainingLots.map((lot) => [lot.id, lot]));

  for (const lot of candidates) {
    if (remaining <= 1e-9) break;
    const take = Math.min(remaining, lot.quantityRemaining);
    if (!Number.isFinite(lot.unitCost) || lot.unitCost < 0) {
      throw new Error(`بهای تمام‌شده بچ ${lot.lotNumber} معتبر نیست.`);
    }
    allocations.push({
      lotId: lot.id,
      lotNumber: lot.lotNumber,
      quantity: take,
      unitCost: lot.unitCost,
      totalCost: take * lot.unitCost,
    });
    const updated = byId.get(lot.id);
    if (updated) updated.quantityRemaining = Math.max(0, updated.quantityRemaining - take);
    remaining -= take;
  }

  const totalCost = allocations.reduce((sum, item) => sum + item.totalCost, 0);
  return {
    allocations,
    remainingLots,
    totalCost,
    weightedUnitCost: totalCost / requestedQuantity,
  };
}

export interface OpenInvoiceBalance {
  invoiceId: string;
  invoiceNumber: string;
  partyId: string;
  partyName: string;
  dueDate: string;
  outstanding: number;
}

export interface AgingBuckets {
  current: number;
  days1to30: number;
  days31to60: number;
  days61to90: number;
  over90: number;
}

export interface AgingRow extends AgingBuckets {
  partyId: string;
  partyName: string;
  totalOutstanding: number;
  invoices: OpenInvoiceBalance[];
}

export function computeOpenItemAging(
  balances: OpenInvoiceBalance[],
  today: string,
  daysBetween: (from: string, to: string) => number,
): AgingRow[] {
  const rows = new Map<string, AgingRow>();
  for (const item of balances) {
    if (!Number.isFinite(item.outstanding) || item.outstanding < 0) {
      throw new Error(`مانده فاکتور ${item.invoiceNumber} معتبر نیست.`);
    }
    if (item.outstanding === 0) continue;
    const row = rows.get(item.partyId) ?? {
      partyId: item.partyId,
      partyName: item.partyName,
      totalOutstanding: 0,
      current: 0,
      days1to30: 0,
      days31to60: 0,
      days61to90: 0,
      over90: 0,
      invoices: [],
    };
    const overdueDays = Math.max(0, daysBetween(item.dueDate, today));
    if (overdueDays === 0) row.current += item.outstanding;
    else if (overdueDays <= 30) row.days1to30 += item.outstanding;
    else if (overdueDays <= 60) row.days31to60 += item.outstanding;
    else if (overdueDays <= 90) row.days61to90 += item.outstanding;
    else row.over90 += item.outstanding;
    row.totalOutstanding += item.outstanding;
    row.invoices.push(item);
    rows.set(item.partyId, row);
  }
  return [...rows.values()].sort((a, b) => b.totalOutstanding - a.totalOutstanding);
}

export interface AtomicFinancialPlan {
  operationId: string;
  idempotencyKey: string;
  debitTotal: number;
  creditTotal: number;
  stockMovements: Array<{ id: string; productId: string; quantityDelta: number }>;
  documentIds: string[];
}

export function validateAtomicFinancialPlan(plan: AtomicFinancialPlan): void {
  if (!plan.operationId.trim() || !plan.idempotencyKey.trim()) {
    throw new Error('شناسه عملیات و کلید جلوگیری از ثبت تکراری الزامی است.');
  }
  const amounts = [plan.debitTotal, plan.creditTotal];
  if (amounts.some((amount) => !Number.isFinite(amount) || amount < 0)) {
    throw new Error('مبالغ سند حسابداری معتبر نیستند.');
  }
  if (Math.abs(plan.debitTotal - plan.creditTotal) > 0.01) {
    throw new Error('سند حسابداری تراز نیست؛ عملیات ثبت نشد.');
  }
  const ids = [...plan.stockMovements.map((move) => move.id), ...plan.documentIds];
  if (new Set(ids).size !== ids.length) throw new Error('شناسه تکراری در اقلام عملیات مالی وجود دارد.');
  for (const move of plan.stockMovements) {
    if (!move.id || !move.productId || !Number.isFinite(move.quantityDelta) || move.quantityDelta === 0) {
      throw new Error('گردش موجودی در برنامه عملیات مالی معتبر نیست.');
    }
  }
}

export interface BankStatementLine {
  id: string;
  accountId: string;
  date: string;
  amount: number;
  reference?: string;
}

export interface LedgerCashLine {
  id: string;
  accountId: string;
  date: string;
  amount: number;
  reference?: string;
}

export interface ReconciliationMatch {
  statementLineId: string;
  ledgerLineId: string;
  matchType: 'reference' | 'exact-amount-date';
}

export interface ReconciliationResult {
  matches: ReconciliationMatch[];
  unmatchedStatementIds: string[];
  unmatchedLedgerIds: string[];
  ambiguousStatementIds: string[];
}

export function reconcileBankLines(
  statement: BankStatementLine[],
  ledger: LedgerCashLine[],
  dateToleranceDays: number,
  daysBetween: (from: string, to: string) => number,
): ReconciliationResult {
  const usedLedger = new Set<string>();
  const matches: ReconciliationMatch[] = [];
  const unmatchedStatementIds: string[] = [];
  const ambiguousStatementIds: string[] = [];

  for (const line of statement) {
    const candidates = ledger.filter((entry) =>
      !usedLedger.has(entry.id) &&
      entry.accountId === line.accountId &&
      entry.amount === line.amount &&
      (line.reference && entry.reference
        ? line.reference === entry.reference
        : Math.abs(daysBetween(line.date, entry.date)) <= dateToleranceDays)
    );
    if (candidates.length === 1) {
      const match = candidates[0];
      usedLedger.add(match.id);
      matches.push({
        statementLineId: line.id,
        ledgerLineId: match.id,
        matchType: line.reference && match.reference ? 'reference' : 'exact-amount-date',
      });
    } else if (candidates.length > 1) {
      ambiguousStatementIds.push(line.id);
    } else {
      unmatchedStatementIds.push(line.id);
    }
  }

  return {
    matches,
    unmatchedStatementIds,
    unmatchedLedgerIds: ledger.filter((line) => !usedLedger.has(line.id)).map((line) => line.id),
    ambiguousStatementIds,
  };
}

export interface TreasuryAuditIssue {
  transactionId: string;
  kind: 'missing-voucher' | 'duplicate-voucher' | 'amount-mismatch';
}

export function auditTreasuryVoucherLinks(
  transactions: Array<{ id: string; amount: number }>,
  vouchers: Array<{ id: string; referenceId?: string; totalDebit: number; totalCredit: number }>,
): TreasuryAuditIssue[] {
  const issues: TreasuryAuditIssue[] = [];
  for (const transaction of transactions) {
    const linked = vouchers.filter((voucher) => voucher.referenceId === transaction.id);
    if (linked.length === 0) {
      issues.push({ transactionId: transaction.id, kind: 'missing-voucher' });
    } else if (linked.length > 1) {
      issues.push({ transactionId: transaction.id, kind: 'duplicate-voucher' });
    } else if (
      Math.abs(linked[0].totalDebit - transaction.amount) > 0.01 ||
      Math.abs(linked[0].totalCredit - transaction.amount) > 0.01
    ) {
      issues.push({ transactionId: transaction.id, kind: 'amount-mismatch' });
    }
  }
  return issues;
}
