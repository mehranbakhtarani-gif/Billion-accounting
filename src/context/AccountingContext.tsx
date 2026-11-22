import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import {
  auth, db, collection, deleteDoc, doc, getDoc, getDocs, onAuthStateChanged,
  onSnapshot, query, serverTimestamp, setDoc, updateDoc, where, writeBatch,
  handleSupabaseError, isSupabaseOfflineError, OperationType, signOutAccount,
  testSupabaseConnection, setActiveCompanyId, flushLocalSyncOutbox,
} from '../lib/supabaseStore';
import { ensurePasswordlessSession, getBillionMembership, acceptBillionInvite, bootstrapBillionCompany, createBillionInvite } from '../lib/supabaseEnrollment';
import {
  Account,
  AuditActivityLog,
  Cheque,
  ChequeStatus,
  CompanyProfile,
  CostCenter,
  CurrencyDefinition,
  CurrencyUnit,
  Employee,
  ExchangeRateEntry,
  FixedAsset,
  ImportDossier,
  Invoice,
  Party,
  Product,
  InventoryLot,
  InventoryLotMovement,
  RbacOperator,
  SalesOrder,
  SubcontractJob,
  Voucher,
  VoucherLine,
  VoucherStatus,
  VoucherType,
} from '../types/accounting';
import { createHolooSeedData } from '../data/holooSeed';
import { getOrCreateLocalDeviceIdentity, loadLocalAccountingSnapshot, LocalDeviceIdentity, saveLocalAccountingSnapshot } from '../lib/localAccountingStore';
import { FxRevaluationRow } from '../lib/enterpriseAccounting';
import { assertSufficientStock, getChequeStatusTransitionError, validateJournalEntryPayload, validateTreasuryOperationPayload, validateTreasuryAccountSelection, validateTreasuryTransferAccounts, validateChequeDateRange, validatePartyTreasuryAccount, validateJalaliDate, validateImportLandedCostPayload, aggregateStockReservations, collectActiveStockReservations, validateSalesOrderDispatchQuantities, validateInvoicePaymentAllocations, buildInvoiceAllocationReversal, getInvoiceStockDirection, getInvoiceCancellationBlockReason, allocateStockFIFO, reconcileInventoryLotLedger, calculateLotReturnableQuantity, calculateLotReturnedQuantity } from '../lib/enterpriseControls';
import {
  AuditReport,
  buildInvoiceVoucherLines,
  calculateEmployeePayroll,
  calculateMonthlyDepreciation,
  computeAuditReport,
  computeBalanceSheet,
  computeIncomeStatement,
  computePartyBalances,
  computeTrialBalance,
} from '../lib/accountingEngine';
import { getLocalIsoDate, generateSafeId, getTodayShamsi, shamsiToGregorianIso } from '../lib/format';
import {
  annotateVoucherLinesWithCurrency,
  BASE_CURRENCY_CODE,
  isForeignCurrency,
  normalizeCurrencyCode,
  roundCurrency,
} from '../lib/currency';

interface AccountingContextValue {
  user: User | null;
  authReady: boolean;
  isCloudMode: boolean;
  isSyncing: boolean;
  deviceIdentity: LocalDeviceIdentity | null;
  profile: CompanyProfile;
  accounts: Account[];
  parties: Party[];
  products: Product[];
  inventoryLots: InventoryLot[];
  inventoryLotMovements: InventoryLotMovement[];
  createOpeningInventoryLot: (payload: { productId: string; lotNumber: string; quantity: number; unitCost: number; receivedDate: string; expiryDate?: string }) => Promise<void>;
  reconcileProductLotsToStock: (productId: string) => Promise<void>;
  vouchers: Voucher[];
  invoices: Invoice[];
  cheques: Cheque[];
  employees: Employee[];
  assets: FixedAsset[];
  costCenters: CostCenter[];
  currencies: CurrencyDefinition[];
  exchangeRates: ExchangeRateEntry[];
  importDossiers: ImportDossier[];
  salesOrders: SalesOrder[];
  subcontractJobs: SubcontractJob[];
  rbacOperators: RbacOperator[];
  activeOperator: RbacOperator;
  setActiveOperatorId: (id: string) => void;
  auditLogs: AuditActivityLog[];
  trialBalance: ReturnType<typeof computeTrialBalance>;
  incomeStatement: ReturnType<typeof computeIncomeStatement>;
  balanceSheet: ReturnType<typeof computeBalanceSheet>;
  partyBalances: Map<string, number>;
  auditReport: AuditReport;
  toast: string | null;
  showToast: (msg: string) => void;
  bootstrapCloud: (token: string) => Promise<void>;
  joinCloud: (token: string) => Promise<void>;
  createDeviceInvite: () => Promise<string>;
  logout: () => Promise<void>;
  updateCompanyProfile: (patch: Partial<CompanyProfile>) => Promise<void>;
  setCurrencyUnit: (unit: CurrencyUnit) => Promise<void>;
  // Accounts CRUD
  addAccount: (acc: Omit<Account, 'id' | 'ownerId'>) => Promise<void>;
  updateAccount: (accountId: string, patch: Partial<Pick<Account, 'title' | 'parentCode' | 'category' | 'nature'>>) => Promise<void>;
  deleteAccount: (accountId: string) => Promise<boolean>;
  // Parties CRUD
  addParty: (party: Omit<Party, 'id' | 'ownerId'>) => Promise<void>;
  updateParty: (partyId: string, patch: Partial<Omit<Party, 'id' | 'ownerId' | 'code'>>) => Promise<void>;
  deleteParty: (partyId: string) => Promise<boolean>;
  // Products & Warehouse CRUD
  addProduct: (product: Omit<Product, 'id' | 'ownerId'>) => Promise<Product>;
  updateProduct: (productId: string, patch: Partial<Omit<Product, 'id' | 'ownerId' | 'sku'>>) => Promise<void>;
  deleteProduct: (productId: string) => Promise<boolean>;
  adjustProductStock: (productId: string, newStock: number) => Promise<void>;
  adjustProductStockWithVoucher: (productId: string, countedStock: number, reason: string) => Promise<void>;
  bulkStocktakingWithVoucher: (
    items: { productId: string; countedStock: number }[],
    reason: string
  ) => Promise<void>;
  bulkUpdateProductPrices: (
    productIds: string[],
    target: 'sellPrice' | 'buyPrice',
    percentDelta: number
  ) => Promise<void>;
  transferProductWarehouse: (productId: string, targetWarehouse: string) => Promise<void>;
  // Vouchers CRUD & Audit ops
  createVoucher: (payload: {
    date: string;
    description: string;
    voucherType: VoucherType;
    status: VoucherStatus;
    lines: VoucherLine[];
    referenceId?: string;
    currencyCode?: string;
    exchangeRate?: number;
  }) => Promise<Voucher>;
  updateVoucher: (
    voucherId: string,
    payload: {
      date: string;
      description: string;
      voucherType: VoucherType;
      status: VoucherStatus;
      lines: VoucherLine[];
      currencyCode?: string;
      exchangeRate?: number;
    }
  ) => Promise<void>;
  deleteVoucher: (voucherId: string) => Promise<boolean>;
  finalizeVoucher: (voucherId: string) => Promise<void>;
  finalizeAllDraftVouchers: () => Promise<number>;
  createReversingVoucher: (voucherId: string) => Promise<Voucher | null>;
  renumberVouchersChronologically: () => Promise<void>;
  // Multi-Currency & Daily Exchange Rates
  addCurrency: (cur: Omit<CurrencyDefinition, 'id' | 'ownerId' | 'isBase'>) => Promise<boolean>;
  updateCurrency: (
    currencyId: string,
    patch: Partial<Pick<CurrencyDefinition, 'name' | 'symbol' | 'decimalPlaces' | 'defaultRateToIrr' | 'active'>>
  ) => Promise<void>;
  deleteCurrency: (currencyId: string) => Promise<boolean>;
  upsertExchangeRate: (entry: Omit<ExchangeRateEntry, 'id' | 'ownerId'>) => Promise<void>;
  deleteExchangeRate: (rateId: string) => Promise<void>;
  // Invoices CRUD & Commercial ops
  createInvoice: (payload: Omit<Invoice, 'id' | 'ownerId' | 'voucherId'>) => Promise<Invoice>;
  cancelInvoice: (invoiceId: string) => Promise<void>;
  convertProformaToSale: (invoiceId: string) => Promise<void>;
  // Treasury & Cheques
  addCheque: (payload: Omit<Cheque, 'id' | 'ownerId'>, skipVoucher?: boolean) => Promise<Cheque>;
  updateCheque: (
    chequeId: string,
    patch: Partial<Pick<Cheque, 'bankName' | 'branch' | 'dueDate' | 'notes'>>
  ) => Promise<void>;
  updateChequeStatus: (
    chequeId: string,
    newStatus: ChequeStatus,
    options?: { bankAccountCode?: string; endorsePartyId?: string }
  ) => Promise<void>;
  recordQuickTreasury: (payload: {
    direction: 'receipt' | 'payment';
    accountCode: string;
    partyId: string;
    amount: number;
    date: string;
    description: string;
    allocations?: { invoiceId: string; amount: number }[];
  }) => Promise<void>;
  recordBankTransfer: (payload: {
    fromAccountCode: string;
    toAccountCode: string;
    amount: number;
    date: string;
    description: string;
  }) => Promise<void>;
  // Corporate CRUD & Vouchers
  addEmployee: (emp: Omit<Employee, 'id' | 'ownerId'>) => Promise<void>;
  updateEmployee: (empId: string, patch: Partial<Omit<Employee, 'id' | 'ownerId' | 'personnelCode'>>) => Promise<void>;
  deleteEmployee: (empId: string) => Promise<void>;
  postMonthlyPayrollVoucher: (monthName: string) => Promise<void>;
  paySalariesVoucher: (monthName: string, bankAccountCode: string, amount: number) => Promise<void>;
  addFixedAsset: (asset: Omit<FixedAsset, 'id' | 'ownerId'>) => Promise<void>;
  updateFixedAsset: (assetId: string, patch: Partial<Omit<FixedAsset, 'id' | 'ownerId' | 'assetCode'>>) => Promise<void>;
  deleteFixedAsset: (assetId: string) => Promise<void>;
  postDepreciationVoucher: (periodLabel: string) => Promise<void>;
  addCostCenter: (cc: Omit<CostCenter, 'id' | 'ownerId'>) => Promise<void>;
  updateCostCenter: (ccId: string, patch: Partial<Omit<CostCenter, 'id' | 'ownerId' | 'code'>>) => Promise<void>;
  deleteCostCenter: (ccId: string) => Promise<void>;
  runYearEndClosing: () => Promise<void>;
  // Enterprise Yarn Import, Weighbridge Orders, Subcontracting, FX Revaluation, RBAC & Audit Log
  addImportDossier: (dossier: Omit<ImportDossier, 'id' | 'ownerId'>) => Promise<void>;
  clearImportDossier: (dossierId: string) => Promise<void>;
  addSalesOrder: (order: Omit<SalesOrder, 'id' | 'ownerId'>) => Promise<void>;
  dispatchSalesOrder: (
    orderId: string,
    payload: {
      dispatchDate: string;
      driverName: string;
      plateNumber: string;
      items: SalesOrder['items'];
    }
  ) => Promise<void>;
  invoiceSalesOrder: (orderId: string) => Promise<void>;
  addSubcontractJob: (job: Omit<SubcontractJob, 'id' | 'ownerId'>) => Promise<void>;
  completeSubcontractJob: (
    jobId: string,
    payload: { returnedWeightKg: number; completionDate: string; finishedLotNumber: string }
  ) => Promise<void>;
  postFxRevaluationVoucher: (rows: FxRevaluationRow[], date: string) => Promise<void>;
  postBrokerCommissionVoucher: (payload: {
    partyId: string;
    partyName: string;
    amountIrr: number;
    date: string;
    periodLabel: string;
  }) => Promise<void>;
  addRbacOperator: (op: Omit<RbacOperator, 'id' | 'ownerId'>) => Promise<void>;
  updateRbacOperator: (
    opId: string,
    patch: Partial<Pick<RbacOperator, 'fullName' | 'role' | 'email' | 'active' | 'permissions'>>
  ) => Promise<void>;
  deleteRbacOperator: (opId: string) => Promise<void>;
  logActivity: (module: string, action: string, details: string) => void;
  // Backup & Restore
  exportBackupJson: () => string;
  importBackupJson: (jsonText: string) => boolean;
}

const AccountingContext = createContext<AccountingContextValue | null>(null);

const DEMO_OWNER = 'demo_holoo_apex';

