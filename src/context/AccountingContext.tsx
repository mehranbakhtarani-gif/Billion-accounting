import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import {
  auth, db, collection, deleteDoc, doc, getDoc, getDocs, onAuthStateChanged,
  onSnapshot, query, serverTimestamp, setDoc, updateDoc, where, writeBatch,
  handleSupabaseError, isSupabaseOfflineError, OperationType, signOutAccount,
  testSupabaseConnection, setActiveCompanyId,
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
import { assertSufficientStock, getChequeStatusTransitionError, validateJournalEntryPayload, validateTreasuryOperationPayload, validateTreasuryAccountSelection, validateTreasuryTransferAccounts } from '../lib/enterpriseControls';
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
import { generateSafeId, getTodayShamsi } from '../lib/format';
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
  addProduct: (product: Omit<Product, 'id' | 'ownerId'>) => Promise<void>;
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
      profile, accounts, parties, products, vouchers, invoices, cheques, employees,
      assets, costCenters, currencies, exchangeRates, importDossiers, salesOrders,
      subcontractJobs, rbacOperators, activeOperatorId, auditLogs,
    }).catch((error) => {
      console.error('Local accounting database save failed:', error);
    });
  }, [
    localDataReady, profile, accounts, parties, products, vouchers, invoices, cheques,
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
        subscribeCol<Voucher>('vouchers', setVouchers);
        subscribeCol<Invoice>('invoices', setInvoices);
        subscribeCol<Cheque>('cheques', setCheques);
        subscribeCol<Employee>('employees', setEmployees);
        subscribeCol<FixedAsset>('assets', setAssets);
        subscribeCol<CostCenter>('costCenters', setCostCenters);
        subscribeCol<CurrencyDefinition>('currencies', setCurrencies);
        subscribeCol<ExchangeRateEntry>('exchangeRates', setExchangeRates);
      })
      .catch((err) => {
        console.error(err);
      });

    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, [authReady, user, ensureCloudSeed]);

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
      if (!existing) return;
      if (vouchers.some((voucher) => voucher.voucherType === 'closing' && voucher.date.slice(0, 4) === existing.date.slice(0, 4))) { const message = `دوره مالی ${existing.date.slice(0, 4)} بسته شده است؛ قطعی‌سازی سند مجاز نیست.`; showToast(message); throw new Error(message); }
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
    [vouchers, user, showToast]
  );

  const createReversingVoucher = useCallback(
    async (voucherId: string): Promise<Voucher | null> => {
      const orig = vouchers.find((v) => v.id === voucherId);
      if (!orig) return null;
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

  const transferProductWarehouse = useCallback(
    async (productId: string, targetWarehouse: string) => {
      const prod = products.find((p) => p.id === productId);
      if (!prod || !targetWarehouse.trim()) return;
      const cleanWh = targetWarehouse.trim().slice(0, 80);
      if (user) {
        try {
          await updateDoc(doc(db, 'products', productId), {
            warehouse: cleanWh,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleSupabaseError(err, OperationType.UPDATE, `products/${productId}`);
        }
      } else {
        setProducts((prev) =>
          prev.map((p) => (p.id === productId ? { ...p, warehouse: cleanWh } : p))
        );
      }
      showToast(`حواله انتقال کالای «${prod.name}» به «${cleanWh}» ثبت شد.`);
    },
    [products, user, showToast]
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
    [ownerId, user, cheques, createVoucher]
  );

  const updateCheque = useCallback(
    async (
      chequeId: string,
      patch: Partial<Pick<Cheque, 'bankName' | 'branch' | 'dueDate' | 'notes'>>
    ) => {
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
    [user, showToast]
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
      const bankAcc = accounts.find((a) => a.code === bankCode);
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
    }) => {
      validateTreasuryOperationPayload(payload);
      const party = parties.find((p) => p.id === payload.partyId);
      if (!party) throw new Error('طرف‌حساب انتخاب‌شده معتبر نیست.');
      const cashAcc = accounts.find((a) => a.code === payload.accountCode);
      validateTreasuryAccountSelection(cashAcc ? { code: cashAcc.code, level: cashAcc.level } : undefined);
      const cashCode = cashAcc!.code;
      const cashTitle = cashAcc!.title;
      const partyCode = party.accountCode || (party.partyType === 'vendor' ? '30101' : '10401');
      const partyTitle =
        partyCode === '30101' ? 'بستانکاران و تأمین‌کنندگان' : 'بدهکاران تجاری و مشتریان';

      const lines: VoucherLine[] =
        payload.direction === 'receipt'
          ? [
              {
                accountCode: cashCode,
                accountTitle: cashTitle,
                description: payload.description,
                debit: payload.amount,
                credit: 0,
              },
              {
                accountCode: partyCode,
                accountTitle: partyTitle,
                partyId: party.id,
                partyName: party.name,
                description: payload.description,
                debit: 0,
                credit: payload.amount,
              },
            ]
          : [
              {
                accountCode: partyCode,
                accountTitle: partyTitle,
                partyId: party.id,
                partyName: party.name,
                description: payload.description,
                debit: payload.amount,
                credit: 0,
              },
              {
                accountCode: cashCode,
                accountTitle: cashTitle,
                description: payload.description,
                debit: 0,
                credit: payload.amount,
              },
            ];

      await createVoucher({
        date: payload.date,
        description: `${payload.direction === 'receipt' ? 'دریافت' : 'پرداخت'} خزانه — ${party.name}`,
        voucherType: 'treasury',
        status: 'permanent',
        lines,
      });
    },
    [parties, accounts, createVoucher]
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

      const isStockOut = ['sale', 'purchase_return', 'waste'].includes(payload.invoiceType);
      if (isStockOut) {
        const subcontractReservations = new Map<string, number>();
        for (const job of subcontractJobs) {
          if (job.status !== 'sent') continue;
          subcontractReservations.set(job.rawProductId, (subcontractReservations.get(job.rawProductId) ?? 0) + job.sentWeightKg);
        }
        assertSufficientStock(
          new Map(products.map((product) => [product.id, Math.max(0, product.stock - (subcontractReservations.get(product.id) ?? 0))])),
          payload.items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
        );
      }

      let cogsTotal = 0;
      const stockDeltas = new Map<string, number>();
      if (payload.invoiceType !== 'proforma') {
        for (const item of payload.items) {
          const product = products.find((candidate) => candidate.id === item.productId);
          if (!product) throw new Error(`کالای ردیف فاکتور یافت نشد: ${item.productName || item.productId}`);
          if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
            throw new Error(`مقدار کالا در فاکتور معتبر نیست: ${item.productName || item.productId}`);
          }
          cogsTotal += Math.round(product.buyPrice * item.quantity);
          const outgoing = ['sale', 'purchase_return', 'waste'].includes(payload.invoiceType);
          stockDeltas.set(product.id, (stockDeltas.get(product.id) ?? 0) + (outgoing ? -item.quantity : item.quantity));
        }
      }

      const isFxInv = isForeignCurrency(payload.currencyCode) && Number(payload.exchangeRate) > 0;
      const full: Invoice = { ...payload, id, ownerId, voucherId };
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

        const persistedInvoice: Invoice = { ...full, ...(voucherId ? { voucherId } : {}) };
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
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } else {
          setInvoices((prev) => [persistedInvoice, ...prev]);
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
    [products, subcontractJobs, currencies, adjustProductStock, createVoucher, addCheque, ownerId, user, showToast]
  );

  const cancelInvoice = useCallback(
    async (invoiceId: string) => {
      const inv = invoices.find((invoice) => invoice.id === invoiceId);
      if (!inv || inv.status === 'cancelled') return;
      const origVoucher = inv.voucherId ? vouchers.find((voucher) => voucher.id === inv.voucherId) : undefined;
      if (inv.voucherId && !origVoucher) throw new Error(`سند اصلی فاکتور ${inv.invoiceNumber} یافت نشد؛ ابطال بدون سند معکوس مجاز نیست.`);
      const appliedStock: Array<{ productId: string; previousStock: number }> = [];
      let reversalVoucher: Voucher | undefined;
      try {
        if (inv.invoiceType !== 'proforma') {
          const wasOut = ['sale', 'purchase_return', 'waste'].includes(inv.invoiceType);
          const stockDeltas = new Map<string, number>();
          for (const item of inv.items) {
            if (!Number.isFinite(item.quantity) || item.quantity <= 0) throw new Error(`مقدار کالای فاکتور ${inv.invoiceNumber} معتبر نیست.`);
            const product = products.find((candidate) => candidate.id === item.productId);
            if (!product) throw new Error(`کالای فاکتور یافت نشد: ${item.productName || item.productId}`);
            stockDeltas.set(product.id, (stockDeltas.get(product.id) || 0) + (wasOut ? item.quantity : -item.quantity));
          }
          if (!wasOut) {
            const subcontractReservations = new Map<string, number>();
            for (const job of subcontractJobs) {
              if (job.status !== 'sent') continue;
              subcontractReservations.set(job.rawProductId, (subcontractReservations.get(job.rawProductId) ?? 0) + job.sentWeightKg);
            }
            assertSufficientStock(
              new Map(products.map((product) => [product.id, Math.max(0, product.stock - (subcontractReservations.get(product.id) ?? 0))])),
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
        if (user) await updateDoc(doc(db, 'invoices', invoiceId), { status: 'cancelled', updatedAt: serverTimestamp() });
        else setInvoices((prev) => prev.map((invoice) => invoice.id === invoiceId ? { ...invoice, status: 'cancelled' } : invoice));
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
    [invoices, products, vouchers, subcontractJobs, adjustProductStock, createVoucher, user, showToast]
  );

  const convertProformaToSale = useCallback(
    async (invoiceId: string) => {
      const inv = invoices.find((i) => i.id === invoiceId);
      if (!inv || inv.invoiceType !== 'proforma' || inv.status === 'cancelled') return;
      if (invoices.some((item) => item.id !== invoiceId && item.invoiceNumber === inv.invoiceNumber.replace(/^PF-/, 'F-') && item.status !== 'cancelled')) {
        throw new Error(`شماره فاکتور فروش ${inv.invoiceNumber.replace(/^PF-/, 'F-')} قبلاً استفاده شده است.`);
      }

      const subcontractReservations = new Map<string, number>();
      for (const job of subcontractJobs) {
        if (job.status !== 'sent') continue;
        subcontractReservations.set(job.rawProductId, (subcontractReservations.get(job.rawProductId) ?? 0) + job.sentWeightKg);
      }
      assertSufficientStock(
        new Map(products.map((product) => [product.id, Math.max(0, product.stock - (subcontractReservations.get(product.id) ?? 0))])),
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
    [invoices, products, subcontractJobs, adjustProductStock, createVoucher, user, showToast]
  );

  // ---------------- CORPORATE MODULES CRUD ----------------
  const addEmployee = useCallback(
    async (emp: Omit<Employee, 'id' | 'ownerId'>) => {
      const id = generateSafeId('emp');
      const full: Employee = { ...emp, id, ownerId };
      if (user) {
        try {
          await setDoc(doc(db, 'employees', id), {
            ownerId,
            personnelCode: emp.personnelCode.slice(0, 32),
            fullName: emp.fullName.trim().slice(0, 140),
            department: emp.department.slice(0, 80),
            baseSalary: Math.max(0, Number(emp.baseSalary) || 0),
            housingAllowance: Math.max(0, Number(emp.housingAllowance) || 0),
            foodAllowance: Math.max(0, Number(emp.foodAllowance) || 0),
            childrenCount: Math.min(20, Math.max(0, Number(emp.childrenCount) || 0)),
            overtimeHours: Math.max(0, Number(emp.overtimeHours) || 0),
            ...(emp.costCenterId ? { costCenterId: emp.costCenterId.slice(0, 128) } : {}),
            active: emp.active,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleSupabaseError(err, OperationType.CREATE, `employees/${id}`);
        }
      } else {
        setEmployees((prev) => [...prev, full]);
      }
      showToast(`پرسنل «${emp.fullName}» به لیست حقوق و دستمزد افزوده شد.`);
    },
    [ownerId, user, showToast]
  );

  const updateEmployee = useCallback(
    async (empId: string, patch: Partial<Omit<Employee, 'id' | 'ownerId' | 'personnelCode'>>) => {
      if (user) {
        try {
          const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };
          if (patch.fullName !== undefined) payload.fullName = patch.fullName.trim().slice(0, 140);
          if (patch.department !== undefined) payload.department = patch.department.slice(0, 80);
          if (patch.baseSalary !== undefined) payload.baseSalary = Math.max(0, Number(patch.baseSalary) || 0);
          if (patch.housingAllowance !== undefined) payload.housingAllowance = Math.max(0, Number(patch.housingAllowance) || 0);
          if (patch.foodAllowance !== undefined) payload.foodAllowance = Math.max(0, Number(patch.foodAllowance) || 0);
          if (patch.childrenCount !== undefined) payload.childrenCount = Math.min(20, Math.max(0, Number(patch.childrenCount) || 0));
          if (patch.overtimeHours !== undefined) payload.overtimeHours = Math.max(0, Number(patch.overtimeHours) || 0);
          if (patch.costCenterId !== undefined) payload.costCenterId = patch.costCenterId.slice(0, 128);
          if (patch.active !== undefined) payload.active = Boolean(patch.active);
          await updateDoc(doc(db, 'employees', empId), payload);
        } catch (err) {
          handleSupabaseError(err, OperationType.UPDATE, `employees/${empId}`);
        }
      } else {
        setEmployees((prev) => prev.map((e) => (e.id === empId ? { ...e, ...patch } : e)));
      }
      showToast('مشخصات و حکم کارگزینی پرسنل ویرایش شد.');
    },
    [user, showToast]
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
      const priorPayments = vouchers
        .filter((voucher) =>
          voucher.status === 'permanent' &&
          voucher.voucherType === 'payroll' &&
          voucher.description.startsWith(`پرداخت خالص حقوق کارکنان ${normalizedMonth} از `)
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
      if (!asset.title.trim() || !Number.isFinite(asset.purchaseCost) || asset.purchaseCost <= 0 || !Number.isFinite(asset.salvageValue) || asset.salvageValue < 0 || asset.salvageValue > asset.purchaseCost || !Number.isFinite(asset.usefulLifeYears) || asset.usefulLifeYears <= 0 || !Number.isFinite(asset.accumulatedDepreciation) || asset.accumulatedDepreciation < 0 || asset.accumulatedDepreciation > asset.purchaseCost - asset.salvageValue) throw new Error('مشخصات مالی دارایی ثابت معتبر نیست.');
      const id = generateSafeId('ast');
      const full: FixedAsset = { ...asset, id, ownerId };
      if (user) {
        try {
          await setDoc(doc(db, 'assets', id), {
            ownerId,
            assetCode: asset.assetCode.slice(0, 40),
            title: asset.title.trim().slice(0, 160),
            purchaseDate: asset.purchaseDate.slice(0, 20),
            purchaseCost: Math.max(1, Number(asset.purchaseCost) || 1),
            salvageValue: Math.max(0, Number(asset.salvageValue) || 0),
            usefulLifeYears: Math.min(100, Math.max(1, Number(asset.usefulLifeYears) || 5)),
            accumulatedDepreciation: Math.max(0, Number(asset.accumulatedDepreciation) || 0),
            ...(asset.costCenterId ? { costCenterId: asset.costCenterId.slice(0, 128) } : {}),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleSupabaseError(err, OperationType.CREATE, `assets/${id}`);
        }
      } else {
        setAssets((prev) => [...prev, full]);
      }
      showToast(`دارایی ثابت «${asset.title}» ثبت شد.`);
    },
    [ownerId, user, showToast]
  );

  const updateFixedAsset = useCallback(
    async (assetId: string, patch: Partial<Omit<FixedAsset, 'id' | 'ownerId' | 'assetCode'>>) => {
      const existing = assets.find((asset) => asset.id === assetId);
      if (!existing) return;
      const nextCost = patch.purchaseCost ?? existing.purchaseCost;
      const nextSalvage = patch.salvageValue ?? existing.salvageValue;
      const nextAccumulated = patch.accumulatedDepreciation ?? existing.accumulatedDepreciation;
      const nextLife = patch.usefulLifeYears ?? existing.usefulLifeYears;
      if (!Number.isFinite(nextCost) || nextCost <= 0 || !Number.isFinite(nextSalvage) || nextSalvage < 0 || nextSalvage > nextCost || !Number.isFinite(nextAccumulated) || nextAccumulated < 0 || nextAccumulated > nextCost - nextSalvage || !Number.isFinite(nextLife) || nextLife <= 0) throw new Error('ویرایش بهای خرید، ارزش اسقاط، عمر مفید یا استهلاک انباشته دارایی معتبر نیست.');
      if (user) {
        try {
          const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };
          if (patch.title !== undefined) payload.title = patch.title.trim().slice(0, 160);
          if (patch.purchaseDate !== undefined) payload.purchaseDate = patch.purchaseDate.slice(0, 20);
          if (patch.purchaseCost !== undefined) payload.purchaseCost = Math.max(1, Number(patch.purchaseCost) || 1);
          if (patch.salvageValue !== undefined) payload.salvageValue = Math.max(0, Number(patch.salvageValue) || 0);
          if (patch.usefulLifeYears !== undefined) payload.usefulLifeYears = Math.min(100, Math.max(1, Number(patch.usefulLifeYears) || 5));
          if (patch.accumulatedDepreciation !== undefined) payload.accumulatedDepreciation = Math.max(0, Number(patch.accumulatedDepreciation) || 0);
          if (patch.costCenterId !== undefined) payload.costCenterId = patch.costCenterId.slice(0, 128);
          await updateDoc(doc(db, 'assets', assetId), payload);
        } catch (err) {
          handleSupabaseError(err, OperationType.UPDATE, `assets/${assetId}`);
        }
      } else {
        setAssets((prev) => prev.map((a) => (a.id === assetId ? { ...a, ...patch } : a)));
      }
      showToast('مشخصات دارایی ثابت ویرایش شد.');
    },
    [assets, user, showToast]
  );

  const deleteFixedAsset = useCallback(
    async (assetId: string) => {
      if (user) {
        try {
          await deleteDoc(doc(db, 'assets', assetId));
        } catch (err) {
          handleSupabaseError(err, OperationType.DELETE, `assets/${assetId}`);
        }
      } else {
        setAssets((prev) => prev.filter((a) => a.id !== assetId));
      }
      showToast('دارایی ثابت حذف شد.');
    },
    [user, showToast]
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
        if (!Number.isFinite(asset.purchaseCost) || asset.purchaseCost <= 0 || !Number.isFinite(asset.salvageValue) || asset.salvageValue < 0 || asset.salvageValue > asset.purchaseCost || !Number.isFinite(asset.usefulLifeYears) || asset.usefulLifeYears <= 0 || !Number.isFinite(asset.accumulatedDepreciation) || asset.accumulatedDepreciation < 0) {
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
      const expenseByCostCenter = new Map<string, number>();
      for (const row of allocations) {
        const key = row.asset.costCenterId || 'cc_hq';
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
    [assets, vouchers, user, createVoucher, showToast]
  );

  const addCostCenter = useCallback(
    async (cc: Omit<CostCenter, 'id' | 'ownerId'>) => {
      const id = generateSafeId('cc');
      const full: CostCenter = { ...cc, id, ownerId };
      if (user) {
        try {
          await setDoc(doc(db, 'costCenters', id), {
            ownerId,
            code: cc.code.slice(0, 32),
            name: cc.name.trim().slice(0, 140),
            budget: Math.max(0, Number(cc.budget) || 0),
            ...(cc.manager ? { manager: cc.manager.slice(0, 120) } : {}),
            active: cc.active,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleSupabaseError(err, OperationType.CREATE, `costCenters/${id}`);
        }
      } else {
        setCostCenters((prev) => [...prev, full]);
      }
      showToast(`مرکز هزینه «${cc.name}» ایجاد شد.`);
    },
    [ownerId, user, showToast]
  );

  const updateCostCenter = useCallback(
    async (ccId: string, patch: Partial<Omit<CostCenter, 'id' | 'ownerId' | 'code'>>) => {
      if (user) {
        try {
          const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };
          if (patch.name !== undefined) payload.name = patch.name.trim().slice(0, 140);
          if (patch.budget !== undefined) payload.budget = Math.max(0, Number(patch.budget) || 0);
          if (patch.manager !== undefined) payload.manager = patch.manager.slice(0, 120);
          if (patch.active !== undefined) payload.active = Boolean(patch.active);
          await updateDoc(doc(db, 'costCenters', ccId), payload);
        } catch (err) {
          handleSupabaseError(err, OperationType.UPDATE, `costCenters/${ccId}`);
        }
      } else {
        setCostCenters((prev) => prev.map((c) => (c.id === ccId ? { ...c, ...patch } : c)));
      }
      showToast('اطلاعات مرکز هزینه ویرایش شد.');
    },
    [user, showToast]
  );

  const deleteCostCenter = useCallback(
    async (ccId: string) => {
      if (user) {
        try {
          await deleteDoc(doc(db, 'costCenters', ccId));
        } catch (err) {
          handleSupabaseError(err, OperationType.DELETE, `costCenters/${ccId}`);
        }
      } else {
        setCostCenters((prev) => prev.filter((c) => c.id !== ccId));
      }
      showToast('مرکز هزینه حذف شد.');
    },
    [user, showToast]
  );

  const runYearEndClosing = useCallback(async () => {
    const closingReference = `year-end-closing:${profile.fiscalYear}`;
    if (vouchers.some((voucher) => voucher.referenceId === closingReference || (voucher.voucherType === 'closing' && voucher.date.startsWith(`${profile.fiscalYear}/`)))) throw new Error(`دوره مالی ${profile.fiscalYear} قبلاً بسته شده است.`);
    const draftCount = vouchers.filter((voucher) => voucher.status === 'draft' && voucher.date.startsWith(`${profile.fiscalYear}/`)).length;
    if (draftCount > 0) throw new Error(`برای بستن سال مالی ابتدا ${draftCount} سند پیش‌نویس را تعیین تکلیف کنید.`);
    const fiscalYearVouchers = vouchers.filter((voucher) =>
      voucher.status === 'permanent' &&
      voucher.date.startsWith(`${profile.fiscalYear}/`) &&
      voucher.voucherType !== 'opening'
    );
    const fiscalYearTrialBalance = computeTrialBalance(accounts, fiscalYearVouchers);
    const tempRows = fiscalYearTrialBalance.filter(
      (r) =>
        (r.category === 'revenue' || r.category === 'cogs' || r.category === 'expense') &&
        (r.balanceDebit > 0 || r.balanceCredit > 0)
    );
    if (tempRows.length === 0) {
      showToast('تمامی حساب‌های موقت قبلاً بسته شده‌اند.');
      return;
    }

    const lines: VoucherLine[] = [];
    let netCreditToSummary = 0;

    for (const r of tempRows) {
      if (r.balanceCredit > 0) {
        lines.push({
          accountCode: r.accountCode,
          accountTitle: r.accountTitle,
          description: 'بستن حساب موقت درآمدی به خلاصه سود و زیان',
          debit: r.balanceCredit,
          credit: 0,
        });
        netCreditToSummary += r.balanceCredit;
      } else if (r.balanceDebit > 0) {
        lines.push({
          accountCode: r.accountCode,
          accountTitle: r.accountTitle,
          description: 'بستن حساب موقت هزینه‌ای/بهای تمام‌شده',
          debit: 0,
          credit: r.balanceDebit,
        });
        netCreditToSummary -= r.balanceDebit;
      }
    }

    if (netCreditToSummary >= 0) {
      lines.push({
        accountCode: '50201',
        accountTitle: 'سود و زیان انباشته سنواتی',
        description: 'انتقال سود خالص دوره به سود و زیان انباشته',
        debit: 0,
        credit: netCreditToSummary,
      });
    } else {
      lines.push({
        accountCode: '50201',
        accountTitle: 'سود و زیان انباشته سنواتی',
        description: 'انتقال زیان خالص دوره به سود و زیان انباشته',
        debit: Math.abs(netCreditToSummary),
        credit: 0,
      });
    }

    await createVoucher({
      date: getShamsiYearEndDate(profile.fiscalYear),
      description: `سند بستن حساب‌های موقت و انتقال سود سال مالی ${profile.fiscalYear}`,
      voucherType: 'closing',
      status: 'permanent',
      referenceId: closingReference,
      lines,
    });
  }, [accounts, vouchers, profile.fiscalYear, createVoucher, showToast]);

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
    },
    [ownerId, activeOperator]
  );

  // ---------------- IMPORT DOSSIERS & LANDED COST ----------------
  const addImportDossier = useCallback(
    async (dossier: Omit<ImportDossier, 'id' | 'ownerId'>) => {
      if (!dossier.dossierNumber.trim() || !dossier.proformaNumber.trim() || !dossier.supplierId ||
          !parties.some((party) => party.id === dossier.supplierId) || !dossier.originCountry.trim() ||
          !dossier.warehouse.trim() || !/^14\d{2}\/\d{2}\/\d{2}$/.test(dossier.date) ||
          !dossier.currencyCode.trim() || !Number.isFinite(dossier.exchangeRate) || dossier.exchangeRate <= 0) {
        throw new Error('اطلاعات اصلی پرونده واردات ناقص یا نامعتبر است.');
      }
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
          !accounts.some((account) => account.code === cost.accountCode && (account.category === 'asset' || account.category === 'liability')))) {
        throw new Error('حساب تسویه هزینه‌های جانبی باید حساب دارایی (بانک/صندوق) یا بدهی (بستانکاران) باشد و مبلغ آن معتبر باشد.');
      }
      const costsTotal = dossier.costs.reduce((sum, cost) => sum + Math.round(cost.amountIrr), 0);
      if (!Number.isFinite(dossier.totalForeignAmount) || dossier.totalForeignAmount <= 0 ||
          !Number.isFinite(dossier.totalFobIrr) || dossier.totalFobIrr <= 0 ||
          !Number.isFinite(dossier.totalLandedCostsIrr) || dossier.totalLandedCostsIrr !== costsTotal ||
          !Number.isFinite(dossier.grandTotalLandedIrr) ||
          dossier.grandTotalLandedIrr !== dossier.totalFobIrr + dossier.totalLandedCostsIrr) {
        throw new Error('جمع بهای تمام‌شده پرونده با ارزش ارزی و هزینه‌های جانبی سازگار نیست.');
      }
      const full: ImportDossier = {
        ...dossier,
        id: generateSafeId('imp'),
        ownerId,
      };
      setImportDossiers((prev) => [full, ...prev]);
      logActivity(
        'واردات و ترخیص',
        `ایجاد پرونده واردات ${full.dossierNumber}`,
        `پروفرما ${full.proformaNumber} · جمع بهای تمام‌شده ${full.grandTotalLandedIrr.toLocaleString('en-US')} ریال`
      );
      showToast(`پرونده واردات ${full.dossierNumber} ثبت شد.`);
    },
    [ownerId, parties, products, accounts, importDossiers, logActivity, showToast]
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
      const costTotal = dossier.costs.reduce((sum, cost) => {
        if (!Number.isFinite(cost.amountIrr) || cost.amountIrr < 0 || !cost.accountCode.trim() || !accounts.some((account) => account.code === cost.accountCode && (account.category === 'asset' || account.category === 'liability'))) throw new Error('حساب تسویه هزینه جانبی باید دارایی یا بدهی باشد و مبلغ آن معتبر باشد.');
        return sum + Math.round(cost.amountIrr);
      }, 0);
      const fobTotal = Math.round(dossier.totalFobIrr);
      const landedTotal = Math.round(dossier.grandTotalLandedIrr);
      const expectedLanded = fobTotal + costTotal;
      if (!Number.isFinite(dossier.totalFobIrr) || !Number.isFinite(dossier.grandTotalLandedIrr) || Math.abs(expectedLanded - landedTotal) > 0) {
        throw new Error('جمع بهای تمام‌شده پرونده با بهای ارزی و هزینه‌های جانبی هم‌خوانی ندارد.');
      }
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
    [activeOperator, importDossiers, vouchers, products, accounts, updateProduct, createVoucher, logActivity, showToast]
  );

  // ---------------- SALES ORDERS & WEIGHBRIDGE DISPATCH ----------------
  const addSalesOrder = useCallback(
    async (order: Omit<SalesOrder, 'id' | 'ownerId'>) => {
      const full: SalesOrder = {
        ...order,
        id: generateSafeId('so'),
        ownerId,
      };
      setSalesOrders((prev) => [full, ...prev]);
      logActivity(
        'سفارش و حواله خروج',
        `ثبت سفارش مشتری ${full.orderNumber}`,
        `مشتری: ${full.partyName} · ${full.items.length} ردیف نخ`
      );
      showToast(`سفارش فروش ${full.orderNumber} ثبت شد.`);
    },
    [ownerId, logActivity, showToast]
  );

  const dispatchSalesOrder = useCallback(
    async (orderId: string, payload: { dispatchDate: string; driverName: string; plateNumber: string; items: SalesOrder['items'] }) => {
      const order = salesOrders.find((item) => item.id === orderId);
      if (!order || order.status === 'invoiced') return;
      if (order.status === 'dispatched') throw new Error('این سفارش قبلاً حواله خروج دریافت کرده است.');
      if (!payload.dispatchDate.trim() || !payload.driverName.trim() || !payload.plateNumber.trim()) throw new Error('تاریخ حواله، نام راننده و شماره پلاک الزامی است.');
      if (!payload.items.length) throw new Error('برای صدور حواله، حداقل یک ردیف کالا لازم است.');
      const requestedLines = payload.items.map((item) => {
        const orderLine = order.items.find((candidate) => candidate.productId === item.productId);
        if (!orderLine) throw new Error(`کالای ${item.productName} در سفارش اصلی وجود ندارد.`);
        const quantity = item.actualWeighedKg > 0 ? item.actualWeighedKg : item.orderedWeightKg;
        if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`وزن حواله کالای ${item.productName} معتبر نیست.`);
        return { productId: item.productId, quantity };
      });
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
      const dispatchNumber = order.dispatchNumber || `DSP-${profile.fiscalYear}-${String(salesOrders.filter((item) => item.dispatchNumber).length + 1).padStart(4, '0')}`;
      setSalesOrders((prev) => prev.map((item) => item.id === orderId ? { ...item, dispatchNumber, dispatchDate: payload.dispatchDate, driverName: payload.driverName.trim(), plateNumber: payload.plateNumber.trim(), items: payload.items, status: 'dispatched' } : item));
      logActivity('انبار و باسکول', `صدور حواله خروج ${dispatchNumber}`, `توزین نهایی سفارش ${order.orderNumber} (${order.partyName})`);
      showToast(`حواله خروج باسکول ${dispatchNumber} ثبت شد.`);
    },
    [salesOrders, products, subcontractJobs, profile.fiscalYear, logActivity, showToast]
  );

  const invoiceSalesOrder = useCallback(
    async (orderId: string) => {
      if (!activeOperator.permissions.canIssueInvoice) {
        showToast('نقش فعال مجوز صدور فاکتور فروش را ندارد.');
        return;
      }
      const order = salesOrders.find((o) => o.id === orderId);
      if (!order || order.status === 'invoiced') return;
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
    [activeOperator, salesOrders, products, profile.fiscalYear, invoices.length, createInvoice, logActivity, showToast]
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
      const reservedByOtherJobs = subcontractJobs
        .filter((item) => item.status === 'sent' && item.rawProductId === job.rawProductId)
        .reduce((sum, item) => sum + item.sentWeightKg, 0);
      const availableForSubcontract = rawProduct.stock - reservedByOtherJobs;
      if (!Number.isFinite(rawProduct.stock) || availableForSubcontract + 1e-9 < job.sentWeightKg) {
        throw new Error('موجودی قابل تخصیص پس از کسر حواله‌های باز پیمانکاری کافی نیست.');
      }
      const full: SubcontractJob = {
        ...job,
        id: generateSafeId('sub'),
        ownerId,
      };
      setSubcontractJobs((prev) => [full, ...prev]);
      logActivity(
        'پیمانکاری رنگرزی/بافندگی',
        `ارسال نخ خام (${full.jobNumber})`,
        `${full.sentWeightKg} کیلوگرم ${full.rawProductName} به ${full.contractorName}`
      );
      showToast(`حواله پیمانکاری ${full.jobNumber} ثبت شد.`);
    },
    [ownerId, products, parties, subcontractJobs, logActivity, showToast]
  );

  const completeSubcontractJob = useCallback(
    async (jobId: string, payload: { returnedWeightKg: number; completionDate: string; finishedLotNumber: string }) => {
      const job = subcontractJobs.find((item) => item.id === jobId);
      if (!job || job.status === 'completed') return;
      if (vouchers.some((voucher) => voucher.referenceId === job.id)) throw new Error('برای این عملیات پیمانکاری قبلاً سند ثبت شده است.');
      const rawProduct = products.find((product) => product.id === job.rawProductId);
      if (!rawProduct) throw new Error(`کالای خام ${job.rawProductName} در انبار یافت نشد.`);
      const reservedByOtherJobs = subcontractJobs
        .filter((item) => item.id !== jobId && item.status === 'sent' && item.rawProductId === job.rawProductId)
        .reduce((sum, item) => sum + item.sentWeightKg, 0);
      if (!Number.isFinite(job.sentWeightKg) || job.sentWeightKg <= 0 || !Number.isFinite(rawProduct.stock) ||
          rawProduct.stock - job.sentWeightKg + 1e-9 < reservedByOtherJobs) {
        throw new Error('موجودی نخ خام برای تکمیل این حواله، پس از حفظ موجودی رزروشده سایر پیمانکاری‌ها کافی نیست.');
      }
      if (!Number.isFinite(payload.returnedWeightKg) || payload.returnedWeightKg <= 0 || payload.returnedWeightKg > job.sentWeightKg + 1e-9 || !/^14\d{2}\/\d{2}\/\d{2}$/.test(payload.completionDate) || !payload.finishedLotNumber.trim()) {
        throw new Error('وزن برگشتی باید مثبت و حداکثر برابر وزن نخ ارسالی باشد؛ تاریخ و شماره لات نیز باید معتبر باشند.');
      }
      if (!Number.isFinite(job.rawUnitCostIrr) || job.rawUnitCostIrr < 0 || !Number.isFinite(job.serviceFeePerKgIrr) || job.serviceFeePerKgIrr < 0) throw new Error('بهای مواد اولیه یا اجرت پیمانکاری نامعتبر است.');
      const rawTotalCost = Math.round(job.sentWeightKg * job.rawUnitCostIrr);
      const serviceFeeTotal = Math.round(payload.returnedWeightKg * job.serviceFeePerKgIrr);
      const finishedTotalCost = rawTotalCost + serviceFeeTotal;
      const finishedUnitCost = Math.round(finishedTotalCost / payload.returnedWeightKg);
      const lines: VoucherLine[] = [
        { accountCode: '10501', accountTitle: 'موجودی انبار نخ و کالای وارداتی', description: `ورود ${payload.returnedWeightKg} کیلوگرم محصول تکمیل‌شده ${job.jobNumber}`, debit: finishedTotalCost, credit: 0 },
        { accountCode: '10501', accountTitle: 'موجودی انبار نخ و کالای وارداتی', description: `مصرف ${job.sentWeightKg} کیلوگرم نخ خام (${job.rawProductName})`, debit: 0, credit: rawTotalCost },
        { accountCode: '30101', accountTitle: 'بستانکاران و تأمین‌کنندگان واردات نخ', partyId: job.contractorPartyId, partyName: job.contractorName, description: `اجرت پیمانکاری رنگرزی/تبدیل ${job.jobNumber}`, debit: 0, credit: serviceFeeTotal },
      ];
      const voucher = await createVoucher({ date: payload.completionDate, description: `تکمیل عملیات پیمانکاری ${job.jobNumber} (${job.finishedProductName} — لات ${payload.finishedLotNumber})`, voucherType: 'general', status: 'permanent', lines, referenceId: job.id });
      let rawStockUpdated = false;
      try {
        const nextRawStock = Number((rawProduct.stock - job.sentWeightKg).toFixed(2));
        await updateProduct(rawProduct.id, { stock: nextRawStock });
        rawStockUpdated = true;
        await addProduct({ sku: `FIN-${job.jobNumber}`, name: job.finishedProductName, category: job.processType === 'dyeing' ? 'نخ رنگ‌شده (پیمانکاری)' : 'محصول تبدیل‌شده پیمانکاری',
          warehouse: rawProduct.warehouse || 'انبار مرکزی شادآباد', unit: 'کیلوگرم', secondaryUnit: rawProduct.secondaryUnit || 'کارتن',
          kgPerCarton: rawProduct.kgPerCarton || 25, lotNumber: payload.finishedLotNumber, originCountry: 'تکمیل داخلی',
          buyPrice: finishedUnitCost, sellPrice: Math.round(finishedUnitCost * 1.18), stock: payload.returnedWeightKg, reorderPoint: 100, vatExempt: false });
      } catch (error) {
        const compensationFailures: string[] = [];
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
    [subcontractJobs, vouchers, products, updateProduct, addProduct, createVoucher, logActivity, showToast]
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
      const full: RbacOperator = { ...op, id: generateSafeId('op'), ownerId };
      setRbacOperators((prev) => [...prev, full]);
      logActivity('مدیریت کاربران', `تعریف کاربر ${full.fullName}`, `نقش: ${full.role}`);
      showToast(`کاربر «${full.fullName}» به لیست اپراتورها اضافه شد.`);
    },
    [ownerId, logActivity, showToast]
  );

  const updateRbacOperator = useCallback(
    async (
      opId: string,
      patch: Partial<Pick<RbacOperator, 'fullName' | 'role' | 'email' | 'active' | 'permissions'>>
    ) => {
      setRbacOperators((prev) => prev.map((o) => (o.id === opId ? { ...o, ...patch } : o)));
      logActivity('مدیریت کاربران', 'ویرایش سطح دسترسی کاربر', `شناسه اپراتور: ${opId}`);
      showToast('سطح دسترسی کاربر به‌روزرسانی شد.');
    },
    [logActivity, showToast]
  );

  const deleteRbacOperator = useCallback(
    async (opId: string) => {
      if (rbacOperators.length <= 1) {
        showToast('حداقل یک کاربر مدیر در سیستم باید باقی بماند.');
        return;
      }
      setRbacOperators((prev) => prev.filter((o) => o.id !== opId));
      if (activeOperatorId === opId) {
        const next = rbacOperators.find((o) => o.id !== opId);
        if (next) setActiveOperatorId(next.id);
      }
      logActivity('مدیریت کاربران', 'حذف اپراتور', `شناسه اپراتور: ${opId}`);
      showToast('اپراتور حذف شد.');
    },
    [rbacOperators, activeOperatorId, logActivity, showToast]
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
