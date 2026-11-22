import type { InvoicePaymentAllocation, InvoiceStatus } from '../types/accounting';
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
  validateJalaliDate(payload.date, 'تاریخ سند حسابداری');
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
  return parseCsvRecords(input)[0] ?? [];
}

/** Parse RFC-4180-style CSV records, including quoted commas, escaped quotes and embedded newlines. */
export function parseCsvRecords(input: string): string[][] {
  const source = input.replace(/^\uFEFF/, '');
  const records: string[][] = [];
  let fields: string[] = [];
  let value = '';
  let quoted = false;
  let afterQuote = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { value += '"'; index += 1; }
      else if (char === '"') { quoted = false; afterQuote = true; }
      else value += char;
      continue;
    }
    if (char === '"' && value.length === 0 && !afterQuote) { quoted = true; continue; }
    if (char === ',') {
      fields.push(value.trim());
      value = '';
      afterQuote = false;
      continue;
    }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      fields.push(value.trim());
      value = '';
      afterQuote = false;
      if (fields.some((field) => field.length > 0)) records.push(fields);
      fields = [];
      continue;
    }
    if (afterQuote && !/\s/.test(char)) throw new Error('ساختار CSV پس از بسته‌شدن نقل‌قول معتبر نیست.');
    if (!afterQuote) value += char;
  }
  if (quoted) throw new Error('نقل‌قول در فایل CSV بسته نشده است.');
  fields.push(value.trim());
  if (fields.some((field) => field.length > 0)) records.push(fields);
  return records;
}
/** Stock movement sign for invoice lifecycle documents: -1 outbound, +1 inbound, 0 non-posting. */
export function getInvoiceStockDirection(invoiceType: string): -1 | 0 | 1 {
  if (invoiceType === 'sale' || invoiceType === 'purchase_return' || invoiceType === 'waste') return -1;
  if (invoiceType === 'purchase' || invoiceType === 'sale_return') return 1;
  if (invoiceType === 'proforma') return 0;
  throw new Error('نوع فاکتور برای گردش موجودی معتبر نیست.');
}

