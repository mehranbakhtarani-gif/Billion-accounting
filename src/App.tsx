import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  Bell,
  BookOpen,
  Briefcase,
  Calculator,
  ChevronDown,
  ChevronLeft,
  FileText,
  FolderTree,
  Keyboard,
  Landmark,
  LayoutDashboard,
  Menu,
  Moon,
  Package,
  Search,
  Settings,
  ShieldCheck,
  Ship,
  Sun,
  X,
} from 'lucide-react';
import { ActiveModule } from './types/accounting';
import { useAccounting } from './context/AccountingContext';
import { DashboardView } from './components/DashboardView';
import { InvoicesView } from './components/InvoicesView';
import { VouchersView } from './components/VouchersView';
import { AuditView } from './components/AuditView';
import { AccountsView } from './components/AccountsView';
import { PartiesView } from './components/PartiesView';
import { InventoryView } from './components/InventoryView';
import { TreasuryView } from './components/TreasuryView';
import { CorporateView } from './components/CorporateView';
import { ReportsView } from './components/ReportsView';
import { BrandStudioView } from './components/BrandStudioView';
import { SettingsView } from './components/SettingsView';
import { CurrenciesView } from './components/CurrenciesView';
import { ImportAndSubcontractView } from './components/ImportAndSubcontractView';
import { OfflineIndicator, PWAInstallButton } from './components/PWAInstallButton';
import {
  CommandPaletteModal,
  QuickCalculatorModal,
  ShortcutHelpModal,
} from './components/ShortcutHelpModal';
import { formatCompactMoney, toPersianDigits } from './lib/format';
import { computeChequeAlerts, useChequeAlertPreferences } from './lib/chequeAlerts';
import { RBAC_ROLE_LABELS } from './lib/enterpriseAccounting';

interface SubMenuItem {
  key: string;
  label: string;
  module: ActiveModule;
  intent?: string;
  shortcut?: string;
}

interface MenuGroup {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  shortcut?: string;
  directModule?: ActiveModule;
  items?: SubMenuItem[];
}

