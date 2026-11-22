import { getJalaliMonthLength, shamsiToExactDayNumber } from './chequeAlerts';

/**
 * Enterprise controls foundation.
 *
 * Pure domain functions only: these helpers deliberately do not persist data or
 * post accounting entries. UI/context integration is performed in later stages
 * after migration and compatibility tests are in place.
 */

export interface JournalValidationLine {
  accountCode: string;
  debit: number;
  credit: number;
}

export function validateJournalEntryPayload(payload: {
  date: string;
  description: string;
  lines: JournalValidationLine[];
}): void {
  const dateParts = payload.date.split('/').map(Number);
  if (!/^14\d{2}\/\d{2}\/\d{2}$/.test(payload.date) ||
      dateParts.length !== 3 || dateParts[1] < 1 || dateParts[1] > 12 ||
      dateParts[2] < 1 || dateParts[2] > 31) {
    throw new Error('تاریخ سند حسابداری معتبر نیست.');
  }
  if (!payload.description?.trim()) throw new Error('شرح سند حسابداری الزامی است.');
  if (!Array.isArray(payload.lines) || payload.lines.length < 2 || payload.lines.length > 100) {
    throw new Error('سند باید بین ۲ تا ۱۰۰ ردیف حسابداری داشته باشد.');
  }
  let totalDebit = 0;
  let totalCredit = 0;
  for (const line of payload.lines) {
    const debit = Number(line.debit);
    const credit = Number(line.credit);
    if (!line.accountCode?.trim() || !Number.isFinite(debit) || !Number.isFinite(credit) ||
        debit < 0 || credit < 0 || (debit > 0 && credit > 0) ||
        (debit === 0 && credit === 0)) {
      throw new Error('کد حساب یا مبلغ بدهکار/بستانکار یکی از ردیف‌های سند معتبر نیست.');
    }
    totalDebit += debit;
    totalCredit += credit;
  }
  if (Math.abs(totalDebit - totalCredit) > 0.000001) {
    throw new Error('سند حسابداری تراز نیست؛ جمع بدهکار و بستانکار باید برابر باشد.');
  }
}