export function getInvoiceCancellationBlockReason(invoice: {
  status: string;
  paidCash?: number;
  paidBank?: number;
  paidCheque?: number;
  paymentAllocations?: unknown[];
}): string | null {
  if (invoice.paymentAllocations?.length) {
    return 'ابتدا باید تخصیص‌های دریافت/پرداخت مرتبط با فاکتور معکوس شوند؛ ابطال مستقیم مجاز نیست.';
  }
  if ((invoice.paidCash ?? 0) > 0 || (invoice.paidBank ?? 0) > 0 || (invoice.paidCheque ?? 0) > 0 || invoice.status === 'settled') {
    return 'فاکتور دارای تسویه است. ابتدا عملیات تسویه یا استرداد وجه را تعیین تکلیف کنید و سپس اصلاح/ابطال را انجام دهید.';
  }
  return null;
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

export interface InventoryLotLedgerMovement {
  id: string;
  lotId: string;
  movementType: 'receipt' | 'issue' | 'return' | 'purchase-return' | 'waste' | 'transfer-in' | 'transfer-out' | 'adjustment' | 'reversal';
  quantity: number;
}

/** Remaining quantity that can be returned against a specific source lot. */
export function calculateLotReturnableQuantity(
  sourceLotId: string,
  movements: Array<{
    id: string;
    lotId: string;
    movementType: string;
    referenceId?: string;
    quantity: number;
    sourceLotId?: string;
    reversalOfMovementId?: string;
  }>,
): number {
  const issueMovements = movements.filter((movement) =>
    movement.lotId === sourceLotId && movement.movementType === 'issue' && movement.referenceId?.startsWith('inv_'));
  const issueIds = new Set(issueMovements.map((movement) => movement.id));
  const netIssued = movements
    .filter((movement) =>
      (movement.lotId === sourceLotId && movement.movementType === 'issue' && movement.referenceId?.startsWith('inv_')) ||
      (movement.movementType === 'reversal' && movement.reversalOfMovementId && issueIds.has(movement.reversalOfMovementId)))
    .reduce((sum, movement) => sum + movement.quantity, 0);
  const netReturned = movements
    .filter((movement) =>
      movement.sourceLotId === sourceLotId &&
      (movement.movementType === 'return' || movement.movementType === 'reversal'))
    .reduce((sum, movement) => sum + movement.quantity, 0);
  const soldQuantity = Math.max(0, -netIssued);
  const returnedQuantity = Math.max(0, netReturned);
  return Number(Math.max(0, soldQuantity - returnedQuantity).toFixed(4));
}

export interface InventoryLotReconciliation {
  lotId: string;
  expectedRemaining: number;
  actualRemaining: number;
  difference: number;
}

/** Reconciles the mutable lot balance against its append-only signed movement ledger. */
export function reconcileInventoryLotLedger(
  lots: StockLot[],
  movements: InventoryLotLedgerMovement[],
): InventoryLotReconciliation[] {
  const lotById = new Map<string, StockLot>();
  for (const lot of lots) {
    if (!lot.id.trim() || lotById.has(lot.id)) throw new Error('شناسه بچ در تطبیق دفتر تکراری یا خالی است.');
    if (!Number.isFinite(lot.quantityReceived) || lot.quantityReceived < 0 || !Number.isFinite(lot.quantityRemaining) || lot.quantityRemaining < 0 || lot.quantityRemaining - lot.quantityReceived > 0.0001) throw new Error('مقدار دریافتی یا مانده بچ برای تطبیق معتبر نیست.');
    lotById.set(lot.id, lot);
  }
  const movementIds = new Set<string>();
  const signedTotals = new Map<string, number>();
  const receiptLotIds = new Set<string>();
  for (const movement of movements) {
    if (!movement.id.trim() || movementIds.has(movement.id)) throw new Error('شناسه گردش بچ تکراری یا خالی است.');
    movementIds.add(movement.id);
    if (!lotById.has(movement.lotId)) throw new Error(`گردش به بچ ناشناخته ${movement.lotId} اشاره می‌کند.`);
    if (!Number.isFinite(movement.quantity) || Math.abs(movement.quantity) < 1e-9) throw new Error('مقدار گردش بچ معتبر نیست.');
    if (['receipt', 'return', 'transfer-in'].includes(movement.movementType) && movement.quantity < 0) {
      throw new Error('گردش ورود بچ باید مقدار مثبت داشته باشد.');
    }
    if (['issue', 'purchase-return', 'waste', 'transfer-out'].includes(movement.movementType) && movement.quantity > 0) {
      throw new Error('گردش خروج بچ باید مقدار منفی داشته باشد.');
    }
    if (['receipt', 'return', 'adjustment'].includes(movement.movementType) && movement.quantity > 0) {
      receiptLotIds.add(movement.lotId);
    }
    signedTotals.set(movement.lotId, (signedTotals.get(movement.lotId) ?? 0) + movement.quantity);
  }
  return lots.map((lot) => {
    if (lot.quantityReceived > 0 && !receiptLotIds.has(lot.id)) {
      throw new Error(`بچ ${lot.id} فاقد گردش ورود اولیه قابل حسابرسی است.`);
    }
    const expectedRemaining = Number((signedTotals.get(lot.id) ?? 0).toFixed(6));
    const actualRemaining = Number(lot.quantityRemaining.toFixed(6));
    if (expectedRemaining < -0.0001 || expectedRemaining - lot.quantityReceived > 0.0001) {
      throw new Error(`گردش‌های بچ ${lot.id} مانده‌ای خارج از محدوده مقدار دریافتی ایجاد کرده‌اند.`);
    }
    return {
      lotId: lot.id,
      expectedRemaining,
      actualRemaining,
      difference: Number((actualRemaining - expectedRemaining).toFixed(6)),
    };
  }).filter((row) => Math.abs(row.difference) > 0.0001);
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
  options: { productId: string; warehouse: string; asOfDate: string; allowExpired?: boolean },
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
        (lot.expiryDate !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(lot.expiryDate) || lot.expiryDate < lot.receivedDate))) {
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
      lot.receivedDate <= options.asOfDate &&
      lot.quantityRemaining > 0 &&
      (options.allowExpired || !lot.expiryDate || lot.expiryDate >= options.asOfDate)
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

export interface InvoiceAllocationCandidate {
  id: string;
  partyId: string;
  invoiceType: string;
  status: string;
  creditAmount: number;
}

export interface InvoicePaymentAllocationInput {
  invoiceId: string;
  amount: number;
}

/** Validates explicit invoice settlement allocations without applying FIFO guesses. */
export function validateInvoicePaymentAllocations(payload: {
  direction: 'receipt' | 'payment';
  partyId: string;
  amount: number;
  allocations: InvoicePaymentAllocationInput[];
  invoices: InvoiceAllocationCandidate[];
}): Array<{ invoiceId: string; amount: number }> {
  if (!Number.isFinite(payload.amount) || payload.amount <= 0) {
    throw new Error('مبلغ عملیات خزانه برای تخصیص معتبر نیست.');
  }
  if (!payload.partyId?.trim() || !Array.isArray(payload.allocations) || payload.allocations.length === 0) {
    throw new Error('برای تخصیص به فاکتور، حداقل یک فاکتور باید انتخاب شود.');
  }
  const seen = new Set<string>();
  let allocatedTotal = 0;
  const expectedType = payload.direction === 'receipt' ? 'sale' : 'purchase';
  const normalized = payload.allocations.map((allocation) => {
    const invoiceId = String(allocation.invoiceId ?? '').trim();
    const amount = Number(allocation.amount);
    if (!invoiceId || seen.has(invoiceId)) throw new Error('فاکتور خالی یا تکراری در تخصیص پرداخت وجود دارد.');
    seen.add(invoiceId);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('مبلغ تخصیص هر فاکتور باید عددی مثبت و معتبر باشد.');
    const invoice = payload.invoices.find((candidate) => candidate.id === invoiceId);
    if (!invoice || invoice.partyId !== payload.partyId) throw new Error('فاکتور انتخاب‌شده متعلق به این طرف‌حساب نیست یا وجود ندارد.');
    if (invoice.status === 'cancelled' || invoice.invoiceType !== expectedType) {
      throw new Error(payload.direction === 'receipt'
        ? 'دریافت فقط به فاکتور فروش باز قابل تخصیص است.'
        : 'پرداخت فقط به فاکتور خرید باز قابل تخصیص است.');
    }
    const outstanding = Number(invoice.creditAmount);
    if (!Number.isFinite(outstanding) || outstanding <= 0 || amount > outstanding + 0.000001) {
      throw new Error(`مبلغ تخصیص از مانده باز فاکتور ${invoiceId} بیشتر است.`);
    }
    allocatedTotal += amount;
    return { invoiceId, amount };
  });
  if (allocatedTotal > payload.amount + 0.000001) {
    throw new Error('جمع تخصیص‌ها نمی‌تواند از مبلغ دریافت/پرداخت بیشتر باشد.');
  }
  return normalized;
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

export interface SalesOrderDispatchQuantity {
  productId: string;
  orderedWeightKg: number;
  actualWeighedKg: number;
}

export function validateSalesOrderDispatchQuantities(
  orderItems: readonly SalesOrderDispatchQuantity[],
  dispatchedItems: readonly SalesOrderDispatchQuantity[],
): StockIssueLine[] {
  if (!orderItems.length || !dispatchedItems.length) {
    throw new Error('سفارش و حواله خروج باید حداقل یک ردیف کالا داشته باشند.');
  }
  const orderedByProduct = new Map<string, number>();
  for (const item of orderItems) {
    if (!item.productId.trim() || !Number.isFinite(item.orderedWeightKg) || item.orderedWeightKg <= 0) {
      throw new Error('مقدار کالای سفارش اصلی معتبر نیست.');
    }
    orderedByProduct.set(item.productId, (orderedByProduct.get(item.productId) ?? 0) + item.orderedWeightKg);
  }
  const dispatchedByProduct = new Map<string, number>();
  for (const item of dispatchedItems) {
    if (!item.productId.trim() || !orderedByProduct.has(item.productId) ||
        !Number.isFinite(item.actualWeighedKg) || item.actualWeighedKg < 0 ||
        !Number.isFinite(item.orderedWeightKg) || item.orderedWeightKg <= 0) {
      throw new Error('ردیف حواله خروج با سفارش اصلی تطابق ندارد یا وزن آن نامعتبر است.');
    }
    const quantity = item.actualWeighedKg > 0 ? item.actualWeighedKg : item.orderedWeightKg;
    dispatchedByProduct.set(item.productId, (dispatchedByProduct.get(item.productId) ?? 0) + quantity);
  }
  for (const [productId, quantity] of dispatchedByProduct) {
    const ordered = orderedByProduct.get(productId) ?? 0;
    if (quantity - ordered > 1e-9) {
      throw new Error(`وزن حواله کالا از وزن سفارش بیشتر است. کالا: ${productId}، سفارش: ${ordered}، حواله: ${quantity}`);
    }
  }
  return [...dispatchedByProduct].map(([productId, quantity]) => ({ productId, quantity }));
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

export interface SalesOrderReservationSource {
  id: string;
  status: string;
  items: readonly { productId: string; actualWeighedKg: number; orderedWeightKg: number }[];
}

export interface SubcontractReservationSource {
  id: string;
  status: string;
  rawProductId: string;
  sentWeightKg: number;
}

/** Collect active sales-dispatch and subcontract reservations, with optional operation exclusions. */
export function collectActiveStockReservations(
  salesOrders: readonly SalesOrderReservationSource[],
  subcontractJobs: readonly SubcontractReservationSource[],
  exclusions: { salesOrderId?: string; subcontractJobId?: string } = {},
): Map<string, number> {
  const reservations: StockReservation[] = [
    ...salesOrders
      .filter((order) => order.status === 'dispatched' && order.id !== exclusions.salesOrderId)
      .flatMap((order) => order.items.map((item) => ({
        productId: item.productId,
        quantity: item.actualWeighedKg > 0 ? item.actualWeighedKg : item.orderedWeightKg,
      }))),
    ...subcontractJobs
      .filter((job) => job.status === 'sent' && job.id !== exclusions.subcontractJobId)
      .map((job) => ({ productId: job.rawProductId, quantity: job.sentWeightKg })),
  ];
  return aggregateStockReservations(reservations);
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


export interface InvoiceAllocationReversalCandidate {
  id: string;
  creditAmount: number;
  paidCash: number;
  paidBank: number;
  status: InvoiceStatus;
  paymentAllocations?: InvoicePaymentAllocation[];
}

export function buildInvoiceAllocationReversal(
  invoices: InvoiceAllocationReversalCandidate[],
  originalVoucherId: string,
  cashAccountCode: string,
): Array<{
  invoiceId: string;
  creditAmount: number;
  paidCash: number;
  paidBank: number;
  status: InvoiceStatus;
  paymentAllocations: InvoicePaymentAllocation[];
}> {
  if (!originalVoucherId?.trim() || !(cashAccountCode.startsWith('101') || cashAccountCode.startsWith('102'))) {
    throw new Error('شناسه سند یا حساب صندوق/بانک برای برگشت تخصیص معتبر نیست.');
  }
  const isBank = cashAccountCode.startsWith('102');
  const updates: Array<{
    invoiceId: string; creditAmount: number; paidCash: number; paidBank: number;
    status: InvoiceStatus; paymentAllocations: InvoicePaymentAllocation[];
  }> = [];
  for (const invoice of invoices) {
    const existing = invoice.paymentAllocations ?? [];
    const reversed = existing.filter((allocation) => allocation.voucherId === originalVoucherId);
    if (!reversed.length) continue;
    const amount = reversed.reduce((sum, allocation) => sum + Number(allocation.amount), 0);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error(`تخصیص ثبت‌شده روی فاکتور ${invoice.id} برای برگشت معتبر نیست.`);
    const paidAmount = Number(isBank ? invoice.paidBank : invoice.paidCash);
    if (!Number.isFinite(paidAmount) || paidAmount + 0.000001 < amount) {
      throw new Error(`مبلغ پرداخت ثبت‌شده فاکتور ${invoice.id} با تخصیص قابل برگشت تطبیق ندارد.`);
    }
    const creditAmount = Number(invoice.creditAmount) + amount;
    if (!Number.isFinite(creditAmount)) throw new Error(`مانده فاکتور ${invoice.id} پس از برگشت تخصیص معتبر نیست.`);
    updates.push({
      invoiceId: invoice.id,
      creditAmount: Number(creditAmount.toFixed(2)),
      paidCash: Number((invoice.paidCash - (isBank ? 0 : amount)).toFixed(2)),
      paidBank: Number((invoice.paidBank - (isBank ? amount : 0)).toFixed(2)),
      status: invoice.status === 'cancelled' ? 'cancelled' : 'issued',
      paymentAllocations: existing.filter((allocation) => allocation.voucherId !== originalVoucherId),
    });
  }
  if (!updates.length) throw new Error('تخصیص فاکتور متناظر با سند خزانه برای برگشت یافت نشد.');
  return updates;
}