const BILLION_MENU_TREE: MenuGroup[] = [
  {
    id: 'dashboard',
    label: 'داشبورد مدیریت مالی',
    icon: LayoutDashboard,
    shortcut: 'F10',
    directModule: 'dashboard',
  },
  {
    id: 'base',
    label: 'اطلاعات اول دوره و پایه',
    icon: FolderTree,
    items: [
      { key: 'accounts-all', label: 'کدینگ حساب‌ها (کل و معین)', module: 'accounts' },
      { key: 'accounts-banks', label: 'معرفی صندوق، تنخواه و بانک‌ها', module: 'accounts', intent: 'banks-cash' },
      { key: 'parties', label: 'طرف‌حساب‌ها و اشخاص', module: 'parties', shortcut: 'F5' },
      { key: 'inventory-base', label: 'معرفی کالاها و انبارها', module: 'inventory', shortcut: 'F6' },
      { key: 'currencies-def', label: 'تعریف ارزها و نرخ برابری روزانه', module: 'currencies', intent: 'rates' },
      { key: 'opening-voucher', label: 'ثبت سند افتتاحیه اول دوره', module: 'vouchers', intent: 'new-opening' },
    ],
  },
  {
    id: 'accounting',
    label: 'عملیات حسابداری و حسابرسی',
    icon: BookOpen,
    items: [
      { key: 'voucher-new', label: 'صدور سند حسابداری جدید', module: 'vouchers', intent: 'new-voucher', shortcut: 'F3' },
      { key: 'voucher-list', label: 'مدیریت، اصلاح و دفتر روزنامه', module: 'vouchers' },
      { key: 'voucher-drafts', label: 'اسناد موقت (نیاز به قطعی‌سازی)', module: 'vouchers', intent: 'drafts' },
      { key: 'audit-center', label: 'مرکز حسابرسی و کنترل اسناد', module: 'audit' },
      { key: 'year-closing', label: 'عملیات بستن حساب پایان سال', module: 'corporate', intent: 'closing' },
    ],
  },
  {
    id: 'invoices',
    label: 'خرید، فروش و فاکتور',
    icon: FileText,
    items: [
      { key: 'inv-sale', label: 'فاکتور فروش رسمی و مودیان', module: 'invoices', intent: 'new-sale', shortcut: 'F2' },
      { key: 'inv-purchase', label: 'فاکتور خرید کالا', module: 'invoices', intent: 'new-purchase', shortcut: 'F4' },
      { key: 'inv-proforma', label: 'صدور و تبدیل پیش‌فاکتور', module: 'invoices', intent: 'new-proforma' },
      { key: 'inv-sale-ret', label: 'فاکتور برگشت از فروش', module: 'invoices', intent: 'new-sale-return' },
      { key: 'inv-pur-ret', label: 'فاکتور برگشت از خرید', module: 'invoices', intent: 'new-purchase-return' },
      { key: 'inv-waste', label: 'ثبت فاکتور ضایعات انبار', module: 'invoices', intent: 'new-waste' },
      { key: 'inv-list', label: 'آرشیو و مدیریت فاکتورها', module: 'invoices' },
      { key: 'inv-designer', label: 'طراحی و سفارشی‌سازی قالب فاکتور', module: 'settings', intent: 'invoice-designer' },
    ],
  },
  {
    id: 'commercial',
    label: 'بازرگانی واردات، باسکول و رنگرزی',
    icon: Ship,
    items: [
      { key: 'comm-imports', label: 'پرونده واردات نخ و قیمت تمام‌شده', module: 'commercial', intent: 'imports' },
      { key: 'comm-orders', label: 'سفارش فروش، حواله باسکول و بارکد', module: 'commercial', intent: 'orders' },
      { key: 'comm-subcontract', label: 'پیمانکاری رنگرزی و بافندگی (کارمزدی)', module: 'commercial', intent: 'subcontract' },
    ],
  },
  {
    id: 'warehouse',
    label: 'انبارداری و کالا',
    icon: Package,
    items: [
      { key: 'inv-products', label: 'فهرست کالاها و موجودی انبار', module: 'inventory' },
      { key: 'inv-kardex', label: 'کاردکس ریالی (میانگین موزون)', module: 'inventory', intent: 'kardex' },
      { key: 'inv-stocktaking', label: 'انبارگردانی گروهی و تعدیل', module: 'inventory', intent: 'stocktaking' },
      { key: 'inv-bulk-price', label: 'تغییر گروهی قیمت کالاها', module: 'inventory', intent: 'bulk-price' },
      { key: 'inv-transfer', label: 'حواله انتقال بین انبارها', module: 'inventory', intent: 'transfer' },
    ],
  },
  {
    id: 'treasury',
    label: 'خزانه‌داری، چک و امور ارزی',
    icon: Landmark,
    items: [
      { key: 'tr-cheques', label: 'مدیریت چک صیادی و گردش چک', module: 'treasury', intent: 'cheques', shortcut: 'F7' },
      { key: 'tr-cheque-print', label: 'چاپ کالیبره برگه چک صیادی (میلی‌متر)', module: 'treasury', intent: 'cheque-print' },
      { key: 'tr-reconciliation', label: 'مغایرت‌گیری خودکار بانکی (CSV)', module: 'treasury', intent: 'reconciliation' },
      { key: 'tr-quick', label: 'دریافت و پرداخت سریع', module: 'treasury', intent: 'quick' },
      { key: 'tr-transfer', label: 'انتقال وجه بین صندوق و بانک', module: 'treasury', intent: 'transfer' },
      { key: 'tr-rasgiri', label: 'ماشین‌حساب راس‌گیری چک', module: 'treasury', intent: 'rasgiri' },
      { key: 'tr-fx-rates', label: 'تابلوی نرخ روز ارز و مبدل ارزی', module: 'currencies', intent: 'converter' },
      { key: 'tr-fx-reval', label: 'تسعیر ارز پایان دوره و معین دو ستونه', module: 'currencies', intent: 'revaluation' },
    ],
  },
  {
    id: 'corporate',
    label: 'امور شرکتی (F8)',
    icon: Briefcase,
    items: [
      { key: 'corp-payroll', label: 'حقوق و دستمزد و فیش حقوقی', module: 'corporate', intent: 'payroll' },
      { key: 'corp-assets', label: 'اموال، دارایی ثابت و استهلاک', module: 'corporate', intent: 'assets' },
      { key: 'corp-cc', label: 'مراکز هزینه و سود پروژه‌ها', module: 'corporate', intent: 'costcenters' },
    ],
  },
  {
    id: 'reports',
    label: 'گزارش‌ها و دفاتر قانونی (F9)',
    icon: BarChart3,
    items: [
      { key: 'rep-trial', label: 'تراز آزمایشی ۲/۴/۶/۸ ستونی', module: 'reports', intent: 'trial' },
      { key: 'rep-moroor', label: 'مرور حساب‌ها (دریل‌داون)', module: 'reports', intent: 'moroor' },
      { key: 'rep-pnl', label: 'صورت سود و زیان جامع', module: 'reports', intent: 'pnl' },
      { key: 'rep-balance', label: 'ترازنامه استاندارد', module: 'reports', intent: 'balance' },
      { key: 'rep-ledger', label: 'دفتر کل و معین (دریل‌داون سند)', module: 'reports', intent: 'ledger' },
      { key: 'rep-party', label: 'صورتحساب تفصیلی طرف‌حساب', module: 'reports', intent: 'party-ledger' },
      { key: 'rep-aging', label: 'گزارش سنی مطالبات (۰ تا +۹۰ روز)', module: 'reports', intent: 'aging' },
      { key: 'rep-commissions', label: 'پورسانت واسطه‌ها و بازاریابان', module: 'reports', intent: 'commissions' },
      { key: 'rep-vat', label: 'گزارش ارزش افزوده مودیان', module: 'reports', intent: 'vat' },
      { key: 'rep-169', label: 'گزارش معاملات فصلی (ماده ۱۶۹)', module: 'reports', intent: 'seasonal-169' },
      { key: 'rep-statutory', label: 'خروجی بیمه DSK / مالیات TTMS / مودیان', module: 'reports', intent: 'statutory' },
      { key: 'rep-prod-profit', label: 'سود ناخالص کالا و فاکتور', module: 'reports', intent: 'product-profit' },
    ],
  },
  {
    id: 'tools',
    label: 'ابزارها، کاربران و تنظیمات',
    icon: Settings,
    items: [
      { key: 'tool-rbac', label: 'کاربران و سطوح دسترسی (RBAC)', module: 'settings', intent: 'rbac' },
      { key: 'tool-audit-log', label: 'گزارش ممیزی و تاریخچه عملیات', module: 'settings', intent: 'audit-log' },
      { key: 'tool-studio', label: 'استودیو اسناد و کاتالوگ', module: 'studio' },
      { key: 'tool-settings', label: 'پشتیبان‌گیری، تنظیمات و PWA', module: 'settings' },
    ],
  },
];