/** Parse one RFC-4180-style CSV row, including quoted commas and escaped double quotes. */
export function parseCsvRow(input: string): string[] {
  const fields: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '"') {
      if (quoted && input[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { fields.push(value.trim()); value = ''; }
    else value += char;
  }
  fields.push(value.trim());
  return fields;
}
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
  if (!options.productId.trim() || !options.warehouse.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(options.asOfDate)) {
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(lot.receivedDate) ||
        (lot.expiryDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(lot.expiryDate))) {
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


export function getChequeStatusTransitionError(
  direction: 'receivable' | 'payable',
  current: 'in_box' | 'deposited' | 'endorsed' | 'cleared' | 'bounced' | 'cancelled',
  next: 'in_box' | 'deposited' | 'endorsed' | 'cleared' | 'bounced' | 'cancelled',
): string | null {
  if (current === next) return null;
  const allowed: Record<typeof direction, Partial<Record<typeof current, typeof next[]>>> = {
    receivable: {
      in_box: ['deposited', 'cleared', 'bounced', 'cancelled', 'endorsed'],
      deposited: ['cleared', 'bounced', 'cancelled'],
      bounced: ['in_box'],
      cleared: ['in_box'],
      endorsed: [],
      cancelled: [],
    },
    payable: {
      in_box: ['cleared', 'bounced', 'cancelled'],
      bounced: ['in_box'],
      cleared: ['in_box'],
      deposited: [],
      endorsed: [],
      cancelled: [],
    },
  };
  if (allowed[direction][current]?.includes(next)) return null;
  return direction === 'receivable'
    ? 'تغییر وضعیت چک دریافتی از این مرحله به مرحله انتخاب‌شده مجاز نیست. چک واگذارشده به غیر تا زمان ثبت فرآیند برگشت، قابل تغییر خودکار نیست.'
    : 'تغییر وضعیت چک پرداختی از این مرحله به مرحله انتخاب‌شده مجاز نیست.';
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
  if (!Number.isInteger(dateToleranceDays) || dateToleranceDays < 0) {
    throw new Error('دامنه مجاز اختلاف تاریخ باید عدد صحیح و نامنفی باشد.');
  }
  const validateLines = (rows: Array<BankStatementLine | LedgerCashLine>, label: string) => {
    const ids = new Set<string>();
    for (const row of rows) {
      if (!row.id?.trim() || !row.accountId?.trim() || !row.date?.trim() || !Number.isFinite(row.amount)) {
        throw new Error(`اطلاعات ردیف ${label} برای تطبیق بانکی معتبر نیست.`);
      }
      if (ids.has(row.id)) throw new Error(`شناسه تکراری در ردیف‌های ${label} وجود دارد.`);
      ids.add(row.id);
    }
  };
  validateLines(statement, 'صورت‌حساب');
  validateLines(ledger, 'دفتر');
  const remainingStatement = new Map(statement.map((line) => [line.id, line]));
  const remainingLedger = new Map(ledger.map((line) => [line.id, line]));
  const matches: ReconciliationMatch[] = [];
  const ambiguousStatementIds: string[] = [];
  const candidatesFor = (line: BankStatementLine) => [...remainingLedger.values()].filter((entry) =>
    entry.accountId === line.accountId &&
    entry.amount === line.amount &&
    (line.reference && entry.reference
      ? line.reference === entry.reference
      : Math.abs(daysBetween(line.date, entry.date)) <= dateToleranceDays)
  );

  // Resolve forced one-candidate statement rows iteratively. This avoids input-order
  // dependence when an earlier row is ambiguous but a later row has only one option.
  while (remainingStatement.size > 0 && remainingLedger.size > 0) {
    const candidateMap = new Map([...remainingStatement.values()].map((line) => [line.id, candidatesFor(line)]));
    const singletonByLedger = new Map<string, string[]>();
    for (const [statementId, candidates] of candidateMap) {
      if (candidates.length !== 1) continue;
      const ledgerId = candidates[0].id;
      const owners = singletonByLedger.get(ledgerId) ?? [];
      owners.push(statementId);
      singletonByLedger.set(ledgerId, owners);
    }
    const forced = [...candidateMap.entries()].find(([statementId, candidates]) =>
      candidates.length === 1 && singletonByLedger.get(candidates[0].id)?.length === 1
    );
    if (!forced) break;
    const [statementId, candidates] = forced;
    const line = remainingStatement.get(statementId)!;
    const match = candidates[0];
    matches.push({
      statementLineId: line.id,
      ledgerLineId: match.id,
      matchType: line.reference && match.reference ? 'reference' : 'exact-amount-date',
    });
    remainingStatement.delete(statementId);
    remainingLedger.delete(match.id);
  }

  for (const line of remainingStatement.values()) {
    if (candidatesFor(line).length > 0) ambiguousStatementIds.push(line.id);
  }
  const unmatchedStatementIds = [...remainingStatement.keys()].filter((id) => !ambiguousStatementIds.includes(id));

  return {
    matches,
    unmatchedStatementIds,
    unmatchedLedgerIds: [...remainingLedger.keys()],
    ambiguousStatementIds,
  };
}

export function validateTreasuryOperationPayload(payload: { date: string; amount: number; description: string }): void {
  const dateParts = typeof payload.date === 'string' ? payload.date.split('/').map(Number) : [];
  const maxDay = dateParts.length === 3
    ? getJalaliMonthLength(dateParts[0], dateParts[1])
    : 0;
  if (typeof payload.date !== 'string' || !/^14\d{2}\/\d{2}\/\d{2}$/.test(payload.date) ||
      dateParts.length !== 3 || dateParts[1] < 1 || dateParts[1] > 12 ||
      dateParts[2] < 1 || dateParts[2] > maxDay) {
    throw new Error('تاریخ عملیات خزانه معتبر نیست.');
  }
  if (!Number.isFinite(payload.amount) || payload.amount <= 0) {
    throw new Error('مبلغ عملیات خزانه باید عددی معتبر و بزرگ‌تر از صفر باشد.');
  }
  if (typeof payload.description !== 'string' || !payload.description.trim()) {
    throw new Error('شرح عملیات خزانه الزامی است.');
  }
}

export function validateJalaliDate(date: string, label = 'تاریخ'): void {
  if (typeof date !== 'string' || !/^14\d{2}\/\d{2}\/\d{2}$/.test(date)) {
    throw new Error(`${label} شمسی معتبر نیست.`);
  }
  const [year, month, day] = date.split('/').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > getJalaliMonthLength(year, month) ||
      shamsiToExactDayNumber(date) === null) {
    throw new Error(`${label} شمسی معتبر نیست.`);
  }
}

export function validateChequeDateRange(issueDate: string, dueDate: string): void {
  validateJalaliDate(issueDate, 'تاریخ صدور چک');
  validateJalaliDate(dueDate, 'تاریخ سررسید چک');
  const issueDay = shamsiToExactDayNumber(issueDate);
  const dueDay = shamsiToExactDayNumber(dueDate);
  if (issueDay === null || dueDay === null || dueDay < issueDay) {
    throw new Error('تاریخ سررسید چک نمی‌تواند قبل از تاریخ صدور باشد.');
  }
}

export interface StockReservation {
  productId: string;
  quantity: number;
}

export function aggregateStockReservations(reservations: readonly StockReservation[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const reservation of reservations) {
    if (!reservation.productId.trim() || !Number.isFinite(reservation.quantity) || reservation.quantity < 0) {
      throw new Error('رزرو موجودی کالا دارای شناسه یا مقدار نامعتبر است.');
    }
    totals.set(reservation.productId, (totals.get(reservation.productId) ?? 0) + reservation.quantity);
  }
  return totals;
}

export interface ImportLandedCostPayload {
  totalForeignAmount: number;
  exchangeRate: number;
  totalFobIrr: number;
  totalLandedCostsIrr: number;
  grandTotalLandedIrr: number;
  costs: Array<{ amountIrr: number }>;
  items: Array<{ weightKg: number; finalUnitCostIrr: number }>;
}

export function validateImportLandedCostPayload(payload: ImportLandedCostPayload): void {
  if (!Number.isFinite(payload.totalForeignAmount) || payload.totalForeignAmount <= 0 ||
      !Number.isFinite(payload.exchangeRate) || payload.exchangeRate <= 0 ||
      !Number.isFinite(payload.totalFobIrr) || payload.totalFobIrr <= 0 ||
      !Number.isFinite(payload.totalLandedCostsIrr) || payload.totalLandedCostsIrr < 0 ||
      !Number.isFinite(payload.grandTotalLandedIrr) || payload.grandTotalLandedIrr <= 0 ||
      !payload.items.length ||
      payload.items.some((item) => !Number.isFinite(item.weightKg) || item.weightKg <= 0 ||
        !Number.isFinite(item.finalUnitCostIrr) || item.finalUnitCostIrr < 0) ||
      payload.costs.some((cost) => !Number.isFinite(cost.amountIrr) || cost.amountIrr < 0)) {
    throw new Error('مقادیر ارزی، هزینه‌ها یا اقلام بهای تمام‌شده واردات معتبر نیستند.');
  }
  const expectedFob = Math.round(payload.totalForeignAmount * payload.exchangeRate);
  if (Math.abs(expectedFob - Math.round(payload.totalFobIrr)) > 1) {
    throw new Error('بهای ریالی پروفرما با مبلغ ارزی و نرخ تبدیل مطابقت ندارد.');
  }
  const costsTotal = payload.costs.reduce((sum, cost) => sum + Math.round(cost.amountIrr), 0);
  const landedTotal = Math.round(payload.totalFobIrr) + costsTotal;
  if (Math.abs(costsTotal - Math.round(payload.totalLandedCostsIrr)) > 0 ||
      Math.abs(landedTotal - Math.round(payload.grandTotalLandedIrr)) > 0) {
    throw new Error('جمع هزینه‌های جانبی و بهای تمام‌شده پرونده با یکدیگر مطابقت ندارند.');
  }
  const itemValueTotal = payload.items.reduce(
    (sum, item) => sum + Math.round(item.weightKg * item.finalUnitCostIrr), 0,
  );
  if (Math.abs(itemValueTotal - landedTotal) > Math.max(1, payload.items.length)) {
    throw new Error('ارزش ریالی اقلام و بهای تمام‌شده کل محموله با یکدیگر تطابق ندارند.');
  }
}

export interface TreasuryAccountIdentity {
  code: string;
  level: string;
}

export function validatePartyTreasuryAccount(
  account: TreasuryAccountIdentity | undefined,
): void {
  if (!account || account.level !== 'moein' ||
      !(account.code.startsWith('104') || account.code.startsWith('301'))) {
    throw new Error('حساب معین تفصیلی طرف‌حساب معتبر نیست؛ حساب بدهکاران یا بستانکاران را بررسی کنید.');
  }
}

export function validateTreasuryAccountSelection(
  account: TreasuryAccountIdentity | undefined,
  label = 'حساب خزانه',
): void {
  if (!account || account.level !== 'moein' ||
      !(account.code.startsWith('101') || account.code.startsWith('102'))) {
    throw new Error(label + ' انتخاب‌شده معتبر نیست یا حساب صندوق/بانک معین نیست.');
  }
}

export function validateTreasuryTransferAccounts(
  fromAccount: TreasuryAccountIdentity | undefined,
  toAccount: TreasuryAccountIdentity | undefined,
): void {
  validateTreasuryAccountSelection(fromAccount, 'حساب مبدأ');
  validateTreasuryAccountSelection(toAccount, 'حساب مقصد');
  if (fromAccount!.code === toAccount!.code) {
    throw new Error('حساب مبدأ و مقصد انتقال باید متفاوت باشند.');
  }
}


export type TreasuryVoucherAuditIssue =
  | { transactionId: string; kind: 'missing-voucher' }
  | { transactionId: string; kind: 'duplicate-voucher' }
  | { transactionId: string; kind: 'amount-mismatch' };

export function auditTreasuryVoucherLinks(
  transactions: Array<{ id: string; amount: number }>,
  vouchers: Array<{ id: string; referenceId?: string; totalDebit: number; totalCredit: number }>,
): TreasuryVoucherAuditIssue[] {
  const issues: TreasuryVoucherAuditIssue[] = [];
  for (const transaction of transactions) {
    const linked = vouchers.filter((voucher) => voucher.referenceId === transaction.id);
    if (linked.length === 0) {
      issues.push({ transactionId: transaction.id, kind: 'missing-voucher' });
    } else if (linked.length > 1) {
      issues.push({ transactionId: transaction.id, kind: 'duplicate-voucher' });
    } else if (!Number.isFinite(transaction.amount) ||
      Math.abs(linked[0].totalDebit - transaction.amount) > 0.01 ||
      Math.abs(linked[0].totalCredit - transaction.amount) > 0.01) {
      issues.push({ transactionId: transaction.id, kind: 'amount-mismatch' });
    }
  }
  return issues;
}

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