const getShamsiYearEndDate = (yearLabel: string): string => {
  const year = Number(yearLabel);
  if (!Number.isInteger(year) || year < 1200 || year > 1600) {
    throw new Error('سال مالی برای محاسبه تاریخ اختتامیه معتبر نیست.');
  }
  const formatter = new Intl.DateTimeFormat('en-US-u-ca-persian', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const targetNextYear = year + 1;
  for (let day = 19; day <= 22; day += 1) {
    const newYearDate = new Date(Date.UTC(year + 622, 2, day, 12));
    const parts = formatter.formatToParts(newYearDate);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    if (Number(values.year) === targetNextYear && Number(values.month) === 1 && Number(values.day) === 1) {
      const lastDay = new Date(newYearDate.getTime() - 24 * 60 * 60 * 1000);
      const endParts = formatter.formatToParts(lastDay);
      const endValues = Object.fromEntries(endParts.map((part) => [part.type, part.value]));
      return `${year}/12/${String(Number(endValues.day)).padStart(2, '0')}`;
    }
  }
  throw new Error(`تاریخ پایان سال شمسی ${year} قابل محاسبه نیست.`);
};

const DEFAULT_PROFILE: CompanyProfile = {
  uid: DEMO_OWNER,
  displayName: 'مهندس مهران باختری',
  email: 'finance@atlasris-yarn.ir',
  companyName: 'شرکت بازرگانی و واردات نخ نساجی اطلس‌ریس (سهامی خاص)',
  economicCode: '411589203411',
  nationalId: '14007892134',
  fiscalYear: '1405',
  currencyUnit: 'IRT',
  role: 'accountant',
};

export const AccountingProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const initialSeed = useMemo(() => createHolooSeedData(DEMO_OWNER), []);

  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [localDataReady, setLocalDataReady] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [deviceIdentity, setDeviceIdentity] = useState<LocalDeviceIdentity | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [profile, setProfile] = useState<CompanyProfile>(DEFAULT_PROFILE);
  const [accounts, setAccounts] = useState<Account[]>(initialSeed.accounts);
  const [parties, setParties] = useState<Party[]>(initialSeed.parties);
  const [products, setProducts] = useState<Product[]>(initialSeed.products);
  const [inventoryLots, setInventoryLots] = useState<InventoryLot[]>([]);
  const [inventoryLotMovements, setInventoryLotMovements] = useState<InventoryLotMovement[]>([]);
  const [vouchers, setVouchers] = useState<Voucher[]>(initialSeed.vouchers);
  const [invoices, setInvoices] = useState<Invoice[]>(initialSeed.invoices);
  const [cheques, setCheques] = useState<Cheque[]>(initialSeed.cheques);
  const [employees, setEmployees] = useState<Employee[]>(initialSeed.employees);
  const [assets, setAssets] = useState<FixedAsset[]>(initialSeed.assets);
  const [costCenters, setCostCenters] = useState<CostCenter[]>(initialSeed.costCenters);
  const [currencies, setCurrencies] = useState<CurrencyDefinition[]>(initialSeed.currencies);
  const [exchangeRates, setExchangeRates] = useState<ExchangeRateEntry[]>(initialSeed.exchangeRates);
  const [importDossiers, setImportDossiers] = useState<ImportDossier[]>(initialSeed.importDossiers);
  const [salesOrders, setSalesOrders] = useState<SalesOrder[]>(initialSeed.salesOrders);
  const [subcontractJobs, setSubcontractJobs] = useState<SubcontractJob[]>(initialSeed.subcontractJobs);
  const [rbacOperators, setRbacOperators] = useState<RbacOperator[]>(initialSeed.rbacOperators);
  const [activeOperatorId, setActiveOperatorId] = useState<string>(initialSeed.rbacOperators[0].id);
  const [auditLogs, setAuditLogs] = useState<AuditActivityLog[]>(initialSeed.auditLogs);

  const activeOperator = useMemo(
    () =>
      rbacOperators.find((op) => op.id === activeOperatorId) ??
      rbacOperators[0] ??
      initialSeed.rbacOperators[0],
    [rbacOperators, activeOperatorId, initialSeed.rbacOperators]
  );

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => {
      setToast((prev) => (prev === msg ? null : prev));
    }, 4000);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    Promise.all([loadLocalAccountingSnapshot(), getOrCreateLocalDeviceIdentity()])
      .then(([saved, identity]) => {
        if (cancelled) return;
        setDeviceIdentity(identity);
        if (cancelled) return;
        if (saved) {
          if (saved.profile) setProfile(saved.profile as CompanyProfile);
          if (Array.isArray(saved.accounts)) setAccounts(saved.accounts as Account[]);
          if (Array.isArray(saved.parties)) setParties(saved.parties as Party[]);
          if (Array.isArray(saved.products)) setProducts(saved.products as Product[]);
          if (Array.isArray(saved.inventoryLots)) setInventoryLots(saved.inventoryLots as InventoryLot[]);
          if (Array.isArray(saved.inventoryLotMovements)) setInventoryLotMovements(saved.inventoryLotMovements as InventoryLotMovement[]);
          if (Array.isArray(saved.vouchers)) setVouchers(saved.vouchers as Voucher[]);
          if (Array.isArray(saved.invoices)) setInvoices(saved.invoices as Invoice[]);
          if (Array.isArray(saved.cheques)) setCheques(saved.cheques as Cheque[]);
          if (Array.isArray(saved.employees)) setEmployees(saved.employees as Employee[]);
          if (Array.isArray(saved.assets)) setAssets(saved.assets as FixedAsset[]);
          if (Array.isArray(saved.costCenters)) setCostCenters(saved.costCenters as CostCenter[]);
          if (Array.isArray(saved.currencies)) setCurrencies(saved.currencies as CurrencyDefinition[]);
          if (Array.isArray(saved.exchangeRates)) setExchangeRates(saved.exchangeRates as ExchangeRateEntry[]);
          if (Array.isArray(saved.importDossiers)) setImportDossiers(saved.importDossiers as ImportDossier[]);
          if (Array.isArray(saved.salesOrders)) setSalesOrders(saved.salesOrders as SalesOrder[]);
          if (Array.isArray(saved.subcontractJobs)) setSubcontractJobs(saved.subcontractJobs as SubcontractJob[]);
          if (Array.isArray(saved.rbacOperators) && saved.rbacOperators.length) setRbacOperators(saved.rbacOperators as RbacOperator[]);
          if (typeof saved.activeOperatorId === 'string') setActiveOperatorId(saved.activeOperatorId);
          if (Array.isArray(saved.auditLogs)) setAuditLogs(saved.auditLogs as AuditActivityLog[]);
        }
      })
      .catch((error) => {
        console.error('Local accounting database could not be loaded:', error);
      })
      .finally(() => {
        if (cancelled) return;
        setLocalDataReady(true);
        void testSupabaseConnection();
        unsubscribe = onAuthStateChanged(auth, (supabaseUser) => {
          if (!supabaseUser) {
            setActiveCompanyId(null);
            setUser(null);
            setAuthReady(true);
            return;
          }
          void getBillionMembership().then((membership) => {
            if (membership) {
              setActiveCompanyId(membership.company_id);
              setUser(supabaseUser);
            } else {
              setActiveCompanyId(null);
              setUser(null);
            }
            setAuthReady(true);
          }).catch((error) => {
            console.error('Supabase membership check failed:', error);
            setActiveCompanyId(null);
            setUser(null);
            setAuthReady(true);
          });
        });
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!localDataReady) return;
    void saveLocalAccountingSnapshot({
      profile, accounts, parties, products, inventoryLots, inventoryLotMovements, vouchers, invoices, cheques, employees,
      assets, costCenters, currencies, exchangeRates, importDossiers, salesOrders,
      subcontractJobs, rbacOperators, activeOperatorId, auditLogs,
    }).catch((error) => {
      console.error('Local accounting database save failed:', error);
    });
  }, [
    localDataReady, profile, accounts, parties, products, inventoryLots, inventoryLotMovements, vouchers, invoices, cheques,
    employees, assets, costCenters, currencies, exchangeRates, importDossiers,
    salesOrders, subcontractJobs, rbacOperators, activeOperatorId, auditLogs,
  ]);

  const ensureCloudSeed = useCallback(
    async (supabaseUser: User) => {
      setIsSyncing(true);
      try {
        const membership = await getBillionMembership();
        if (!membership) {
          setActiveCompanyId(null);
          showToast('این دستگاه هنوز عضو شرکت نیست؛ با کلید راه‌اندازی یا کد دعوت به شرکت متصل شوید.');
          return;
        }
        setActiveCompanyId(membership.company_id);
        const offlineSync = await flushLocalSyncOutbox();
        if (offlineSync.synced > 0) showToast(`${offlineSync.synced} عملیات آفلاین با موفقیت همگام شد.`);
        if (offlineSync.failed > 0) showToast(`${offlineSync.failed} عملیات آفلاین به‌دلیل تعارض یا خطای داده نیازمند بررسی است؛ اطلاعات دستگاه دیگر بازنویسی نشد.`);
        const uid = supabaseUser.id;
        const profileRef = doc(db, 'users', uid);
        const profileSnap = await getDoc(profileRef);
        if (!profileSnap.exists()) {
          await setDoc(profileRef, {
            uid,
            displayName: String(supabaseUser.user_metadata?.full_name || 'مدیر مالی').slice(0, 120),
            email: (supabaseUser.email || '').slice(0, 200),
            companyName: DEFAULT_PROFILE.companyName,
            economicCode: DEFAULT_PROFILE.economicCode,
            nationalId: DEFAULT_PROFILE.nationalId,
            fiscalYear: DEFAULT_PROFILE.fiscalYear,
            currencyUnit: DEFAULT_PROFILE.currencyUnit,
            role: membership.role,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
        const existingAccs = await getDocs(query(collection(db, 'accounts'), where('ownerId', '==', uid)));
        if (existingAccs.empty) {
          const seed = createHolooSeedData(uid);
          const batch = writeBatch(db);
          const putAll = <T extends { id: string }>(colName: string, items: T[]) => {
            items.forEach((item) => {
              const { id, ...rest } = item;
              batch.set(doc(db, colName, id), {
                ...rest,
                ownerId: uid,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              });
            });
          };
          putAll('accounts', seed.accounts);
          putAll('parties', seed.parties);
          putAll('products', seed.products);
          putAll('costCenters', seed.costCenters);
          putAll('vouchers', seed.vouchers);
          putAll('invoices', seed.invoices);
          putAll('cheques', seed.cheques);
          putAll('employees', seed.employees);
          putAll('assets', seed.assets);
          putAll('currencies', seed.currencies);
          putAll('exchangeRates', seed.exchangeRates);
           putAll('importDossiers', seed.importDossiers);
           putAll('salesOrders', seed.salesOrders);
           putAll('subcontractJobs', seed.subcontractJobs);
           putAll('rbacOperators', seed.rbacOperators);
          await batch.commit();
          showToast('فضای کاری اولیه در Supabase ایجاد شد.');
        } else {
          const existingCurrencies = await getDocs(query(collection(db, 'currencies'), where('ownerId', '==', uid)));
          if (existingCurrencies.empty) {
            const seed = createHolooSeedData(uid);
            const batch = writeBatch(db);
            seed.currencies.forEach((item) => batch.set(doc(db, 'currencies', item.id), {
              ...item, ownerId: uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
            }));
            seed.exchangeRates.forEach((item) => batch.set(doc(db, 'exchangeRates', item.id), {
              ...item, ownerId: uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
            }));
            await batch.commit();
          }
          const extraSeed = createHolooSeedData(uid);
          for (const [collectionName, records] of [
            ['importDossiers', extraSeed.importDossiers],
            ['salesOrders', extraSeed.salesOrders],
            ['subcontractJobs', extraSeed.subcontractJobs],
            ['rbacOperators', extraSeed.rbacOperators],
          ] as const) {
            const existingRecords = await getDocs(query(collection(db, collectionName), where('ownerId', '==', uid)));
            if (existingRecords.empty && records.length) {
              const batch = writeBatch(db);
              records.forEach((record) => batch.set(doc(db, collectionName, record.id), {
                ...record, ownerId: uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
              }));
              await batch.commit();
            }
          }
        }
      } catch (error) {
        if (isSupabaseOfflineError(error)) {
          showToast('ارتباط با Supabase برقرار نیست؛ داده‌های محلی در دسترس می‌مانند.');
          return;
        }
        handleSupabaseError(error, OperationType.WRITE, 'billion_records');
      } finally {
        setIsSyncing(false);
      }
    },
    [showToast]
  );

  useEffect(() => {
    if (!authReady) return;
    if (!user) return;

    let cancelled = false;
    const unsubs: (() => void)[] = [];

    ensureCloudSeed(user)
      .then(() => {
        if (cancelled) return;
        const uid = user.id;

        unsubs.push(
          onSnapshot(
            doc(db, 'users', uid),
            (snap) => {
              if (snap.exists()) {
                const d = snap.data();
                setProfile({
                  uid: d.uid,
                  displayName: d.displayName,
                  email: d.email,
                  companyName: d.companyName,
                  economicCode: d.economicCode,
                  nationalId: d.nationalId,
                  fiscalYear: d.fiscalYear,
                  currencyUnit: d.currencyUnit || 'IRT',
                  role: 'accountant',
                });
              }
            },
            (err) => {
              if (isSupabaseOfflineError(err)) return;
              handleSupabaseError(err, OperationType.GET, `users/${uid}`);
            }
          )
        );

        const subscribeCol = <T,>(
          colName: string,
          setter: React.Dispatch<React.SetStateAction<T[]>>
        ) => {
          const q = query(collection(db, colName), where('ownerId', '==', uid));
          unsubs.push(
            onSnapshot(
              q,
              (snap) => {
                const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as T);
                setter(list);
              },
              (err) => {
                if (isSupabaseOfflineError(err)) return;
                handleSupabaseError(err, OperationType.LIST, colName);
              }
            )
          );
        };

        subscribeCol<Account>('accounts', setAccounts);
        subscribeCol<Party>('parties', setParties);
        subscribeCol<Product>('products', setProducts);
        subscribeCol<InventoryLot>('inventoryLots', setInventoryLots);
        subscribeCol<InventoryLotMovement>('inventoryLotMovements', setInventoryLotMovements);
        subscribeCol<Voucher>('vouchers', setVouchers);
        subscribeCol<Invoice>('invoices', setInvoices);
        subscribeCol<Cheque>('cheques', setCheques);
        subscribeCol<Employee>('employees', setEmployees);
        subscribeCol<FixedAsset>('assets', setAssets);
        subscribeCol<CostCenter>('costCenters', setCostCenters);
        subscribeCol<CurrencyDefinition>('currencies', setCurrencies);
        subscribeCol<ExchangeRateEntry>('exchangeRates', setExchangeRates);
         subscribeCol<ImportDossier>('importDossiers', setImportDossiers);
         subscribeCol<SalesOrder>('salesOrders', setSalesOrders);
         subscribeCol<SubcontractJob>('subcontractJobs', setSubcontractJobs);
         subscribeCol<RbacOperator>('rbacOperators', setRbacOperators);
         subscribeCol<AuditActivityLog>('auditLogs', setAuditLogs);
      })
      .catch((err) => {
        console.error(err);
      });

    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, [authReady, user, ensureCloudSeed]);

  useEffect(() => {
    if (!authReady || !user || typeof window === 'undefined') return;
    const handleReconnect = () => {
      void flushLocalSyncOutbox().then((result) => {
        if (result.synced > 0) showToast(`${result.synced} عملیات ذخیره‌شده پس از اتصال اینترنت همگام شد.`);
        if (result.failed > 0) showToast(`${result.failed} عملیات آفلاین نیازمند بررسی است؛ از بازنویسی تغییرات دستگاه دیگر جلوگیری شد.`);
      }).catch((error) => {
        console.error('Offline accounting sync failed:', error);
      });
    };
    window.addEventListener('online', handleReconnect);
    return () => window.removeEventListener('online', handleReconnect);
  }, [authReady, user, showToast]);

  const ownerId = user?.id ?? DEMO_OWNER;
  const isCloudMode = !!user;

  const trialBalance = useMemo(() => computeTrialBalance(accounts, vouchers), [accounts, vouchers]);
  const incomeStatement = useMemo(() => computeIncomeStatement(trialBalance), [trialBalance]);
  const balanceSheet = useMemo(() => computeBalanceSheet(trialBalance), [trialBalance]);
  const partyBalances = useMemo(() => computePartyBalances(parties, vouchers), [parties, vouchers]);
  const auditReport = useMemo(
    () =>
      computeAuditReport({
        accounts,
        vouchers,
        invoices,
        parties,
        products,
        cheques,
        trialBalance,
        balanceSheet,
        partyBalances,
      }),
    [accounts, vouchers, invoices, parties, products, cheques, trialBalance, balanceSheet, partyBalances]
  );

  const completeEnrollment = useCallback(async (mode: 'bootstrap' | 'invite', token: string) => {
    const session = await ensurePasswordlessSession();
    const deviceId = deviceIdentity?.deviceId;
    if (!deviceId) throw new Error('شناسه این دستگاه آماده نیست.');
    const platform = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent)
      ? 'android'
      : typeof navigator !== 'undefined' && /iphone|ipad/i.test(navigator.userAgent) ? 'ios' : 'web';
    const deviceLabel = platform === 'android' ? 'دستگاه Android' : platform === 'ios' ? 'دستگاه iOS' : 'دستگاه مرورگر';
    if (mode === 'bootstrap') {
      await bootstrapBillionCompany({
        bootstrapToken: token,
        companyName: DEFAULT_PROFILE.companyName,
        deviceId,
        deviceLabel,
        platform,
      });
    } else {
      await acceptBillionInvite({ token, deviceId, deviceLabel, platform });
    }
    const membership = await getBillionMembership();
    if (!membership) throw new Error('عضویت شرکت پس از ثبت دعوت‌نامه تأیید نشد.');
    setActiveCompanyId(membership.company_id);
    setUser(session.user);
    setAuthReady(true);
    showToast(mode === 'bootstrap' ? 'شرکت در Supabase راه‌اندازی شد.' : 'این دستگاه به شرکت متصل شد.');
  }, [deviceIdentity, ensureCloudSeed, showToast]);

  const bootstrapCloud = useCallback((token: string) => completeEnrollment('bootstrap', token), [completeEnrollment]);
  const joinCloud = useCallback((token: string) => completeEnrollment('invite', token), [completeEnrollment]);

  const createDeviceInvite = useCallback(async () => {
    const result = await createBillionInvite('member');
    const token = String(result.invite_token ?? '');
    if (!token) throw new Error('کد دعوت از Supabase دریافت نشد.');
    return token;
  }, []);

  const logout = useCallback(async () => {
    await signOutAccount();
    showToast('از حساب ابری خارج شدید. محیط نمونه محلی فعال است.');
  }, [showToast]);

  const updateCompanyProfile = useCallback(
    async (patch: Partial<CompanyProfile>) => {
      const next = { ...profile, ...patch };
      setProfile(next);
      if (user) {
        const path = `users/${user.id}`;
        try {
          await updateDoc(doc(db, 'users', user.id), {
            displayName: next.displayName.slice(0, 120),
            companyName: next.companyName.slice(0, 160),
            economicCode: (next.economicCode || '').slice(0, 32),
            nationalId: (next.nationalId || '').slice(0, 32),
            fiscalYear: next.fiscalYear.slice(0, 16),
            currencyUnit: next.currencyUnit,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleSupabaseError(err, OperationType.UPDATE, path);
        }
      }
      showToast('مشخصات شرکتی و سال مالی ذخیره شد.');
    },
    [profile, user, showToast]
  );

  const setCurrencyUnit = useCallback(
    async (unit: CurrencyUnit) => {
      await updateCompanyProfile({ currencyUnit: unit });
    },
    [updateCompanyProfile]
  );

  // ---------------- ACCOUNTS CRUD ----------------
  const addAccount = useCallback(
    async (acc: Omit<Account, 'id' | 'ownerId'>) => {
      const id = generateSafeId('acc');
      const full: Account = { ...acc, id, ownerId };
      if (user) {
        try {
          await setDoc(doc(db, 'accounts', id), {
            ownerId,
            code: acc.code.replace(/\D/g, '').slice(0, 24),
            title: acc.title.trim().slice(0, 160),
            level: acc.level,
            ...(acc.parentCode ? { parentCode: acc.parentCode.slice(0, 24) } : {}),
            category: acc.category,
            nature: acc.nature,
            isSystem: false,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleSupabaseError(err, OperationType.CREATE, `accounts/${id}`);
        }
      } else {
        setAccounts((prev) => [...prev, full]);
      }
      showToast(`حساب «${acc.title}» با کد ${acc.code} در کدینگ ثبت شد.`);
    },
    [ownerId, user, showToast]
  );

  const updateAccount = useCallback(
    async (
      accountId: string,
      patch: Partial<Pick<Account, 'title' | 'parentCode' | 'category' | 'nature'>>
    ) => {
      const existing = accounts.find((a) => a.id === accountId);
      if (!existing) return;
      const updatePayload: Record<string, unknown> = { updatedAt: serverTimestamp() };
      if (patch.title !== undefined) updatePayload.title = patch.title.trim().slice(0, 160);
      if (patch.parentCode !== undefined) updatePayload.parentCode = patch.parentCode.slice(0, 24);
      if (patch.category !== undefined) updatePayload.category = patch.category;
      if (patch.nature !== undefined) updatePayload.nature = patch.nature;

      if (user) {
        try {
          await updateDoc(doc(db, 'accounts', accountId), updatePayload);
        } catch (err) {
          handleSupabaseError(err, OperationType.UPDATE, `accounts/${accountId}`);
        }
      } else {
        setAccounts((prev) =>
          prev.map((a) => (a.id === accountId ? { ...a, ...patch } : a))
        );
      }
      showToast(`حساب «${patch.title ?? existing.title}» ویرایش شد.`);
    },
    [accounts, user, showToast]
  );

  const deleteAccount = useCallback(
    async (accountId: string): Promise<boolean> => {
      const acc = accounts.find((a) => a.id === accountId);
      if (!acc) return false;
      if (acc.isSystem) {
        showToast('حساب‌های سیستمی استاندارد هلو قابل حذف نیستند (فقط قابل ویرایش عنوان هستند).');
        return false;
      }
      const hasLines = vouchers.some((v) => v.lines.some((l) => l.accountCode === acc.code));
      if (hasLines) {
        showToast('این حساب دارای گردش در اسناد حسابداری است و طبق اصول حسابرسی قابل حذف نیست.');
        return false;
      }
      if (user) {
        try {
          await deleteDoc(doc(db, 'accounts', accountId));
        } catch (err) {
          handleSupabaseError(err, OperationType.DELETE, `accounts/${accountId}`);
        }
      } else {
        setAccounts((prev) => prev.filter((a) => a.id !== accountId));
      }
      showToast(`حساب «${acc.title}» از کدینگ حذف شد.`);
      return true;
    },
    [accounts, vouchers, user, showToast]
  );

  // ---------------- PARTIES CRUD ----------------
  const addParty = useCallback(
    async (party: Omit<Party, 'id' | 'ownerId'>) => {
      const id = generateSafeId('pty');
      const full: Party = { ...party, id, ownerId };
      if (user) {
        try {
          await setDoc(doc(db, 'parties', id), {
            ownerId,
            code: party.code.slice(0, 32),
            name: party.name.trim().slice(0, 160),
            partyType: party.partyType,
            ...(party.nationalId ? { nationalId: party.nationalId.slice(0, 32) } : {}),
            ...(party.economicCode ? { economicCode: party.economicCode.slice(0, 32) } : {}),
            ...(party.phone ? { phone: party.phone.slice(0, 32) } : {}),
            ...(party.address ? { address: party.address.slice(0, 300) } : {}),
            creditLimit: Math.max(0, Number(party.creditLimit) || 0),
            openingBalance: Number(party.openingBalance) || 0,
            accountCode: party.accountCode.slice(0, 24),
            ...(party.commissionRate !== undefined
              ? { commissionRate: Math.min(100, Math.max(0, Number(party.commissionRate))) }
              : {}),
            ...(party.pricingTier ? { pricingTier: party.pricingTier } : {}),
            ...(party.tierDiscountPct !== undefined
              ? { tierDiscountPct: Number(party.tierDiscountPct) || 0 }
              : {}),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleSupabaseError(err, OperationType.CREATE, `parties/${id}`);
        }
      } else {
        setParties((prev) => [full, ...prev]);
      }
      showToast(`طرف‌حساب «${party.name}» با موفقیت تعریف شد.`);
    },
    [ownerId, user, showToast]
  );

  const updateParty = useCallback(
    async (partyId: string, patch: Partial<Omit<Party, 'id' | 'ownerId' | 'code'>>) => {
      const existing = parties.find((p) => p.id === partyId);
      if (!existing) return;
      if (user) {
        try {
          const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };
          if (patch.name !== undefined) payload.name = patch.name.trim().slice(0, 160);
          if (patch.partyType !== undefined) payload.partyType = patch.partyType;
          if (patch.nationalId !== undefined) payload.nationalId = patch.nationalId.slice(0, 32);
          if (patch.economicCode !== undefined) payload.economicCode = patch.economicCode.slice(0, 32);
          if (patch.phone !== undefined) payload.phone = patch.phone.slice(0, 32);
          if (patch.address !== undefined) payload.address = patch.address.slice(0, 300);
          if (patch.creditLimit !== undefined) payload.creditLimit = Math.max(0, Number(patch.creditLimit) || 0);
          if (patch.openingBalance !== undefined) payload.openingBalance = Number(patch.openingBalance) || 0;
          if (patch.accountCode !== undefined) payload.accountCode = patch.accountCode.slice(0, 24);
          if (patch.commissionRate !== undefined) {
            payload.commissionRate = Math.min(100, Math.max(0, Number(patch.commissionRate) || 0));
          }
          if (patch.pricingTier !== undefined) payload.pricingTier = patch.pricingTier;
          if (patch.tierDiscountPct !== undefined) {
            payload.tierDiscountPct = Math.min(50, Math.max(0, Number(patch.tierDiscountPct) || 0));
          }
          await updateDoc(doc(db, 'parties', partyId), payload);
        } catch (err) {
          handleSupabaseError(err, OperationType.UPDATE, `parties/${partyId}`);
        }
      } else {
        setParties((prev) => prev.map((p) => (p.id === partyId ? { ...p, ...patch } : p)));
      }
      showToast(`اطلاعات طرف‌حساب «${patch.name ?? existing.name}» به‌روزرسانی شد.`);
    },
    [parties, user, showToast]
  );

  const deleteParty = useCallback(
    async (partyId: string): Promise<boolean> => {
      const party = parties.find((p) => p.id === partyId);
      if (!party) return false;
      const usedInVoucher = vouchers.some((v) => v.lines.some((l) => l.partyId === partyId));
      const usedInInvoice = invoices.some((i) => i.partyId === partyId);
      if (usedInVoucher || usedInInvoice) {
        showToast('این طرف‌حساب دارای سابقه سند یا فاکتور است و جهت حفظ یکپارچگی دفاتر قابل حذف نیست.');
        return false;
      }
      if (user) {
        try {
          await deleteDoc(doc(db, 'parties', partyId));
        } catch (err) {
          handleSupabaseError(err, OperationType.DELETE, `parties/${partyId}`);
        }
      } else {
        setParties((prev) => prev.filter((p) => p.id !== partyId));
      }
      showToast(`طرف‌حساب «${party.name}» حذف شد.`);
      return true;
    },
    [parties, vouchers, invoices, user, showToast]
  );

  // ---------------- VOUCHERS CRUD & AUDIT OPS ----------------
  const createVoucher = useCallback(
    async (payload: {
      date: string;
      description: string;
      voucherType: VoucherType;
      status: VoucherStatus;
      lines: VoucherLine[];
      referenceId?: string;
      currencyCode?: string;
      exchangeRate?: number;
    }): Promise<Voucher> => {
      validateJournalEntryPayload(payload);
      if (payload.voucherType !== 'closing' && vouchers.some((voucher) => voucher.voucherType === 'closing' && voucher.date.slice(0, 4) === payload.date.slice(0, 4))) { const message = `دوره مالی ${payload.date.slice(0, 4)} بسته شده است؛ ثبت سند جدید مجاز نیست.`; showToast(message); throw new Error(message); }
      const totalDebit = payload.lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
      const totalCredit = payload.lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
      if (Math.abs(totalDebit - totalCredit) > 0 || payload.lines.length < 2) {
        throw new Error('سند حسابداری تراز نیست! جمع بدهکار و بستانکار باید دقیقاً برابر باشد.');
      }
      const nextNumber =
        vouchers.reduce((max, v) => Math.max(max, v.voucherNumber || 0), 0) + 1;
      const id = generateSafeId('vch');

      const normCode = normalizeCurrencyCode(payload.currencyCode);
      const isFx = isForeignCurrency(normCode) && Number(payload.exchangeRate) > 0;
      const safeRate = isFx ? Number(payload.exchangeRate) : undefined;
      const cleanLines = payload.lines.slice(0, 100);
      const foreignTotalDebit = isFx
        ? roundCurrency(
            cleanLines.reduce((s, l) => s + (Number(l.foreignDebit) || 0), 0),
            2
          )
        : undefined;
      const foreignTotalCredit = isFx
        ? roundCurrency(
            cleanLines.reduce((s, l) => s + (Number(l.foreignCredit) || 0), 0),
            2
          )
        : undefined;

      const full: Voucher = {
        id,
        ownerId,
        voucherNumber: nextNumber,
        date: payload.date,
        description: payload.description.trim().slice(0, 300),
        voucherType: payload.voucherType,
        status: payload.status,
        totalDebit,
        totalCredit,
        ...(isFx
          ? {
              currencyCode: normCode,
              exchangeRate: safeRate,
              foreignTotalDebit,
              foreignTotalCredit,
            }
          : {}),
        referenceId: payload.referenceId,
        lines: cleanLines,
      };

      if (user) {
        try {
          await setDoc(doc(db, 'vouchers', id), {
            ownerId,
            voucherNumber: nextNumber,
            date: full.date.slice(0, 20),
            description: full.description,
            voucherType: full.voucherType,
            status: full.status,
            totalDebit,
            totalCredit,
            ...(isFx && safeRate
              ? {
                  currencyCode: normCode.slice(0, 10),
                  exchangeRate: safeRate,
                  foreignTotalDebit: foreignTotalDebit ?? 0,
                  foreignTotalCredit: foreignTotalCredit ?? 0,
                }
              : {}),
            ...(full.referenceId ? { referenceId: full.referenceId.slice(0, 128) } : {}),
            lines: full.lines,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleSupabaseError(err, OperationType.CREATE, `vouchers/${id}`);
          throw err;
        }
      } else {
        setVouchers((prev) => [...prev, full]);
      }
      showToast(
        isFx
          ? `سند ارزی شماره ${nextNumber} (${normCode}) با موفقیت ثبت شد.`
          : `سند حسابداری شماره ${nextNumber} با موفقیت ثبت شد.`
      );
      return full;
    },
    [vouchers, ownerId, user, showToast]
  );

  const updateVoucher = useCallback(
    async (
      voucherId: string,
      payload: {
        date: string;
        description: string;
        voucherType: VoucherType;
        status: VoucherStatus;
        lines: VoucherLine[];
        currencyCode?: string;
        exchangeRate?: number;
      }
    ) => {
      validateJournalEntryPayload(payload);
      const existing = vouchers.find((v) => v.id === voucherId);
      if (!existing) return;
      if (vouchers.some((voucher) => voucher.voucherType === 'closing' && (voucher.date.slice(0, 4) === existing.date.slice(0, 4) || voucher.date.slice(0, 4) === payload.date.slice(0, 4)))) { const message = `دوره مالی ${existing.date.slice(0, 4)} بسته شده است؛ ویرایش سند مجاز نیست.`; showToast(message); throw new Error(message); }
      if (existing.status === 'permanent') {
        showToast('اسناد دائم طبق قانون دفاتر قابل ویرایش مستقیم نیستند؛ از دکمه «صدور سند اصلاحی/معکوس» استفاده کنید.');
        return;
      }
      const totalDebit = payload.lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
      const totalCredit = payload.lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
      if (Math.abs(totalDebit - totalCredit) > 0 || payload.lines.length < 2) {
        showToast('اختلاف بدهکار و بستانکار سند باید دقیقاً صفر باشد.');
        return;
      }
      const cleanDesc = payload.description.trim().slice(0, 300);
      const cleanLines = payload.lines.slice(0, 100);
      const normCode = normalizeCurrencyCode(payload.currencyCode);
      const isFx = isForeignCurrency(normCode) && Number(payload.exchangeRate) > 0;
      const safeRate = isFx ? Number(payload.exchangeRate) : 1;
      const foreignTotalDebit = isFx
        ? roundCurrency(
            cleanLines.reduce((s, l) => s + (Number(l.foreignDebit) || 0), 0),
            2
          )
        : 0;
      const foreignTotalCredit = isFx
        ? roundCurrency(
            cleanLines.reduce((s, l) => s + (Number(l.foreignCredit) || 0), 0),
            2
          )
        : 0;

      if (user) {
        try {
          await updateDoc(doc(db, 'vouchers', voucherId), {
            date: payload.date.slice(0, 20),
            description: cleanDesc,
            voucherType: payload.voucherType,
            status: payload.status,
            lines: cleanLines,
            totalDebit,
            totalCredit,
            currencyCode: isFx ? normCode.slice(0, 10) : BASE_CURRENCY_CODE,
            exchangeRate: safeRate,
            foreignTotalDebit,
            foreignTotalCredit,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleSupabaseError(err, OperationType.UPDATE, `vouchers/${voucherId}`);
          throw err;
        }
      } else {
        setVouchers((prev) =>
          prev.map((v) =>
            v.id === voucherId
              ? {
                  ...v,
                  date: payload.date,
                  description: cleanDesc,
                  voucherType: payload.voucherType,
                  status: payload.status,
                  lines: cleanLines,
                  totalDebit,
                  totalCredit,
                  currencyCode: isFx ? normCode : undefined,
                  exchangeRate: isFx ? safeRate : undefined,
                  foreignTotalDebit: isFx ? foreignTotalDebit : undefined,
                  foreignTotalCredit: isFx ? foreignTotalCredit : undefined,
                }
              : v
          )
        );
      }
      showToast(`سند موقت شماره ${existing.voucherNumber} با موفقیت اصلاح شد.`);
    },
    [vouchers, user, showToast]
  );

  const deleteVoucher = useCallback(
    async (voucherId: string): Promise<boolean> => {
      const existing = vouchers.find((v) => v.id === voucherId);
      if (!existing) return false;
      if (vouchers.some((voucher) => voucher.voucherType === 'closing' && voucher.date.slice(0, 4) === existing.date.slice(0, 4))) { showToast(`دوره مالی ${existing.date.slice(0, 4)} بسته شده است؛ حذف سند مجاز نیست.`); return false; }
      if (existing.status === 'permanent') {
        showToast('حذف سند دائم مجاز نیست! برای ابطال اثر سند دائم، «سند معکوس» صادر کنید.');
        return false;
      }
      if (user) {
        try {
          await deleteDoc(doc(db, 'vouchers', voucherId));
        } catch (err) {
          handleSupabaseError(err, OperationType.DELETE, `vouchers/${voucherId}`);
          throw err;
        }
      } else {
        setVouchers((prev) => prev.filter((v) => v.id !== voucherId));
      }
      showToast(`سند موقت شماره ${existing.voucherNumber} حذف شد.`);
      return true;
    },
    [vouchers, user, showToast]
  );

  const finalizeVoucher = useCallback(
    async (voucherId: string) => {
      const existing = vouchers.find((voucher) => voucher.id === voucherId);
      if (!existing || existing.status === 'permanent') return;
      if (vouchers.some((voucher) => voucher.voucherType === 'closing' && voucher.date.slice(0, 4) === existing.date.slice(0, 4))) { const message = `دوره مالی ${existing.date.slice(0, 4)} بسته شده است؛ قطعی‌سازی سند مجاز نیست.`; showToast(message); throw new Error(message); }

      const originalVoucher = existing.referenceId
        ? vouchers.find((voucher) => voucher.id === existing.referenceId)
        : undefined;
      if (originalVoucher?.referenceId?.startsWith('treasury-allocation:')) {
        if (vouchers.some((voucher) => voucher.referenceId === originalVoucher.id && voucher.id !== existing.id && voucher.status === 'permanent')) {
          throw new Error('اثر تخصیص این سند خزانه قبلاً برگشت داده شده است.');
        }
        const cashLine = originalVoucher.lines.find((line) => line.accountCode.startsWith('101') || line.accountCode.startsWith('102'));
        if (!cashLine) throw new Error('حساب صندوق/بانک سند اصلی برای برگشت تخصیص یافت نشد.');
        const invoiceUpdates = buildInvoiceAllocationReversal(invoices, originalVoucher.id, cashLine.accountCode);
        if (user) {
          const batch = writeBatch(db);
          batch.update(doc(db, 'vouchers', voucherId), { status: 'permanent', updatedAt: serverTimestamp() });
          for (const update of invoiceUpdates) {
            batch.update(doc(db, 'invoices', update.invoiceId), {
              creditAmount: update.creditAmount, paidCash: update.paidCash, paidBank: update.paidBank,
              status: update.status, paymentAllocations: update.paymentAllocations, updatedAt: serverTimestamp(),
            });
          }
          await batch.commit();
        } else {
          setVouchers((prev) => prev.map((voucher) => voucher.id === voucherId ? { ...voucher, status: 'permanent' } : voucher));
          setInvoices((prev) => prev.map((invoice) => {
            const update = invoiceUpdates.find((candidate) => candidate.invoiceId === invoice.id);
            return update ? { ...invoice, ...update, id: invoice.id } : invoice;
          }));
        }
        showToast('سند معکوس قطعی شد و تخصیص‌های فاکتورها نیز به‌صورت یکجا برگشت خورد.');
        return;
      }

      if (user) {
        try {
          await updateDoc(doc(db, 'vouchers', voucherId), {
            status: 'permanent',
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleSupabaseError(err, OperationType.UPDATE, `vouchers/${voucherId}`);
          throw err;
        }
      } else {
        setVouchers((prev) =>
          prev.map((v) => (v.id === voucherId ? { ...v, status: 'permanent' } : v))
        );
      }
      showToast('سند حسابداری به وضعیت «دائم و قطعی» تبدیل شد.');
    },
    [vouchers, invoices, user, showToast]
  );

  const createReversingVoucher = useCallback(
    async (voucherId: string): Promise<Voucher | null> => {
      const orig = vouchers.find((v) => v.id === voucherId);
      if (!orig) return null;
      if (orig.referenceId?.startsWith('treasury-allocation:') &&
          vouchers.some((voucher) => voucher.referenceId === orig.id)) {
        throw new Error('برای این سند خزانه قبلاً سند معکوس ایجاد شده است.');
      }
      const reversedLines: VoucherLine[] = orig.lines.map((l) => ({
        ...l,
        description: `برگشت/اصلاح سند #${orig.voucherNumber}: ${l.description}`,
        debit: l.credit,
        credit: l.debit,
        ...(l.foreignCredit !== undefined ? { foreignDebit: l.foreignCredit } : { foreignDebit: undefined }),
        ...(l.foreignDebit !== undefined ? { foreignCredit: l.foreignDebit } : { foreignCredit: undefined }),
      }));
      return createVoucher({
        date: getTodayShamsi(),
        description: `سند معکوس و اصلاحی بابت ابطال اثر سند شماره ${orig.voucherNumber} (${orig.date})`,
        voucherType: 'general',
        status: 'draft',
        lines: reversedLines,
        referenceId: orig.id,
        ...(isForeignCurrency(orig.currencyCode) && orig.exchangeRate
          ? { currencyCode: orig.currencyCode, exchangeRate: orig.exchangeRate }
          : {}),
      });
    },
    [vouchers, createVoucher]
  );

  const renumberVouchersChronologically = useCallback(async () => {
    const rank = (t: VoucherType) => (t === 'opening' ? 0 : t === 'closing' ? 2 : 1);
    const ordered = [...vouchers].sort((a, b) => {
      const rDiff = rank(a.voucherType) - rank(b.voucherType);
      if (rDiff !== 0) return rDiff;
      const dateDiff = a.date.localeCompare(b.date);
      if (dateDiff !== 0) return dateDiff;
      return a.voucherNumber - b.voucherNumber;
    });

    if (user) {
      try {
        const batch = writeBatch(db);
        ordered.forEach((v, idx) => {
          const nextNum = idx + 1;
          if (v.voucherNumber !== nextNum) {
            batch.update(doc(db, 'vouchers', v.id), {
              voucherNumber: nextNum,
              updatedAt: serverTimestamp(),
            });
          }
        });
        await batch.commit();
      } catch (err) {
        handleSupabaseError(err, OperationType.UPDATE, 'vouchers');
      }
    } else {
      const numMap = new Map<string, number>();
      ordered.forEach((v, idx) => numMap.set(v.id, idx + 1));
      setVouchers((prev) =>
        prev.map((v) => ({ ...v, voucherNumber: numMap.get(v.id) ?? v.voucherNumber }))
      );
    }
    showToast('تمامی اسناد بر اساس تاریخ شمسی و ترتیب افتتاحیه/اختتامیه شماره‌گذاری مجدد شدند.');
  }, [vouchers, user, showToast]);

  // ---------------- PRODUCTS & WAREHOUSE CRUD ----------------
  const addProduct = useCallback(
    async (product: Omit<Product, 'id' | 'ownerId'>) => {
      const id = generateSafeId('prd');
      const full: Product = { ...product, id, ownerId };
      if (user) {
        try {
          await setDoc(doc(db, 'products', id), {
            ownerId,
            sku: product.sku.slice(0, 48),
            name: product.name.trim().slice(0, 180),
            category: product.category.slice(0, 80),
            warehouse: product.warehouse.slice(0, 80),
            unit: product.unit.slice(0, 32),
            ...(product.secondaryUnit ? { secondaryUnit: product.secondaryUnit.trim().slice(0, 32) } : {}),
            ...(product.kgPerCarton && Number(product.kgPerCarton) > 0
              ? { kgPerCarton: Math.min(10000, Number(product.kgPerCarton)) }
              : {}),
            ...(product.bobbinUnit ? { bobbinUnit: product.bobbinUnit.trim().slice(0, 32) } : {}),
            ...(product.bobbinsPerCarton !== undefined && Number(product.bobbinsPerCarton) >= 0
              ? { bobbinsPerCarton: Math.min(10000, Number(product.bobbinsPerCarton)) }
              : {}),
            ...(product.yarnCount ? { yarnCount: product.yarnCount.trim().slice(0, 48) } : {}),
            ...(product.lotNumber ? { lotNumber: product.lotNumber.trim().slice(0, 48) } : {}),
            ...(product.originCountry ? { originCountry: product.originCountry.trim().slice(0, 64) } : {}),
            buyPrice: Math.max(0, Number(product.buyPrice) || 0),
            sellPrice: Math.max(0, Number(product.sellPrice) || 0),
            stock: Number((Number(product.stock) || 0).toFixed(2)),
            reorderPoint: Math.max(0, Number(product.reorderPoint) || 0),
            vatExempt: Boolean(product.vatExempt),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleSupabaseError(err, OperationType.CREATE, `products/${id}`);
          throw err;
        }
      } else {
        setProducts((prev) => [full, ...prev]);
      }
      showToast(`نخ/کالای «${product.name}» با موفقیت در انبار ثبت شد.`);
      return full;
    },
    [ownerId, user, showToast]
  );

  const updateProduct = useCallback(
    async (productId: string, patch: Partial<Omit<Product, 'id' | 'ownerId' | 'sku'>>) => {
      const existing = products.find((p) => p.id === productId);
      if (!existing) throw new Error(`کالای موردنظر برای ویرایش یافت نشد: ${productId}`);
      if (user) {
        try {
          const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };
          if (patch.name !== undefined) payload.name = patch.name.trim().slice(0, 180);
          if (patch.category !== undefined) payload.category = patch.category.slice(0, 80);
          if (patch.warehouse !== undefined) payload.warehouse = patch.warehouse.slice(0, 80);
          if (patch.unit !== undefined) payload.unit = patch.unit.slice(0, 32);
          if (patch.secondaryUnit !== undefined) payload.secondaryUnit = patch.secondaryUnit.trim().slice(0, 32);
          if (patch.kgPerCarton !== undefined && Number(patch.kgPerCarton) > 0) {
            payload.kgPerCarton = Math.min(10000, Number(patch.kgPerCarton));
          }
          if (patch.bobbinUnit !== undefined) payload.bobbinUnit = patch.bobbinUnit.trim().slice(0, 32);
          if (patch.bobbinsPerCarton !== undefined && Number(patch.bobbinsPerCarton) >= 0) {
            payload.bobbinsPerCarton = Math.min(10000, Number(patch.bobbinsPerCarton));
          }
          if (patch.yarnCount !== undefined) payload.yarnCount = patch.yarnCount.trim().slice(0, 48);
          if (patch.lotNumber !== undefined) payload.lotNumber = patch.lotNumber.trim().slice(0, 48);
          if (patch.originCountry !== undefined) payload.originCountry = patch.originCountry.trim().slice(0, 64);
          if (patch.buyPrice !== undefined) payload.buyPrice = Math.max(0, Number(patch.buyPrice) || 0);
          if (patch.sellPrice !== undefined) payload.sellPrice = Math.max(0, Number(patch.sellPrice) || 0);
          if (patch.stock !== undefined) payload.stock = Number((Number(patch.stock) || 0).toFixed(2));
          if (patch.reorderPoint !== undefined) payload.reorderPoint = Math.max(0, Number(patch.reorderPoint) || 0);
          if (patch.vatExempt !== undefined) payload.vatExempt = Boolean(patch.vatExempt);
          await updateDoc(doc(db, 'products', productId), payload);
        } catch (err) {
          handleSupabaseError(err, OperationType.UPDATE, `products/${productId}`);
          throw err;
        }
      } else {
        setProducts((prev) => prev.map((p) => (p.id === productId ? { ...p, ...patch } : p)));
      }
      showToast(`مشخصات نخ/کالا «${patch.name ?? existing.name}» ویرایش شد.`);
    },
    [products, user, showToast]
  );

  const deleteProduct = useCallback(
    async (productId: string): Promise<boolean> => {
      const prod = products.find((p) => p.id === productId);
      if (!prod) return false;
      const used = invoices.some((i) => i.items.some((it) => it.productId === productId));
      if (used) {
        showToast('این کالا دارای گردش در فاکتورها است و قابل حذف نیست.');
        return false;
      }
      if (user) {
        try {
          await deleteDoc(doc(db, 'products', productId));
        } catch (err) {
          handleSupabaseError(err, OperationType.DELETE, `products/${productId}`);
          throw err;
        }
      } else {
        setProducts((prev) => prev.filter((p) => p.id !== productId));
      }
      showToast(`کالا «${prod.name}» از انبار حذف شد.`);
      return true;
    },
    [products, invoices, user, showToast]
  );

  const adjustProductStock = useCallback(
    async (productId: string, newStock: number) => {
      const product = products.find((item) => item.id === productId);
      if (!product) throw new Error(`کالای موردنظر برای تعدیل موجودی یافت نشد: ${productId}`);
      if (!Number.isFinite(newStock) || newStock < 0) throw new Error('موجودی جدید باید عددی معتبر و غیرمنفی باشد.');
      if (user) {
        try {
          await updateDoc(doc(db, 'products', productId), {
            stock: Number(newStock),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleSupabaseError(err, OperationType.UPDATE, `products/${productId}`);
          throw err;
        }
      } else {
        setProducts((prev) =>
          prev.map((p) => (p.id === productId ? { ...p, stock: Number(newStock) } : p))
        );
      }
    },
    [user, products]
  );

  const adjustProductStockWithVoucher = useCallback(
    async (productId: string, countedStock: number, reason: string) => {
      const prod = products.find((p) => p.id === productId);
      if (!prod) throw new Error(`کالای موردنظر برای انبارگردانی یافت نشد: ${productId}`);
      if (!Number.isFinite(countedStock) || countedStock < 0) throw new Error('موجودی شمارش‌شده باید عددی معتبر و غیرمنفی باشد.');
      const cleanCounted = Math.max(0, Number(countedStock.toFixed(2)));
      const diffQty = Number((cleanCounted - prod.stock).toFixed(2));
      if (diffQty === 0) {
        showToast('موجودی شمارش‌شده با موجودی سیستمی برابر است؛ نیازی به تعدیل نیست.');
        return;
      }
      await adjustProductStock(productId, cleanCounted);
      const valueDiff = Math.round(Math.abs(diffQty) * prod.buyPrice);
      if (valueDiff > 0) {
        const lines: VoucherLine[] =
          diffQty < 0
            ? [
                {
                  accountCode: '80401',
                  accountTitle: 'کسری باسکول، انبارگردانی و ضایعات نخ',
                  costCenterId: 'cc_warehouse',
                  description: `کسری انبارگردانی ${Math.abs(diffQty)} ${prod.unit} «${prod.name}» — ${reason}`,
                  debit: valueDiff,
                  credit: 0,
                },
                {
                  accountCode: '10501',
                  accountTitle: 'موجودی انبار نخ و کالای وارداتی',
                  description: `تعدیل کاهشی انبار بابت ${prod.sku}`,
                  debit: 0,
                  credit: valueDiff,
                },
              ]
            : [
                {
                  accountCode: '10501',
                  accountTitle: 'موجودی انبار نخ و کالای وارداتی',
                  costCenterId: 'cc_warehouse',
                  description: `اضافی انبارگردانی ${diffQty} ${prod.unit} «${prod.name}» — ${reason}`,
                  debit: valueDiff,
                  credit: 0,
                },
                {
                  accountCode: '60301',
                  accountTitle: 'اضافی انبارگردانی و درآمدهای متفرقه',
                  description: `ثبت درآمد اضافی انبارگردانی ${prod.sku}`,
                  debit: 0,
                  credit: valueDiff,
                },
              ];

        try {
          await createVoucher({
            date: getTodayShamsi(),
            description: `سند تعدیل انبارگردانی کالا ${prod.sku} (${diffQty > 0 ? 'اضافی' : 'کسری'} ${Math.abs(diffQty)} ${prod.unit})`,
            voucherType: 'general',
            status: 'permanent',
            lines,
            referenceId: prod.id,
          });
        } catch (error) {
          try {
            await adjustProductStock(productId, prod.stock);
          } catch (rollbackError) {
            console.error('Inventory adjustment rollback failed:', rollbackError);
            throw new Error(`ثبت سند انبارگردانی ناموفق بود و برگشت موجودی کالا ${prod.sku} نیز شکست خورد؛ مغایرت موجودی نیازمند رسیدگی دستی است. علت ثبت سند: ${error instanceof Error ? error.message : String(error)}؛ علت برگشت: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
          }
          throw error;
        }
      } else {
        showToast('موجودی انبارگردانی با موفقیت تعدیل شد.');
      }
    },
    [products, adjustProductStock, createVoucher, showToast]
  );

  const bulkStocktakingWithVoucher = useCallback(
    async (items: { productId: string; countedStock: number }[], reason: string) => {
      const voucherLines: VoucherLine[] = [];
      const changedProducts: Array<{ productId: string; previousStock: number }> = [];
      let changedCount = 0;
      const requestedIds = items.map((entry) => entry.productId);
      if (new Set(requestedIds).size !== requestedIds.length) throw new Error('در فهرست انبارگردانی، یک کالا بیش از یک بار تکرار شده است.');
      for (const entry of items) {
        if (!Number.isFinite(entry.countedStock) || entry.countedStock < 0) throw new Error(`موجودی شمارش‌شده برای کالا ${entry.productId} معتبر نیست.`);
        if (!products.some((product) => product.id === entry.productId)) throw new Error(`کالای انبارگردانی یافت نشد: ${entry.productId}`);
      }

      try {
      for (const entry of items) {
        const prod = products.find((p) => p.id === entry.productId)!;
        const safeCounted = Math.max(0, Number(entry.countedStock.toFixed(2)));
        const diffQty = Number((safeCounted - prod.stock).toFixed(2));
        if (diffQty === 0) continue;

        changedCount += 1;
        changedProducts.push({ productId: prod.id, previousStock: prod.stock });
        await adjustProductStock(prod.id, safeCounted);
        const valueDiff = Math.round(Math.abs(diffQty) * prod.buyPrice);
        if (valueDiff > 0) {
          if (diffQty < 0) {
            voucherLines.push(
              {
                accountCode: '80401',
                accountTitle: 'کسری انبارگردانی و ضایعات کالا',
                costCenterId: 'cc_warehouse',
                description: `کسری انبارگردانی ${Math.abs(diffQty)} ${prod.unit} «${prod.name}» — ${reason}`,
                debit: valueDiff,
                credit: 0,
              },
              {
                accountCode: '10501',
                accountTitle: 'موجودی انبار مرکزی',
                description: `تعدیل کاهشی انبار بابت ${prod.sku}`,
                debit: 0,
                credit: valueDiff,
              }
            );
          } else {
            voucherLines.push(
              {
                accountCode: '10501',
                accountTitle: 'موجودی انبار مرکزی',
                costCenterId: 'cc_warehouse',
                description: `اضافی انبارگردانی ${diffQty} ${prod.unit} «${prod.name}» — ${reason}`,
                debit: valueDiff,
                credit: 0,
              },
              {
                accountCode: '60301',
                accountTitle: 'اضافی انبارگردانی و درآمدهای متفرقه',
                description: `ثبت درآمد اضافی انبارگردانی ${prod.sku}`,
                debit: 0,
                credit: valueDiff,
              }
            );
          }
        }
      }

      if (changedCount === 0) {
        showToast('تغییری در موجودی شمارش‌شده نسبت به سیستم وجود نداشت.');
        return;
      }

      if (voucherLines.length >= 2) {
        await createVoucher({
          date: getTodayShamsi(),
          description: `سند تجمیعی انبارگردانی (${changedCount} قلم کالا) — ${reason}`,
          voucherType: 'general',
          status: 'permanent',
          lines: voucherLines,
        });
      } else {
        showToast(`موجودی ${changedCount} قلم کالا با موفقیت اصلاح شد.`);
      }
      } catch (error) {
        const rollbackResults = await Promise.allSettled(
          changedProducts.map((entry) => adjustProductStock(entry.productId, entry.previousStock)),
        );
        const rollbackFailures = rollbackResults.flatMap((result, index) =>
          result.status === 'rejected'
            ? [`${changedProducts[index].productId}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
            : [],
        );
        if (rollbackFailures.length > 0) {
          console.error('Bulk stocktake rollback failures:', rollbackFailures);
          throw new Error(`ثبت سند انبارگردانی تجمیعی ناموفق بود و برگشت موجودی ${rollbackFailures.length} کالا نیز شکست خورد؛ مغایرت این کالاها نیازمند رسیدگی دستی است: ${rollbackFailures.join(' | ')}. علت اولیه: ${error instanceof Error ? error.message : String(error)}`);
        }
        throw error;
      }
    },
    [products, adjustProductStock, createVoucher, showToast]
  );

  const bulkUpdateProductPrices = useCallback(
    async (productIds: string[], target: 'sellPrice' | 'buyPrice', percentDelta: number) => {
      if (productIds.length === 0 || percentDelta === 0) return;
      const factor = 1 + percentDelta / 100;
      let count = 0;
      for (const pid of productIds) {
        const prod = products.find((p) => p.id === pid);
        if (!prod) continue;
        const newVal = Math.max(0, Math.round((prod[target] * factor) / 1000) * 1000);
        await updateProduct(pid, { [target]: newVal });
        count += 1;
      }
      showToast(
        `${target === 'sellPrice' ? 'قیمت فروش' : 'قیمت خرید'} ${count} کالا با تغییر ${percentDelta > 0 ? '+' : ''}${percentDelta}٪ به‌روزرسانی شد.`
      );
    },
    [products, updateProduct, showToast]
  );

  const finalizeAllDraftVouchers = useCallback(async (): Promise<number> => {
    const drafts = vouchers.filter((v) => v.status === 'draft');
    if (drafts.length === 0) {
      showToast('هیچ سند موقتی برای دائم‌سازی وجود ندارد.');
      return 0;
    }
    let finalized = 0;
    for (const v of drafts) {
      if (v.totalDebit === v.totalCredit && v.totalDebit > 0 && v.lines.length >= 2) {
        await finalizeVoucher(v.id);
        finalized += 1;
      }
    }
    showToast(`${finalized} سند موقت تراز با موفقیت به دائم تبدیل شد.`);
    return finalized;
  }, [vouchers, finalizeVoucher, showToast]);

  const createOpeningInventoryLot = useCallback(async (payload: {
    productId: string; lotNumber: string; quantity: number; unitCost: number; receivedDate: string; expiryDate?: string;
  }) => {
    const product = products.find((item) => item.id === payload.productId);
    if (!product) throw new Error('کالای موردنظر برای ایجاد بچ افتتاحیه یافت نشد.');
    if (!payload.lotNumber.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(payload.receivedDate) ||
        (payload.expiryDate && (!/^\d{4}-\d{2}-\d{2}$/.test(payload.expiryDate) || payload.expiryDate < payload.receivedDate)) ||
        !Number.isFinite(payload.quantity) || payload.quantity <= 0 ||
        !Number.isFinite(payload.unitCost) || payload.unitCost < 0) {
      throw new Error('شماره بچ، تاریخ، مقدار یا بهای واحد معتبر نیست.');
    }
    if (inventoryLots.some((lot) => lot.productId === product.id && lot.warehouse === product.warehouse && lot.lotNumber === payload.lotNumber.trim())) {
      throw new Error('این شماره بچ برای همین کالا و انبار قبلاً ثبت شده است.');
    }
    const existingLotQty = inventoryLots.filter((lot) => lot.productId === product.id && lot.warehouse === product.warehouse)
      .reduce((sum, lot) => sum + lot.quantityRemaining, 0);
    if (Math.abs(existingLotQty) > 0.01) throw new Error('برای این کالا قبلاً بچ ثبت شده است؛ بچ افتتاحیه تکراری مجاز نیست.');
    if (Math.abs(product.stock - payload.quantity) > 0.01) {
      throw new Error('مقدار بچ افتتاحیه باید دقیقاً با موجودی فعلی کالا برابر باشد تا موجودی دوباره‌شماری نشود.');
    }
    const lotId = generateSafeId('lot');
    const movementId = generateSafeId('lotmove');
    const lot: InventoryLot = {
      id: lotId, ownerId, productId: product.id, warehouse: product.warehouse,
      lotNumber: payload.lotNumber.trim().slice(0, 80), receivedDate: payload.receivedDate,
      ...(payload.expiryDate ? { expiryDate: payload.expiryDate } : {}),
      quantityReceived: payload.quantity, quantityRemaining: payload.quantity,
      unitCost: payload.unitCost, costBasis: 'estimated-opening', createdAt: serverTimestamp(),
    };
    const movement: InventoryLotMovement = {
      id: movementId, ownerId, lotId, productId: product.id, warehouse: product.warehouse,
      movementType: 'receipt', quantity: payload.quantity, unitCost: payload.unitCost,
      referenceId: 'opening-balance:' + lotId, referenceNumber: 'افتتاحیه',
      date: payload.receivedDate, notes: 'موجودی افتتاحیه با بهای برآوردی؛ سند تاریخی خرید محسوب نمی‌شود.',
    };
    if (user) {
      const batch = writeBatch(db);
      batch.set(doc(db, 'inventoryLots', lotId), lot);
      batch.set(doc(db, 'inventoryLotMovements', movementId), movement);
      await batch.commit();
    }
    setInventoryLots((prev) => [...prev, lot]);
    setInventoryLotMovements((prev) => [...prev, movement]);
    showToast('بچ افتتاحیه ثبت شد؛ بهای آن برآوردی است و به‌عنوان خرید تاریخی ثبت نشده است.');
  }, [products, inventoryLots, ownerId, user, showToast]);

  const reconcileProductLotsToStock = useCallback(async (productId: string) => {
    const product = products.find((item) => item.id === productId);
    if (!product) throw new Error('کالا برای تطبیق مانده بچ یافت نشد.');
    const ledgerIssues = reconcileInventoryLotLedger(inventoryLots as any, inventoryLotMovements);
    if (ledgerIssues.length) throw new Error('ابتدا مغایرت دفتر گردش بچ را رفع کنید؛ تطبیق خودکار مجاز نیست.');
    const currentLots = inventoryLots.filter((lot) => lot.productId === productId && lot.warehouse === product.warehouse);
    const lotBalance = currentLots.reduce((sum, lot) => sum + lot.quantityRemaining, 0);
    const difference = Number((product.stock - lotBalance).toFixed(4));
    if (Math.abs(difference) <= 0.01) {
      showToast('مانده بچ‌ها با موجودی کالا برابر است.');
      return;
    }
    const date = getLocalIsoDate();
    const updatedLots = new Map<string, InventoryLot>();
    const movements: InventoryLotMovement[] = [];
    let remaining = Math.abs(difference);
    if (difference > 0) {
      const lotId = generateSafeId('lot');
      const lot: InventoryLot = {
        id: lotId, ownerId, productId, warehouse: product.warehouse,
        lotNumber: `ADJ-${product.sku}-${lotId.slice(-6)}`,
        receivedDate: date, quantityReceived: difference, quantityRemaining: difference,
        unitCost: product.buyPrice, costBasis: currentLots.length ? 'estimated-adjustment' : 'estimated-opening',
        createdAt: serverTimestamp(),
      };
      updatedLots.set(lot.id, lot);
      movements.push({
        id: generateSafeId('lotmove'), ownerId, lotId, productId, warehouse: product.warehouse,
        movementType: 'adjustment', quantity: difference, unitCost: product.buyPrice,
        referenceId: 'stock-reconciliation:' + productId, referenceNumber: 'تطبیق موجودی',
        date, notes: 'افزایش مانده بچ برای تطبیق با موجودی کالا؛ بهای واحد برآوردی است.',
      });
    } else {
      const orderedLots = currentLots.slice().sort((a, b) => a.receivedDate.localeCompare(b.receivedDate) || a.id.localeCompare(b.id));
      for (const lot of orderedLots) {
        if (remaining <= 0.0001) break;
        const unreservedQuantity = Math.max(0, lot.quantityRemaining - (lot.reservedQuantity || 0));
        const take = Math.min(remaining, unreservedQuantity);
        if (take <= 0) continue;
        updatedLots.set(lot.id, { ...lot, quantityRemaining: Number((lot.quantityRemaining - take).toFixed(4)) });
        movements.push({
          id: generateSafeId('lotmove'), ownerId, lotId: lot.id, productId, warehouse: lot.warehouse,
          movementType: 'adjustment', quantity: -take, unitCost: lot.unitCost,
          referenceId: 'stock-reconciliation:' + productId, referenceNumber: 'تطبیق موجودی',
          date, notes: 'کاهش مانده بچ برای تطبیق با موجودی شمارش‌شده.',
        });
        remaining = Number((remaining - take).toFixed(4));
      }
      if (remaining > 0.01) throw new Error('مقدار کاهش از مانده تمام بچ‌های ثبت‌شده بیشتر است؛ عملیات متوقف شد.');
    }
    if (user) {
      const batch = writeBatch(db);
      updatedLots.forEach((lot) => {
        if (currentLots.some((current) => current.id === lot.id)) {
          batch.update(doc(db, 'inventoryLots', lot.id), { quantityRemaining: lot.quantityRemaining, updatedAt: serverTimestamp() });
        } else {
          batch.set(doc(db, 'inventoryLots', lot.id), lot);
        }
      });
      movements.forEach((movement) => batch.set(doc(db, 'inventoryLotMovements', movement.id), movement));
      await batch.commit();
    }
    setInventoryLots((prev) => [
      ...prev.filter((lot) => !updatedLots.has(lot.id)),
      ...[...updatedLots.values()],
    ]);
    setInventoryLotMovements((prev) => [...prev, ...movements]);
    showToast(difference > 0
      ? 'مانده بچ با یک بچ تعدیل افزایشی و بهای برآوردی تطبیق داده شد.'
      : 'مانده بچ‌ها با گردش تعدیل کاهشی تطبیق داده شد.');
  }, [products, inventoryLots, inventoryLotMovements, ownerId, user, showToast]);

  const transferProductWarehouse = useCallback(
    async (productId: string, targetWarehouse: string) => {
      const prod = products.find((p) => p.id === productId);
      if (!prod || !targetWarehouse.trim()) return;
      const cleanWh = targetWarehouse.trim().slice(0, 80);
      if (cleanWh === prod.warehouse) throw new Error('انبار مقصد با انبار فعلی یکسان است.');
      const sourceLots = inventoryLots.filter((lot) => lot.productId === productId && lot.warehouse === prod.warehouse);
      if (prod.stock > 0.0001 && sourceLots.length === 0) {
        throw new Error('برای انتقال این کالا ابتدا باید موجودی فعلی را با بهای برآوردی یا بچ‌های خرید در دفتر بچ ثبت کنید.');
      }
      const ledgerIssues = reconcileInventoryLotLedger(inventoryLots as any, inventoryLotMovements);
      if (ledgerIssues.length) throw new Error('دفتر بچ با گردش‌های ثبت‌شده مغایرت دارد؛ انتقال انبار متوقف شد.');
      const lotQty = sourceLots.reduce((sum, lot) => sum + lot.quantityRemaining, 0);
      if (Math.abs(lotQty - prod.stock) > 0.01) {
        throw new Error('جمع مانده بچ‌های انبار با موجودی کالا برابر نیست؛ ابتدا مغایرت را رفع کنید.');
      }
      const transferId = generateSafeId('lot-transfer');
      const transferDate = getLocalIsoDate();
      const movements: InventoryLotMovement[] = sourceLots.filter((lot) => lot.quantityRemaining > 0).flatMap((lot) => [
        {
          id: generateSafeId('lotmove'), ownerId, lotId: lot.id, productId,
          warehouse: prod.warehouse, movementType: 'transfer-out' as const,
          quantity: -lot.quantityRemaining, unitCost: lot.unitCost,
          referenceId: transferId, referenceNumber: transferId, date: transferDate,
        },
        {
          id: generateSafeId('lotmove'), ownerId, lotId: lot.id, productId,
          warehouse: cleanWh, movementType: 'transfer-in' as const,
          quantity: lot.quantityRemaining, unitCost: lot.unitCost,
          referenceId: transferId, referenceNumber: transferId, date: transferDate,
        },
      ]);
      if (user) {
        const batch = writeBatch(db);
        batch.update(doc(db, 'products', productId), { warehouse: cleanWh, updatedAt: serverTimestamp() });
        sourceLots.forEach((lot) => batch.update(doc(db, 'inventoryLots', lot.id), {
          warehouse: cleanWh, updatedAt: serverTimestamp(),
        }));
        movements.forEach((movement) => batch.set(doc(db, 'inventoryLotMovements', movement.id), movement));
        await batch.commit();
      }
      setProducts((prev) => prev.map((product) => product.id === productId ? { ...product, warehouse: cleanWh } : product));
      setInventoryLots((prev) => prev.map((lot) => lot.productId === productId && lot.warehouse === prod.warehouse
        ? { ...lot, warehouse: cleanWh } : lot));
      setInventoryLotMovements((prev) => [...prev, ...movements]);
      showToast(`حواله انتقال ${prod.name} از «${prod.warehouse}» به «${cleanWh}» ثبت شد؛ بچ‌ها و بهای تاریخی حفظ شدند.`);
    },
    [products, inventoryLots, inventoryLotMovements, ownerId, user, showToast]
  );

  // ---------------- CHEQUES & TREASURY ----------------
  const addCheque = useCallback(
    async (payload: Omit<Cheque, 'id' | 'ownerId'>, skipVoucher = false) => {
      const normalizedSayadiId = payload.sayadiId.trim();
      if (normalizedSayadiId.length < 6 || !payload.serial.trim() || !payload.partyId ||
          !Number.isFinite(payload.amount) || payload.amount <= 0 ||
          !/^14\d{2}\/\d{2}\/\d{2}$/.test(payload.issueDate) ||
          !/^14\d{2}\/\d{2}\/\d{2}$/.test(payload.dueDate)) {
        throw new Error('شناسه صیادی، سریال، طرف‌حساب، مبلغ یا تاریخ چک معتبر نیست.');
      }
      if (cheques.some((cheque) => cheque.sayadiId.trim() === normalizedSayadiId)) {
        throw new Error('شناسه صیادی این چک قبلاً در سیستم ثبت شده است.');
      }
      validateChequeDateRange(payload.issueDate, payload.dueDate);
      if (!parties.some((party) => party.id === payload.partyId)) {
        throw new Error('طرف‌حساب انتخاب‌شده برای چک معتبر نیست.');
      }
      const id = generateSafeId('chq');
      const full: Cheque = { ...payload, id, ownerId };

      if (user) {
        try {
          await setDoc(doc(db, 'cheques', id), {
            ownerId,
            sayadiId: full.sayadiId.slice(0, 32),
            serial: full.serial.slice(0, 48),
            direction: full.direction,
            partyId: full.partyId.slice(0, 128),
            partyName: full.partyName.slice(0, 160),
            bankName: full.bankName.slice(0, 100),
            ...(full.branch ? { branch: full.branch.slice(0, 100) } : {}),
            amount: full.amount,
            issueDate: full.issueDate.slice(0, 20),
            dueDate: full.dueDate.slice(0, 20),
            status: full.status,
            ...(full.notes ? { notes: full.notes.slice(0, 300) } : {}),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleSupabaseError(err, OperationType.CREATE, `cheques/${id}`);
          throw err;
        }
      } else {
        setCheques((prev) => [full, ...prev]);
      }

      if (!skipVoucher) {
        const lines: VoucherLine[] =
          payload.direction === 'receivable'
            ? [
                {
                  accountCode: '10301',
                  accountTitle: 'اسناد دریافتنی نزد صندوق',
                  partyId: payload.partyId,
                  partyName: payload.partyName,
                  description: `دریافت چک صیادی ${payload.sayadiId}`,
                  debit: payload.amount,
                  credit: 0,
                },
                {
                  accountCode: '10401',
                  accountTitle: 'بدهکاران تجاری و مشتریان',
                  partyId: payload.partyId,
                  partyName: payload.partyName,
                  description: `بستانکاری مشتری بابت چک صیادی ${payload.sayadiId}`,
                  debit: 0,
                  credit: payload.amount,
                },
              ]
            : [
                {
                  accountCode: '30101',
                  accountTitle: 'بستانکاران و تأمین‌کنندگان',
                  partyId: payload.partyId,
                  partyName: payload.partyName,
                  description: `پرداخت چک صیادی ${payload.sayadiId}`,
                  debit: payload.amount,
                  credit: 0,
                },
                {
                  accountCode: '30201',
                  accountTitle: 'اسناد پرداختنی تجاری (چک‌های صادره)',
                  partyId: payload.partyId,
                  partyName: payload.partyName,
                  description: `صدور چک صیادی ${payload.sayadiId}`,
                  debit: 0,
                  credit: payload.amount,
                },
              ];

        try {
          await createVoucher({
            date: payload.issueDate,
            description: `ثبت چک صیادی ${payload.sayadiId} — ${payload.partyName}`,
            voucherType: 'treasury',
            status: 'permanent',
            lines,
            referenceId: id,
          });
        } catch (error) {
          if (user) {
            try { await deleteDoc(doc(db, 'cheques', id)); }
            catch (rollbackError) { console.error('Cheque creation rollback failed', id, rollbackError); }
          } else {
            setCheques((prev) => prev.filter((cheque) => cheque.id !== id));
          }
          throw error;
        }
      }
      return full;
    },
    [ownerId, user, cheques, parties, createVoucher]
  );

  const updateCheque = useCallback(
    async (
      chequeId: string,
      patch: Partial<Pick<Cheque, 'bankName' | 'branch' | 'dueDate' | 'notes'>>
    ) => {
      const existingCheque = cheques.find((cheque) => cheque.id === chequeId);
      if (!existingCheque) throw new Error('چک موردنظر برای ویرایش یافت نشد.');
      validateChequeDateRange(existingCheque.issueDate, patch.dueDate ?? existingCheque.dueDate);
      if (user) {
        try {
          const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };
          if (patch.bankName !== undefined) payload.bankName = patch.bankName.slice(0, 100);
          if (patch.branch !== undefined) payload.branch = patch.branch.slice(0, 100);
          if (patch.dueDate !== undefined) payload.dueDate = patch.dueDate.slice(0, 20);
          if (patch.notes !== undefined) payload.notes = patch.notes.slice(0, 300);
          await updateDoc(doc(db, 'cheques', chequeId), payload);
        } catch (err) {
          handleSupabaseError(err, OperationType.UPDATE, `cheques/${chequeId}`);
          throw err;
        }
      } else {
        setCheques((prev) => prev.map((c) => (c.id === chequeId ? { ...c, ...patch } : c)));
      }
      showToast('مشخصات چک صیادی ویرایش شد.');
    },
    [cheques, user, showToast]
  );

  const updateChequeStatus = useCallback(
    async (
      chequeId: string,
      newStatus: ChequeStatus,
      options?: { bankAccountCode?: string; endorsePartyId?: string }
    ) => {
      const chq = cheques.find((c) => c.id === chequeId);
      if (!chq || chq.status === newStatus) return;

      const transitionError = getChequeStatusTransitionError(chq.direction, chq.status, newStatus);
      if (transitionError) {
        showToast(transitionError);
        return;
      }

      if (chq.status === 'cancelled') {
        showToast('چک ابطال‌شده قابل تغییر وضعیت نیست.');
        return;
      }
      if (chq.status === 'cleared' && newStatus !== 'in_box') {
        showToast('برای اصلاح چک وصول‌شده، ابتدا گزینه «عودت به صندوق (نزد صندوق)» را انتخاب کنید.');
        return;
      }

      const bankCode = options?.bankAccountCode || '10201';
      const bankAcc = accounts.find((a) => a.code === bankCode && a.level === 'moein' && a.code.startsWith('102'));
      if ((newStatus === 'cleared' || chq.status === 'cleared') && !bankAcc) {
        throw new Error('برای وصول یا عودت چک، حساب بانکی معین معتبر انتخاب کنید.');
      }
      const bankTitle = bankAcc?.title || 'بانک ملت — حساب جاری شرکتی';

      let lines: VoucherLine[] = [];
      let desc = '';

      if (chq.direction === 'receivable') {
        const sourceCode = chq.status === 'deposited' ? '10302' : '10301';
        const sourceTitle =
          sourceCode === '10302' ? 'اسناد در جریان وصول نزد بانک' : 'اسناد دریافتنی نزد صندوق';

        if (newStatus === 'deposited' && chq.status === 'in_box') {
          desc = `واگذاری چک صیادی ${chq.sayadiId} به بانک جهت وصول`;
          lines = [
            {
              accountCode: '10302',
              accountTitle: 'اسناد در جریان وصول نزد بانک',
              partyId: chq.partyId,
              partyName: chq.partyName,
              description: desc,
              debit: chq.amount,
              credit: 0,
            },
            {
              accountCode: '10301',
              accountTitle: 'اسناد دریافتنی نزد صندوق',
              partyId: chq.partyId,
              partyName: chq.partyName,
              description: `خروج چک ${chq.sayadiId} از صندوق به بانک`,
              debit: 0,
              credit: chq.amount,
            },
          ];
        } else if (newStatus === 'cleared') {
          desc = `وصول چک صیادی دریافتی ${chq.sayadiId} به حساب ${bankTitle}`;
          lines = [
            {
              accountCode: bankCode,
              accountTitle: bankTitle,
              description: desc,
              debit: chq.amount,
              credit: 0,
            },
            {
              accountCode: sourceCode,
              accountTitle: sourceTitle,
              partyId: chq.partyId,
              partyName: chq.partyName,
              description: `تسویه سند دریافتنی چک ${chq.sayadiId}`,
              debit: 0,
              credit: chq.amount,
            },
          ];
        } else if (newStatus === 'bounced' || newStatus === 'cancelled') {
          desc = `${newStatus === 'bounced' ? 'برگشت خوردن' : 'ابطال'} چک صیادی ${chq.sayadiId} — بازگشت بدهی به حساب ${chq.partyName}`;
          lines = [
            {
              accountCode: '10401',
              accountTitle: 'بدهکاران تجاری و مشتریان',
              partyId: chq.partyId,
              partyName: chq.partyName,
              description: desc,
              debit: chq.amount,
              credit: 0,
            },
            {
              accountCode: sourceCode,
              accountTitle: sourceTitle,
              partyId: chq.partyId,
              partyName: chq.partyName,
              description: `خروج چک ${chq.sayadiId} از اسناد دریافتنی`,
              debit: 0,
              credit: chq.amount,
            },
          ];
        } else if (newStatus === 'endorsed') {
          const targetParty =
            parties.find((p) => p.id === options?.endorsePartyId) ||
            parties.find((p) => p.partyType === 'vendor' || p.partyType === 'both');
          if (!targetParty) {
            showToast('برای خرج کردن چک، ابتدا یک تأمین‌کننده/طرف‌حساب مقصد انتخاب کنید.');
            return;
          }
          desc = `خرج کردن چک صیادی ${chq.sayadiId} در وجه «${targetParty.name}»`;
          lines = [
            {
              accountCode: targetParty.accountCode || '30101',
              accountTitle:
                targetParty.accountCode === '10401'
                  ? 'بدهکاران تجاری و مشتریان'
                  : 'بستانکاران و تأمین‌کنندگان',
              partyId: targetParty.id,
              partyName: targetParty.name,
              description: desc,
              debit: chq.amount,
              credit: 0,
            },
            {
              accountCode: sourceCode,
              accountTitle: sourceTitle,
              partyId: chq.partyId,
              partyName: chq.partyName,
              description: `واگذاری چک ${chq.sayadiId} به غیر`,
              debit: 0,
              credit: chq.amount,
            },
          ];
        } else if (newStatus === 'in_box' && chq.status === 'bounced') {
          desc = `بازگشت چک صیادی ${chq.sayadiId} به صندوق جهت اقدام مجدد`;
          lines = [
            {
              accountCode: '10301',
              accountTitle: 'اسناد دریافتنی نزد صندوق',
              partyId: chq.partyId,
              partyName: chq.partyName,
              description: desc,
              debit: chq.amount,
              credit: 0,
            },
            {
              accountCode: '10401',
              accountTitle: 'بدهکاران تجاری و مشتریان',
              partyId: chq.partyId,
              partyName: chq.partyName,
              description: `تحویل مجدد چک ${chq.sayadiId}`,
              debit: 0,
              credit: chq.amount,
            },
          ];
        } else if (newStatus === 'in_box' && chq.status === 'cleared') {
          desc = `عودت چک صیادی ${chq.sayadiId} از حالت وصول به صندوق (اصلاحیه خزانه)`;
          lines = [
            {
              accountCode: '10301',
              accountTitle: 'اسناد دریافتنی نزد صندوق',
              partyId: chq.partyId,
              partyName: chq.partyName,
              description: desc,
              debit: chq.amount,
              credit: 0,
            },
            {
              accountCode: bankCode,
              accountTitle: bankTitle,
              description: `برگشت وجه وصول چک ${chq.sayadiId} از ${bankTitle}`,
              debit: 0,
              credit: chq.amount,
            },
          ];
        }
      } else {
        // Payable cheque
        if (newStatus === 'cleared') {
          desc = `پاس شدن چک صیادی پرداختی ${chq.sayadiId} از ${bankTitle}`;
          lines = [
            {
              accountCode: '30201',
              accountTitle: 'اسناد پرداختنی تجاری (چک‌های صادره)',
              partyId: chq.partyId,
              partyName: chq.partyName,
              description: desc,
              debit: chq.amount,
              credit: 0,
            },
            {
              accountCode: bankCode,
              accountTitle: bankTitle,
              description: `برداشت از بانک بابت چک ${chq.sayadiId}`,
              debit: 0,
              credit: chq.amount,
            },
          ];
        } else if (newStatus === 'bounced' || newStatus === 'cancelled') {
          desc = `${newStatus === 'cancelled' ? 'ابطال و استرداد' : 'برگشت'} چک پرداختی ${chq.sayadiId}`;
          lines = [
            {
              accountCode: '30201',
              accountTitle: 'اسناد پرداختنی تجاری (چک‌های صادره)',
              partyId: chq.partyId,
              partyName: chq.partyName,
              description: desc,
              debit: chq.amount,
              credit: 0,
            },
            {
              accountCode: '30101',
              accountTitle: 'بستانکاران و تأمین‌کنندگان',
              partyId: chq.partyId,
              partyName: chq.partyName,
              description: `بازگشت بدهی به حساب ${chq.partyName}`,
              debit: 0,
              credit: chq.amount,
            },
          ];
        } else if (newStatus === 'in_box' && chq.status === 'bounced') {
          desc = `بازگشت چک پرداختی ${chq.sayadiId} به وضعیت اسناد پرداختنی`;
          lines = [
            {
              accountCode: '30101',
              accountTitle: 'بستانکاران و تأمین‌کنندگان',
              partyId: chq.partyId,
              partyName: chq.partyName,
              description: desc,
              debit: chq.amount,
              credit: 0,
            },
            {
              accountCode: '30201',
              accountTitle: 'اسناد پرداختنی تجاری (چک‌های صادره)',
              partyId: chq.partyId,
              partyName: chq.partyName,
              description: `ثبت مجدد چک پرداختی ${chq.sayadiId}`,
              debit: 0,
              credit: chq.amount,
            },
          ];
        } else if (newStatus === 'in_box' && chq.status === 'cleared') {
          desc = `عودت چک پرداختی ${chq.sayadiId} از حالت پاس‌شده (اصلاحیه خزانه)`;
          lines = [
            {
              accountCode: bankCode,
              accountTitle: bankTitle,
              description: desc,
              debit: chq.amount,
              credit: 0,
            },
            {
              accountCode: '30201',
              accountTitle: 'اسناد پرداختنی تجاری (چک‌های صادره)',
              partyId: chq.partyId,
              partyName: chq.partyName,
              description: `بازگشت چک ${chq.sayadiId} به اسناد پرداختنی`,
              debit: 0,
              credit: chq.amount,
            },
          ];
        }
      }

      let transitionVoucher: Voucher | undefined;
      if (lines.length >= 2) {
        const transitionPrefix = 'cheque-status:' + chequeId + ':' + chq.status + ':' + newStatus + ':';
        const transitionIndex = vouchers.filter((voucher) => voucher.referenceId?.startsWith(transitionPrefix)).length;
        transitionVoucher = await createVoucher({
          date: getTodayShamsi(),
          description: desc,
          voucherType: 'treasury',
          status: 'permanent',
          lines,
          referenceId: transitionPrefix + transitionIndex,
        });
      }

      if (user) {
        try {
          await updateDoc(doc(db, 'cheques', chequeId), {
            status: newStatus,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          let compensationFailure: string | undefined;
          if (transitionVoucher) {
            try {
              await createVoucher({
                date: getTodayShamsi(),
                description: 'سند معکوس خودکار بابت عدم ثبت تغییر وضعیت چک ' + chq.sayadiId,
                voucherType: 'treasury',
                status: 'permanent',
                referenceId: 'cheque-status-compensation:' + transitionVoucher.id,
                lines: transitionVoucher.lines.map((line) => ({ ...line, description: 'برگشت سند #' + transitionVoucher!.voucherNumber + ': ' + line.description, debit: line.credit, credit: line.debit, foreignDebit: line.foreignCredit, foreignCredit: line.foreignDebit })),
              });
            } catch (reversalError) {
              console.error('Cheque status voucher compensation failed', chequeId, reversalError);
              compensationFailure = reversalError instanceof Error ? reversalError.message : String(reversalError);
            }
          }
          handleSupabaseError(err, OperationType.UPDATE, 'cheques/' + chequeId);
          const originalFailure = String(err);
          if (compensationFailure) {
            throw new Error(`تغییر وضعیت چک ${chq?.sayadiId ?? chequeId} ثبت نشد و سند معکوس خودکار نیز ناموفق بود؛ رسیدگی دستی لازم است. خطای ثبت: ${originalFailure}. خطای جبران: ${compensationFailure}`);
          }
          throw err;
        }
      } else {
        setCheques((prev) => prev.map((c) => (c.id === chequeId ? { ...c, status: newStatus } : c)));
      }

      if (lines.length < 2) showToast('وضعیت چک صیادی به‌روزرسانی شد.');
    },
    [cheques, accounts, parties, vouchers, user, createVoucher, showToast]
  );

  const recordQuickTreasury = useCallback(
    async (payload: {
      direction: 'receipt' | 'payment';
      accountCode: string;
      partyId: string;
      amount: number;
      date: string;
      description: string;
      allocations?: { invoiceId: string; amount: number }[];
    }) => {
      validateTreasuryOperationPayload(payload);
      const party = parties.find((p) => p.id === payload.partyId);
      if (!party) throw new Error('طرف‌حساب انتخاب‌شده معتبر نیست.');
      const cashAcc = accounts.find((a) => a.code === payload.accountCode);
      validateTreasuryAccountSelection(cashAcc ? { code: cashAcc.code, level: cashAcc.level } : undefined);
      const cashCode = cashAcc!.code;
      const cashTitle = cashAcc!.title;
      const partyAcc = accounts.find((account) => account.code === party.accountCode);
      validatePartyTreasuryAccount(partyAcc ? { code: partyAcc.code, level: partyAcc.level } : undefined);
      const partyCode = partyAcc!.code;
      const partyTitle = partyAcc!.title;

      const allocations = payload.allocations?.length
        ? validateInvoicePaymentAllocations({
            direction: payload.direction,
            partyId: party.id,
            amount: payload.amount,
            allocations: payload.allocations,
            invoices,
          })
        : [];
      const allocationId = generateSafeId('pay');
      const voucherId = generateSafeId('vch');
      const voucherNumber = vouchers.reduce((max, voucher) => Math.max(max, voucher.voucherNumber || 0), 0) + 1;
      const description = payload.description.trim();
      const lines: VoucherLine[] = payload.direction === 'receipt'
        ? [
            { accountCode: cashCode, accountTitle: cashTitle, description, debit: payload.amount, credit: 0 },
            { accountCode: partyCode, accountTitle: partyTitle, partyId: party.id, partyName: party.name, description, debit: 0, credit: payload.amount },
          ]
        : [
            { accountCode: partyCode, accountTitle: partyTitle, partyId: party.id, partyName: party.name, description, debit: payload.amount, credit: 0 },
            { accountCode: cashCode, accountTitle: cashTitle, description, debit: 0, credit: payload.amount },
          ];
      const voucher: Voucher = {
        id: voucherId, ownerId, voucherNumber, date: payload.date,
        description: `${payload.direction === 'receipt' ? 'دریافت' : 'پرداخت'} خزانه — ${party.name}`,
        voucherType: 'treasury', status: 'permanent',
        totalDebit: payload.amount, totalCredit: payload.amount,
        referenceId: allocations.length ? `treasury-allocation:${allocationId}` : undefined,
        lines,
      };

      const invoiceUpdates = allocations.map((allocation) => {
        const invoice = invoices.find((candidate) => candidate.id === allocation.invoiceId)!;
        const nextOutstanding = Math.max(0, Number((invoice.creditAmount - allocation.amount).toFixed(2)));
        const paymentAllocation = {
          id: allocationId,
          voucherId,
          date: payload.date,
          direction: payload.direction,
          amount: allocation.amount,
        };
        return {
          invoiceId: invoice.id,
          next: {
            ...invoice,
            paidCash: Number((invoice.paidCash + (cashCode.startsWith('102') ? 0 : allocation.amount)).toFixed(2)),
            paidBank: Number((invoice.paidBank + (cashCode.startsWith('102') ? allocation.amount : 0)).toFixed(2)),
            creditAmount: nextOutstanding,
            status: nextOutstanding <= 0.000001 ? 'settled' as const : 'issued' as const,
            paymentAllocations: [...(invoice.paymentAllocations ?? []), paymentAllocation],
          },
        };
      });

      if (user) {
        const batch = writeBatch(db);
        batch.set(doc(db, 'vouchers', voucherId), {
          ownerId, voucherNumber, date: payload.date, description: voucher.description,
          voucherType: 'treasury', status: 'permanent',
          totalDebit: payload.amount, totalCredit: payload.amount,
          ...(voucher.referenceId ? { referenceId: voucher.referenceId } : {}),
          lines, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
        });
        for (const update of invoiceUpdates) {
          const { id: _id, ownerId: _ownerId, ...invoicePatch } = update.next;
          batch.update(doc(db, 'invoices', update.invoiceId), {
            paidCash: invoicePatch.paidCash,
            paidBank: invoicePatch.paidBank,
            creditAmount: invoicePatch.creditAmount,
            status: invoicePatch.status,
            paymentAllocations: invoicePatch.paymentAllocations,
            updatedAt: serverTimestamp(),
          });
        }
        await batch.commit();
      } else {
        setVouchers((previous) => [...previous, voucher]);
      }
      if (invoiceUpdates.length) {
        setInvoices((previous) => previous.map((invoice) =>
          invoiceUpdates.find((update) => update.invoiceId === invoice.id)?.next ?? invoice
        ));
      }
      showToast(allocations.length
        ? `سند خزانه شماره ${voucherNumber} ثبت شد و ${allocations.length} تخصیص فاکتور به‌صورت یکجا ذخیره شد.`
        : `سند خزانه شماره ${voucherNumber} ثبت شد.`);
    },
    [parties, accounts, invoices, vouchers, ownerId, user, showToast]
  );

  const recordBankTransfer = useCallback(
    async (payload: {
      fromAccountCode: string;
      toAccountCode: string;
      amount: number;
      date: string;
      description: string;
    }) => {
      validateTreasuryOperationPayload(payload);
      const fromAcc = accounts.find((a) => a.code === payload.fromAccountCode);
      const toAcc = accounts.find((a) => a.code === payload.toAccountCode);
      validateTreasuryTransferAccounts(
        fromAcc ? { code: fromAcc.code, level: fromAcc.level } : undefined,
        toAcc ? { code: toAcc.code, level: toAcc.level } : undefined,
      );
      if (!fromAcc || !toAcc) throw new Error('حساب مبدأ یا مقصد انتقال معتبر نیست.');

      await createVoucher({
        date: payload.date,
        description: `انتقال وجه از ${fromAcc.title} به ${toAcc.title}`,
        voucherType: 'treasury',
        status: 'permanent',
        lines: [
          {
            accountCode: toAcc.code,
            accountTitle: toAcc.title,
            description: payload.description || `واریز انتقالی از ${fromAcc.title}`,
            debit: payload.amount,
            credit: 0,
          },
          {
            accountCode: fromAcc.code,
            accountTitle: fromAcc.title,
            description: payload.description || `برداشت انتقالی به ${toAcc.title}`,
            debit: 0,
            credit: payload.amount,
          },
        ],
      });
    },
    [accounts, createVoucher]
  );

  // ---------------- INVOICES CRUD & COMMERCIAL OPS ----------------
  const createInvoice = useCallback(
    async (payload: Omit<Invoice, 'id' | 'ownerId' | 'voucherId'>): Promise<Invoice> => {
      const id = generateSafeId('inv');
      let voucherId: string | undefined;
      let createdVoucher: Voucher | undefined;
      let createdCheque: Cheque | undefined;
      let invoicePersistenceAttempted = false;
      const appliedStock: Array<{ productId: string; previousStock: number }> = [];

      const stockDirection = getInvoiceStockDirection(payload.invoiceType);
      const isStockOut = stockDirection === -1;
      if (isStockOut) {
        const stockReservations = [
          ...subcontractJobs.filter((job) => job.status === 'sent')
            .map((job) => ({ productId: job.rawProductId, quantity: job.sentWeightKg })),
          ...salesOrders.filter((order) => order.status === 'dispatched' && order.id !== payload.salesOrderId)
            .flatMap((order) => order.items.map((item) => ({
              productId: item.productId,
              quantity: item.actualWeighedKg > 0 ? item.actualWeighedKg : item.orderedWeightKg,
            }))),
        ];
        const reserved = aggregateStockReservations(stockReservations);
        assertSufficientStock(
          new Map(products.map((product) => [product.id, Math.max(0, product.stock - (reserved.get(product.id) ?? 0))])),
          payload.items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
        );
      }

      let cogsTotal = 0;
      const stockDeltas = new Map<string, number>();
      let workingLots = inventoryLots.map((lot) => ({ ...lot }));
      const invoiceItems = payload.items.map((item) => ({ ...item }));
      const currentOrderReservedLotQuantities = new Map<string, number>();
      if (payload.salesOrderId) invoiceItems.forEach((item) => (item.lotAllocations || []).forEach((allocation) => {
        currentOrderReservedLotQuantities.set(allocation.lotId, (currentOrderReservedLotQuantities.get(allocation.lotId) || 0) + allocation.quantity);
      }));
      const reservedLotQuantities = new Map<string, number>();
      for (const job of subcontractJobs.filter((candidate) => candidate.status === 'sent')) {
        let reservations = job.rawLotAllocations || [];
        if (!reservations.length) {
          const rawProduct = products.find((candidate) => candidate.id === job.rawProductId);
          if (!rawProduct) throw new Error('کالای خام یک حواله باز پیمانکاری یافت نشد؛ فروش متوقف شد.');
          const availableForLegacyJob = workingLots.map((lot) => ({
            ...lot,
            quantityRemaining: Math.max(0, lot.quantityRemaining - (reservedLotQuantities.get(lot.id) || 0)),
          }));
          reservations = allocateStockFIFO(availableForLegacyJob as any, job.sentWeightKg, {
            productId: rawProduct.id, warehouse: rawProduct.warehouse, asOfDate: shamsiToGregorianIso(job.date),
          }).allocations;
        }
        reservations.forEach((allocation) => {
          reservedLotQuantities.set(allocation.lotId, (reservedLotQuantities.get(allocation.lotId) || 0) + allocation.quantity);
        });
      }
      for (const order of salesOrders.filter((candidate) => candidate.status === 'dispatched' && candidate.id !== payload.salesOrderId)) {
        for (const item of order.items) {
          let reservations = item.lotAllocations || [];
          if (!reservations.length) {
            const product = products.find((candidate) => candidate.id === item.productId);
            if (!product) throw new Error('کالای یک حواله خروج باز یافت نشد؛ فروش متوقف شد.');
            const quantity = item.actualWeighedKg > 0 ? item.actualWeighedKg : item.orderedWeightKg;
            const availableForLegacyOrder = workingLots.map((lot) => ({
              ...lot,
              quantityRemaining: Math.max(0, lot.quantityRemaining - Math.max(lot.reservedQuantity || 0, reservedLotQuantities.get(lot.id) || 0)),
            }));
            reservations = allocateStockFIFO(availableForLegacyOrder as any, quantity, {
              productId: product.id, warehouse: order.warehouse,
              asOfDate: shamsiToGregorianIso(order.dispatchDate || order.date),
            }).allocations;
          }
          reservations.forEach((allocation) => {
            reservedLotQuantities.set(allocation.lotId, (reservedLotQuantities.get(allocation.lotId) || 0) + allocation.quantity);
          });
        }
      }
      for (const lot of workingLots) {
        const currentOrderReserved = currentOrderReservedLotQuantities.get(lot.id) || 0;
        const otherReserved = Math.max(Math.max(0, (lot.reservedQuantity || 0) - currentOrderReserved), reservedLotQuantities.get(lot.id) || 0);
        if (otherReserved + currentOrderReserved > lot.quantityRemaining + 0.0001) {
          throw new Error('رزروهای بچ با مانده واقعی دفتر بچ سازگار نیست؛ فروش متوقف شد.');
        }
        if (otherReserved > 0) reservedLotQuantities.set(lot.id, otherReserved);
      }
      const lotUpdates = new Map<string, InventoryLot>();
      const lotReceipts: InventoryLot[] = [];
      const lotMovementsToSave: InventoryLotMovement[] = [];
      validateJalaliDate(payload.date, 'تاریخ فاکتور');
      const asOfDate = shamsiToGregorianIso(payload.date);
      if (payload.invoiceType !== 'proforma') {
        const ledgerIssues = reconcileInventoryLotLedger(workingLots as any, inventoryLotMovements);
        if (ledgerIssues.length) throw new Error('دفتر بچ با گردش‌های ثبت‌شده مغایرت دارد؛ تا رفع مغایرت، ثبت فاکتور متوقف شد.');
      }
      if (stockDirection === -1) {
        for (const productId of new Set(invoiceItems.map((item) => item.productId))) {
          const product = products.find((candidate) => candidate.id === productId);
          if (!product) continue;
          if (product.warehouse !== payload.warehouse) {
            throw new Error(`انبار فاکتور با انبار تعریف‌شده برای کالای ${product.name} یکسان نیست؛ ابتدا حواله انتقال انبار را ثبت کنید.`);
          }
          const lotBalance = workingLots.filter((lot) => lot.productId === productId && lot.warehouse === payload.warehouse)
            .reduce((sum, lot) => sum + lot.quantityRemaining, 0);
          if (Math.abs(lotBalance - product.stock) > 0.01) {
            throw new Error(`جمع مانده بچ‌های ${product.name} با موجودی کالا برابر نیست؛ ابتدا دفتر بچ را تطبیق دهید.`);
          }
        }
      }
      if (payload.invoiceType !== 'proforma') {
        for (const item of invoiceItems) {
          const product = products.find((candidate) => candidate.id === item.productId);
          if (!product) throw new Error(`کالای ردیف فاکتور یافت نشد: ${item.productName || item.productId}`);
          if (product.warehouse !== payload.warehouse) {
            throw new Error(`انبار فاکتور با انبار تعریف‌شده برای کالای ${product.name} یکسان نیست؛ ابتدا حواله انتقال انبار را ثبت کنید.`);
          }
          if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
            throw new Error(`مقدار کالا در فاکتور معتبر نیست: ${item.productName || item.productId}`);
          }
          const outgoing = stockDirection === -1;
          if (outgoing) {
            if (payload.salesOrderId && item.lotAllocations?.length) {
              const allocatedQuantity = item.lotAllocations.reduce((sum, allocation) => sum + allocation.quantity, 0);
              if (Math.abs(allocatedQuantity - item.quantity) > 0.0001) {
                throw new Error('جمع تخصیص بچ‌های حواله با مقدار فاکتور برابر نیست.');
              }
              const normalizedAllocations: InvoiceLotAllocation[] = [];
              for (const allocation of item.lotAllocations) {
                const lot = workingLots.find((candidate) => candidate.id === allocation.lotId);
                if (!lot || lot.productId !== product.id || lot.warehouse !== payload.warehouse) {
                  throw new Error(`بچ تخصیص‌یافته ${allocation.lotNumber} با کالا یا انبار فاکتور سازگار نیست.`);
                }
                if (lot.receivedDate > asOfDate || (lot.expiryDate && lot.expiryDate < asOfDate)) {
                  throw new Error(`بچ ${lot.lotNumber} در تاریخ حواله قابل خروج نیست.`);
                }
                const currentOrderRemaining = currentOrderReservedLotQuantities.get(lot.id) || 0;
                if (currentOrderRemaining + 0.0001 < allocation.quantity) {
                  throw new Error(`رزرو بچ ${lot.lotNumber} برای حواله جاری کافی نیست.`);
                }
                const otherReserved = reservedLotQuantities.get(lot.id) || 0;
                const effectiveReserved = Math.max(lot.reservedQuantity || 0, otherReserved + currentOrderRemaining);
                if (effectiveReserved - otherReserved + 0.0001 < allocation.quantity ||
                    lot.quantityRemaining + 0.0001 < allocation.quantity) {
                  throw new Error(`مانده آزاد بچ ${lot.lotNumber} برای ثبت فاکتور کافی نیست.`);
                }
                lot.quantityRemaining = Number((lot.quantityRemaining - allocation.quantity).toFixed(4));
                lot.reservedQuantity = Number(Math.max(otherReserved, effectiveReserved - allocation.quantity).toFixed(4));
                currentOrderReservedLotQuantities.set(lot.id, Number((currentOrderRemaining - allocation.quantity).toFixed(4)));
                const totalCost = allocation.quantity * lot.unitCost;
                normalizedAllocations.push({
                  lotId: lot.id, lotNumber: lot.lotNumber, quantity: allocation.quantity,
                  unitCost: lot.unitCost, totalCost,
                });
                lotUpdates.set(lot.id, { ...lot });
                lotMovementsToSave.push({
                  id: generateSafeId('lotmove'), ownerId, lotId: lot.id, productId: product.id,
                  warehouse: lot.warehouse, movementType: payload.invoiceType === 'waste' ? 'waste' : payload.invoiceType === 'purchase_return' ? 'purchase-return' : 'issue',
                  quantity: -allocation.quantity, unitCost: lot.unitCost,
                  referenceId: id, referenceNumber: payload.invoiceNumber, date: asOfDate,
                });
                cogsTotal += Math.round(totalCost);
              }
              item.lotAllocations = normalizedAllocations;
            } else {
              const fifoAvailableLots = workingLots.map((lot) => ({
                ...lot,
                quantityRemaining: Math.max(0, lot.quantityRemaining - Math.max(
                  lot.reservedQuantity || 0,
                  (reservedLotQuantities.get(lot.id) || 0) + (currentOrderReservedLotQuantities.get(lot.id) || 0),
                )),
              }));
              const fifo = allocateStockFIFO(fifoAvailableLots as any, item.quantity, {
                productId: product.id, warehouse: payload.warehouse, asOfDate,
                allowExpired: payload.invoiceType === 'waste',
              });
              item.lotAllocations = fifo.allocations;
              fifo.allocations.forEach((allocation) => {
                const lot = workingLots.find((candidate) => candidate.id === allocation.lotId);
                if (!lot) throw new Error('بچ تخصیص‌یافته برای ثبت خروج یافت نشد.');
                lot.quantityRemaining = Number((lot.quantityRemaining - allocation.quantity).toFixed(4));
                if (lot.quantityRemaining < -0.0001) throw new Error('مقدار خروج از مانده واقعی بچ بیشتر است؛ عملیات متوقف شد.');
                lotUpdates.set(lot.id, { ...lot });
                lotMovementsToSave.push({
                  id: generateSafeId('lotmove'), ownerId, lotId: lot.id, productId: product.id,
                  warehouse: lot.warehouse, movementType: payload.invoiceType === 'waste' ? 'waste' : payload.invoiceType === 'purchase_return' ? 'purchase-return' : 'issue',
                  quantity: -allocation.quantity, unitCost: allocation.unitCost,
                  referenceId: id, referenceNumber: payload.invoiceNumber, date: asOfDate,
                });
              });
              cogsTotal += Math.round(fifo.totalCost);
            }
          } else {
            const lotId = generateSafeId('lot');
            const lotNumber = (item.lotNumber || product.lotNumber || `${payload.invoiceNumber}-${lotId.slice(-6)}`).trim();
            const returnedSourceLot = payload.invoiceType === 'sale_return'
              ? inventoryLots.find((candidate) => candidate.productId === product.id &&
                  candidate.warehouse === payload.warehouse && candidate.lotNumber === item.lotNumber)
              : undefined;
            if (payload.invoiceType === 'sale_return' && !returnedSourceLot &&
                inventoryLotMovements.some((movement) => movement.productId === product.id && movement.warehouse === payload.warehouse && movement.movementType === 'issue')) {
              throw new Error('برای برگشت فروش باید شماره بچ اصلیِ فروش‌شده وارد شود؛ بچ ناشناس قابل برگشت نیست.');
            }
            if (returnedSourceLot) {
              const movementReturned = calculateLotReturnedQuantity(returnedSourceLot.id, inventoryLotMovements);
              const sourceLotCurrent = lotUpdates.get(returnedSourceLot.id) ?? returnedSourceLot;
              const returnedSoFar = Math.max(sourceLotCurrent.returnedQuantity ?? 0, movementReturned);
              const netSoldFromSource = calculateLotReturnableQuantity(returnedSourceLot.id, inventoryLotMovements) + movementReturned;
              const returnable = Math.max(0, netSoldFromSource - returnedSoFar);
              if (item.quantity > returnable + 0.0001) {
                throw new Error(`مقدار برگشت از بچ ${returnedSourceLot.lotNumber} بیش از مقدار فروش خالص همان بچ است. حداکثر قابل برگشت: ${returnable}`);
              }
              lotUpdates.set(returnedSourceLot.id, {
                ...sourceLotCurrent, returnedQuantity: returnedSoFar + item.quantity,
              });
            }
            if (item.receivedDate && !/^\d{4}-\d{2}-\d{2}$/.test(item.receivedDate)) throw new Error('تاریخ ورود بچ در ردیف فاکتور معتبر نیست.');
            if (item.expiryDate && (!/^\d{4}-\d{2}-\d{2}$/.test(item.expiryDate) || item.expiryDate < (item.receivedDate || asOfDate))) throw new Error('تاریخ انقضای بچ باید معتبر و بعد از تاریخ ورود باشد.');
            const grossLineCost = Math.max(0, item.quantity * item.unitPrice);
            const documentedUnitCost = Math.max(0, grossLineCost - Math.min(grossLineCost, item.discount || 0)) / item.quantity;
            const lot: InventoryLot = {
              id: lotId, ownerId, productId: product.id, warehouse: payload.warehouse,
              lotNumber: lotNumber.slice(0, 80), receivedDate: payload.invoiceType === 'sale_return' ? asOfDate : (item.receivedDate || asOfDate),
              ...(item.expiryDate ? { expiryDate: item.expiryDate } : returnedSourceLot?.expiryDate ? { expiryDate: returnedSourceLot.expiryDate } : {}),
              quantityReceived: item.quantity, quantityRemaining: item.quantity,
              unitCost: returnedSourceLot?.unitCost ?? (payload.invoiceType === 'sale_return' ? product.buyPrice : documentedUnitCost),
              costBasis: returnedSourceLot?.costBasis ?? (payload.invoiceType === 'sale_return' ? 'estimated-return' : 'documented'),
              sourceInvoiceId: id, ...(returnedSourceLot ? { sourceLotId: returnedSourceLot.id } : {}), createdAt: serverTimestamp(),
            };
            item.receivedLotId = lotId;
            if (payload.invoiceType === 'sale_return') {
              item.lotAllocations = [{ lotId, lotNumber: lot.lotNumber, quantity: item.quantity, unitCost: lot.unitCost, totalCost: item.quantity * lot.unitCost }];
            }
            lotReceipts.push(lot);
            if (payload.invoiceType === 'sale_return') cogsTotal += Math.round(item.quantity * lot.unitCost);
            lotMovementsToSave.push({
              id: generateSafeId('lotmove'), ownerId, lotId, productId: product.id,
              warehouse: lot.warehouse, movementType: payload.invoiceType === 'sale_return' ? 'return' : 'receipt',
              quantity: item.quantity, unitCost: lot.unitCost, referenceId: id,
              referenceNumber: payload.invoiceNumber, date: lot.receivedDate,
              ...(returnedSourceLot ? { sourceLotId: returnedSourceLot.id } : {}),
              ...(payload.invoiceType === 'sale_return' && !returnedSourceLot ? { notes: 'بهای برگشت فروش بر مبنای قیمت خرید فعلی برآورد شده است؛ شماره بچ اصلی تطبیق داده نشد.' } : {}),
            });
          }
          stockDeltas.set(product.id, (stockDeltas.get(product.id) ?? 0) + (outgoing ? -item.quantity : item.quantity));
        }
      }

      const isFxInv = isForeignCurrency(payload.currencyCode) && Number(payload.exchangeRate) > 0;
      const full: Invoice = { ...payload, items: invoiceItems, id, ownerId, voucherId };
      try {
        if (payload.invoiceType !== 'proforma') {
          for (const [productId, delta] of stockDeltas) {
            const product = products.find((candidate) => candidate.id === productId);
            if (!product) throw new Error(`کالای فاکتور یافت نشد: ${productId}`);
            const nextStock = Number((product.stock + delta).toFixed(2));
            if (!Number.isFinite(nextStock) || nextStock < -1e-9) {
              throw new Error(`موجودی کالا برای ثبت فاکتور کافی نیست: ${product.name}`);
            }
            await adjustProductStock(product.id, Math.max(0, nextStock));
            appliedStock.push({ productId, previousStock: product.stock });
          }

          const rawLines = buildInvoiceVoucherLines(payload, cogsTotal);
          const isFx = isForeignCurrency(payload.currencyCode) && Number(payload.exchangeRate) > 0;
          const fxCode = isFx ? normalizeCurrencyCode(payload.currencyCode) : undefined;
          const fxRate = isFx ? Number(payload.exchangeRate) : undefined;
          const fxCurDef = fxCode
            ? currencies.find((currency) => normalizeCurrencyCode(currency.code) === fxCode)
            : undefined;
          const lines = isFx && fxRate
            ? annotateVoucherLinesWithCurrency(rawLines, fxRate, fxCurDef?.decimalPlaces ?? 2)
            : rawLines;
          if (lines.length >= 2) {
            const voucherType: VoucherType =
              payload.invoiceType === 'purchase' || payload.invoiceType === 'purchase_return'
                ? 'purchase'
                : payload.invoiceType === 'waste' ? 'general' : 'sales';
            const fxSuffix = isFx && fxCode && fxRate
              ? ` (ارزی ${fxCode} @ نرخ ${fxRate.toLocaleString('en-US')})`
              : '';
            createdVoucher = await createVoucher({
              date: payload.date,
              description: `سند اتوماتیک فاکتور ${payload.invoiceNumber} — ${payload.partyName}${fxSuffix}`,
              voucherType,
              status: 'permanent',
              lines,
              referenceId: id,
              ...(isFx && fxCode && fxRate ? { currencyCode: fxCode, exchangeRate: fxRate } : {}),
            });
            voucherId = createdVoucher.id;
          }

          if (payload.paidCheque > 0 && (payload.invoiceType === 'sale' || payload.invoiceType === 'purchase')) {
            createdCheque = await addCheque({
              sayadiId: `SYD${Math.floor(1000000000000 + Math.random() * 8999999999999)}`,
              serial: `INV-${payload.invoiceNumber.slice(-3)}`,
              direction: payload.invoiceType === 'sale' ? 'receivable' : 'payable',
              partyId: payload.partyId,
              partyName: payload.partyName,
              bankName: 'بانک ملت',
              branch: 'ثبت خودکار از فاکتور',
              amount: payload.paidCheque,
              issueDate: payload.date,
              dueDate: payload.date,
              status: 'in_box',
              notes: `ثبت خودکار بابت فاکتور ${payload.invoiceNumber}`,
            }, true);
          }
        }

        const persistedInvoice: Invoice = {
          ...full, items: invoiceItems,
          lotMovements: lotMovementsToSave.map((movement) => movement.id),
          ...(voucherId ? { voucherId } : {}),
        };
        if (user) {
          invoicePersistenceAttempted = true;
          await setDoc(doc(db, 'invoices', id), {
            ownerId,
            invoiceNumber: persistedInvoice.invoiceNumber.slice(0, 48),
            ...(persistedInvoice.taxSerial ? { taxSerial: persistedInvoice.taxSerial.slice(0, 64) } : {}),
            invoiceType: persistedInvoice.invoiceType,
            date: persistedInvoice.date.slice(0, 20),
            partyId: persistedInvoice.partyId.slice(0, 128),
            partyName: persistedInvoice.partyName.slice(0, 160),
            ...(persistedInvoice.intermediaryId ? { intermediaryId: persistedInvoice.intermediaryId.slice(0, 128) } : {}),
            ...(persistedInvoice.intermediaryName ? { intermediaryName: persistedInvoice.intermediaryName.slice(0, 160) } : {}),
            warehouse: persistedInvoice.warehouse.slice(0, 80),
            ...(persistedInvoice.costCenterId ? { costCenterId: persistedInvoice.costCenterId.slice(0, 128) } : {}),
            ...(persistedInvoice.salesOrderId ? { salesOrderId: persistedInvoice.salesOrderId.slice(0, 128) } : {}),
            ...(isFxInv && persistedInvoice.currencyCode && persistedInvoice.exchangeRate
              ? {
                  currencyCode: normalizeCurrencyCode(persistedInvoice.currencyCode).slice(0, 10),
                  exchangeRate: Number(persistedInvoice.exchangeRate),
                  foreignSubtotal: Number(persistedInvoice.foreignSubtotal ?? 0),
                  foreignDiscount: Number(persistedInvoice.foreignDiscount ?? 0),
                  foreignVatAmount: Number(persistedInvoice.foreignVatAmount ?? 0),
                  foreignGrandTotal: Number(persistedInvoice.foreignGrandTotal ?? 0),
                }
              : {}),
            subtotal: persistedInvoice.subtotal,
            discount: persistedInvoice.discount,
            vatAmount: persistedInvoice.vatAmount,
            grandTotal: persistedInvoice.grandTotal,
            paidCash: persistedInvoice.paidCash,
            paidBank: persistedInvoice.paidBank,
            paidCheque: persistedInvoice.paidCheque,
            creditAmount: persistedInvoice.creditAmount,
            status: persistedInvoice.status,
            ...(voucherId ? { voucherId } : {}),
            items: persistedInvoice.items.slice(0, 100),
            ...(persistedInvoice.lotMovements ? { lotMovements: persistedInvoice.lotMovements } : {}),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } else {
          setInvoices((prev) => [persistedInvoice, ...prev]);
        }

        if (lotReceipts.length || lotUpdates.size || lotMovementsToSave.length) {
          if (user) {
            const lotBatch = writeBatch(db);
            lotReceipts.forEach((lot) => lotBatch.set(doc(db, 'inventoryLots', lot.id), lot));
            lotUpdates.forEach((lot) => lotBatch.update(doc(db, 'inventoryLots', lot.id), {
              quantityRemaining: lot.quantityRemaining,
              ...(lot.returnedQuantity !== undefined ? { returnedQuantity: lot.returnedQuantity } : {}),
              ...(lot.reservedQuantity !== undefined ? { reservedQuantity: lot.reservedQuantity } : {}),
              updatedAt: serverTimestamp(),
            }));
            lotMovementsToSave.forEach((movement) => lotBatch.set(doc(db, 'inventoryLotMovements', movement.id), movement));
            await lotBatch.commit();
          }
          setInventoryLots((prev) => [
            ...prev.filter((lot) => !lotUpdates.has(lot.id) && !lotReceipts.some((added) => added.id === lot.id)),
            ...[...lotUpdates.values(), ...lotReceipts],
          ]);
          setInventoryLotMovements((prev) => [...prev, ...lotMovementsToSave]);
        }
        showToast(
          payload.invoiceType === 'proforma'
            ? `پیش‌فاکتور ${persistedInvoice.invoiceNumber} صادر شد (بدون تأثیر بر انبار و سند تا زمان تبدیل به فاکتور فروش).`
            : isFxInv && persistedInvoice.currencyCode
              ? `فاکتور ارزی ${persistedInvoice.invoiceNumber} (${persistedInvoice.currencyCode}) صادر و سند معادل ریالی آن ثبت شد.`
              : `فاکتور ${persistedInvoice.invoiceNumber} صادر و سند حسابداری آن ثبت شد.`
        );
        return persistedInvoice;
      } catch (error) {
        const compensationFailures: string[] = [];
        if (invoicePersistenceAttempted && user) {
          try {
            await deleteDoc(doc(db, 'invoices', id));
          } catch (cleanupError) {
            compensationFailures.push(`پاک‌سازی فاکتور نیمه‌ثبت‌شده ${id} ناموفق بود: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
          }
        }
        if (createdCheque) {
          try {
            if (user) await deleteDoc(doc(db, 'cheques', createdCheque.id));
            else setCheques((prev) => prev.filter((cheque) => cheque.id !== createdCheque!.id));
          } catch (cleanupError) {
            compensationFailures.push(`حذف چک خودکار ${createdCheque.id} ناموفق بود: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
          }
        }
        for (const snapshot of appliedStock.reverse()) {
          try {
            await adjustProductStock(snapshot.productId, snapshot.previousStock);
          } catch (rollbackError) {
            compensationFailures.push(`برگشت موجودی کالای ${snapshot.productId} ناموفق بود: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
          }
        }
        if (createdVoucher) {
          try {
            await createVoucher({
              date: getTodayShamsi(),
              description: `سند معکوس خودکار بابت عدم تکمیل فاکتور ${payload.invoiceNumber}`,
              voucherType: 'general',
              status: 'permanent',
              referenceId: `invoice-compensation:${id}`,
              lines: createdVoucher.lines.map((line) => ({
                ...line,
                description: `برگشت سند فاکتور #${createdVoucher!.voucherNumber}: ${line.description}`,
                debit: line.credit,
                credit: line.debit,
                foreignDebit: line.foreignCredit,
                foreignCredit: line.foreignDebit,
              })),
            });
          } catch (reversalError) {
            compensationFailures.push(`صدور سند معکوس ${createdVoucher.id} ناموفق بود: ${reversalError instanceof Error ? reversalError.message : String(reversalError)}`);
          }
        }
        const reason = error instanceof Error ? error.message : String(error);
        const compensation = compensationFailures.length
          ? ` جبران کامل نشد؛ رسیدگی دستی لازم است: ${compensationFailures.join(' | ')}`
          : ' عملیات جبرانی با موفقیت انجام شد.';
        handleSupabaseError(error, OperationType.CREATE, `invoices/${id}`);
        throw new Error(`ثبت فاکتور ${payload.invoiceNumber} کامل نشد. علت: ${reason}.${compensation}`);
      }
    },
    [products, inventoryLots, inventoryLotMovements, subcontractJobs, salesOrders, currencies, adjustProductStock, createVoucher, addCheque, ownerId, user, showToast]
  );

  const cancelInvoice = useCallback(
    async (invoiceId: string) => {
      const inv = invoices.find((invoice) => invoice.id === invoiceId);
      if (!inv || inv.status === 'cancelled') return;
      const cancellationBlockReason = getInvoiceCancellationBlockReason(inv);
      if (cancellationBlockReason) throw new Error(cancellationBlockReason);
      const origVoucher = inv.voucherId ? vouchers.find((voucher) => voucher.id === inv.voucherId) : undefined;
      if (inv.voucherId && !origVoucher) throw new Error(`سند اصلی فاکتور ${inv.invoiceNumber} یافت نشد؛ ابطال بدون سند معکوس مجاز نیست.`);
      const appliedStock: Array<{ productId: string; previousStock: number }> = [];
      let reversalVoucher: Voucher | undefined;
      try {
        if (inv.invoiceType !== 'proforma') {
          const wasOut = getInvoiceStockDirection(inv.invoiceType) === -1;
          const stockDeltas = new Map<string, number>();
          for (const item of inv.items) {
            if (!Number.isFinite(item.quantity) || item.quantity <= 0) throw new Error(`مقدار کالای فاکتور ${inv.invoiceNumber} معتبر نیست.`);
            const product = products.find((candidate) => candidate.id === item.productId);
            if (!product) throw new Error(`کالای فاکتور یافت نشد: ${item.productName || item.productId}`);
            stockDeltas.set(product.id, (stockDeltas.get(product.id) || 0) + (wasOut ? item.quantity : -item.quantity));
          }
          if (!wasOut) {
            const reserved = collectActiveStockReservations(salesOrders, subcontractJobs);
            assertSufficientStock(
              new Map(products.map((product) => [product.id, Math.max(0, product.stock - (reserved.get(product.id) ?? 0))])),
              inv.items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
            );
          }
          for (const [productId, delta] of stockDeltas) {
            const product = products.find((candidate) => candidate.id === productId);
            if (!product) throw new Error(`کالای فاکتور یافت نشد: ${productId}`);
            const nextStock = Number((product.stock + delta).toFixed(2));
            if (!Number.isFinite(nextStock) || nextStock < -1e-9) throw new Error(`موجودی کالا برای ابطال فاکتور کافی نیست: ${product.name}`);
            await adjustProductStock(productId, Math.max(0, nextStock));
            appliedStock.push({ productId, previousStock: product.stock });
          }
          if (origVoucher) {
            reversalVoucher = await createVoucher({ date: getTodayShamsi(), description: `سند ابطال فاکتور ${inv.invoiceNumber} (معکوس سند #${origVoucher.voucherNumber})`, voucherType: 'general', status: 'permanent', lines: origVoucher.lines.map((line) => ({ ...line, description: `ابطال فاکتور ${inv.invoiceNumber}: ${line.description}`, debit: line.credit, credit: line.debit, foreignDebit: line.foreignCredit, foreignCredit: line.foreignDebit })), referenceId: inv.id });
          }
        }
        const lotUpdates = new Map<string, InventoryLot>();
        const reversalMovements: InventoryLotMovement[] = [];
        const wasOutForLots = getInvoiceStockDirection(inv.invoiceType) === -1;
        if (inv.invoiceType !== 'proforma') {
          for (const item of inv.items) {
            if (wasOutForLots && item.lotAllocations?.length) {
              for (const allocation of item.lotAllocations) {
                const lot = lotUpdates.get(allocation.lotId) ?? inventoryLots.find((candidate) => candidate.id === allocation.lotId);
                if (!lot) throw new Error(`بچ ${allocation.lotNumber} برای ابطال فاکتور یافت نشد.`);
                if ((lot.returnedQuantity ?? 0) > 0.0001 ||
                    calculateLotReturnedQuantity(lot.id, inventoryLotMovements) > 0.0001 ||
                    inventoryLots.some((returnedLot) => returnedLot.sourceLotId === lot.id && returnedLot.quantityRemaining > 0.0001)) {
                  throw new Error(`ابتدا باید تمام فاکتورهای برگشت مرتبط با بچ ${lot.lotNumber} ابطال شوند؛ ابطال فروش اصلی فعلاً مجاز نیست.`);
                }
                const nextQty = Number((lot.quantityRemaining + allocation.quantity).toFixed(4));
                if (nextQty > lot.quantityReceived + 0.0001) throw new Error('ابطال باعث افزایش مانده بچ بیش از مقدار دریافتی می‌شود؛ عملیات متوقف شد.');
                lotUpdates.set(lot.id, { ...lot, quantityRemaining: nextQty });
                const originalMovement = inventoryLotMovements.find((movement) =>
                  movement.referenceId === inv.id && movement.lotId === lot.id && movement.quantity < 0);
                if (inv.invoiceType === 'sale' && inv.lotMovements?.length && !originalMovement) {
                  throw new Error('گردش اصلی FIFO فاکتور در دفتر بچ پیدا نشد؛ ابطال برای جلوگیری از مخدوش‌شدن سابقه برگشت فروش متوقف شد.');
                }
                reversalMovements.push({
                  id: generateSafeId('lotmove'), ownerId, lotId: lot.id, productId: lot.productId,
                  warehouse: lot.warehouse, movementType: 'reversal', quantity: allocation.quantity,
                  unitCost: allocation.unitCost, referenceId: 'cancel:' + inv.id,
                  referenceNumber: inv.invoiceNumber, date: getLocalIsoDate(),
                  ...(originalMovement ? { reversalOfMovementId: originalMovement.id } : {}),
                });
              }
            } else if (!wasOutForLots && item.receivedLotId) {
              const lot = lotUpdates.get(item.receivedLotId) ?? inventoryLots.find((candidate) => candidate.id === item.receivedLotId);
              if (!lot) throw new Error('بچ ورودی فاکتور برای ابطال یافت نشد.');
              if (Math.abs(lot.quantityRemaining - lot.quantityReceived) > 0.0001) {
                throw new Error(`بچ ${lot.lotNumber} پس از ثبت فاکتور مصرف یا تغییر کرده است؛ ابتدا گردش‌های بعدی را تعیین تکلیف کنید.`);
              }
              if (lot.sourceLotId) {
                const sourceLot = lotUpdates.get(lot.sourceLotId) ?? inventoryLots.find((candidate) => candidate.id === lot.sourceLotId);
                if (!sourceLot) throw new Error('بچ اصلی برگشت فروش برای اصلاح مانده برگشت یافت نشد.');
                const movementReturned = calculateLotReturnedQuantity(sourceLot.id, inventoryLotMovements);
                const returnedSoFar = lotUpdates.has(sourceLot.id)
                  ? (sourceLot.returnedQuantity ?? movementReturned)
                  : Math.max(sourceLot.returnedQuantity ?? 0, movementReturned);
                if (returnedSoFar + 0.0001 < lot.quantityReceived) throw new Error('مانده برگشت ثبت‌شده در بچ اصلی با فاکتور برگشت سازگار نیست.');
                lotUpdates.set(sourceLot.id, { ...sourceLot, returnedQuantity: Number((returnedSoFar - lot.quantityReceived).toFixed(4)) });
              }
              lotUpdates.set(lot.id, { ...lot, quantityRemaining: 0 });
              const originalMovement = inventoryLotMovements.find((movement) =>
                movement.referenceId === inv.id && movement.lotId === lot.id && movement.quantity > 0);
              reversalMovements.push({
                id: generateSafeId('lotmove'), ownerId, lotId: lot.id, productId: lot.productId,
                warehouse: lot.warehouse, movementType: 'reversal', quantity: -lot.quantityReceived,
                unitCost: lot.unitCost, referenceId: 'cancel:' + inv.id,
                referenceNumber: inv.invoiceNumber, date: getLocalIsoDate(),
                ...(originalMovement ? { reversalOfMovementId: originalMovement.id } : {}),
                ...(lot.sourceLotId ? { sourceLotId: lot.sourceLotId } : {}),
              });
            }
          }
        }
        if (user) {
          const cancellationBatch = writeBatch(db);
          lotUpdates.forEach((lot) => cancellationBatch.update(doc(db, 'inventoryLots', lot.id), {
            quantityRemaining: lot.quantityRemaining,
            ...(lot.returnedQuantity !== undefined ? { returnedQuantity: lot.returnedQuantity } : {}),
            updatedAt: serverTimestamp(),
          }));
          reversalMovements.forEach((movement) => cancellationBatch.set(doc(db, 'inventoryLotMovements', movement.id), movement));
          cancellationBatch.update(doc(db, 'invoices', invoiceId), { status: 'cancelled', updatedAt: serverTimestamp() });
          await cancellationBatch.commit();
        } else {
          setInvoices((prev) => prev.map((invoice) => invoice.id === invoiceId ? { ...invoice, status: 'cancelled' } : invoice));
        }
        if (lotUpdates.size) setInventoryLots((prev) => prev.map((lot) => lotUpdates.get(lot.id) ?? lot));
        if (reversalMovements.length) setInventoryLotMovements((prev) => [...prev, ...reversalMovements]);
      } catch (error) {
        const compensationFailures: string[] = [];
        for (const snapshot of appliedStock.reverse()) {
          try {
            await adjustProductStock(snapshot.productId, snapshot.previousStock);
          } catch (rollbackError) {
            console.error('Invoice cancellation stock rollback failed', snapshot.productId, rollbackError);
            compensationFailures.push(`بازگردانی موجودی کالا ${snapshot.productId}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
          }
        }
        if (reversalVoucher) {
          try {
            await createVoucher({
              date: getTodayShamsi(),
              description: `سند جبرانی خودکار بابت عدم تکمیل ابطال فاکتور ${inv.invoiceNumber}`,
              voucherType: 'general',
              status: 'permanent',
              referenceId: `invoice-cancel-compensation:${inv.id}`,
              lines: reversalVoucher.lines.map((line) => ({
                ...line,
                description: `برگشت سند ابطال فاکتور #${reversalVoucher!.voucherNumber}: ${line.description}`,
                debit: line.credit,
                credit: line.debit,
                foreignDebit: line.foreignCredit,
                foreignCredit: line.foreignDebit,
              })),
            });
          } catch (compensationError) {
            console.error('Invoice cancellation voucher compensation failed', reversalVoucher.id, compensationError);
            compensationFailures.push(`جبران سند معکوس ${reversalVoucher.voucherNumber}: ${compensationError instanceof Error ? compensationError.message : String(compensationError)}`);
          }
        }
        const originalFailure = error instanceof Error ? error.message : String(error);
        const compensationSummary = compensationFailures.length
          ? ` خطاهای جبران نیز رخ داد: ${compensationFailures.join('؛ ')}.`
          : ' عملیات جبرانی بدون خطای گزارش‌شده انجام شد.';
        throw new Error(`ابطال فاکتور ${inv.invoiceNumber} کامل نشد. علت اصلی: ${originalFailure}.${compensationSummary}`);
      }
      showToast(`فاکتور ${inv.invoiceNumber} ابطال شد و گردش موجودی/سند معکوس ثبت گردید.`);
    },
    [invoices, products, inventoryLots, inventoryLotMovements, vouchers, salesOrders, subcontractJobs, adjustProductStock, createVoucher, user, ownerId, showToast]
  );

  const convertProformaToSale = useCallback(
    async (invoiceId: string) => {
      const inv = invoices.find((i) => i.id === invoiceId);
      if (!inv || inv.invoiceType !== 'proforma' || inv.status === 'cancelled') return;
      if (invoices.some((item) => item.id !== invoiceId && item.invoiceNumber === inv.invoiceNumber.replace(/^PF-/, 'F-') && item.status !== 'cancelled')) {
        throw new Error(`شماره فاکتور فروش ${inv.invoiceNumber.replace(/^PF-/, 'F-')} قبلاً استفاده شده است.`);
      }

      const reserved = collectActiveStockReservations(salesOrders, subcontractJobs, {
        salesOrderId: inv.salesOrderId,
      });
      assertSufficientStock(
        new Map(products.map((product) => [product.id, Math.max(0, product.stock - (reserved.get(product.id) ?? 0))])),
        inv.items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
      );

      let cogsTotal = 0;
      const stockDeltas = new Map<string, number>();
      for (const item of inv.items) {
        const prod = products.find((p) => p.id === item.productId);
        if (!prod) throw new Error(`کالای پیش‌فاکتور یافت نشد: ${item.productName || item.productId}`);
        if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
          throw new Error(`مقدار کالای پیش‌فاکتور معتبر نیست: ${item.productName || item.productId}`);
        }
        cogsTotal += Math.round(prod.buyPrice * item.quantity);
        stockDeltas.set(prod.id, (stockDeltas.get(prod.id) ?? 0) - item.quantity);
      }

      const saleNumber = inv.invoiceNumber.replace(/^PF-/, 'F-');
      const salePayload: Omit<Invoice, 'id' | 'ownerId' | 'voucherId'> = {
        ...inv,
        invoiceNumber: saleNumber,
        invoiceType: 'sale',
        status: inv.creditAmount === 0 ? 'settled' : 'issued',
      };
      const rawLines = buildInvoiceVoucherLines(salePayload, cogsTotal);
      const isFx = isForeignCurrency(inv.currencyCode) && Number(inv.exchangeRate) > 0;
      const lines = isFx && inv.exchangeRate
        ? annotateVoucherLinesWithCurrency(rawLines, inv.exchangeRate, 2)
        : rawLines;

      const appliedStock: Array<{ productId: string; previousStock: number }> = [];
      let createdVoucher: Voucher | undefined;
      try {
        for (const [productId, delta] of stockDeltas) {
          const prod = products.find((p) => p.id === productId);
          if (!prod) throw new Error(`کالای پیش‌فاکتور یافت نشد: ${productId}`);
          const nextStock = Number((prod.stock + delta).toFixed(2));
          if (!Number.isFinite(nextStock) || nextStock < -1e-9) {
            throw new Error(`موجودی کالا برای تبدیل پیش‌فاکتور کافی نیست: ${prod.name}`);
          }
          await adjustProductStock(productId, Math.max(0, nextStock));
          appliedStock.push({ productId, previousStock: prod.stock });
        }

        createdVoucher = await createVoucher({
          date: getTodayShamsi(),
          description: `سند اتوماتیک تبدیل پیش‌فاکتور به فروش رسمی ${saleNumber} — ${inv.partyName}`,
          voucherType: 'sales',
          status: 'permanent',
          lines,
          referenceId: inv.id,
          ...(isFx && inv.currencyCode && inv.exchangeRate
            ? { currencyCode: inv.currencyCode, exchangeRate: inv.exchangeRate }
            : {}),
        });

        if (user) {
          await updateDoc(doc(db, 'invoices', invoiceId), {
            invoiceNumber: saleNumber,
            invoiceType: 'sale',
            status: salePayload.status,
            voucherId: createdVoucher.id,
            updatedAt: serverTimestamp(),
          });
        } else {
          setInvoices((prev) =>
            prev.map((i) => i.id === invoiceId
              ? { ...i, invoiceNumber: saleNumber, invoiceType: 'sale', status: salePayload.status, voucherId: createdVoucher!.id }
              : i)
          );
        }
      } catch (error) {
        const compensationFailures: string[] = [];
        for (const snapshot of appliedStock.reverse()) {
          try {
            await adjustProductStock(snapshot.productId, snapshot.previousStock);
          } catch (rollbackError) {
            compensationFailures.push(`برگشت موجودی کالای ${snapshot.productId} ناموفق بود: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
          }
        }
        if (createdVoucher) {
          try {
            await createVoucher({
              date: getTodayShamsi(),
              description: `سند معکوس خودکار بابت شکست تبدیل پیش‌فاکتور ${inv.invoiceNumber}`,
              voucherType: 'general',
              status: 'permanent',
              referenceId: `proforma-conversion-compensation:${inv.id}`,
              lines: createdVoucher.lines.map((line) => ({
                ...line,
                description: `برگشت سند تبدیل پیش‌فاکتور #${createdVoucher!.voucherNumber}: ${line.description}`,
                debit: line.credit,
                credit: line.debit,
                foreignDebit: line.foreignCredit,
                foreignCredit: line.foreignDebit,
              })),
            });
          } catch (reversalError) {
            compensationFailures.push(`صدور سند معکوس #${createdVoucher.voucherNumber} ناموفق بود: ${reversalError instanceof Error ? reversalError.message : String(reversalError)}`);
          }
        }
        const originalMessage = error instanceof Error ? error.message : String(error);
        const compensationMessage = compensationFailures.length
          ? ` جبران کامل نشد و رسیدگی دستی لازم است: ${compensationFailures.join(' | ')}`
          : ' برگشت موجودی و سند با موفقیت انجام شد.';
        throw new Error(`تبدیل پیش‌فاکتور ${inv.invoiceNumber} کامل نشد. علت: ${originalMessage}.${compensationMessage}`);
      }

      showToast(`پیش‌فاکتور به فاکتور فروش رسمی ${saleNumber} تبدیل و سند حسابداری آن صادر شد.`);
    },
    [invoices, products, salesOrders, subcontractJobs, adjustProductStock, createVoucher, user, showToast]
  );

  // ---------------- CORPORATE MODULES CRUD ----------------
  const addEmployee = useCallback(
    async (emp: Omit<Employee, 'id' | 'ownerId'>) => {
      const personnelCode = emp.personnelCode.trim();
      const fullName = emp.fullName.trim();
      const department = emp.department.trim();
      if (!personnelCode || !fullName || !department) {
        throw new Error('کد پرسنلی، نام و واحد سازمانی الزامی هستند.');
      }
      if (employees.some((employee) => employee.personnelCode.trim().toLowerCase() === personnelCode.toLowerCase())) {
        throw new Error('کد پرسنلی واردشده قبلاً ثبت شده است.');
      }
      if (!Number.isInteger(emp.childrenCount) || emp.childrenCount > 20) {
        throw new Error('تعداد فرزند باید عدد صحیح بین صفر تا ۲۰ باشد.');
      }
      calculateEmployeePayroll({ ...emp, personnelCode, fullName, department, id: 'validation', ownerId } as Employee);
      const normalizedEmployee = { ...emp, personnelCode, fullName, department };
      const id = generateSafeId('emp');
      const full: Employee = { ...normalizedEmployee, id, ownerId };
      if (user) {
        try {
          await setDoc(doc(db, 'employees', id), {
            ownerId,
            personnelCode,
            fullName,
            department,
            baseSalary: emp.baseSalary,
            housingAllowance: emp.housingAllowance,
            foodAllowance: emp.foodAllowance,
            childrenCount: emp.childrenCount,
            overtimeHours: emp.overtimeHours,
            ...(emp.costCenterId ? { costCenterId: emp.costCenterId.slice(0, 128) } : {}),
            active: emp.active,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleSupabaseError(err, OperationType.CREATE, `employees/${id}`);
          throw err;
        }
      } else {
        setEmployees((prev) => [...prev, full]);
      }
      showToast(`پرسنل «${fullName}» به لیست حقوق و دستمزد افزوده شد.`);
    },
    [ownerId, user, employees, showToast]
  );

  const updateEmployee = useCallback(
    async (empId: string, patch: Partial<Omit<Employee, 'id' | 'ownerId' | 'personnelCode'>>) => {
      const existing = employees.find((employee) => employee.id === empId);
      if (!existing) throw new Error('پرسنل موردنظر برای ویرایش یافت نشد.');
      const merged = { ...existing, ...patch };
      if (!merged.fullName.trim() || !merged.department.trim()) {
        throw new Error('نام و واحد سازمانی پرسنل الزامی هستند.');
      }
      if (!Number.isInteger(merged.childrenCount) || merged.childrenCount > 20) {
        throw new Error('تعداد فرزند باید عدد صحیح بین صفر تا ۲۰ باشد.');
      }
      calculateEmployeePayroll(merged);
      if (user) {
        try {
          const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };
          if (patch.fullName !== undefined) payload.fullName = patch.fullName.trim().slice(0, 140);
          if (patch.department !== undefined) payload.department = patch.department.trim().slice(0, 80);
          if (patch.baseSalary !== undefined) payload.baseSalary = patch.baseSalary;
          if (patch.housingAllowance !== undefined) payload.housingAllowance = patch.housingAllowance;
          if (patch.foodAllowance !== undefined) payload.foodAllowance = patch.foodAllowance;
          if (patch.childrenCount !== undefined) payload.childrenCount = patch.childrenCount;
          if (patch.overtimeHours !== undefined) payload.overtimeHours = patch.overtimeHours;
          if (patch.costCenterId !== undefined) payload.costCenterId = patch.costCenterId.slice(0, 128);
          if (patch.active !== undefined) payload.active = Boolean(patch.active);
          await updateDoc(doc(db, 'employees', empId), payload);
        } catch (err) {
          handleSupabaseError(err, OperationType.UPDATE, `employees/${empId}`);
          throw err;
        }
      } else {
        setEmployees((prev) => prev.map((employee) => (employee.id === empId ? merged : employee)));
      }
      showToast('مشخصات و حکم کارگزینی پرسنل ویرایش شد.');
    },
    [employees, user, showToast]
  );

  const deleteEmployee = useCallback(
    async (empId: string) => {
      if (user) {
        try {
          await deleteDoc(doc(db, 'employees', empId));
        } catch (err) {
          handleSupabaseError(err, OperationType.DELETE, `employees/${empId}`);
        }
      } else {
        setEmployees((prev) => prev.filter((e) => e.id !== empId));
      }
      showToast('پرسنل از لیست فعال حذف شد.');
    },
    [user, showToast]
  );

  const postMonthlyPayrollVoucher = useCallback(
    async (monthName: string) => {
      const normalizedMonth = monthName.trim();
      if (!normalizedMonth) throw new Error('ماه حقوق و دستمزد را مشخص کنید.');
      const payrollReference = `payroll:${normalizedMonth}`;
      if (vouchers.some((voucher) => voucher.referenceId === payrollReference)) {
        throw new Error(`سند حقوق ماه «${normalizedMonth}» قبلاً صادر شده است.`);
      }
      const activeEmps = employees.filter((e) => e.active);
      if (activeEmps.length === 0) throw new Error('برای صدور لیست حقوق، کارمند فعال ثبت نشده است.');
      const calcs = activeEmps.map(calculateEmployeePayroll);
      const totalNet = calcs.reduce((s, c) => s + c.netPay, 0);
      const totalInsurance = calcs.reduce(
        (s, c) => s + c.employeeInsurance + c.employerInsurance,
        0
      );
      const totalTax = calcs.reduce((s, c) => s + c.incomeTax, 0);
      const validCostCenterIds = new Set(costCenters.map((center) => center.id));
      const payrollExpenseByCostCenter = new Map<string, number>();
      for (const calc of calcs) {
        const requestedCenter = calc.employee.costCenterId;
        const costCenterId = requestedCenter && validCostCenterIds.has(requestedCenter)
          ? requestedCenter
          : 'cc_hq';
        payrollExpenseByCostCenter.set(
          costCenterId,
          (payrollExpenseByCostCenter.get(costCenterId) || 0) + calc.totalEmployerCost
        );
      }

      const lines: VoucherLine[] = [
        ...[...payrollExpenseByCostCenter.entries()].map(([costCenterId, debit]) => ({
          accountCode: '80101',
          accountTitle: 'هزینه حقوق، مزایا و بیمه سهم کارفرما',
          costCenterId,
          description: `هزینه حقوق و دستمزد ${normalizedMonth}`,
          debit,
          credit: 0,
        })),
        {
          accountCode: '30401',
          accountTitle: 'حقوق پرداختنی کارکنان',
          description: `خالص پرداختنی حقوق ${normalizedMonth}`,
          debit: 0,
          credit: totalNet,
        },
        {
          accountCode: '30402',
          accountTitle: 'سازمان تأمین اجتماعی (بیمه ۳۰٪)',
          description: `بیمه سهم کارمند و کارفرما ${normalizedMonth}`,
          debit: 0,
          credit: totalInsurance,
        },
      ];
      if (totalTax > 0) {
        lines.push({
          accountCode: '30403',
          accountTitle: 'مالیات حقوق پرداختنی',
          description: `مالیات حقوق ${normalizedMonth}`,
          debit: 0,
          credit: totalTax,
        });
      }

      await createVoucher({
        date: getTodayShamsi(),
        description: `سند اتوماتیک حقوق و دستمزد ${normalizedMonth} (${activeEmps.length} نفر)`,
        voucherType: 'payroll',
        status: 'permanent',
        referenceId: payrollReference,
        lines,
      });
    },
    [employees, costCenters, vouchers, createVoucher]
  );

  const paySalariesVoucher = useCallback(
    async (monthName: string, bankAccountCode: string, amount: number) => {
      const normalizedMonth = monthName.trim();
      if (!normalizedMonth) throw new Error('ماه حقوق را مشخص کنید.');
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('مبلغ پرداخت حقوق باید عددی مثبت و معتبر باشد.');
      const bankAcc = accounts.find((a) => a.code === bankAccountCode && a.level === 'moein' && a.code.startsWith('102'));
      if (!bankAcc) throw new Error('حساب بانکی انتخاب‌شده معتبر نیست.');
      const payrollVoucher = vouchers.find((voucher) => voucher.referenceId === `payroll:${normalizedMonth}`);
      if (!payrollVoucher || payrollVoucher.status !== 'permanent') {
        throw new Error(`ابتدا سند قطعی حقوق ماه «${normalizedMonth}» را صادر کنید.`);
      }
      const payableCredit = payrollVoucher.lines
        .filter((line) => line.accountCode === '30401')
        .reduce((sum, line) => sum + (Number(line.credit) || 0) - (Number(line.debit) || 0), 0);
      const paymentPrefix = `payroll-payment:${normalizedMonth}:`;
      const priorPayments = vouchers
        .filter((voucher) =>
          voucher.status === 'permanent' &&
          voucher.voucherType === 'payroll' &&
          (voucher.referenceId?.startsWith(paymentPrefix) ||
            voucher.description.startsWith(`پرداخت خالص حقوق کارکنان ${normalizedMonth} از `))
        )
        .reduce((sum, voucher) => sum + voucher.lines
          .filter((line) => line.accountCode === '30401')
          .reduce((lineSum, line) => lineSum + (Number(line.debit) || 0) - (Number(line.credit) || 0), 0), 0);
      const outstanding = Math.max(0, payableCredit - priorPayments);
      if (amount > outstanding + 0.000001) {
        throw new Error(`مبلغ پرداخت از حقوق پرداختنی باقیمانده بیشتر است. مانده قابل پرداخت: ${outstanding.toLocaleString('en-US')}`);
      }
      const bankTitle = bankAcc?.title || 'بانک ملت — حساب جاری شرکتی';
      await createVoucher({
        date: getTodayShamsi(),
        description: `پرداخت خالص حقوق کارکنان ${normalizedMonth} از ${bankTitle}`,
        voucherType: 'payroll',
        status: 'permanent',
        referenceId: paymentPrefix + generateSafeId('pay'),
        lines: [
          {
            accountCode: '30401',
            accountTitle: 'حقوق پرداختنی کارکنان',
            description: `تسویه حقوق پرداختنی ${normalizedMonth}`,
            debit: amount,
            credit: 0,
          },
          {
            accountCode: bankAccountCode,
            accountTitle: bankTitle,
            description: `واریز حقوق پرسنل ${normalizedMonth}`,
            debit: 0,
            credit: amount,
          },
        ],
      });
    },
    [accounts, vouchers, createVoucher]
  );

  const addFixedAsset = useCallback(
    async (asset: Omit<FixedAsset, 'id' | 'ownerId'>) => {
      const assetCode = asset.assetCode.trim();
      const title = asset.title.trim();
      if (!assetCode || !title) throw new Error('کد اموال و شرح دارایی الزامی هستند.');
      if (assets.some((existing) => existing.assetCode.trim().toLowerCase() === assetCode.toLowerCase())) {
        throw new Error('کد اموال واردشده قبلاً ثبت شده است.');
      }
      validateJalaliDate(asset.purchaseDate, 'تاریخ خرید دارایی');
      if (!Number.isFinite(asset.purchaseCost) || asset.purchaseCost <= 0 ||
          !Number.isFinite(asset.salvageValue) || asset.salvageValue < 0 || asset.salvageValue > asset.purchaseCost ||
          !Number.isFinite(asset.usefulLifeYears) || asset.usefulLifeYears <= 0 || asset.usefulLifeYears > 100 ||
          !Number.isFinite(asset.accumulatedDepreciation) || asset.accumulatedDepreciation < 0 ||
          asset.accumulatedDepreciation > asset.purchaseCost - asset.salvageValue) {
        throw new Error('مشخصات مالی دارایی ثابت معتبر نیست.');
      }
      if (asset.costCenterId && !costCenters.some((center) => center.id === asset.costCenterId)) {
        throw new Error('مرکز هزینه انتخاب‌شده برای دارایی معتبر نیست.');
      }
      const normalizedAsset = { ...asset, assetCode, title };
      const id = generateSafeId('ast');
      const full: FixedAsset = { ...normalizedAsset, id, ownerId };
      if (user) {
        try {
          await setDoc(doc(db, 'assets', id), {
            ownerId,
            assetCode,
            title,
            purchaseDate: asset.purchaseDate,
            purchaseCost: asset.purchaseCost,
            salvageValue: asset.salvageValue,
            usefulLifeYears: asset.usefulLifeYears,
            accumulatedDepreciation: asset.accumulatedDepreciation,
            ...(asset.costCenterId ? { costCenterId: asset.costCenterId.slice(0, 128) } : {}),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleSupabaseError(err, OperationType.CREATE, `assets/${id}`);
          throw err;
        }
      } else {
        setAssets((prev) => [...prev, full]);
      }
      showToast(`دارایی ثابت «${title}» ثبت شد.`);
    },
    [ownerId, user, assets, costCenters, showToast]
  );

  const updateFixedAsset = useCallback(
    async (assetId: string, patch: Partial<Omit<FixedAsset, 'id' | 'ownerId' | 'assetCode'>>) => {
      const existing = assets.find((asset) => asset.id === assetId);
      if (!existing) throw new Error('دارایی موردنظر برای ویرایش یافت نشد.');
      if (patch.title !== undefined && !patch.title.trim()) throw new Error('شرح دارایی نمی‌تواند خالی باشد.');
      if (patch.purchaseDate !== undefined) validateJalaliDate(patch.purchaseDate, 'تاریخ خرید دارایی');
      const financialFieldsChanged =
        (patch.purchaseDate !== undefined && patch.purchaseDate !== existing.purchaseDate) ||
        (patch.purchaseCost !== undefined && patch.purchaseCost !== existing.purchaseCost) ||
        (patch.salvageValue !== undefined && patch.salvageValue !== existing.salvageValue) ||
        (patch.usefulLifeYears !== undefined && patch.usefulLifeYears !== existing.usefulLifeYears) ||
        (patch.accumulatedDepreciation !== undefined && patch.accumulatedDepreciation !== existing.accumulatedDepreciation);
      if (existing.accumulatedDepreciation > 0 && financialFieldsChanged) {
        throw new Error('دارایی دارای سابقه استهلاک است؛ تغییر مبانی مالی آن نیازمند سند اصلاحی و رسیدگی حسابداری است.');
      }
      const nextCost = patch.purchaseCost ?? existing.purchaseCost;
      const nextSalvage = patch.salvageValue ?? existing.salvageValue;
      const nextAccumulated = patch.accumulatedDepreciation ?? existing.accumulatedDepreciation;
      const nextLife = patch.usefulLifeYears ?? existing.usefulLifeYears;
      if (!Number.isFinite(nextCost) || nextCost <= 0 ||
          !Number.isFinite(nextSalvage) || nextSalvage < 0 || nextSalvage > nextCost ||
          !Number.isFinite(nextAccumulated) || nextAccumulated < 0 || nextAccumulated > nextCost - nextSalvage ||
          !Number.isFinite(nextLife) || nextLife <= 0 || nextLife > 100) {
        throw new Error('ویرایش بهای خرید، ارزش اسقاط، عمر مفید یا استهلاک انباشته دارایی معتبر نیست.');
      }
      if (patch.costCenterId && !costCenters.some((center) => center.id === patch.costCenterId)) {
        throw new Error('مرکز هزینه انتخاب‌شده برای دارایی معتبر نیست.');
      }
      if (user) {
        try {
          const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };
          if (patch.title !== undefined) payload.title = patch.title.trim().slice(0, 160);
          if (patch.purchaseDate !== undefined) payload.purchaseDate = patch.purchaseDate.slice(0, 20);
          if (patch.purchaseCost !== undefined) payload.purchaseCost = patch.purchaseCost;
          if (patch.salvageValue !== undefined) payload.salvageValue = patch.salvageValue;
          if (patch.usefulLifeYears !== undefined) payload.usefulLifeYears = patch.usefulLifeYears;
          if (patch.accumulatedDepreciation !== undefined) payload.accumulatedDepreciation = patch.accumulatedDepreciation;
          if (patch.costCenterId !== undefined) payload.costCenterId = patch.costCenterId.slice(0, 128);
          await updateDoc(doc(db, 'assets', assetId), payload);
        } catch (err) {
          handleSupabaseError(err, OperationType.UPDATE, `assets/${assetId}`);
          throw err;
        }
      } else {
        setAssets((prev) => prev.map((asset) => (asset.id === assetId ? { ...asset, ...patch } : asset)));
      }
      showToast('مشخصات دارایی ثابت ویرایش شد.');
    },
    [assets, costCenters, user, showToast]
  );

  const deleteFixedAsset = useCallback(
    async (assetId: string) => {
      const existing = assets.find((asset) => asset.id === assetId);
      if (!existing) throw new Error('دارایی موردنظر برای حذف یافت نشد.');
      if (existing.accumulatedDepreciation > 0) {
        throw new Error('دارایی دارای سابقه استهلاک است و حذف مستقیم آن مجاز نیست؛ ابتدا سند اصلاحی/واگذاری ثبت کنید.');
      }
      if (user) {
        try {
          await deleteDoc(doc(db, 'assets', assetId));
        } catch (err) {
          handleSupabaseError(err, OperationType.DELETE, `assets/${assetId}`);
          throw err;
        }
      } else {
        setAssets((prev) => prev.filter((asset) => asset.id !== assetId));
      }
      showToast('دارایی ثابت حذف شد.');
    },
    [assets, user, showToast]
  );

  const postDepreciationVoucher = useCallback(
    async (periodLabel: string) => {
      const normalizedPeriod = periodLabel.trim();
      if (!normalizedPeriod) throw new Error('دوره استهلاک را مشخص کنید.');
      const referenceId = `depreciation:${normalizedPeriod}`;
      if (vouchers.some((voucher) => voucher.voucherType === 'depreciation' && (voucher.referenceId === referenceId || voucher.description === `سند اتوماتیک استهلاک دارایی‌های ثابت — ${normalizedPeriod}`))) {
        throw new Error(`برای دوره «${normalizedPeriod}» قبلاً سند استهلاک ثبت شده است.`);
      }
      const allocations = assets.map((asset) => {
        if (!Number.isFinite(asset.purchaseCost) || asset.purchaseCost <= 0 || !Number.isFinite(asset.salvageValue) || asset.salvageValue < 0 || asset.salvageValue > asset.purchaseCost || !Number.isFinite(asset.usefulLifeYears) || asset.usefulLifeYears <= 0 || !Number.isFinite(asset.accumulatedDepreciation) || asset.accumulatedDepreciation < 0 || asset.accumulatedDepreciation > asset.purchaseCost - asset.salvageValue) {
          throw new Error(`اطلاعات بهای تمام‌شده، ارزش اسقاط، عمر مفید یا استهلاک انباشته دارایی «${asset.title}» معتبر نیست.`);
        }
        const amount = calculateMonthlyDepreciation(asset);
        return { asset, amount, nextAccumulated: asset.accumulatedDepreciation + amount };
      }).filter((row) => row.amount > 0);
      const totalDep = allocations.reduce((sum, row) => sum + row.amount, 0);
      if (totalDep <= 0) {
        showToast('دارایی قابل استهلاک برای این دوره وجود ندارد.');
        return;
      }
      const validCostCenterIds = new Set(costCenters.map((center) => center.id));
      const fallbackCostCenterId = validCostCenterIds.has('cc_hq') ? 'cc_hq' : costCenters[0]?.id;
      if (!fallbackCostCenterId) throw new Error('برای ثبت هزینه استهلاک، حداقل یک مرکز هزینه معتبر لازم است.');
      const expenseByCostCenter = new Map<string, number>();
      for (const row of allocations) {
        const key = row.asset.costCenterId && validCostCenterIds.has(row.asset.costCenterId)
          ? row.asset.costCenterId
          : fallbackCostCenterId;
        expenseByCostCenter.set(key, (expenseByCostCenter.get(key) || 0) + row.amount);
      }
      const expenseLines: VoucherLine[] = [...expenseByCostCenter.entries()].map(([costCenterId, debit]) => ({
        accountCode: '80301', accountTitle: 'هزینه استهلاک اموال و تجهیزات', costCenterId,
        description: `هزینه استهلاک ${normalizedPeriod}`, debit, credit: 0,
      }));
      expenseLines.push({
        accountCode: '20201', accountTitle: 'استهلاک انباشته تجهیزات اداری',
        description: `افزایش استهلاک انباشته ${normalizedPeriod}`, debit: 0, credit: totalDep,
      });
      const voucher = await createVoucher({
        date: getTodayShamsi(),
        description: `سند اتوماتیک استهلاک دارایی‌های ثابت — ${normalizedPeriod}`,
        voucherType: 'depreciation', status: 'permanent', referenceId, lines: expenseLines,
      });
      // Update asset subledger only after the depreciation voucher has been created.
      const updatedRows: typeof allocations = [];
      try {
        if (user) {
          for (const row of allocations) {
            await updateDoc(doc(db, 'assets', row.asset.id), { accumulatedDepreciation: row.nextAccumulated, updatedAt: serverTimestamp() });
            updatedRows.push(row);
          }
        } else {
          const nextById = new Map(allocations.map((row) => [row.asset.id, row.nextAccumulated]));
          setAssets((prev) => prev.map((asset) => nextById.has(asset.id) ? { ...asset, accumulatedDepreciation: nextById.get(asset.id)! } : asset));
          updatedRows.push(...allocations);
        }
      } catch (error) {
        for (const row of updatedRows) {
          if (user) {
            try { await updateDoc(doc(db, 'assets', row.asset.id), { accumulatedDepreciation: row.asset.accumulatedDepreciation, updatedAt: serverTimestamp() }); }
            catch (rollbackError) { console.error('Depreciation asset rollback failed', row.asset.id, rollbackError); }
          }
        }
        if (!user) setAssets((prev) => prev.map((asset) => { const original = updatedRows.find((row) => row.asset.id === asset.id); return original ? { ...asset, accumulatedDepreciation: original.asset.accumulatedDepreciation } : asset; }));
        try {
          await createVoucher({ date: getTodayShamsi(), description: `سند معکوس خودکار بابت عدم تکمیل دفتر اموال — ${normalizedPeriod}`, voucherType: 'general', status: 'permanent', referenceId: voucher.id,
            lines: voucher.lines.map((line) => ({ ...line, description: `برگشت سند استهلاک #${voucher.voucherNumber}: ${line.description}`, debit: line.credit, credit: line.debit, foreignDebit: line.foreignCredit, foreignCredit: line.foreignDebit })) });
        } catch (reversalError) { console.error('Depreciation voucher compensation failed', voucher.id, reversalError); }
        throw new Error(`سند استهلاک صادر شد اما به‌روزرسانی دفتر اموال کامل نشد؛ تلاش برای سند معکوس انجام شد. علت: ${error instanceof Error ? error.message : String(error)}`);
      }
      showToast(`سند استهلاک دوره «${normalizedPeriod}» با شماره ${voucher.voucherNumber} صادر شد.`);
    },
    [assets, costCenters, vouchers, user, createVoucher, showToast]
  );

  const addCostCenter = useCallback(
    async (cc: Omit<CostCenter, 'id' | 'ownerId'>) => {
      const code = cc.code.trim();
      const name = cc.name.trim();
      if (!code || !name || !Number.isFinite(cc.budget) || cc.budget < 0) {
        throw new Error('کد، نام و بودجه مرکز هزینه باید معتبر باشند.');
      }
      if (costCenters.some((center) => center.code.trim().toLowerCase() === code.toLowerCase())) {
        throw new Error('کد مرکز هزینه واردشده قبلاً ثبت شده است.');
      }
      const id = generateSafeId('cc');
      const full: CostCenter = { ...cc, code, name, id, ownerId };
      if (user) {
        try {
          await setDoc(doc(db, 'costCenters', id), {
            ownerId,
            code: code.slice(0, 32),
            name: name.slice(0, 140),
            budget: cc.budget,
            ...(cc.manager ? { manager: cc.manager.trim().slice(0, 120) } : {}),
            active: cc.active,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleSupabaseError(err, OperationType.CREATE, `costCenters/${id}`);
          throw err;
        }
      } else {
        setCostCenters((prev) => [...prev, full]);
      }
      showToast(`مرکز هزینه «${name}» ایجاد شد.`);
    },
    [ownerId, user, costCenters, showToast]
  );

  const updateCostCenter = useCallback(
    async (ccId: string, patch: Partial<Omit<CostCenter, 'id' | 'ownerId' | 'code'>>) => {
      const existing = costCenters.find((center) => center.id === ccId);
      if (!existing) throw new Error('مرکز هزینه موردنظر برای ویرایش یافت نشد.');
      const nextName = patch.name === undefined ? existing.name : patch.name.trim();
      const nextBudget = patch.budget ?? existing.budget;
      if (!nextName || !Number.isFinite(nextBudget) || nextBudget < 0) {
        throw new Error('عنوان و بودجه مرکز هزینه باید معتبر باشند.');
      }
      if (user) {
        try {
          const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };
          if (patch.name !== undefined) payload.name = nextName.slice(0, 140);
          if (patch.budget !== undefined) payload.budget = nextBudget;
          if (patch.manager !== undefined) payload.manager = patch.manager.trim().slice(0, 120);
          if (patch.active !== undefined) payload.active = Boolean(patch.active);
          await updateDoc(doc(db, 'costCenters', ccId), payload);
        } catch (err) {
          handleSupabaseError(err, OperationType.UPDATE, `costCenters/${ccId}`);
          throw err;
        }
      } else {
        setCostCenters((prev) => prev.map((center) => (center.id === ccId ? { ...center, ...patch, name: nextName } : center)));
      }
      showToast('اطلاعات مرکز هزینه ویرایش شد.');
    },
    [costCenters, user, showToast]
  );

  const deleteCostCenter = useCallback(
    async (ccId: string) => {
      const existing = costCenters.find((center) => center.id === ccId);
      if (!existing) throw new Error('مرکز هزینه موردنظر یافت نشد.');
      if (ccId === 'cc_hq') throw new Error('مرکز هزینه اصلی شرکت قابل حذف نیست.');
      if (employees.some((employee) => employee.costCenterId === ccId) ||
          assets.some((asset) => asset.costCenterId === ccId)) {
        throw new Error('این مرکز هزینه به پرسنل یا دارایی ثابت متصل است؛ ابتدا تخصیص‌ها را منتقل کنید.');
      }
      if (vouchers.some((voucher) => voucher.lines.some((line) => line.costCenterId === ccId))) {
        throw new Error('این مرکز هزینه در اسناد حسابداری سابقه دارد و حذف آن مجاز نیست.');
      }
      if (user) {
        try {
          await deleteDoc(doc(db, 'costCenters', ccId));
        } catch (err) {
          handleSupabaseError(err, OperationType.DELETE, `costCenters/${ccId}`);
          throw err;
        }
      } else {
        setCostCenters((prev) => prev.filter((center) => center.id !== ccId));
      }
      showToast('مرکز هزینه حذف شد.');
    },
    [costCenters, employees, assets, vouchers, user, showToast]
  );

  const runYearEndClosing = useCallback(async () => {
    const fiscalYear = profile.fiscalYear;
    const yearEndDate = getShamsiYearEndDate(fiscalYear);
    const nextFiscalYear = String(Number(fiscalYear) + 1);
    const openingDate = `${nextFiscalYear}/01/01`;
    const closingReference = `year-end-closing:${fiscalYear}`;
    const openingReference = `year-end-opening:${fiscalYear}`;
    if (vouchers.some((voucher) => voucher.referenceId === closingReference || (voucher.voucherType === 'closing' && voucher.date.startsWith(`${fiscalYear}/`)))) {
      throw new Error(`دوره مالی ${fiscalYear} قبلاً بسته شده است.`);
    }
    if (vouchers.some((voucher) => voucher.referenceId === openingReference)) {
      throw new Error(`سند افتتاحیه سال مالی ${nextFiscalYear} قبلاً ایجاد شده است.`);
    }
    const draftCount = vouchers.filter((voucher) =>
      voucher.status === 'draft' && voucher.date <= yearEndDate
    ).length;
    if (draftCount > 0) throw new Error(`برای بستن سال مالی ابتدا ${draftCount} سند پیش‌نویس تا پایان دوره را تعیین تکلیف کنید.`);

    // Include every permanent posting through year-end so prior opening balances
    // and previously closed periods remain part of the carried-forward balance.
    const postedThroughYearEnd = vouchers.filter((voucher) =>
      voucher.status === 'permanent' && voucher.date <= yearEndDate
    );
    const trialRows = computeTrialBalance(accounts, postedThroughYearEnd);
    const temporaryRows = trialRows.filter((row) =>
      (row.category === 'revenue' || row.category === 'cogs' || row.category === 'expense') &&
      (row.balanceDebit > 0 || row.balanceCredit > 0)
    );
    if (temporaryRows.length === 0) {
      throw new Error('حساب موقت دارای مانده‌ای برای بستن وجود ندارد؛ برای جلوگیری از ثبت افتتاحیه بدون سند اختتامیه، عملیات متوقف شد.');
    }

    const closingLines: VoucherLine[] = [];
    let netCreditToSummary = 0;
    for (const row of temporaryRows) {
      if (row.balanceCredit > 0) {
        closingLines.push({
          accountCode: row.accountCode, accountTitle: row.accountTitle,
          description: 'بستن حساب موقت درآمدی به خلاصه سود و زیان',
          debit: row.balanceCredit, credit: 0,
        });
        netCreditToSummary += row.balanceCredit;
      } else if (row.balanceDebit > 0) {
        closingLines.push({
          accountCode: row.accountCode, accountTitle: row.accountTitle,
          description: 'بستن حساب موقت هزینه‌ای/بهای تمام‌شده',
          debit: 0, credit: row.balanceDebit,
        });
        netCreditToSummary -= row.balanceDebit;
      }
    }
    const retainedEarnings = accounts.find((account) => account.code === '50201');
    if (!retainedEarnings || retainedEarnings.category !== 'equity') {
      throw new Error('حساب سود و زیان انباشته 50201 با ماهیت حقوق صاحبان سهام یافت نشد؛ بستن سال مالی متوقف شد.');
    }
    if (Math.abs(netCreditToSummary) > 0.000001) {
      closingLines.push({
        accountCode: retainedEarnings.code,
        accountTitle: retainedEarnings.title,
        description: netCreditToSummary > 0
          ? 'انتقال سود خالص دوره به سود و زیان انباشته'
          : 'انتقال زیان خالص دوره به سود و زیان انباشته',
        debit: netCreditToSummary < 0 ? Math.abs(netCreditToSummary) : 0,
        credit: netCreditToSummary > 0 ? netCreditToSummary : 0,
      });
    }
    const closingDescription = `سند بستن حساب‌های موقت و انتقال سود سال مالی ${fiscalYear}`;
    validateJournalEntryPayload({ date: yearEndDate, description: closingDescription, lines: closingLines });

    // Reconstruct opening subsidiary balances party-by-party. If the party
    // subledger does not reconcile to its control account, refuse to close.
    const partyBalancesAtClose = computePartyBalances(parties, postedThroughYearEnd);
    const partiesByAccount = new Map<string, Party[]>();
    for (const party of parties) {
      if (!party.accountCode) continue;
      const group = partiesByAccount.get(party.accountCode) ?? [];
      group.push(party);
      partiesByAccount.set(party.accountCode, group);
    }
    const partyAccountCodes = new Set(partiesByAccount.keys());
    for (const [accountCode, group] of partiesByAccount) {
      const account = accounts.find((candidate) => candidate.code === accountCode);
      if (!account || !['asset', 'liability', 'equity'].includes(account.category)) {
        const hasBalance = group.some((party) => Math.abs(partyBalancesAtClose.get(party.id) ?? 0) > 0.000001);
        if (hasBalance) throw new Error(`حساب تفصیلی طرف‌حساب‌ها ${accountCode} برای انتقال افتتاحیه معتبر نیست.`);
        continue;
      }
      const partyNet = group.reduce((sum, party) => sum + (partyBalancesAtClose.get(party.id) ?? 0), 0);
      const ledgerRow = trialRows.find((row) => row.accountCode === accountCode);
      const ledgerNet = (ledgerRow?.balanceDebit ?? 0) - (ledgerRow?.balanceCredit ?? 0);
      if (Math.abs(partyNet - ledgerNet) > 1) {
        throw new Error(`مانده تفصیلی طرف‌حساب‌ها با حساب کل/معین ${accountCode} تطبیق ندارد؛ اختلاف ${Math.round(partyNet - ledgerNet)} ریال است. ابتدا مغایرت‌گیری کنید.`);
      }
    }

    const openingLines: VoucherLine[] = [];
    for (const row of trialRows) {
      if (!['asset', 'liability', 'equity'].includes(row.category) || partyAccountCodes.has(row.accountCode)) continue;
      let netBalance = row.balanceDebit - row.balanceCredit;
      if (row.accountCode === retainedEarnings.code) netBalance += netCreditToSummary;
      if (Math.abs(netBalance) <= 0.000001) continue;
      openingLines.push({
        accountCode: row.accountCode,
        accountTitle: row.accountTitle,
        description: `انتقال مانده افتتاحیه از پایان سال مالی ${fiscalYear}`,
        debit: netBalance > 0 ? netBalance : 0,
        credit: netBalance < 0 ? Math.abs(netBalance) : 0,
      });
    }
    if (!trialRows.some((row) => row.accountCode === retainedEarnings.code) && Math.abs(netCreditToSummary) > 0.000001) {
      openingLines.push({
        accountCode: retainedEarnings.code,
        accountTitle: retainedEarnings.title,
        description: `انتقال سود/زیان خالص سال مالی ${fiscalYear} به مانده افتتاحیه`,
        debit: netCreditToSummary < 0 ? Math.abs(netCreditToSummary) : 0,
        credit: netCreditToSummary > 0 ? netCreditToSummary : 0,
      });
    }
    for (const party of parties) {
      if (!party.accountCode || !partyAccountCodes.has(party.accountCode)) continue;
      const netBalance = partyBalancesAtClose.get(party.id) ?? 0;
      if (Math.abs(netBalance) <= 0.000001) continue;
      const account = accounts.find((candidate) => candidate.code === party.accountCode);
      if (!account) throw new Error(`حساب افتتاحیه طرف‌حساب ${party.name} یافت نشد.`);
      openingLines.push({
        accountCode: account.code,
        accountTitle: account.title,
        partyId: party.id,
        partyName: party.name,
        description: `انتقال مانده افتتاحیه طرف‌حساب ${party.name}`,
        debit: netBalance > 0 ? netBalance : 0,
        credit: netBalance < 0 ? Math.abs(netBalance) : 0,
      });
    }
    const openingDescription = `سند افتتاحیه سال مالی ${nextFiscalYear} بر اساس مانده‌های پایان ${fiscalYear}`;
    validateJournalEntryPayload({ date: openingDate, description: openingDescription, lines: openingLines });

    const nextVoucherNumber = vouchers.reduce((max, voucher) => Math.max(max, voucher.voucherNumber || 0), 0) + 1;
    const closingDebit = closingLines.reduce((sum, line) => sum + line.debit, 0);
    const closingCredit = closingLines.reduce((sum, line) => sum + line.credit, 0);
    const openingDebit = openingLines.reduce((sum, line) => sum + line.debit, 0);
    const openingCredit = openingLines.reduce((sum, line) => sum + line.credit, 0);
    const closingVoucher: Voucher = {
      id: generateSafeId('vch'), ownerId, voucherNumber: nextVoucherNumber,
      date: yearEndDate, description: closingDescription, voucherType: 'closing',
      status: 'permanent', totalDebit: closingDebit, totalCredit: closingCredit,
      referenceId: closingReference, lines: closingLines,
    };
    const openingVoucher: Voucher = {
      id: generateSafeId('vch'), ownerId, voucherNumber: nextVoucherNumber + 1,
      date: openingDate, description: openingDescription, voucherType: 'opening',
      status: 'permanent', totalDebit: openingDebit, totalCredit: openingCredit,
      referenceId: openingReference, lines: openingLines,
    };

    // Persist both vouchers in one database RPC batch; never leave only one side
    // of the close/open pair committed.
    if (user) {
      const batch = writeBatch(db);
      for (const voucher of [closingVoucher, openingVoucher]) {
        batch.set(doc(db, 'vouchers', voucher.id), {
          ownerId, voucherNumber: voucher.voucherNumber, date: voucher.date,
          description: voucher.description, voucherType: voucher.voucherType,
          status: voucher.status, totalDebit: voucher.totalDebit,
          totalCredit: voucher.totalCredit, referenceId: voucher.referenceId,
          lines: voucher.lines, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
        });
      }
      await batch.commit();
    } else {
      setVouchers((previous) => [...previous, closingVoucher, openingVoucher]);
    }
    showToast(`سال مالی ${fiscalYear} بسته شد و سند افتتاحیه ${nextFiscalYear} نیز ثبت شد.`);
  }, [accounts, parties, vouchers, profile.fiscalYear, ownerId, user, showToast]);

  // ---------------- MULTI-CURRENCY & DAILY EXCHANGE RATES ----------------
  const addCurrency = useCallback(
    async (cur: Omit<CurrencyDefinition, 'id' | 'ownerId' | 'isBase'>): Promise<boolean> => {
      const code = normalizeCurrencyCode(cur.code).replace(/[^A-Z0-9_-]/g, '').slice(0, 10);
      if (!code || code.length < 2) {
        showToast('کد ارز باید حداقل ۲ حرف لاتین (مثلاً USD، TRY یا GBP) باشد.');
        return false;
      }
      if (currencies.some((c) => normalizeCurrencyCode(c.code) === code)) {
        showToast(`ارز با کد ${code} قبلاً تعریف شده است.`);
        return false;
      }
      const id = generateSafeId('cur');
      const full: CurrencyDefinition = {
        id,
        ownerId,
        code,
        name: cur.name.trim().slice(0, 80),
        symbol: (cur.symbol.trim() || code).slice(0, 16),
        isBase: false,
        decimalPlaces: Math.min(4, Math.max(0, Math.round(Number(cur.decimalPlaces) || 2))),
        defaultRateToIrr: Math.max(1, Math.round(Number(cur.defaultRateToIrr) || 1)),
        active: Boolean(cur.active),
      };

      if (user) {
        try {
          await setDoc(doc(db, 'currencies', id), {
            ownerId,
            code: full.code,
            name: full.name,
            symbol: full.symbol,
            isBase: false,
            decimalPlaces: full.decimalPlaces,
            defaultRateToIrr: full.defaultRateToIrr,
            active: full.active,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleSupabaseError(err, OperationType.CREATE, `currencies/${id}`);
          return false;
        }
      } else {
        setCurrencies((prev) => [...prev, full]);
      }

      // Also seed an initial daily rate entry for today so it's immediately usable
      const rateId = generateSafeId('fx');
      const today = getTodayShamsi();
      const rateEntry: ExchangeRateEntry = {
        id: rateId,
        ownerId,
        currencyCode: full.code,
        date: today,
        rateToIrr: full.defaultRateToIrr,
        rateType: 'market',
        notes: 'نرخ اولیه هنگام تعریف ارز',
      };
      if (user) {
        try {
          await setDoc(doc(db, 'exchangeRates', rateId), {
            ownerId,
            currencyCode: rateEntry.currencyCode,
            date: rateEntry.date,
            rateToIrr: rateEntry.rateToIrr,
            rateType: rateEntry.rateType,
            notes: rateEntry.notes,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleSupabaseError(err, OperationType.CREATE, `exchangeRates/${rateId}`);
        }
      } else {
        setExchangeRates((prev) => [rateEntry, ...prev]);
      }

      showToast(`ارز «${full.name} (${full.code})» با موفقیت تعریف شد.`);
      return true;
    },
    [currencies, ownerId, user, showToast]
  );

  const updateCurrency = useCallback(
    async (
      currencyId: string,
      patch: Partial<
        Pick<CurrencyDefinition, 'name' | 'symbol' | 'decimalPlaces' | 'defaultRateToIrr' | 'active'>
      >
    ) => {
      const existing = currencies.find((c) => c.id === currencyId);
      if (!existing) return;
      const safePatch: Partial<CurrencyDefinition> = {};
      if (patch.name !== undefined) safePatch.name = patch.name.trim().slice(0, 80);
      if (patch.symbol !== undefined) safePatch.symbol = patch.symbol.trim().slice(0, 16);
      if (patch.decimalPlaces !== undefined) {
        safePatch.decimalPlaces = Math.min(4, Math.max(0, Math.round(Number(patch.decimalPlaces) || 0)));
      }
      if (patch.defaultRateToIrr !== undefined) {
        safePatch.defaultRateToIrr = existing.isBase
          ? 1
          : Math.max(1, Math.round(Number(patch.defaultRateToIrr) || 1));
      }
      if (patch.active !== undefined) {
        safePatch.active = existing.isBase ? true : Boolean(patch.active);
      }

      if (user) {
        try {
          await updateDoc(doc(db, 'currencies', currencyId), {
            ...safePatch,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleSupabaseError(err, OperationType.UPDATE, `currencies/${currencyId}`);
        }
      } else {
        setCurrencies((prev) =>
          prev.map((c) => (c.id === currencyId ? { ...c, ...safePatch } : c))
        );
      }
      showToast(`مشخصات ارز «${existing.code}» به‌روزرسانی شد.`);
    },
    [currencies, user, showToast]
  );

  const deleteCurrency = useCallback(
    async (currencyId: string): Promise<boolean> => {
      const target = currencies.find((c) => c.id === currencyId);
      if (!target) return false;
      if (target.isBase || normalizeCurrencyCode(target.code) === BASE_CURRENCY_CODE) {
        showToast('ارز پایه دفاتر (ریال ایران) قابل حذف نیست.');
        return false;
      }
      const code = normalizeCurrencyCode(target.code);
      const usedInVoucher = vouchers.some((v) => normalizeCurrencyCode(v.currencyCode) === code);
      const usedInInvoice = invoices.some((i) => normalizeCurrencyCode(i.currencyCode) === code);
      if (usedInVoucher || usedInInvoice) {
        showToast('این ارز در اسناد یا فاکتورهای ثبت‌شده استفاده شده است؛ می‌توانید آن را غیرفعال کنید.');
        return false;
      }
      if (user) {
        try {
          await deleteDoc(doc(db, 'currencies', currencyId));
        } catch (err) {
          handleSupabaseError(err, OperationType.DELETE, `currencies/${currencyId}`);
          return false;
        }
      } else {
        setCurrencies((prev) => prev.filter((c) => c.id !== currencyId));
      }
      showToast(`ارز «${target.name} (${target.code})» حذف شد.`);
      return true;
    },
    [currencies, vouchers, invoices, user, showToast]
  );

  const upsertExchangeRate = useCallback(
    async (entry: Omit<ExchangeRateEntry, 'id' | 'ownerId'>) => {
      const code = normalizeCurrencyCode(entry.currencyCode);
      if (code === BASE_CURRENCY_CODE) {
        showToast('نرخ برابری ارز پایه (IRR) همواره برابر ۱ ریال است.');
        return;
      }
      const cleanDate = entry.date.trim().slice(0, 20);
      const cleanRate = Math.max(1, Math.round(Number(entry.rateToIrr) || 0));
      const cleanNotes = entry.notes?.trim().slice(0, 200);

      const existing = exchangeRates.find(
        (r) => normalizeCurrencyCode(r.currencyCode) === code && r.date === cleanDate
      );

      if (existing) {
        if (user) {
          try {
            await updateDoc(doc(db, 'exchangeRates', existing.id), {
              currencyCode: code,
              date: cleanDate,
              rateToIrr: cleanRate,
              rateType: entry.rateType,
              ...(cleanNotes !== undefined ? { notes: cleanNotes } : {}),
              updatedAt: serverTimestamp(),
            });
          } catch (err) {
            handleSupabaseError(err, OperationType.UPDATE, `exchangeRates/${existing.id}`);
          }
        } else {
          setExchangeRates((prev) =>
            prev.map((r) =>
              r.id === existing.id
                ? {
                    ...r,
                    rateToIrr: cleanRate,
                    rateType: entry.rateType,
                    notes: cleanNotes,
                  }
                : r
            )
          );
        }
        showToast(`نرخ روز ${code} در تاریخ ${cleanDate} به‌روزرسانی شد.`);
      } else {
        const id = generateSafeId('fx');
        const full: ExchangeRateEntry = {
          id,
          ownerId,
          currencyCode: code,
          date: cleanDate,
          rateToIrr: cleanRate,
          rateType: entry.rateType,
          ...(cleanNotes ? { notes: cleanNotes } : {}),
        };
        if (user) {
          try {
            await setDoc(doc(db, 'exchangeRates', id), {
              ownerId,
              currencyCode: full.currencyCode,
              date: full.date,
              rateToIrr: full.rateToIrr,
              rateType: full.rateType,
              ...(cleanNotes ? { notes: cleanNotes } : {}),
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          } catch (err) {
            handleSupabaseError(err, OperationType.CREATE, `exchangeRates/${id}`);
          }
        } else {
          setExchangeRates((prev) => [full, ...prev]);
        }
        showToast(`نرخ روز ${code} برای تاریخ ${cleanDate} ثبت شد.`);
      }

      // Sync currency's defaultRateToIrr if this date is >= latest existing date
      const curDef = currencies.find((c) => normalizeCurrencyCode(c.code) === code);
      if (curDef && !curDef.isBase) {
        const latestExistingDate = exchangeRates
          .filter((r) => normalizeCurrencyCode(r.currencyCode) === code)
          .map((r) => r.date)
          .sort((a, b) => b.localeCompare(a))[0];
        if (!latestExistingDate || cleanDate >= latestExistingDate) {
          if (user) {
            try {
              await updateDoc(doc(db, 'currencies', curDef.id), {
                defaultRateToIrr: cleanRate,
                updatedAt: serverTimestamp(),
              });
            } catch {
              // Non-blocking fallback sync
            }
          } else {
            setCurrencies((prev) =>
              prev.map((c) => (c.id === curDef.id ? { ...c, defaultRateToIrr: cleanRate } : c))
            );
          }
        }
      }
    },
    [exchangeRates, currencies, ownerId, user, showToast]
  );

  const deleteExchangeRate = useCallback(
    async (rateId: string) => {
      if (user) {
        try {
          await deleteDoc(doc(db, 'exchangeRates', rateId));
        } catch (err) {
          handleSupabaseError(err, OperationType.DELETE, `exchangeRates/${rateId}`);
        }
      } else {
        setExchangeRates((prev) => prev.filter((r) => r.id !== rateId));
      }
      showToast('رکورد نرخ روز ارز حذف شد.');
    },
    [user, showToast]
  );

  // ---------------- ACTIVITY AUDIT LOG ----------------
  const logActivity = useCallback(
    (module: string, action: string, details: string) => {
      const nowTime = new Date().toLocaleTimeString('fa-IR', {
        hour: '2-digit',
        minute: '2-digit',
      });
      const entry: AuditActivityLog = {
        id: generateSafeId('log'),
        ownerId,
        timestamp: `${getTodayShamsi()} · ${nowTime}`,
        operatorName: activeOperator.fullName,
        operatorRole: activeOperator.role,
        module,
        action,
        details,
      };
      setAuditLogs((prev) => [entry, ...prev].slice(0, 200));
      if (user) {
        void setDoc(doc(db, 'auditLogs', entry.id), { ...entry, createdAt: serverTimestamp() })
          .catch((error) => console.error('Audit log cloud sync failed', error));
      }
    },
    [ownerId, activeOperator, user]
  );

  // ---------------- IMPORT DOSSIERS & LANDED COST ----------------
  const addImportDossier = useCallback(
    async (dossier: Omit<ImportDossier, 'id' | 'ownerId'>) => {
      if (!dossier.dossierNumber.trim() || !dossier.proformaNumber.trim() || !dossier.supplierId ||
          !parties.some((party) => party.id === dossier.supplierId) || !dossier.originCountry.trim() ||
          !dossier.warehouse.trim() || 
          !dossier.currencyCode.trim() || !Number.isFinite(dossier.exchangeRate) || dossier.exchangeRate <= 0) {
        throw new Error('اطلاعات اصلی پرونده واردات ناقص یا نامعتبر است.');
      }
      validateJalaliDate(dossier.date, 'تاریخ پرونده واردات');
      if (importDossiers.some((item) => item.dossierNumber.trim() === dossier.dossierNumber.trim())) {
        throw new Error('شماره پرونده واردات تکراری است.');
      }
      if (!dossier.items.length || dossier.items.some((item) =>
        !products.some((product) => product.id === item.productId) ||
        !item.lotNumber.trim() || !Number.isFinite(item.weightKg) || item.weightKg <= 0 ||
        !Number.isFinite(item.foreignUnitPrice) || item.foreignUnitPrice < 0 ||
        !Number.isFinite(item.finalUnitCostIrr) || item.finalUnitCostIrr < 0
      )) {
        throw new Error('اقلام یا شماره لات پرونده واردات معتبر نیستند.');
      }
      const lotByProduct = new Map<string, string>();
      for (const item of dossier.items) {
        const existingLot = lotByProduct.get(item.productId);
        if (existingLot !== undefined && existingLot !== item.lotNumber.trim()) {
          throw new Error('برای یک کالا چند شماره لات متفاوت ثبت شده است؛ برای حفظ ردیابی لات‌ها، هر لات را به‌عنوان کالای انبار جداگانه تعریف کنید.');
        }
        lotByProduct.set(item.productId, item.lotNumber.trim());
      }
      if (dossier.costs.some((cost) => !Number.isFinite(cost.amountIrr) || cost.amountIrr < 0 ||
          !accounts.some((account) => account.code === cost.accountCode && account.level === 'moein' && (account.code.startsWith('101') || account.code.startsWith('102') || account.code.startsWith('301')) && (account.category === 'asset' || account.category === 'liability')))) {
        throw new Error('حساب تسویه هزینه‌های جانبی باید حساب دارایی (بانک/صندوق) یا بدهی (بستانکاران) باشد و مبلغ آن معتبر باشد.');
      }
      validateImportLandedCostPayload({
        totalForeignAmount: dossier.totalForeignAmount,
        exchangeRate: dossier.exchangeRate,
        totalFobIrr: dossier.totalFobIrr,
        totalLandedCostsIrr: dossier.totalLandedCostsIrr,
        grandTotalLandedIrr: dossier.grandTotalLandedIrr,
        costs: dossier.costs,
        items: dossier.items,
      });
      const full: ImportDossier = {
        ...dossier,
        id: generateSafeId('imp'),
        ownerId,
      };
      if (user) {
        try { await setDoc(doc(db, 'importDossiers', full.id), { ...full, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }); }
        catch (error) { handleSupabaseError(error, OperationType.CREATE, `importDossiers/${full.id}`); throw error; }
      }
      setImportDossiers((prev) => [full, ...prev]);
      logActivity(
        'واردات و ترخیص',
        `ایجاد پرونده واردات ${full.dossierNumber}`,
        `پروفرما ${full.proformaNumber} · جمع بهای تمام‌شده ${full.grandTotalLandedIrr.toLocaleString('en-US')} ریال`
      );
      showToast(`پرونده واردات ${full.dossierNumber} ثبت شد.`);
    },
    [ownerId, user, parties, products, accounts, importDossiers, logActivity, showToast]
  );

  const clearImportDossier = useCallback(
    async (dossierId: string) => {
      if (!activeOperator.permissions.canCreateVoucher || !activeOperator.permissions.canEditInventory) {
        showToast('نقش فعال مجوز همزمان ترخیص انبار و صدور سند بهای تمام‌شده را ندارد.'); return;
      }
      const dossier = importDossiers.find((item) => item.id === dossierId);
      if (!dossier || dossier.status === 'cleared') return;
      if (vouchers.some((voucher) => voucher.referenceId === dossier.id)) throw new Error('برای این پرونده قبلاً سند ترخیص صادر شده است.');
      if (!Number.isFinite(dossier.totalForeignAmount) || dossier.totalForeignAmount <= 0 || !Number.isFinite(dossier.exchangeRate) || dossier.exchangeRate <= 0 || !Number.isFinite(dossier.totalFobIrr) || dossier.totalFobIrr <= 0 || !dossier.currencyCode.trim()) throw new Error('مبلغ ارزی، نرخ تبدیل، ارز یا بهای پروفرما معتبر نیست.');
      if (!dossier.items.length || dossier.items.some((item) => !Number.isFinite(item.weightKg) || item.weightKg <= 0 || !Number.isFinite(item.finalUnitCostIrr) || item.finalUnitCostIrr < 0)) {
        throw new Error('اقلام پرونده واردات دارای وزن یا بهای تمام‌شده نامعتبر هستند.');
      }
      const groupedItems = new Map<string, ImportDossier['items'][number]>();
      for (const item of dossier.items) {
        const previous = groupedItems.get(item.productId);
        if (!previous) groupedItems.set(item.productId, { ...item });
        else {
          const combinedWeight = previous.weightKg + item.weightKg;
          const combinedCost = previous.weightKg * previous.finalUnitCostIrr + item.weightKg * item.finalUnitCostIrr;
          groupedItems.set(item.productId, {
            ...previous,
            weightKg: combinedWeight,
            finalUnitCostIrr: combinedWeight > 0 ? Math.round(combinedCost / combinedWeight) : 0,
            lotNumber: previous.lotNumber === item.lotNumber ? previous.lotNumber : '',
          });
        }
      }
      const productSnapshots = [...groupedItems.values()].map((item) => {
        const product = products.find((candidate) => candidate.id === item.productId);
        if (!product) throw new Error(`کالای ${item.productName} در انبار یافت نشد.`);
        if (!Number.isFinite(product.stock) || product.stock < 0 || !Number.isFinite(product.buyPrice) || product.buyPrice < 0) throw new Error(`موجودی یا بهای میانگین کالای ${item.productName} معتبر نیست.`);
        return { item, product };
      });
      validateJalaliDate(dossier.date, 'تاریخ پرونده واردات');
      if (dossier.costs.some((cost) => !cost.accountCode.trim() ||
          !accounts.some((account) => account.code === cost.accountCode && account.level === 'moein' &&
            (account.code.startsWith('101') || account.code.startsWith('102') || account.code.startsWith('301')) &&
            (account.category === 'asset' || account.category === 'liability')))) {
        throw new Error('حساب تسویه هزینه جانبی باید معین صندوق، بانک یا بستانکاران باشد.');
      }
      validateImportLandedCostPayload({
        totalForeignAmount: dossier.totalForeignAmount,
        exchangeRate: dossier.exchangeRate,
        totalFobIrr: dossier.totalFobIrr,
        totalLandedCostsIrr: dossier.totalLandedCostsIrr,
        grandTotalLandedIrr: dossier.grandTotalLandedIrr,
        costs: dossier.costs,
        items: dossier.items,
      });
      const fobTotal = Math.round(dossier.totalFobIrr);
      const landedTotal = Math.round(dossier.grandTotalLandedIrr);
      const lines: VoucherLine[] = [
        { accountCode: '10501', accountTitle: 'موجودی انبار نخ و کالای وارداتی', description: `ورود محموله ترخیص‌شده پرونده ${dossier.dossierNumber} با سرشکن هزینه‌ها`, debit: landedTotal, credit: 0 },
        { accountCode: '30101', accountTitle: 'بستانکاران و تأمین‌کنندگان واردات نخ', partyId: dossier.supplierId, partyName: dossier.supplierName, description: `بهای ارزی پروفرما ${dossier.proformaNumber} (${dossier.totalForeignAmount} ${dossier.currencyCode})`, debit: 0, credit: fobTotal },
      ];
      const costByAccount = new Map<string, { title: string; total: number }>();
      for (const cost of dossier.costs) {
        if (cost.amountIrr <= 0) continue;
        const account = accounts.find((candidate) => candidate.code === cost.accountCode);
        const current = costByAccount.get(cost.accountCode) || { title: account?.title || 'بانک ملت — حساب جاری شرکتی', total: 0 };
        current.total += Math.round(cost.amountIrr); costByAccount.set(cost.accountCode, current);
      }
      for (const [accountCode, info] of costByAccount) lines.push({
        accountCode, accountTitle: info.title, ...(accountCode === '30101' ? { partyId: dossier.supplierId, partyName: dossier.supplierName } : {}),
        description: `هزینه‌های جانبی، حمل، بیمه و گمرک پرونده ${dossier.dossierNumber}`, debit: 0, credit: info.total,
      });
      const voucher = await createVoucher({ date: dossier.date || getTodayShamsi(), description: `ترخیص گمرکی و ورود به انبار پرونده واردات ${dossier.dossierNumber} (${dossier.originCountry})`, voucherType: 'purchase', status: 'permanent', lines, referenceId: dossier.id, currencyCode: dossier.currencyCode, exchangeRate: dossier.exchangeRate });
      const updated: typeof productSnapshots = [];
      try {
        for (const { item, product } of productSnapshots) {
          const previousQuantity = product.stock;
          const nextQuantity = Number((previousQuantity + item.weightKg).toFixed(2));
          const weightedBuy = nextQuantity > 0 ? Math.round((previousQuantity * product.buyPrice + item.weightKg * item.finalUnitCostIrr) / nextQuantity) : item.finalUnitCostIrr;
          // Record the snapshot before the write: a cloud write may succeed remotely
          // and still surface a transport error locally.
          updated.push({ item, product });
          await updateProduct(product.id, { stock: nextQuantity, buyPrice: weightedBuy, lotNumber: item.lotNumber || product.lotNumber });
        }
        if (user) await updateDoc(doc(db, 'importDossiers', dossierId), { status: 'cleared', voucherId: voucher.id, updatedAt: serverTimestamp() });
      } catch (error) {
        const rollbackFailures: string[] = [];
        for (const { product } of updated.reverse()) {
          try { await updateProduct(product.id, { stock: product.stock, buyPrice: product.buyPrice, lotNumber: product.lotNumber }); }
          catch (rollbackError) {
            rollbackFailures.push(`برگشت موجودی ${product.sku}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
            console.error('Import stock rollback failed', product.id, rollbackError);
          }
        }
        try {
          await createVoucher({ date: getTodayShamsi(), description: `سند معکوس خودکار ترخیص ناموفق پرونده ${dossier.dossierNumber}`, voucherType: 'general', status: 'permanent', referenceId: `import-reversal:${dossier.id}`, lines: voucher.lines.map((line) => ({ ...line, description: `برگشت سند ترخیص #${voucher.voucherNumber}: ${line.description}`, debit: line.credit, credit: line.debit, foreignDebit: line.foreignCredit, foreignCredit: line.foreignDebit })) });
        } catch (reversalError) {
          rollbackFailures.push(`برگشت سند ${voucher.voucherNumber}: ${reversalError instanceof Error ? reversalError.message : String(reversalError)}`);
          console.error('Import clearance voucher compensation failed', voucher.id, reversalError);
        }
        const failureDetail = error instanceof Error ? error.message : String(error);
        if (rollbackFailures.length) {
          throw new Error(`ترخیص پرونده ناموفق بود و برگشت خودکار کامل نشد. علت اصلی: ${failureDetail}. موارد نیازمند رسیدگی دستی: ${rollbackFailures.join('؛ ')}`);
        }
        throw new Error(`ترخیص پرونده کامل نشد؛ سند و موجودی با موفقیت به وضعیت قبل برگردانده شدند. علت: ${failureDetail}`);
      }
      setImportDossiers((prev) => prev.map((item) => item.id === dossierId ? { ...item, status: 'cleared', voucherId: voucher.id } : item));
      logActivity('واردات و ترخیص', `ترخیص و قطعی‌سازی پرونده ${dossier.dossierNumber}`, `سند #${voucher.voucherNumber} ثبت شد و موجودی و بهای میانگین موزون کالاها به‌روزرسانی گردید.`);
      showToast(`پرونده ${dossier.dossierNumber} ترخیص، وارد انبار و سند #${voucher.voucherNumber} صادر شد.`);
    },
    [activeOperator, importDossiers, vouchers, products, accounts, updateProduct, createVoucher, logActivity, showToast, user]
  );

  // ---------------- SALES ORDERS & WEIGHBRIDGE DISPATCH ----------------
  const addSalesOrder = useCallback(
    async (order: Omit<SalesOrder, 'id' | 'ownerId'>) => {
      const full: SalesOrder = {
        ...order,
        id: generateSafeId('so'),
        ownerId,
      };
      if (user) {
        try { await setDoc(doc(db, 'salesOrders', full.id), { ...full, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }); }
        catch (error) { handleSupabaseError(error, OperationType.CREATE, `salesOrders/${full.id}`); throw error; }
      }
      setSalesOrders((prev) => [full, ...prev]);
      logActivity(
        'سفارش و حواله خروج',
        `ثبت سفارش مشتری ${full.orderNumber}`,
        `مشتری: ${full.partyName} · ${full.items.length} ردیف نخ`
      );
      showToast(`سفارش فروش ${full.orderNumber} ثبت شد.`);
    },
    [ownerId, user, logActivity, showToast]
  );

  const dispatchSalesOrder = useCallback(
    async (orderId: string, payload: { dispatchDate: string; driverName: string; plateNumber: string; items: SalesOrder['items'] }) => {
      const order = salesOrders.find((item) => item.id === orderId);
      if (!order || order.status === 'invoiced') return;
      if (order.status === 'dispatched') throw new Error('این سفارش قبلاً حواله خروج دریافت کرده است.');
      if (!payload.dispatchDate.trim() || !payload.driverName.trim() || !payload.plateNumber.trim()) throw new Error('تاریخ حواله، نام راننده و شماره پلاک الزامی است.');
      if (!payload.items.length) throw new Error('برای صدور حواله، حداقل یک ردیف کالا لازم است.');
      const requestedLines = validateSalesOrderDispatchQuantities(order.items, payload.items);
      const reservedByOtherOrders = new Map<string, number>();
      for (const other of salesOrders) {
        if (other.id === orderId || other.status !== 'dispatched') continue;
        for (const item of other.items) {
          const quantity = item.actualWeighedKg > 0 ? item.actualWeighedKg : item.orderedWeightKg;
          reservedByOtherOrders.set(item.productId, (reservedByOtherOrders.get(item.productId) || 0) + Math.max(0, quantity));
        }
      }
      for (const job of subcontractJobs) {
        if (job.status !== 'sent') continue;
        reservedByOtherOrders.set(job.rawProductId, (reservedByOtherOrders.get(job.rawProductId) || 0) + job.sentWeightKg);
      }
      const available = new Map(products.map((product) => [product.id, Math.max(0, product.stock - (reservedByOtherOrders.get(product.id) || 0))]));
      assertSufficientStock(available, requestedLines);
      validateJalaliDate(payload.dispatchDate, 'تاریخ حواله خروج');
      const dispatchDateIso = shamsiToGregorianIso(payload.dispatchDate);
      const ledgerIssues = reconcileInventoryLotLedger(inventoryLots as any, inventoryLotMovements);
      if (ledgerIssues.length) throw new Error('دفتر بچ با گردش‌های ثبت‌شده مغایرت دارد؛ صدور حواله متوقف شد.');
      const reservedLotQuantities = new Map<string, number>();
      const reserveVirtualLots = (productId: string, quantity: number, warehouse: string, date: string) => {
        if (quantity <= 0) return;
        const availableLots = inventoryLots.map((lot) => ({
          ...lot,
          quantityRemaining: Math.max(0, lot.quantityRemaining - Math.max(lot.reservedQuantity || 0, reservedLotQuantities.get(lot.id) || 0)),
        }));
        const allocations = allocateStockFIFO(availableLots as any, quantity, {
          productId, warehouse, asOfDate: date,
        }).allocations;
        allocations.forEach((allocation) => {
          reservedLotQuantities.set(allocation.lotId, (reservedLotQuantities.get(allocation.lotId) || 0) + allocation.quantity);
        });
      };
      for (const job of subcontractJobs.filter((item) => item.status === 'sent')) {
        if (job.rawLotAllocations?.length) {
          job.rawLotAllocations.forEach((allocation) => reservedLotQuantities.set(
            allocation.lotId, (reservedLotQuantities.get(allocation.lotId) || 0) + allocation.quantity,
          ));
        } else {
          const product = products.find((item) => item.id === job.rawProductId);
          if (!product) throw new Error('کالای خام یک حواله باز پیمانکاری یافت نشد.');
          reserveVirtualLots(product.id, job.sentWeightKg, product.warehouse, shamsiToGregorianIso(job.date));
        }
      }
      for (const other of salesOrders.filter((item) => item.id !== orderId && item.status === 'dispatched')) {
        for (const item of other.items) {
          if (item.lotAllocations?.length) {
            item.lotAllocations.forEach((allocation) => reservedLotQuantities.set(
              allocation.lotId, (reservedLotQuantities.get(allocation.lotId) || 0) + allocation.quantity,
            ));
          } else {
            const product = products.find((candidate) => candidate.id === item.productId);
            if (!product) throw new Error('کالای یک حواله خروج باز یافت نشد.');
            const quantity = item.actualWeighedKg > 0 ? item.actualWeighedKg : item.orderedWeightKg;
            reserveVirtualLots(product.id, quantity, other.warehouse, shamsiToGregorianIso(other.dispatchDate || other.date));
          }
        }
      }
      for (const lot of inventoryLots) {
        const reservedQty = Math.max(lot.reservedQuantity || 0, reservedLotQuantities.get(lot.id) || 0);
        if (reservedQty > lot.quantityRemaining + 0.0001) throw new Error('رزروهای قبلی بچ‌ها با مانده واقعی سازگار نیست؛ حواله جدید مجاز نیست.');
        if (reservedQty > 0) reservedLotQuantities.set(lot.id, reservedQty);
      }
      const dispatchedItems: SalesOrder['items'] = [];
      const currentOrderAllocations = new Map<string, number>();
      for (const item of payload.items) {
        const product = products.find((candidate) => candidate.id === item.productId);
        if (!product) throw new Error(`کالای حواله خروج یافت نشد: ${item.productName}`);
        if (product.warehouse !== order.warehouse) throw new Error(`انبار سفارش با انبار تعریف‌شده برای کالای ${product.name} یکسان نیست.`);
        const quantity = item.actualWeighedKg > 0 ? item.actualWeighedKg : item.orderedWeightKg;
        const lotBalance = inventoryLots.filter((lot) => lot.productId === product.id && lot.warehouse === order.warehouse)
          .reduce((sum, lot) => sum + lot.quantityRemaining, 0);
        if (Math.abs(lotBalance - product.stock) > 0.01) throw new Error(`مانده بچ‌های ${product.name} با موجودی کالا برابر نیست؛ ابتدا دفتر بچ را تطبیق دهید.`);
        const availableLots = inventoryLots.map((lot) => ({
          ...lot,
          quantityRemaining: Math.max(0, lot.quantityRemaining - Math.max(lot.reservedQuantity || 0, reservedLotQuantities.get(lot.id) || 0)),
        }));
        const fifo = allocateStockFIFO(availableLots as any, quantity, {
          productId: product.id, warehouse: order.warehouse, asOfDate: dispatchDateIso,
        });
        fifo.allocations.forEach((allocation) => {
          currentOrderAllocations.set(allocation.lotId, (currentOrderAllocations.get(allocation.lotId) || 0) + allocation.quantity);
          reservedLotQuantities.set(allocation.lotId, (reservedLotQuantities.get(allocation.lotId) || 0) + allocation.quantity);
        });
        dispatchedItems.push({ ...item, lotAllocations: fifo.allocations });
      }
      const dispatchNumber = order.dispatchNumber || `DSP-${profile.fiscalYear}-${String(salesOrders.filter((item) => item.dispatchNumber).length + 1).padStart(4, '0')}`;
      const dispatchPatch = { dispatchNumber, dispatchDate: payload.dispatchDate, driverName: payload.driverName.trim(), plateNumber: payload.plateNumber.trim(), items: dispatchedItems, status: 'dispatched' as const, updatedAt: serverTimestamp() };
      const reservedLotUpdates = new Map<string, InventoryLot>();
      for (const [lotId, quantity] of currentOrderAllocations) {
        const lot = reservedLotUpdates.get(lotId) ?? inventoryLots.find((candidate) => candidate.id === lotId);
        if (!lot) throw new Error('بچ تخصیص‌یافته برای حواله خروج یافت نشد.');
        const baseReserved = Math.max(lot.reservedQuantity || 0, reservedLotQuantities.get(lotId)! - quantity);
        reservedLotUpdates.set(lotId, { ...lot, reservedQuantity: Number((baseReserved + quantity).toFixed(4)) });
      }
      if (user) {
        const batch = writeBatch(db);
        batch.update(doc(db, 'salesOrders', orderId), dispatchPatch);
        reservedLotUpdates.forEach((lot) => batch.update(doc(db, 'inventoryLots', lot.id), {
          reservedQuantity: lot.reservedQuantity, updatedAt: serverTimestamp(),
        }));
        await batch.commit();
      }
      if (reservedLotUpdates.size) setInventoryLots((prev) => prev.map((lot) => reservedLotUpdates.get(lot.id) ?? lot));
      setSalesOrders((prev) => prev.map((item) => item.id === orderId ? { ...item, ...dispatchPatch } : item));
      logActivity('انبار و باسکول', `صدور حواله خروج ${dispatchNumber}`, `توزین نهایی سفارش ${order.orderNumber} (${order.partyName}) و رزرو بچ‌ها بر اساس FIFO`);
      showToast(`حواله خروج باسکول ${dispatchNumber} با رزرو بچ‌های FIFO ثبت شد.`);
    },
    [salesOrders, products, subcontractJobs, inventoryLots, inventoryLotMovements, profile.fiscalYear, logActivity, showToast, user]
  );

  const invoiceSalesOrder = useCallback(
    async (orderId: string) => {
      if (!activeOperator.permissions.canIssueInvoice) {
        showToast('نقش فعال مجوز صدور فاکتور فروش را ندارد.');
        return;
      }
      const order = salesOrders.find((o) => o.id === orderId);
      if (!order || order.status === 'invoiced') return;
      const existingOrderInvoice = invoices.find((invoice) => invoice.salesOrderId === orderId);
      if (existingOrderInvoice) {
        if (user) await updateDoc(doc(db, 'salesOrders', orderId), { status: 'invoiced', invoiceId: existingOrderInvoice.id, updatedAt: serverTimestamp() });
        setSalesOrders((prev) => prev.map((item) => item.id === orderId ? { ...item, status: 'invoiced', invoiceId: existingOrderInvoice.id } : item));
        return;
      }
      if (order.invoiceId) throw new Error('سفارش دارای شناسه فاکتور است اما فاکتور متناظر یافت نشد؛ از ثبت مجدد خودداری شد.');
      if (order.status !== 'dispatched' || !order.dispatchNumber) {
        throw new Error('صدور فاکتور فقط پس از ثبت حواله خروج و توزین نهایی مجاز است.');
      }
      if (order.invoiceId || invoices.some((invoice) => invoice.id === order.invoiceId)) {
        throw new Error('برای این سفارش قبلاً فاکتور صادر شده است.');
      }

      const invItems = order.items.map((it) => {
        const prod = products.find((p) => p.id === it.productId);
        const qty = it.actualWeighedKg > 0 ? it.actualWeighedKg : it.orderedWeightKg;
        const gross = Math.round(qty * it.unitPriceIrr);
        const vat = prod?.vatExempt ? 0 : Math.round(gross * 0.1);
        return {
          productId: it.productId,
          sku: it.sku,
          productName: it.productName,
          unit: 'کیلوگرم',
          quantity: qty,
          secondaryUnit: prod?.secondaryUnit || 'کارتن',
          kgPerCarton: prod?.kgPerCarton,
          cartonCount: it.actualCartons || it.orderedCartons,
          lotNumber: it.lotNumber || prod?.lotNumber,
          ...(it.lotAllocations?.length ? { lotAllocations: it.lotAllocations } : {}),
          unitPrice: it.unitPriceIrr,
          discount: 0,
          vatAmount: vat,
          lineTotal: gross + vat,
        };
      });

      const subtotal = invItems.reduce((s, i) => s + Math.round(i.quantity * i.unitPrice), 0);
      const vatAmount = invItems.reduce((s, i) => s + i.vatAmount, 0);
      const grandTotal = subtotal + vatAmount;
      const nextNum = `F-${profile.fiscalYear}-${String(invoices.length + 101)}`;

      const created = await createInvoice({
        invoiceNumber: nextNum,
        salesOrderId: orderId,
        invoiceType: 'sale',
        date: order.dispatchDate || getTodayShamsi(),
        partyId: order.partyId,
        partyName: order.partyName,
        warehouse: order.warehouse,
        items: invItems,
        subtotal,
        discount: 0,
        vatAmount,
        grandTotal,
        paidCash: 0,
        paidBank: 0,
        paidCheque: 0,
        creditAmount: grandTotal,
        status: 'issued',
      });

      if (user) await updateDoc(doc(db, 'salesOrders', orderId), { status: 'invoiced', invoiceId: created.id, updatedAt: serverTimestamp() });
      setSalesOrders((prev) =>
        prev.map((o) =>
          o.id === orderId ? { ...o, status: 'invoiced', invoiceId: created.id } : o
        )
      );
      logActivity(
        'سفارش و فاکتور',
        `تبدیل حواله ${order.dispatchNumber || order.orderNumber} به فاکتور ${created.invoiceNumber}`,
        `فاکتور فروش نهایی بر اساس وزن واقعی باسکول به مبلغ ${grandTotal.toLocaleString('en-US')} ریال صادر شد.`
      );
    },
    [activeOperator, salesOrders, products, profile.fiscalYear, invoices, createInvoice, logActivity, showToast, user]
  );

  // ---------------- DYEING / WEAVING SUBCONTRACTING ----------------
  const addSubcontractJob = useCallback(
    async (job: Omit<SubcontractJob, 'id' | 'ownerId'>) => {
      const rawProduct = products.find((product) => product.id === job.rawProductId);
      if (!job.jobNumber.trim() || subcontractJobs.some((item) => item.jobNumber.trim() === job.jobNumber.trim())) {
        throw new Error('شماره حواله پیمانکاری خالی یا تکراری است.');
      }
      if (!rawProduct || !parties.some((party) => party.id === job.contractorPartyId) ||
          !Number.isFinite(job.sentWeightKg) || job.sentWeightKg <= 0 ||
          !Number.isFinite(job.rawUnitCostIrr) || job.rawUnitCostIrr < 0 ||
          !Number.isFinite(job.serviceFeePerKgIrr) || job.serviceFeePerKgIrr < 0 ||
          !Number.isFinite(job.expectedLossPct) || job.expectedLossPct < 0 || job.expectedLossPct >= 100) {
        throw new Error('کالای خام، پیمانکار، وزن، بهای مواد یا نرخ اجرت پیمانکاری معتبر نیست.');
      }
      validateJalaliDate(job.date, 'تاریخ ارسال پیمانکاری');
      const reservations = [
        ...subcontractJobs.filter((item) => item.status === 'sent' && item.rawProductId === job.rawProductId)
          .map((item) => ({ productId: item.rawProductId, quantity: item.sentWeightKg })),
        ...salesOrders.filter((order) => order.status === 'dispatched')
          .flatMap((order) => order.items.filter((item) => item.productId === job.rawProductId).map((item) => ({
            productId: item.productId,
            quantity: item.actualWeighedKg > 0 ? item.actualWeighedKg : item.orderedWeightKg,
          }))),
      ];
      const reserved = aggregateStockReservations(reservations).get(job.rawProductId) ?? 0;
      const availableForSubcontract = rawProduct.stock - reserved;
      if (!Number.isFinite(rawProduct.stock) || availableForSubcontract + 1e-9 < job.sentWeightKg) {
        throw new Error('موجودی قابل تخصیص پس از کسر حواله‌های باز پیمانکاری کافی نیست.');
      }
      const legacyOpenJobs = subcontractJobs.filter((item) =>
        item.status === 'sent' && item.rawProductId === job.rawProductId && !item.rawLotAllocations?.length);
      if (legacyOpenJobs.length) {
        throw new Error('برای حواله‌های پیمانکاری باز قدیمی تخصیص بچ ثبت نشده است؛ ابتدا آن‌ها را تکمیل کنید تا FIFO دوباره‌شماری نشود.');
      }
      const ledgerIssues = reconcileInventoryLotLedger(inventoryLots as any, inventoryLotMovements);
      if (ledgerIssues.length) throw new Error('دفتر بچ با گردش‌های ثبت‌شده مغایرت دارد؛ حواله پیمانکاری متوقف شد.');
      const lotBalance = inventoryLots.filter((lot) => lot.productId === rawProduct.id && lot.warehouse === rawProduct.warehouse)
        .reduce((sum, lot) => sum + lot.quantityRemaining, 0);
      if (Math.abs(lotBalance - rawProduct.stock) > 0.01) {
        throw new Error('مانده بچ‌های نخ خام با موجودی کالا برابر نیست؛ ابتدا دفتر بچ را تطبیق دهید.');
      }
      const reservedLots = new Map<string, number>();
      subcontractJobs.filter((item) => item.status === 'sent' && item.rawProductId === job.rawProductId)
        .forEach((item) => (item.rawLotAllocations || []).forEach((allocation) => {
          reservedLots.set(allocation.lotId, (reservedLots.get(allocation.lotId) || 0) + allocation.quantity);
        }));
      const effectiveReservedLots = new Map<string, number>();
      for (const lot of inventoryLots) {
        const reservedQty = Math.max(lot.reservedQuantity || 0, reservedLots.get(lot.id) || 0);
        if (reservedQty > lot.quantityRemaining + 0.0001) {
          throw new Error('رزرو بچ‌های پیمانکاری با مانده واقعی دفتر بچ سازگار نیست؛ حواله جدید مجاز نیست.');
        }
        if (reservedQty > 0) effectiveReservedLots.set(lot.id, reservedQty);
      }
      const availableLots = inventoryLots.map((lot) => ({
        ...lot,
        quantityRemaining: Math.max(0, lot.quantityRemaining - (effectiveReservedLots.get(lot.id) || 0)),
      }));
      const asOfDate = shamsiToGregorianIso(job.date);
      const fifoReservation = allocateStockFIFO(availableLots as any, job.sentWeightKg, {
        productId: rawProduct.id, warehouse: rawProduct.warehouse, asOfDate,
      });
      const full: SubcontractJob = {
        ...job,
        id: generateSafeId('sub'),
        ownerId,
        rawUnitCostIrr: fifoReservation.weightedUnitCost,
        rawLotAllocations: fifoReservation.allocations,
      };
      const reservedLotUpdates = new Map<string, InventoryLot>();
      for (const allocation of fifoReservation.allocations) {
        const lot = reservedLotUpdates.get(allocation.lotId) ?? inventoryLots.find((candidate) => candidate.id === allocation.lotId);
        if (!lot) throw new Error(`بچ ${allocation.lotNumber} برای رزرو پیمانکاری یافت نشد.`);
        const currentReserved = Math.max(lot.reservedQuantity || 0, effectiveReservedLots.get(lot.id) || 0);
        reservedLotUpdates.set(lot.id, { ...lot, reservedQuantity: Number((currentReserved + allocation.quantity).toFixed(4)) });
      }
      if (user) {
        try {
          const batch = writeBatch(db);
          batch.set(doc(db, 'subcontractJobs', full.id), { ...full, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
          reservedLotUpdates.forEach((lot) => batch.update(doc(db, 'inventoryLots', lot.id), {
            reservedQuantity: lot.reservedQuantity, updatedAt: serverTimestamp(),
          }));
          await batch.commit();
        } catch (error) {
          handleSupabaseError(error, OperationType.CREATE, `subcontractJobs/${full.id}`);
          throw error;
        }
      }
      if (reservedLotUpdates.size) setInventoryLots((prev) => prev.map((lot) => reservedLotUpdates.get(lot.id) ?? lot));
      setSubcontractJobs((prev) => [full, ...prev]);
      logActivity(
        'پیمانکاری رنگرزی/بافندگی',
        `ارسال نخ خام (${full.jobNumber})`,
        `${full.sentWeightKg} کیلوگرم ${full.rawProductName} به ${full.contractorName}`
      );
      showToast(`حواله پیمانکاری ${full.jobNumber} ثبت شد.`);
    },
    [ownerId, products, parties, subcontractJobs, salesOrders, inventoryLots, inventoryLotMovements, logActivity, showToast, user]
  );

  const completeSubcontractJob = useCallback(
    async (jobId: string, payload: { returnedWeightKg: number; completionDate: string; finishedLotNumber: string }) => {
      const job = subcontractJobs.find((item) => item.id === jobId);
      if (!job || job.status === 'completed') return;
      if (vouchers.some((voucher) => voucher.referenceId === job.id)) throw new Error('برای این عملیات پیمانکاری قبلاً سند ثبت شده است.');
      const rawProduct = products.find((product) => product.id === job.rawProductId);
      if (!rawProduct) throw new Error(`کالای خام ${job.rawProductName} در انبار یافت نشد.`);
      const reservations = [
        ...subcontractJobs.filter((item) => item.id !== jobId && item.status === 'sent' && item.rawProductId === job.rawProductId)
          .map((item) => ({ productId: item.rawProductId, quantity: item.sentWeightKg })),
        ...salesOrders.filter((order) => order.status === 'dispatched')
          .flatMap((order) => order.items.filter((item) => item.productId === job.rawProductId).map((item) => ({
            productId: item.productId,
            quantity: item.actualWeighedKg > 0 ? item.actualWeighedKg : item.orderedWeightKg,
          }))),
      ];
      const reservedByOtherOperations = aggregateStockReservations(reservations).get(job.rawProductId) ?? 0;
      if (!Number.isFinite(job.sentWeightKg) || job.sentWeightKg <= 0 || !Number.isFinite(rawProduct.stock) ||
          rawProduct.stock - job.sentWeightKg + 1e-9 < reservedByOtherOperations) {
        throw new Error('موجودی نخ خام برای تکمیل این حواله، پس از حفظ رزرو سایر پیمانکاری‌ها و سفارش‌های فروش کافی نیست.');
      }
      if (!Number.isFinite(payload.returnedWeightKg) || payload.returnedWeightKg <= 0 || payload.returnedWeightKg > job.sentWeightKg + 1e-9 || !payload.finishedLotNumber.trim()) {
        throw new Error('وزن برگشتی باید مثبت و حداکثر برابر وزن نخ ارسالی باشد؛ تاریخ و شماره لات نیز باید معتبر باشند.');
      }
      validateJalaliDate(payload.completionDate, 'تاریخ تکمیل پیمانکاری');
      if (!Number.isFinite(job.serviceFeePerKgIrr) || job.serviceFeePerKgIrr < 0) throw new Error('اجرت پیمانکاری نامعتبر است.');
      const ledgerIssues = reconcileInventoryLotLedger(inventoryLots as any, inventoryLotMovements);
      if (ledgerIssues.length) throw new Error('دفتر بچ با گردش‌های ثبت‌شده مغایرت دارد؛ تکمیل پیمانکاری متوقف شد.');
      const rawLotBalance = inventoryLots.filter((lot) => lot.productId === rawProduct.id && lot.warehouse === rawProduct.warehouse)
        .reduce((sum, lot) => sum + lot.quantityRemaining, 0);
      if (Math.abs(rawLotBalance - rawProduct.stock) > 0.01) {
        throw new Error('مانده بچ‌های نخ خام با موجودی کالا برابر نیست؛ ابتدا دفتر بچ را تطبیق دهید.');
      }
      const movementDate = shamsiToGregorianIso(payload.completionDate);
      const rawIssueDate = shamsiToGregorianIso(job.date);
      let rawLotAllocations = job.rawLotAllocations || [];
      if (!rawLotAllocations.length) {
        const reservedLots = new Map<string, number>();
        for (const otherJob of subcontractJobs.filter((item) => item.id !== jobId && item.status === 'sent')) {
          let otherAllocations = otherJob.rawLotAllocations || [];
          if (!otherAllocations.length) {
            const otherProduct = products.find((product) => product.id === otherJob.rawProductId);
            if (!otherProduct) throw new Error('کالای خام یک حواله باز پیمانکاری یافت نشد.');
            const otherAvailableLots = inventoryLots.map((lot) => ({
              ...lot,
              quantityRemaining: Math.max(0, lot.quantityRemaining - (reservedLots.get(lot.id) || 0)),
            }));
            otherAllocations = allocateStockFIFO(otherAvailableLots as any, otherJob.sentWeightKg, {
              productId: otherProduct.id, warehouse: otherProduct.warehouse, asOfDate: shamsiToGregorianIso(otherJob.date),
            }).allocations;
          }
          otherAllocations.forEach((allocation) => {
            reservedLots.set(allocation.lotId, (reservedLots.get(allocation.lotId) || 0) + allocation.quantity);
          });
        }
        const availableLots = inventoryLots.map((lot) => ({
          ...lot,
          quantityRemaining: Math.max(0, lot.quantityRemaining - (reservedLots.get(lot.id) || 0)),
        }));
        rawLotAllocations = allocateStockFIFO(availableLots as any, job.sentWeightKg, {
          productId: rawProduct.id, warehouse: rawProduct.warehouse, asOfDate: rawIssueDate,
        }).allocations;
      }
      const rawTotalCost = Math.round(rawLotAllocations.reduce((sum, allocation) => sum + allocation.totalCost, 0));
      const serviceFeeTotal = Math.round(payload.returnedWeightKg * job.serviceFeePerKgIrr);
      const finishedTotalCost = rawTotalCost + serviceFeeTotal;
      const finishedUnitCost = Math.round(finishedTotalCost / payload.returnedWeightKg);
      const lines: VoucherLine[] = [
        { accountCode: '10501', accountTitle: 'موجودی انبار نخ و کالای وارداتی', description: `ورود ${payload.returnedWeightKg} کیلوگرم محصول تکمیل‌شده ${job.jobNumber}`, debit: finishedTotalCost, credit: 0 },
        { accountCode: '10501', accountTitle: 'موجودی انبار نخ و کالای وارداتی', description: `مصرف ${job.sentWeightKg} کیلوگرم نخ خام با بهای FIFO (${job.rawProductName})`, debit: 0, credit: rawTotalCost },
        { accountCode: '30101', accountTitle: 'بستانکاران و تأمین‌کنندگان واردات نخ', partyId: job.contractorPartyId, partyName: job.contractorName, description: `اجرت پیمانکاری رنگرزی/تبدیل ${job.jobNumber}`, debit: 0, credit: serviceFeeTotal },
      ];
      const voucher = await createVoucher({ date: payload.completionDate, description: `تکمیل عملیات پیمانکاری ${job.jobNumber} (${job.finishedProductName} — لات ${payload.finishedLotNumber})`, voucherType: 'general', status: 'permanent', lines, referenceId: job.id });
      let rawStockUpdated = false;
      let finishedProductId: string | undefined;
      try {
        const nextRawStock = Number((rawProduct.stock - job.sentWeightKg).toFixed(2));
        await updateProduct(rawProduct.id, { stock: nextRawStock });
        rawStockUpdated = true;
        const finishedProduct = await addProduct({ sku: `FIN-${job.jobNumber}`, name: job.finishedProductName, category: job.processType === 'dyeing' ? 'نخ رنگ‌شده (پیمانکاری)' : 'محصول تبدیل‌شده پیمانکاری',
          warehouse: rawProduct.warehouse || 'انبار مرکزی شادآباد', unit: 'کیلوگرم', secondaryUnit: rawProduct.secondaryUnit || 'کارتن',
          kgPerCarton: rawProduct.kgPerCarton || 25, lotNumber: payload.finishedLotNumber, originCountry: 'تکمیل داخلی',
          buyPrice: finishedUnitCost, sellPrice: Math.round(finishedUnitCost * 1.18), stock: payload.returnedWeightKg, reorderPoint: 100, vatExempt: false });
        finishedProductId = finishedProduct.id;
        const finishedLotId = generateSafeId('lot');
        const finishedMovementId = generateSafeId('lotmove');
        const finishedLot: InventoryLot = {
          id: finishedLotId, ownerId, productId: finishedProduct.id, warehouse: finishedProduct.warehouse,
          lotNumber: payload.finishedLotNumber.trim().slice(0, 80), receivedDate: movementDate,
          quantityReceived: payload.returnedWeightKg, quantityRemaining: payload.returnedWeightKg,
          unitCost: finishedUnitCost, costBasis: 'documented', sourceInvoiceId: job.id, createdAt: serverTimestamp(),
        };
        const rawUpdatedLots = new Map<string, InventoryLot>();
        const jobLotReservations = new Map<string, number>();
        subcontractJobs.filter((item) => item.status === 'sent')
          .forEach((item) => (item.rawLotAllocations || []).forEach((allocation) => {
            jobLotReservations.set(allocation.lotId, (jobLotReservations.get(allocation.lotId) || 0) + allocation.quantity);
          }));
        const isLotReservedJob = !!job.rawLotAllocations?.length;
        for (const allocation of rawLotAllocations) {
          const lot = rawUpdatedLots.get(allocation.lotId) ?? inventoryLots.find((candidate) => candidate.id === allocation.lotId);
          if (!lot || lot.productId !== rawProduct.id || lot.warehouse !== rawProduct.warehouse ||
              lot.quantityRemaining + 0.0001 < allocation.quantity) {
            throw new Error(`بچ ${allocation.lotNumber} برای مصرف پیمانکاری موجودی کافی ندارد؛ حواله دوباره بررسی شود.`);
          }
          const currentReserved = rawUpdatedLots.has(lot.id)
            ? (lot.reservedQuantity || 0)
            : Math.max(lot.reservedQuantity || 0, jobLotReservations.get(lot.id) || 0);
          if (isLotReservedJob && currentReserved + 0.0001 < allocation.quantity) {
            throw new Error(`رزرو بچ ${lot.lotNumber} برای این حواله معتبر نیست؛ تکمیل متوقف شد.`);
          }
          rawUpdatedLots.set(lot.id, {
            ...lot,
            quantityRemaining: Number((lot.quantityRemaining - allocation.quantity).toFixed(4)),
            ...(isLotReservedJob ? { reservedQuantity: Number(Math.max(0, currentReserved - allocation.quantity).toFixed(4)) } : {}),
          });
        }
        const rawMovements: InventoryLotMovement[] = rawLotAllocations.map((allocation) => ({
          id: generateSafeId('lotmove'), ownerId, lotId: allocation.lotId, productId: rawProduct.id,
          warehouse: rawProduct.warehouse, movementType: 'issue', quantity: -allocation.quantity,
          unitCost: allocation.unitCost, referenceId: job.id, referenceNumber: job.jobNumber, date: rawIssueDate,
          notes: 'مصرف نخ خام در پیمانکاری بر اساس FIFO',
        }));
        const finishedMovement: InventoryLotMovement = {
          id: finishedMovementId, ownerId, lotId: finishedLotId, productId: finishedProduct.id,
          warehouse: finishedProduct.warehouse, movementType: 'receipt', quantity: payload.returnedWeightKg,
          unitCost: finishedUnitCost, referenceId: job.id, referenceNumber: job.jobNumber, date: movementDate,
          notes: 'ورود محصول تکمیل‌شده با بهای مواد FIFO و اجرت پیمانکاری',
        };
        if (user) {
          const batch = writeBatch(db);
          rawUpdatedLots.forEach((lot) => batch.update(doc(db, 'inventoryLots', lot.id), {
            quantityRemaining: lot.quantityRemaining,
            ...(lot.reservedQuantity !== undefined ? { reservedQuantity: lot.reservedQuantity } : {}),
            updatedAt: serverTimestamp(),
          }));
          rawMovements.forEach((movement) => batch.set(doc(db, 'inventoryLotMovements', movement.id), movement));
          batch.set(doc(db, 'inventoryLots', finishedLotId), finishedLot);
          batch.set(doc(db, 'inventoryLotMovements', finishedMovementId), finishedMovement);
          batch.update(doc(db, 'subcontractJobs', jobId), {
            status: 'completed', completionDate: payload.completionDate, returnedWeightKg: payload.returnedWeightKg,
            finishedLotNumber: payload.finishedLotNumber, totalServiceFeeIrr: serviceFeeTotal,
            finishedUnitCostIrr: finishedUnitCost, voucherId: voucher.id, updatedAt: serverTimestamp(),
          });
          await batch.commit();
        }
        setInventoryLots((prev) => [
          ...prev.filter((lot) => !rawUpdatedLots.has(lot.id) && lot.id !== finishedLotId),
          ...[...rawUpdatedLots.values(), finishedLot],
        ]);
        setInventoryLotMovements((prev) => [...prev, ...rawMovements, finishedMovement]);
      } catch (error) {
        const compensationFailures: string[] = [];
        if (user && finishedProductId) {
          try { await deleteDoc(doc(db, 'products', finishedProductId)); }
          catch (deleteError) { compensationFailures.push(`حذف محصول تکمیل‌شده ${finishedProductId} ناموفق بود: ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`); }
        } else if (!user && finishedProductId) {
          setProducts((prev) => prev.filter((product) => product.id !== finishedProductId));
        }
        if (rawStockUpdated) {
          try {
            await updateProduct(rawProduct.id, { stock: rawProduct.stock });
          } catch (rollbackError) {
            console.error('Subcontract raw stock rollback failed', rawProduct.id, rollbackError);
            compensationFailures.push(`برگشت موجودی کالای خام (${rawProduct.id}) ناموفق بود: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
          }
        }
        try {
          await createVoucher({
            date: getTodayShamsi(),
            description: `سند معکوس خودکار تکمیل ناموفق پیمانکاری ${job.jobNumber}`,
            voucherType: 'general',
            status: 'permanent',
            referenceId: `subcontract-reversal:${job.id}`,
            lines: voucher.lines.map((line) => ({
              ...line,
              description: `برگشت سند پیمانکاری #${voucher.voucherNumber}: ${line.description}`,
              debit: line.credit,
              credit: line.debit,
              foreignDebit: line.foreignCredit,
              foreignCredit: line.foreignDebit,
            })),
          });
        } catch (reversalError) {
          console.error('Subcontract voucher compensation failed', voucher.id, reversalError);
          compensationFailures.push(`صدور سند معکوس برای سند #${voucher.voucherNumber} ناموفق بود: ${reversalError instanceof Error ? reversalError.message : String(reversalError)}`);
        }
        const originalMessage = error instanceof Error ? error.message : String(error);
        const compensationMessage = compensationFailures.length > 0
          ? ` برگشت خودکار کامل نشد و رسیدگی دستی لازم است: ${compensationFailures.join(' | ')}`
          : ' سند معکوس و برگشت موجودی با موفقیت ثبت شد.';
        throw new Error(`تکمیل پیمانکاری ${job.jobNumber} انجام نشد. علت: ${originalMessage}.${compensationMessage}`);
      }
      setSubcontractJobs((prev) => prev.map((item) => item.id === jobId ? { ...item, status: 'completed', completionDate: payload.completionDate, returnedWeightKg: payload.returnedWeightKg, finishedLotNumber: payload.finishedLotNumber, totalServiceFeeIrr: serviceFeeTotal, finishedUnitCostIrr: finishedUnitCost, voucherId: voucher.id } : item));
      logActivity('پیمانکاری رنگرزی/بافندگی', `اتمام و ورود محصول ${job.jobNumber}`, `بازگشت ${payload.returnedWeightKg} کیلوگرم با لات ${payload.finishedLotNumber} و ثبت سند #${voucher.voucherNumber}`);
      showToast(`عملیات پیمانکاری ${job.jobNumber} تکمیل و سند #${voucher.voucherNumber} ثبت شد.`);
    },
    [subcontractJobs, salesOrders, vouchers, products, inventoryLots, inventoryLotMovements, ownerId, updateProduct, addProduct, createVoucher, logActivity, showToast, user]
  );

  // ---------------- FX REVALUATION & BROKER COMMISSION VOUCHERS ----------------
  const postFxRevaluationVoucher = useCallback(
    async (rows: FxRevaluationRow[], date: string) => {
      const referenceId = `fx-revaluation:${date}`;
      if (vouchers.some((voucher) => voucher.referenceId === referenceId)) {
        throw new Error(`برای تاریخ ${date} قبلاً سند تسعیر صادر شده است.`);
      }
      const nonZero = rows.filter((row) => Math.abs(row.revaluationDiffIrr) >= 1);
      if (nonZero.length === 0) { showToast('هیچ اختلاف تسعیر ارزی برای صدور سند وجود ندارد.'); return; }
      const totalGains = nonZero.reduce((sum, row) => sum + Math.max(0, row.revaluationDiffIrr), 0);
      const totalLosses = nonZero.reduce((sum, row) => sum + Math.max(0, -row.revaluationDiffIrr), 0);
      const lines: VoucherLine[] = nonZero.map((row) => ({
        accountCode: row.accountCode, accountTitle: row.accountTitle, partyId: row.partyId, partyName: row.partyName,
        description: `${row.revaluationDiffIrr > 0 ? 'تعدیل مثبت' : 'تعدیل منفی'} تسعیر ${row.currencyCode} به نرخ ${row.currentRateToIrr.toLocaleString('en-US')} ریال`,
        debit: Math.max(0, row.revaluationDiffIrr), credit: Math.max(0, -row.revaluationDiffIrr),
      }));
      if (totalGains > 0) lines.push({ accountCode: '60901', accountTitle: 'سود ناشی از تسعیر دارایی‌ها و بدهی‌های ارزی', description: `شناسایی سود تسعیر ارز تا تاریخ ${date}`, debit: 0, credit: totalGains });
      if (totalLosses > 0) lines.push({ accountCode: '80901', accountTitle: 'زیان تسعیر ارز و کارمزدهای بانکی', description: `شناسایی زیان تسعیر ارز تا تاریخ ${date}`, debit: totalLosses, credit: 0 });
      const v = await createVoucher({ date, description: `سند تسعیر ارز دارایی‌ها و بدهی‌های ارزی پایان دوره (${date})`, voucherType: 'general', status: 'permanent', referenceId, lines });
      logActivity('ارز و تسعیر', `صدور سند تسعیر ارز #${v.voucherNumber}`, `${nonZero.length} ردیف ارزی تسعیر شد (سود: ${totalGains.toLocaleString('en-US')}، زیان: ${totalLosses.toLocaleString('en-US')} ریال)`);
      showToast(`سند تسعیر ارز #${v.voucherNumber} با موفقیت صادر شد.`);
    },
    [vouchers, createVoucher, logActivity, showToast]
  );

  const postBrokerCommissionVoucher = useCallback(
    async (payload: {
      partyId: string;
      partyName: string;
      amountIrr: number;
      date: string;
      periodLabel: string;
    }) => {
      const amount = Math.round(payload.amountIrr);
      if (amount <= 0) return;
      const v = await createVoucher({
        date: payload.date,
        description: `هزینه پورسانت کارگزاری فروش ${payload.partyName} — ${payload.periodLabel}`,
        voucherType: 'general',
        status: 'permanent',
        lines: [
          {
            accountCode: '80501',
            accountTitle: 'پورسانت کارگزاران بازار و حمل بار نخ',
            description: `پورسانت فروش ${payload.partyName} (${payload.periodLabel})`,
            debit: amount,
            credit: 0,
          },
          {
            accountCode: '30101',
            accountTitle: 'بستانکاران و تأمین‌کنندگان واردات نخ',
            partyId: payload.partyId,
            partyName: payload.partyName,
            description: `بستانکاری پورسانت ${payload.partyName}`,
            debit: 0,
            credit: amount,
          },
        ],
      });
      logActivity(
        'پورسانت فروش',
        `صدور سند پورسانت #${v.voucherNumber}`,
        `${payload.partyName} به مبلغ ${amount.toLocaleString('en-US')} ریال`
      );
      showToast(`سند پورسانت ${payload.partyName} (#${v.voucherNumber}) صادر شد.`);
    },
    [createVoucher, logActivity, showToast]
  );

  // ---------------- RBAC OPERATORS CRUD ----------------
  const addRbacOperator = useCallback(
    async (op: Omit<RbacOperator, 'id' | 'ownerId'>) => {
      const fullName = op.fullName.trim();
      if (!fullName) throw new Error('نام اپراتور الزامی است.');
      const email = op.email?.trim().toLowerCase() || undefined;
      if (email && rbacOperators.some((existing) => (existing.email ?? '').toLowerCase() === email)) {
        throw new Error('این ایمیل قبلاً برای اپراتور دیگری ثبت شده است.');
      }
      const full: RbacOperator = { ...op, fullName, email, id: generateSafeId('op'), ownerId };
      if (user) {
        try {
          await setDoc(doc(db, 'rbacOperators', full.id), { ...full, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
        } catch (error) {
          handleSupabaseError(error, OperationType.CREATE, `rbacOperators/${full.id}`);
          throw error;
        }
      }
      setRbacOperators((prev) => [...prev, full]);
      logActivity('مدیریت کاربران', `تعریف کاربر ${full.fullName}`, `نقش: ${full.role}`);
      showToast(`کاربر «${full.fullName}» به لیست اپراتورها اضافه شد.`);
    },
    [ownerId, user, rbacOperators, logActivity, showToast]
  );

  const updateRbacOperator = useCallback(
    async (
      opId: string,
      patch: Partial<Pick<RbacOperator, 'fullName' | 'role' | 'email' | 'active' | 'permissions'>>
    ) => {
      const existing = rbacOperators.find((operator) => operator.id === opId);
      if (!existing) throw new Error('اپراتور موردنظر یافت نشد.');
      const nextName = patch.fullName === undefined ? existing.fullName : patch.fullName.trim();
      if (!nextName) throw new Error('نام اپراتور نمی‌تواند خالی باشد.');
      const nextEmail = patch.email === undefined ? (existing.email ?? '') : patch.email.trim().toLowerCase();
      if (nextEmail && rbacOperators.some((operator) => operator.id !== opId && (operator.email ?? '').toLowerCase() === nextEmail)) {
        throw new Error('این ایمیل قبلاً برای اپراتور دیگری ثبت شده است.');
      }
      if (user) {
        try {
          const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };
          if (patch.fullName !== undefined) payload.fullName = nextName.slice(0, 140);
          if (patch.role !== undefined) payload.role = patch.role;
          if (patch.email !== undefined) payload.email = nextEmail.slice(0, 180);
          if (patch.active !== undefined) payload.active = Boolean(patch.active);
          if (patch.permissions !== undefined) payload.permissions = patch.permissions;
          await updateDoc(doc(db, 'rbacOperators', opId), payload);
        } catch (error) {
          handleSupabaseError(error, OperationType.UPDATE, `rbacOperators/${opId}`);
          throw error;
        }
      }
      setRbacOperators((prev) => prev.map((operator) => operator.id === opId ? { ...operator, ...patch, fullName: nextName, email: nextEmail } : operator));
      logActivity('مدیریت کاربران', 'ویرایش سطح دسترسی کاربر', `شناسه اپراتور: ${opId}`);
      showToast('سطح دسترسی کاربر به‌روزرسانی شد.');
    },
    [rbacOperators, user, logActivity, showToast]
  );

  const deleteRbacOperator = useCallback(
    async (opId: string) => {
      if (rbacOperators.length <= 1) throw new Error('حداقل یک کاربر مدیر در سیستم باید باقی بماند.');
      const target = rbacOperators.find((operator) => operator.id === opId);
      if (!target) throw new Error('اپراتور موردنظر یافت نشد.');
      if (user) {
        try {
          await deleteDoc(doc(db, 'rbacOperators', opId));
        } catch (error) {
          handleSupabaseError(error, OperationType.DELETE, `rbacOperators/${opId}`);
          throw error;
        }
      }
      setRbacOperators((prev) => prev.filter((operator) => operator.id !== opId));
      if (activeOperatorId === opId) {
        const next = rbacOperators.find((operator) => operator.id !== opId);
        if (next) setActiveOperatorId(next.id);
      }
      logActivity('مدیریت کاربران', 'حذف اپراتور', `شناسه اپراتور: ${opId}`);
      showToast('اپراتور حذف شد.');
    },
    [rbacOperators, activeOperatorId, user, logActivity, showToast]
  );

  // ---------------- BACKUP & RESTORE ----------------
  const exportBackupJson = useCallback(() => {
    return JSON.stringify(
      {
        version: 'holoo-apex-1.2',
        exportedAt: new Date().toISOString(),
        profile,
        accounts,
        parties,
        products,
        inventoryLots,
        inventoryLotMovements,
        vouchers,
        invoices,
        cheques,
        employees,
        assets,
        costCenters,
        currencies,
        exchangeRates,
        importDossiers,
        salesOrders,
        subcontractJobs,
        rbacOperators,
        auditLogs,
      },
      null,
      2
    );
  }, [
    profile,
    accounts,
    parties,
    products,
    inventoryLots,
    inventoryLotMovements,
    vouchers,
    invoices,
    cheques,
    employees,
    assets,
    costCenters,
    currencies,
    exchangeRates,
    importDossiers,
    salesOrders,
    subcontractJobs,
    rbacOperators,
    auditLogs,
  ]);

  const importBackupJson = useCallback(
    (jsonText: string): boolean => {
      try {
        const parsed = JSON.parse(jsonText);
        if (!Array.isArray(parsed.accounts) || !Array.isArray(parsed.vouchers)) {
          showToast('ساختار فایل پشتیبان معتبر نیست.');
          return false;
        }
        if (parsed.profile) setProfile((p) => ({ ...p, ...parsed.profile }));
        setAccounts(parsed.accounts);
        setParties(parsed.parties || []);
        setProducts(parsed.products || []);
        setInventoryLots(Array.isArray(parsed.inventoryLots) ? parsed.inventoryLots : []);
        setInventoryLotMovements(Array.isArray(parsed.inventoryLotMovements) ? parsed.inventoryLotMovements : []);
        setVouchers(parsed.vouchers);
        setInvoices(parsed.invoices || []);
        setCheques(parsed.cheques || []);
        setEmployees(parsed.employees || []);
        setAssets(parsed.assets || []);
        setCostCenters(parsed.costCenters || []);
        if (Array.isArray(parsed.currencies) && parsed.currencies.length > 0) {
          setCurrencies(parsed.currencies);
        }
        if (Array.isArray(parsed.exchangeRates)) {
          setExchangeRates(parsed.exchangeRates);
        }
        if (Array.isArray(parsed.importDossiers)) setImportDossiers(parsed.importDossiers);
        if (Array.isArray(parsed.salesOrders)) setSalesOrders(parsed.salesOrders);
        if (Array.isArray(parsed.subcontractJobs)) setSubcontractJobs(parsed.subcontractJobs);
        if (Array.isArray(parsed.rbacOperators) && parsed.rbacOperators.length > 0) {
          setRbacOperators(parsed.rbacOperators);
        }
        if (Array.isArray(parsed.auditLogs)) setAuditLogs(parsed.auditLogs);
        showToast('فایل پشتیبان حسابداری با موفقیت بازیابی و بارگذاری شد.');
        return true;
      } catch {
        showToast('خطا در خواندن فایل پشتیبان JSON.');
        return false;
      }
    },
    [showToast]
  );

  return (
    <AccountingContext.Provider
      value={{
        user,
        authReady,
        isCloudMode,
        isSyncing,
        deviceIdentity,
        profile,
        accounts,
        parties,
        products,
        inventoryLots,
        inventoryLotMovements,
        vouchers,
        invoices,
        cheques,
        employees,
        assets,
        costCenters,
        currencies,
        exchangeRates,
        importDossiers,
        salesOrders,
        subcontractJobs,
        rbacOperators,
        activeOperator,
        setActiveOperatorId,
        auditLogs,
        trialBalance,
        incomeStatement,
        balanceSheet,
        partyBalances,
        auditReport,
        toast,
        showToast,
        bootstrapCloud,
        joinCloud,
        createDeviceInvite,
        logout,
        updateCompanyProfile,
        setCurrencyUnit,
        addAccount,
        updateAccount,
        deleteAccount,
        addParty,
        updateParty,
        deleteParty,
        addProduct,
        updateProduct,
        createOpeningInventoryLot,
        reconcileProductLotsToStock,
        deleteProduct,
        adjustProductStock,
        adjustProductStockWithVoucher,
        bulkStocktakingWithVoucher,
        bulkUpdateProductPrices,
        transferProductWarehouse,
        createVoucher,
        updateVoucher,
        deleteVoucher,
        finalizeVoucher,
        finalizeAllDraftVouchers,
        createReversingVoucher,
        renumberVouchersChronologically,
        addCurrency,
        updateCurrency,
        deleteCurrency,
        upsertExchangeRate,
        deleteExchangeRate,
        createInvoice,
        cancelInvoice,
        convertProformaToSale,
        addCheque,
        updateCheque,
        updateChequeStatus,
        recordQuickTreasury,
        recordBankTransfer,
        addEmployee,
        updateEmployee,
        deleteEmployee,
        postMonthlyPayrollVoucher,
        paySalariesVoucher,
        addFixedAsset,
        updateFixedAsset,
        deleteFixedAsset,
        postDepreciationVoucher,
        addCostCenter,
        updateCostCenter,
        deleteCostCenter,
        runYearEndClosing,
        addImportDossier,
        clearImportDossier,
        addSalesOrder,
        dispatchSalesOrder,
        invoiceSalesOrder,
        addSubcontractJob,
        completeSubcontractJob,
        postFxRevaluationVoucher,
        postBrokerCommissionVoucher,
        addRbacOperator,
        updateRbacOperator,
        deleteRbacOperator,
        logActivity,
        exportBackupJson,
        importBackupJson,
      }}
    >
      {children}
    </AccountingContext.Provider>
  );
};

export function useAccounting() {
  const ctx = useContext(AccountingContext);
  if (!ctx) throw new Error('useAccounting must be used within AccountingProvider');
  return ctx;
}