const ALL_MODULES: ActiveModule[] = [
  'dashboard',
  'invoices',
  'vouchers',
  'audit',
  'accounts',
  'parties',
  'inventory',
  'treasury',
  'currencies',
  'commercial',
  'corporate',
  'reports',
  'studio',
  'settings',
];

function findGroupIdForModule(mod: ActiveModule, intent?: string): string {
  for (const g of BILLION_MENU_TREE) {
    if (g.directModule === mod) return g.id;
    if (g.items?.some((it) => it.module === mod && (!intent || it.intent === intent))) {
      return g.id;
    }
  }
  for (const g of BILLION_MENU_TREE) {
    if (g.items?.some((it) => it.module === mod)) return g.id;
  }
  return 'dashboard';
}

function getBreadcrumbLabel(mod: ActiveModule, subKey: string | null): string {
  if (mod === 'dashboard') return 'داشبورد مدیریت مالی';
  for (const g of BILLION_MENU_TREE) {
    if (g.items) {
      const exact = subKey ? g.items.find((it) => it.key === subKey) : undefined;
      if (exact) return `${g.label} / ${exact.label}`;
    }
  }
  for (const g of BILLION_MENU_TREE) {
    const match = g.items?.find((it) => it.module === mod);
    if (match) return `${g.label} / ${match.label}`;
  }
  return 'بیلیون';
}

export default function App() {
  const {
    profile,
    accounts,
    parties,
    cheques,
    trialBalance,
    auditReport,
    activeOperator,
    isCloudMode,
    isSyncing,
    toast,
    bootstrapCloud,
    joinCloud,
    createDeviceInvite,
    showToast,
    setCurrencyUnit,
  } = useAccounting();

  const { prefs: chequeAlertPrefs } = useChequeAlertPreferences();

  const inviteAnotherDevice = useCallback(async () => {
    try {
      const token = await createDeviceInvite();
      window.prompt('کد دعوت یک‌بارمصرف (اعتبار ۲۴ ساعت):', token);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'ساخت کد دعوت ناموفق بود.');
    }
  }, [createDeviceInvite, showToast]);



  const connectToCloud = useCallback(async () => {
    const isFirstDevice = window.confirm('آیا این دستگاه، اولین دستگاه و مدیر اصلی شرکت است؟\n\nتأیید: راه‌اندازی شرکت با کلید اولیه\nلغو: پیوستن به شرکت با کد دعوت');
    const token = window.prompt(isFirstDevice ? 'کلید راه‌اندازی اولیه را وارد کنید:' : 'کد دعوت یک‌بارمصرف شرکت را وارد کنید:');
    if (!token?.trim()) return;
    try {
      if (isFirstDevice) await bootstrapCloud(token.trim());
      else await joinCloud(token.trim());
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'اتصال به Supabase ناموفق بود.');
    }
  }, [bootstrapCloud, joinCloud, showToast]);



  const chequeAlertSummary = useMemo(
    () =>
      computeChequeAlerts({
        cheques,
        accounts,
        trialBalance,
        parties,
        leadDays: chequeAlertPrefs.leadDays,
        snoozedMap: chequeAlertPrefs.snoozedMap,
      }),
    [cheques, accounts, trialBalance, parties, chequeAlertPrefs.leadDays, chequeAlertPrefs.snoozedMap]
  );

  const [activeModule, setActiveModule] = useState<ActiveModule>('dashboard');
  const [moduleIntent, setModuleIntent] = useState<string | undefined>(undefined);
  const [activeSubKey, setActiveSubKey] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    base: true,
    accounting: true,
    invoices: true,
    commercial: true,
    warehouse: false,
    treasury: false,
    corporate: false,
    reports: false,
    tools: false,
  });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showCalculator, setShowCalculator] = useState(false);
  const [showChequePopover, setShowChequePopover] = useState(false);
  const [avatarError, setAvatarError] = useState(false);

  // Sync Tailwind v4 dark class on <html>
  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [darkMode]);

  const navigate = useCallback((mod: ActiveModule, intent?: string, subKey?: string) => {
    setActiveModule(mod);
    setModuleIntent(intent);
    setActiveSubKey(subKey ?? null);
    const gid = findGroupIdForModule(mod, intent);
    if (gid !== 'dashboard') {
      setOpenGroups((prev) => ({ ...prev, [gid]: true }));
    }
    setMobileMenuOpen(false);
  }, []);

  // Read PWA deep-link shortcut URL params on initial load
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const view = params.get('view') as ActiveModule | null;
    const action = params.get('action') || undefined;
    if (view && ALL_MODULES.includes(view)) {
      navigate(view, action);
    }
  }, [navigate]);

  // Global Billion Keyboard Shortcuts (F1 - F10, Ctrl+K, Alt+C, Esc)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowShortcuts(false);
        setShowCommandPalette(false);
        setShowChequePopover(false);
        setMobileMenuOpen(false);
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowCommandPalette((prev) => !prev);
        return;
      }

      if (e.altKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        setShowCalculator((prev) => !prev);
        return;
      }

      switch (e.key) {
        case 'F1':
          e.preventDefault();
          setShowShortcuts((prev) => !prev);
          break;
        case 'F2':
          e.preventDefault();
          navigate('invoices', 'new-sale', 'inv-sale');
          break;
        case 'F3':
          e.preventDefault();
          navigate('vouchers', 'new-voucher', 'voucher-new');
          break;
        case 'F4':
          e.preventDefault();
          navigate('invoices', 'new-purchase', 'inv-purchase');
          break;
        case 'F5':
          e.preventDefault();
          navigate('parties', undefined, 'parties');
          break;
        case 'F6':
          e.preventDefault();
          navigate('inventory', undefined, 'inventory-base');
          break;
        case 'F7':
          e.preventDefault();
          navigate('treasury', 'cheques', 'tr-cheques');
          break;
        case 'F8':
          e.preventDefault();
          navigate('corporate', 'payroll', 'corp-payroll');
          break;
        case 'F9':
          e.preventDefault();
          navigate('reports', 'trial', 'rep-trial');
          break;
        case 'F10':
          e.preventDefault();
          navigate('dashboard');
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate]);

  const toggleGroup = (id: string) => {
    setOpenGroups((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const renderMenuTree = () => (
    <div className="space-y-1">
      {BILLION_MENU_TREE.map((group) => {
        const Icon = group.icon;
        if (group.directModule) {
          const isActive = activeModule === group.directModule;
          return (
            <button
              key={group.id}
              onClick={() => navigate(group.directModule!)}
              className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                isActive
                  ? 'bg-teal-50 dark:bg-teal-950/50 text-teal-900 dark:text-teal-200 font-semibold'
                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100/80 dark:hover:bg-slate-800/60'
              }`}
            >
              <span className="flex items-center gap-2.5 min-w-0">
                <Icon
                  className={`w-4 h-4 shrink-0 ${
                    isActive
                      ? 'text-teal-700 dark:text-teal-400'
                      : 'text-slate-400 dark:text-slate-500'
                  }`}
                />
                <span className="truncate">{group.label}</span>
              </span>
              {group.shortcut && (
                <span className="font-code text-[10px] text-slate-400 shrink-0">
                  {group.shortcut}
                </span>
              )}
            </button>
          );
        }

        const isOpen = !!openGroups[group.id];
        const groupHasActive = group.items?.some((it) =>
          activeSubKey ? it.key === activeSubKey : it.module === activeModule
        );

        return (
          <div key={group.id} className="space-y-0.5">
            <button
              type="button"
              onClick={() => toggleGroup(group.id)}
              className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${
                groupHasActive
                  ? 'text-teal-900 dark:text-teal-200 bg-slate-100/70 dark:bg-slate-800/50'
                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100/70 dark:hover:bg-slate-800/50'
              }`}
            >
              <span className="flex items-center gap-2.5 min-w-0">
                <Icon
                  className={`w-4 h-4 shrink-0 ${
                    groupHasActive
                      ? 'text-teal-700 dark:text-teal-400'
                      : 'text-slate-400 dark:text-slate-500'
                  }`}
                />
                <span className="truncate">{group.label}</span>
              </span>
              {isOpen ? (
                <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              ) : (
                <ChevronLeft className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              )}
            </button>

            {isOpen && group.items && (
              <div className="pr-5 pl-1 space-y-0.5 border-r border-slate-200 dark:border-slate-800 mr-4">
                {group.items.map((sub) => {
                  const isSubActive = activeSubKey
                    ? activeSubKey === sub.key
                    : activeModule === sub.module && !sub.intent;
                  const showAuditAlert =
                    sub.module === 'audit' &&
                    (auditReport.errorCount > 0 || auditReport.warningCount > 0);
                  const showChequeAlert =
                    sub.key === 'tr-cheques' && chequeAlertSummary.urgentAlerts.length > 0;
                  return (
                    <button
                      key={sub.key}
                      onClick={() => navigate(sub.module, sub.intent, sub.key)}
                      className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md text-[11.5px] transition-colors text-right ${
                        isSubActive
                          ? 'bg-teal-50 dark:bg-teal-950/60 text-teal-800 dark:text-teal-300 font-semibold'
                          : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100/70 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      <span className="truncate">{sub.label}</span>
                      {showAuditAlert ? (
                        <span
                          className={`font-code text-[10px] font-bold shrink-0 ${
                            auditReport.errorCount > 0
                              ? 'text-rose-600 dark:text-rose-400'
                              : 'text-amber-600 dark:text-amber-400'
                          }`}
                        >
                          {toPersianDigits(
                            auditReport.errorCount > 0
                              ? auditReport.errorCount
                              : auditReport.warningCount
                          )}
                        </span>
                      ) : showChequeAlert ? (
                        <span
                          className={`font-code text-[10px] font-bold shrink-0 ${
                            chequeAlertSummary.overdueCount > 0 ||
                            chequeAlertSummary.dueTodayCount > 0 ||
                            chequeAlertSummary.bouncedCount > 0
                              ? 'text-rose-600 dark:text-rose-400'
                              : 'text-amber-600 dark:text-amber-400'
                          }`}
                        >
                          {toPersianDigits(chequeAlertSummary.urgentAlerts.length)}
                        </span>
                      ) : sub.shortcut ? (
                        <span className="font-code text-[10px] text-slate-400 shrink-0">
                          {sub.shortcut}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  const breadcrumbText = getBreadcrumbLabel(activeModule, activeSubKey);

  return (
    <div className="min-h-screen w-full max-w-full min-w-0 flex overflow-x-hidden bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      {/* Desktop Right-Hand RTL Sidebar */}
      <aside className="hidden lg:flex lg:flex-col w-68 shrink-0 bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 sticky top-0 h-screen no-print">
        <div className="h-14 px-4 flex items-center justify-between border-b border-slate-200 dark:border-slate-800">
          <span className="text-base font-extrabold tracking-tight text-slate-900 dark:text-white whitespace-nowrap">
            بیلیون
          </span>
          <span className="font-code text-[11px] font-semibold text-teal-700 dark:text-teal-400">
            سال {toPersianDigits(profile.fiscalYear)}
          </span>
        </div>

        <nav className="flex-1 overflow-y-auto p-3" aria-label="منوی اصلی بیلیون">
          {renderMenuTree()}
        </nav>

        {/* Compact Sidebar Utilities & User Footer */}
        <div className="p-3 border-t border-slate-200 dark:border-slate-800 space-y-2.5">
          <div className="flex items-center justify-between gap-1.5">
            <button
              onClick={() => setShowShortcuts(true)}
              className="flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 px-2 text-[11px] font-medium rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
            >
              <Keyboard className="w-3.5 h-3.5" />
              <span>میانبرها F1</span>
            </button>
            <button
              onClick={() => setShowCalculator((p) => !p)}
              className="flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 px-2 text-[11px] font-medium rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
            >
              <Calculator className="w-3.5 h-3.5" />
              <span>ماشین‌حساب</span>
            </button>
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            <button
              type="button"
              onClick={() => navigate('settings', 'rbac', 'tool-rbac')}
              title="تغییر اپراتور فعال و سطوح دسترسی RBAC"
              className="flex items-center gap-2.5 min-w-0 text-right hover:opacity-90 transition-opacity"
            >
              {!avatarError ? (
                <img
                  src="/src/assets/images/avatar_finance_director_1795265732394.jpg"
                  alt={activeOperator.fullName}
                  referrerPolicy="no-referrer"
                  onError={() => setAvatarError(true)}
                  className="w-8 h-8 rounded-lg object-cover shrink-0 border border-slate-200 dark:border-slate-700"
                />
              ) : (
                <div className="w-8 h-8 rounded-lg bg-teal-700 text-white flex items-center justify-center text-xs font-bold shrink-0">
                  {activeOperator.fullName.slice(0, 1)}
                </div>
              )}
              <div className="min-w-0">
                <div className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                  {activeOperator.fullName}
                </div>
                <div className="text-[10.5px] text-teal-700 dark:text-teal-400 truncate">
                  {RBAC_ROLE_LABELS[activeOperator.role].split('(')[0].trim()} ·{' '}
                  {isSyncing ? 'در حال همگام‌سازی' : isCloudMode ? 'ابری' : 'محلی'}
                </div>
              </div>
            </button>
            {!isCloudMode && (
              <button
                onClick={connectToCloud}
                title="اتصال امن به شرکت در Supabase"
                className="p-1.5 rounded-lg text-teal-700 dark:text-teal-400 hover:bg-teal-50 dark:hover:bg-teal-950/40 shrink-0"
              >
                <span className="text-xs font-bold">ابر</span>
              </button>
            )}
          </div>
        </div>
      </aside>

      {/* Mobile Drawer Navigation */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex no-print">
          <div className="w-72 max-w-[84vw] bg-white dark:bg-slate-900 h-full border-l border-slate-200 dark:border-slate-800 flex flex-col">
            <div className="h-14 px-4 flex items-center justify-between border-b border-slate-200 dark:border-slate-800">
              <span className="font-extrabold text-sm text-slate-900 dark:text-white">
                بیلیون
              </span>
              <button
                onClick={() => setMobileMenuOpen(false)}
                className="p-1.5 rounded-lg text-slate-500"
                aria-label="بستن منو"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto p-3">{renderMenuTree()}</nav>
            <div className="p-3 border-t border-slate-200 dark:border-slate-800">
              <PWAInstallButton compact />
            </div>
          </div>
          <div
            className="flex-1 bg-slate-950/50"
            onClick={() => setMobileMenuOpen(false)}
          />
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Clean 3-Zone Top Bar (<= 56px height) */}
        <header className="h-14 sticky top-0 z-30 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-slate-200 dark:border-slate-800 px-4 lg:px-6 flex items-center justify-between gap-4 no-print">
          {/* Zone 1: Mobile Menu + Breadcrumb */}
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              aria-label="منو"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 truncate">
              <span className="hidden sm:inline font-medium text-slate-700 dark:text-slate-300">
                بیلیون
              </span>
              <span className="hidden sm:inline" aria-hidden="true">
                /
              </span>
              <span className="font-semibold text-slate-900 dark:text-white truncate">
                {breadcrumbText}
              </span>
            </div>
          </div>

          {/* Zone 2: Quick Command Search */}
          <button
            onClick={() => setShowCommandPalette(true)}
            className="hidden md:flex items-center justify-between gap-4 w-72 px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400 bg-slate-100/80 dark:bg-slate-800/80 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg border border-slate-200/80 dark:border-slate-700 transition-colors"
          >
            <span className="flex items-center gap-2 truncate">
              <Search className="w-3.5 h-3.5 shrink-0" />
              <span>دنبال سند، چک، کالا یا حسابی؟...</span>
            </span>
            <kbd className="font-code text-[10px] px-1.5 py-0.5 rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
              Ctrl+K
            </kbd>
          </button>

          {/* Zone 3: Primary Action & Compact Utilities */}
          <div className="flex items-center gap-2 shrink-0">
            {/* Live Urgent Cheque Alert Bell & Popover */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowChequePopover((p) => !p)}
                title="اعلان‌های هوشمند سررسید چک (از ۳ روز قبل)"
                aria-label="اعلان‌های هوشمند سررسید چک"
                aria-expanded={showChequePopover}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap ${
                  chequeAlertSummary.urgentAlerts.length > 0
                    ? chequeAlertSummary.overdueCount > 0 ||
                      chequeAlertSummary.dueTodayCount > 0 ||
                      chequeAlertSummary.bouncedCount > 0
                      ? 'border-rose-300 dark:border-rose-800 bg-rose-50/70 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300'
                      : 'border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/35 text-amber-800 dark:text-amber-300'
                    : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                }`}
              >
                <Bell className="w-3.5 h-3.5 shrink-0" />
                {chequeAlertSummary.urgentAlerts.length > 0 && (
                  <span className="font-code tabular-nums font-bold">
                    {toPersianDigits(chequeAlertSummary.urgentAlerts.length)}
                  </span>
                )}
              </button>

              {showChequePopover && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setShowChequePopover(false)}
                    aria-hidden="true"
                  />
                  <div className="absolute left-0 mt-2 w-88 max-w-[92vw] z-50 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-lg overflow-hidden text-right">
                    <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
                      <div>
                        <div className="text-xs font-bold text-slate-900 dark:text-white">
                          اعلان‌های سررسید چک ({toPersianDigits(chequeAlertSummary.leadDays)} روز آینده)
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 font-code tabular-nums">
                          امروز {toPersianDigits(chequeAlertSummary.todayShamsi)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowChequePopover(false)}
                        className="p-1 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                        aria-label="بستن اعلان‌ها"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    {chequeAlertSummary.urgentAlerts.length === 0 ? (
                      <div className="px-4 py-6 text-center text-xs text-slate-500 dark:text-slate-400">
                        چک ضروری در بازه {toPersianDigits(chequeAlertSummary.leadDays)} روز آینده وجود ندارد.
                      </div>
                    ) : (
                      <div className="max-h-80 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
                        {chequeAlertSummary.urgentAlerts.map((al) => {
                          const ch = al.cheque;
                          const isCritical =
                            al.severity === 'bounced' ||
                            al.severity === 'overdue' ||
                            al.severity === 'today';
                          return (
                            <button
                              key={ch.id}
                              type="button"
                              onClick={() => {
                                setShowChequePopover(false);
                                navigate('treasury', `cheque:${ch.id}`, 'tr-cheques');
                              }}
                              className="w-full px-4 py-3 text-right hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors"
                            >
                              <div className="flex items-center justify-between gap-2 text-xs">
                                <span
                                  className={
                                    isCritical
                                      ? 'font-bold text-rose-700 dark:text-rose-400'
                                      : 'font-semibold text-amber-700 dark:text-amber-400'
                                  }
                                >
                                  {al.urgencyLabel}
                                </span>
                                <span className="font-code tabular-nums font-bold text-slate-900 dark:text-white">
                                  {formatCompactMoney(ch.amount, profile.currencyUnit)}
                                </span>
                              </div>
                              <div className="text-xs font-medium text-slate-800 dark:text-slate-100 truncate mt-1">
                                {ch.partyName}
                              </div>
                              <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-1.5">
                                <span
                                  className={
                                    ch.direction === 'receivable'
                                      ? 'text-emerald-700 dark:text-emerald-400 font-medium'
                                      : 'text-rose-700 dark:text-rose-400 font-medium'
                                  }
                                >
                                  {ch.direction === 'receivable' ? 'دریافتی' : 'پرداختی'}
                                </span>
                                <span aria-hidden="true">·</span>
                                <span className="font-code tabular-nums">
                                  سررسید {toPersianDigits(ch.dueDate)}
                                </span>
                                <span aria-hidden="true">·</span>
                                <span>{ch.bankName}</span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}

                    <div className="px-4 py-2.5 bg-slate-50 dark:bg-slate-950/50 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs">
                      <button
                        type="button"
                        onClick={() => {
                          setShowChequePopover(false);
                          navigate('dashboard');
                        }}
                        className="font-medium text-slate-600 dark:text-slate-300 hover:underline"
                      >
                        مرکز هشدار داشبورد
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowChequePopover(false);
                          navigate('treasury', 'cheques', 'tr-cheques');
                        }}
                        className="font-semibold text-teal-700 dark:text-teal-400 hover:underline"
                      >
                        مدیریت چک‌ها
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>

            <button
              onClick={() => navigate('audit', undefined, 'audit-center')}
              title="امتیاز سلامت حسابرسی دفاتر"
              className={`hidden xl:inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap ${
                auditReport.errorCount > 0
                  ? 'text-rose-700 dark:text-rose-400'
                  : 'text-emerald-700 dark:text-emerald-400'
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span className="font-code">حسابرسی {toPersianDigits(auditReport.score)}٪</span>
            </button>

            <button
              onClick={() => setCurrencyUnit(profile.currencyUnit === 'IRT' ? 'IRR' : 'IRT')}
              title="تغییر واحد نمایش پول بین تومان و ریال"
              className="hidden sm:inline-flex items-center px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
            >
              {profile.currencyUnit === 'IRT' ? 'تومان' : 'ریال'}
            </button>

            <button
              onClick={() => setDarkMode((d) => !d)}
              title={darkMode ? 'حالت روشن' : 'حالت تاریک'}
              className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
              aria-label="تغییر پوسته"
            >
              {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>

            <div className="hidden md:block">
              <PWAInstallButton compact />
            </div>

            {!isCloudMode ? (
              <button
                onClick={connectToCloud}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                <span className="text-sm">☁</span>
                <span>اتصال به شرکت</span>
              </button>
            ) : (
              <>
              <button
                onClick={inviteAnotherDevice}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-teal-700 border border-teal-700 rounded-lg hover:bg-teal-50 whitespace-nowrap shrink-0"
              >
                دعوت دستگاه
              </button>
              <button
                onClick={() => navigate('invoices', 'new-sale', 'inv-sale')}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                <FileText className="w-3.5 h-3.5" />
                <span>فاکتور فروش</span>
              </button>
              </>
            )}
          </div>
        </header>

        {/* Active Module Viewport */}
        <main className="module-viewport flex-1 min-w-0 p-3 sm:p-4 lg:p-6 max-w-[1440px] w-full mx-auto">
          {activeModule === 'dashboard' && <DashboardView onNavigate={navigate} />}
          {activeModule === 'invoices' && (
            <InvoicesView
              initialIntent={moduleIntent}
              clearIntent={() => setModuleIntent(undefined)}
            />
          )}
          {activeModule === 'vouchers' && (
            <VouchersView
              initialIntent={moduleIntent}
              clearIntent={() => setModuleIntent(undefined)}
            />
          )}
          {activeModule === 'audit' && <AuditView onNavigate={navigate} />}
          {activeModule === 'accounts' && (
            <AccountsView
              initialIntent={moduleIntent}
              clearIntent={() => setModuleIntent(undefined)}
            />
          )}
          {activeModule === 'parties' && (
            <PartiesView
              initialIntent={moduleIntent}
              clearIntent={() => setModuleIntent(undefined)}
            />
          )}
          {activeModule === 'inventory' && (
            <InventoryView
              initialIntent={moduleIntent}
              clearIntent={() => setModuleIntent(undefined)}
            />
          )}
          {activeModule === 'treasury' && (
            <TreasuryView
              initialIntent={moduleIntent}
              clearIntent={() => setModuleIntent(undefined)}
            />
          )}
          {activeModule === 'currencies' && (
            <CurrenciesView
              initialIntent={moduleIntent}
              clearIntent={() => setModuleIntent(undefined)}
              onNavigate={navigate}
            />
          )}
          {activeModule === 'commercial' && (
            <ImportAndSubcontractView
              initialIntent={moduleIntent}
              clearIntent={() => setModuleIntent(undefined)}
            />
          )}
          {activeModule === 'corporate' && (
            <CorporateView
              initialIntent={moduleIntent}
              clearIntent={() => setModuleIntent(undefined)}
            />
          )}
          {activeModule === 'reports' && (
            <ReportsView
              initialIntent={moduleIntent}
              clearIntent={() => setModuleIntent(undefined)}
            />
          )}
          {activeModule === 'studio' && <BrandStudioView />}
          {activeModule === 'settings' && (
            <SettingsView
              initialIntent={moduleIntent}
              clearIntent={() => setModuleIntent(undefined)}
            />
          )}
        </main>
      </div>

      {/* Global Toast */}
      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 px-5 py-2.5 rounded-lg bg-slate-900 dark:bg-teal-700 text-white text-xs font-medium shadow-xl no-print">
          {toast}
        </div>
      )}

      {/* Global Overlays */}
      <ShortcutHelpModal
        open={showShortcuts}
        onClose={() => setShowShortcuts(false)}
        onNavigate={navigate}
      />
      <CommandPaletteModal
        open={showCommandPalette}
        onClose={() => setShowCommandPalette(false)}
        onNavigate={navigate}
      />
      <QuickCalculatorModal
        open={showCalculator}
        onClose={() => setShowCalculator(false)}
      />
      <OfflineIndicator />
    </div>
  );
}
