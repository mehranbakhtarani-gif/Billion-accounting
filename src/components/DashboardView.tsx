import React, { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  BookOpen,
  FileText,
  Landmark,
  Package,
  TrendingUp,
} from 'lucide-react';
import { useAccounting } from '../context/AccountingContext';
import { formatCompactMoney, formatMoney, formatNumber, toPersianDigits } from '../lib/format';
import { computeChequeAlerts, useChequeAlertPreferences } from '../lib/chequeAlerts';
import { ActiveModule } from '../types/accounting';
import { DashboardChequeAlerts } from './DashboardChequeAlerts';
import { DashboardActionSearch } from './DashboardActionSearch';
import { LiveFxTickerCard } from './LiveFxTickerCard';

const SHAMSI_MONTHS = [
  { key: '01', name: 'فروردین' },
  { key: '02', name: 'اردیبهشت' },
  { key: '03', name: 'خرداد' },
  { key: '04', name: 'تیر' },
  { key: '05', name: 'مرداد' },
  { key: '06', name: 'شهریور' },
  { key: '07', name: 'مهر' },
  { key: '08', name: 'آبان' },
  { key: '09', name: 'آذر' },
  { key: '10', name: 'دی' },
  { key: '11', name: 'بهمن' },
  { key: '12', name: 'اسفند' },
];

const EXPENSE_COLORS = ['#0f766e', '#0284c7', '#d97706', '#dc2626', '#475569', '#059669'];
const BANK_COLORS = ['#0f766e', '#0369a1', '#0d9488', '#334155', '#047857'];

export const DashboardView: React.FC<{
  onNavigate: (mod: ActiveModule, intent?: string, subKey?: string) => void;
}> = ({ onNavigate }) => {
  const {
    profile,
    trialBalance,
    incomeStatement,
    balanceSheet,
    invoices,
    vouchers,
    products,
    cheques,
    accounts,
    parties,
  } = useAccounting();

  const { prefs: chequeAlertPrefs } = useChequeAlertPreferences();

  const unit = profile.currencyUnit;
  const unitLabel = unit === 'IRT' ? 'میلیون تومان' : 'میلیون ریال';
  const millionDivisor = unit === 'IRT' ? 10_000_000 : 1_000_000;

  // Cash & Bank Liquidity from Trial Balance (101xx + 102xx)
  const liquidity = useMemo(() => {
    return trialBalance
      .filter((r) => r.accountCode.startsWith('101') || r.accountCode.startsWith('102'))
      .reduce((s, r) => s + r.balanceDebit - r.balanceCredit, 0);
  }, [trialBalance]);

  // Receivables + Pending Receivable Cheques (103xx + 104xx)
  const totalReceivables = useMemo(() => {
    return trialBalance
      .filter((r) => r.accountCode.startsWith('103') || r.accountCode.startsWith('104'))
      .reduce((s, r) => s + r.balanceDebit - r.balanceCredit, 0);
  }, [trialBalance]);

  // Determine active month horizon up to latest voucher month (minimum 8 months for readability)
  const activeMonths = useMemo(() => {
    let maxMonth = 8;
    vouchers.forEach((v) => {
      const m = parseInt(v.date.split('/')[1] || '1', 10);
      if (!Number.isNaN(m) && m > maxMonth) maxMonth = Math.min(12, m);
    });
    return SHAMSI_MONTHS.slice(0, maxMonth);
  }, [vouchers]);

  // Widget 1: Monthly Cash Flow (LineChart) — Inflows, Outflows & Cumulative Cash/Bank Balance
  const cashFlowChartData = useMemo(() => {
    let runningBalance = 0;
    return activeMonths.map((m) => {
      let inflow = 0;
      let outflow = 0;
      vouchers.forEach((v) => {
        const parts = v.date.split('/');
        if (parts[1] === m.key) {
          v.lines.forEach((l) => {
            if (l.accountCode.startsWith('101') || l.accountCode.startsWith('102')) {
              if (v.voucherType === 'opening') {
                runningBalance += (l.debit || 0) - (l.credit || 0);
              } else {
                inflow += l.debit || 0;
                outflow += l.credit || 0;
              }
            }
          });
        }
      });
      runningBalance += inflow - outflow;
      return {
        month: m.name,
        ورودی: Math.round(inflow / millionDivisor),
        خروجی: Math.round(outflow / millionDivisor),
        مانده: Math.round(runningBalance / millionDivisor),
      };
    });
  }, [activeMonths, vouchers, millionDivisor]);

  // Widget 2: Expense Composition (PieChart) — Breakdown across COGS & Operating Expense accounts
  const expensePieData = useMemo(() => {
    const items = trialBalance
      .filter((r) => r.category === 'cogs' || r.category === 'expense')
      .map((r) => ({
        code: r.accountCode,
        name: r.accountTitle,
        rawAmount: Math.max(0, r.balanceDebit - r.balanceCredit),
        value: Math.round(Math.max(0, r.balanceDebit - r.balanceCredit) / millionDivisor),
      }))
      .filter((x) => x.rawAmount > 0)
      .sort((a, b) => b.rawAmount - a.rawAmount);

    const total = items.reduce((s, i) => s + i.rawAmount, 0);
    return items.map((item, idx) => ({
      ...item,
      pct: total > 0 ? Math.round((item.rawAmount / total) * 1000) / 10 : 0,
      color: EXPENSE_COLORS[idx % EXPENSE_COLORS.length],
    }));
  }, [trialBalance, millionDivisor]);

  // Widget 3: Profit & Loss by Month (BarChart)
  const pnlBarData = useMemo(() => {
    return activeMonths.map((m) => {
      let revenue = 0;
      let totalCost = 0;
      vouchers.forEach((v) => {
        const parts = v.date.split('/');
        if (parts[1] === m.key && v.voucherType !== 'closing') {
          v.lines.forEach((l) => {
            if (l.accountCode.startsWith('601')) revenue += l.credit || 0;
            if (l.accountCode.startsWith('602')) revenue -= l.debit || 0;
            if (l.accountCode.startsWith('7') || l.accountCode.startsWith('8')) {
              totalCost += l.debit || 0;
            }
          });
        }
      });
      const profit = revenue - totalCost;
      return {
        month: m.name,
        درآمد: Math.round(revenue / millionDivisor),
        هزینه: Math.round(totalCost / millionDivisor),
        سود: Math.round(profit / millionDivisor),
      };
    });
  }, [activeMonths, vouchers, millionDivisor]);

  // Widget 4: Bank & Cash Accounts Balances (BarChart)
  const bankBalancesData = useMemo(() => {
    const balanceMap = new Map<string, number>();
    trialBalance.forEach((r) => {
      balanceMap.set(r.accountCode, r.balanceDebit - r.balanceCredit);
    });

    const cashBankAccounts = accounts
      .filter(
        (a) =>
          (a.level === 'moein' || a.level === 'tafsili') &&
          (a.code.startsWith('101') || a.code.startsWith('102'))
      )
      .sort((a, b) => a.code.localeCompare(b.code));

    return cashBankAccounts.map((acc, idx) => {
      const rawBalance = balanceMap.get(acc.code) ?? 0;
      const shortName = acc.title.split('—')[0].trim();
      return {
        code: acc.code,
        name: shortName,
        fullTitle: acc.title,
        rawBalance,
        مانده: Math.round(rawBalance / millionDivisor),
        isBank: acc.code.startsWith('102'),
        color: BANK_COLORS[idx % BANK_COLORS.length],
      };
    });
  }, [accounts, trialBalance, millionDivisor]);

  const lowStockProducts = useMemo(
    () => products.filter((p) => p.stock <= p.reorderPoint),
    [products]
  );

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

  const pendingCheques = useMemo(
    () => chequeAlertSummary.allActiveAlerts,
    [chequeAlertSummary.allActiveAlerts]
  );

  const recentVouchers = useMemo(
    () => [...vouchers].sort((a, b) => b.voucherNumber - a.voucherNumber).slice(0, 5),
    [vouchers]
  );

  const tooltipStyle = {
    borderRadius: '8px',
    border: '1px solid #cbd5e1',
    backgroundColor: '#ffffff',
    color: '#0f172a',
    fontSize: '12px',
    direction: 'rtl' as const,
    textAlign: 'right' as const,
  };

  return (
    <div className="space-y-6">
      {/* Header Row & Quick Holoo Actions */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">
            داشبورد مدیریت مالی و کنترلی
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mt-1">
            <span>{profile.companyName}</span>
            <span aria-hidden="true">·</span>
            <span>سال مالی {toPersianDigits(profile.fiscalYear)}</span>
            <span aria-hidden="true">·</span>
            <span>
              ترازنامه: {balanceSheet.isBalanced ? 'متوازن و تاییدشده' : 'نیاز به بررسی تراز'}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => onNavigate('invoices', 'new-sale')}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <FileText className="w-4 h-4" />
            <span>فاکتور فروش (F2)</span>
          </button>
          <button
            onClick={() => onNavigate('vouchers', 'new-voucher')}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <BookOpen className="w-4 h-4" />
            <span>ثبت سند (F3)</span>
          </button>
          <button
            onClick={() => onNavigate('treasury')}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <Landmark className="w-4 h-4" />
            <span>خزانه‌داری و چک (F7)</span>
          </button>
        </div>
      </div>

      {/* Live Free-Market FX Ticker Card (USD, CNY, AED, EUR — chand.app) */}
      <LiveFxTickerCard onNavigate={onNavigate} />

      {/* Inline Fuzzy Action Launcher for All ERP Functions */}
      <DashboardActionSearch onNavigate={onNavigate} />

      {/* Smart Urgent Cheque Alerts (3 Days Before Maturity — Received & Paid) */}
      <DashboardChequeAlerts onNavigate={onNavigate} />

      {/* 4-Column Executive KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>فروش خالص دوره</span>
            <TrendingUp className="w-4 h-4 text-teal-700 dark:text-teal-400" />
          </div>
          <div className="text-2xl font-bold text-slate-900 dark:text-white tabular-nums mt-2.5">
            {formatCompactMoney(incomeStatement.netSales, unit)}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-2 flex items-center gap-1.5">
            <span>حاشیه سود ناخالص:</span>
            <span className="font-semibold text-emerald-700 dark:text-emerald-400 tabular-nums">
              {toPersianDigits(incomeStatement.grossMarginPct.toFixed(1))}٪
            </span>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>سود خالص عملیاتی</span>
            <ArrowUpRight className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div
            className={`text-2xl font-bold tabular-nums mt-2.5 ${
              incomeStatement.netProfit >= 0
                ? 'text-emerald-700 dark:text-emerald-400'
                : 'text-rose-700 dark:text-rose-400'
            }`}
          >
            {formatCompactMoney(incomeStatement.netProfit, unit)}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-2 flex items-center gap-1.5">
            <span>حاشیه سود خالص:</span>
            <span className="font-semibold text-slate-800 dark:text-slate-200 tabular-nums">
              {toPersianDigits(incomeStatement.netMarginPct.toFixed(1))}٪
            </span>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>موجودی نقد و بانک‌ها</span>
            <Landmark className="w-4 h-4 text-slate-500" />
          </div>
          <div className="text-2xl font-bold text-slate-900 dark:text-white tabular-nums mt-2.5">
            {formatCompactMoney(liquidity, unit)}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-2">
            صندوق مرکزی · بانک ملت · بانک سامان
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>مطالبات و چک‌های دریافتنی</span>
            <ArrowDownLeft className="w-4 h-4 text-amber-600 dark:text-amber-400" />
          </div>
          <div className="text-2xl font-bold text-slate-900 dark:text-white tabular-nums mt-2.5">
            {formatCompactMoney(totalReceivables, unit)}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-2">
            {toPersianDigits(pendingCheques.length)} فقره چک فعال در جریان وصول
          </div>
        </div>
      </div>

      {/* 4 Recharts Financial Widgets Grid (2x2) */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Widget 1: Monthly Cash Flow (LineChart) */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4 gap-2">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                جریان نقدینگی ماهانه (ورودی، خروجی و مانده نقد)
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                بر حسب {unitLabel} — محاسبه‌شده از گردش صندوق و بانک‌ها
              </p>
            </div>
            <button
              onClick={() => onNavigate('treasury')}
              className="text-xs font-medium text-teal-700 dark:text-teal-400 hover:underline whitespace-nowrap shrink-0"
            >
              جزئیات خزانه
            </button>
          </div>
          <div className="h-64 w-full" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={cashFlowChartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#64748b' }} />
                <YAxis tick={{ fontSize: 11, fill: '#64748b' }} />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(value: unknown, name: unknown) => [
                    `${toPersianDigits(Number(value).toLocaleString('en-US'))} ${unitLabel}`,
                    String(name),
                  ]}
                />
                <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                <Line
                  type="monotone"
                  dataKey="مانده"
                  name="مانده تجمعی نقد"
                  stroke="#0f766e"
                  strokeWidth={2.5}
                  dot={{ r: 3.5, fill: '#0f766e' }}
                  activeDot={{ r: 5 }}
                />
                <Line
                  type="monotone"
                  dataKey="ورودی"
                  name="ورودی نقدی"
                  stroke="#16a34a"
                  strokeWidth={2}
                  dot={{ r: 3, fill: '#16a34a' }}
                />
                <Line
                  type="monotone"
                  dataKey="خروجی"
                  name="خروجی نقدی"
                  stroke="#dc2626"
                  strokeWidth={2}
                  strokeDasharray="4 4"
                  dot={{ r: 3, fill: '#dc2626' }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Widget 2: Expense Composition (PieChart) */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4 gap-2">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                ترکیب هزینه‌ها و بهای تمام‌شده
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                سهم هر سرفصل هزینه‌ای از کل هزینه‌های ثبت‌شده دوره
              </p>
            </div>
            <button
              onClick={() => onNavigate('reports')}
              className="text-xs font-medium text-teal-700 dark:text-teal-400 hover:underline whitespace-nowrap shrink-0"
            >
              تراز آزمایشی
            </button>
          </div>

          {expensePieData.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-xs text-slate-500">
              هنوز سرفصل هزینه‌ای در اسناد دوره ثبت نشده است.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-4 items-center">
              <div className="sm:col-span-6 h-60 w-full" dir="ltr">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={expensePieData}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={52}
                      outerRadius={86}
                      paddingAngle={2}
                    >
                      {expensePieData.map((entry) => (
                        <Cell key={entry.code} fill={entry.color} stroke="none" />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={tooltipStyle}
                      formatter={(value: unknown, name: unknown) => [
                        `${toPersianDigits(Number(value).toLocaleString('en-US'))} ${unitLabel}`,
                        String(name),
                      ]}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="sm:col-span-6 divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                {expensePieData.map((item) => (
                  <div key={item.code} className="py-2 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="w-2.5 h-2.5 rounded-sm shrink-0"
                        style={{ backgroundColor: item.color }}
                        aria-hidden="true"
                      />
                      <span className="text-slate-700 dark:text-slate-300 truncate" title={item.name}>
                        {item.name}
                      </span>
                    </div>
                    <div className="text-left shrink-0 font-code tabular-nums">
                      <span className="font-semibold text-slate-900 dark:text-white">
                        {toPersianDigits(item.pct)}٪
                      </span>
                      <div className="text-[11px] text-slate-500">
                        {formatCompactMoney(item.rawAmount, unit)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Widget 3: Profit & Loss (BarChart) */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4 gap-2">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                نمودار سود و زیان ماهانه
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                مقایسه درآمد فروش، کل بهای تمام‌شده/هزینه‌ها و سود خالص ({unitLabel})
              </p>
            </div>
            <button
              onClick={() => onNavigate('reports')}
              className="text-xs font-medium text-teal-700 dark:text-teal-400 hover:underline whitespace-nowrap shrink-0"
            >
              صورت سود و زیان
            </button>
          </div>
          <div className="h-64 w-full" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={pnlBarData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#64748b' }} />
                <YAxis tick={{ fontSize: 11, fill: '#64748b' }} />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(value: unknown, name: unknown) => [
                    `${toPersianDigits(Number(value).toLocaleString('en-US'))} ${unitLabel}`,
                    String(name),
                  ]}
                />
                <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                <Bar dataKey="درآمد" name="درآمد فروش" fill="#0f766e" radius={[4, 4, 0, 0]} />
                <Bar dataKey="هزینه" name="بهای تمام‌شده و هزینه" fill="#94a3b8" radius={[4, 4, 0, 0]} />
                <Bar dataKey="سود" name="سود (زیان) خالص" fill="#16a34a" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Widget 4: Bank & Cash Accounts Balances (BarChart + Tabular Summary) */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-4 gap-2">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                مانده حساب‌های بانکی و صندوق‌ها
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                مانده لحظه‌ای حساب‌های کدینگ ۱۰۱ و ۱۰۲ بر حسب {unitLabel}
              </p>
            </div>
            <button
              onClick={() => onNavigate('accounts')}
              className="text-xs font-medium text-teal-700 dark:text-teal-400 hover:underline whitespace-nowrap shrink-0"
            >
              دفتر بانک‌ها
            </button>
          </div>

          <div className="h-44 w-full" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={bankBalancesData}
                layout="vertical"
                margin={{ top: 4, right: 20, left: 10, bottom: 4 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11, fill: '#64748b' }} />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={108}
                  tick={{ fontSize: 11, fill: '#475569' }}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(value: unknown) => [
                    `${toPersianDigits(Number(value).toLocaleString('en-US'))} ${unitLabel}`,
                    'مانده حساب',
                  ]}
                />
                <Bar dataKey="مانده" radius={[0, 4, 4, 0]} barSize={20}>
                  {bankBalancesData.map((entry) => (
                    <Cell key={entry.code} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            {bankBalancesData.map((b) => (
              <div key={b.code} className="flex items-center justify-between gap-2 min-w-0">
                <span className="text-slate-600 dark:text-slate-400 truncate" title={b.fullTitle}>
                  <span className="font-code text-[11px] text-slate-400 ml-1">{b.code}</span>
                  {b.name}
                </span>
                <span className="font-code tabular-nums font-semibold text-slate-900 dark:text-white shrink-0">
                  {formatCompactMoney(b.rawBalance, unit)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Operational Alerts + Recent Vouchers Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Recent Vouchers */}
        <div className="xl:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">
              آخرین اسناد حسابداری ثبت‌شده
            </h2>
            <button
              onClick={() => onNavigate('vouchers')}
              className="text-xs font-medium text-teal-700 dark:text-teal-400 hover:underline whitespace-nowrap"
            >
              دفتر روزنامه ({toPersianDigits(vouchers.length)} سند)
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-right border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400 bg-slate-50/70 dark:bg-slate-950/50">
                  <th className="py-2.5 px-4 font-medium">شماره سند</th>
                  <th className="py-2.5 px-4 font-medium">تاریخ</th>
                  <th className="py-2.5 px-4 font-medium">شرح سند</th>
                  <th className="py-2.5 px-4 font-medium text-left">جمع بدهکار/بستانکار</th>
                  <th className="py-2.5 px-4 font-medium">وضعیت</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                {recentVouchers.map((v) => (
                  <tr
                    key={v.id}
                    onClick={() => onNavigate('vouchers')}
                    className="hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer transition-colors"
                  >
                    <td className="py-3 px-4 font-code font-semibold text-slate-900 dark:text-slate-100">
                      #{toPersianDigits(v.voucherNumber)}
                    </td>
                    <td className="py-3 px-4 font-code text-slate-600 dark:text-slate-300">
                      {toPersianDigits(v.date)}
                    </td>
                    <td className="py-3 px-4 text-slate-800 dark:text-slate-200 max-w-xs truncate">
                      {v.description}
                    </td>
                    <td className="py-3 px-4 text-left font-code tabular-nums font-medium text-slate-900 dark:text-slate-100">
                      {formatMoney(v.totalDebit, unit, false)}
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`font-medium ${
                          v.status === 'permanent'
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-amber-700 dark:text-amber-400'
                        }`}
                      >
                        {v.status === 'permanent' ? 'دائم و قطعی' : 'موقت'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Alerts & Action Queue */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-5">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white">
            هشدارهای کنترلی و سررسیدها
          </h2>

          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-500 dark:text-slate-400">
              <span>تقویم سررسید چک‌های فعال</span>
              <button
                type="button"
                onClick={() => onNavigate('treasury', 'cheques', 'tr-cheques')}
                className="font-medium text-teal-700 dark:text-teal-400 hover:underline"
              >
                همه چک‌ها
              </button>
            </div>
            {pendingCheques.length === 0 ? (
              <p className="text-xs text-slate-500">چک در جریان وصولی ثبت نشده است.</p>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800 border-t border-b border-slate-100 dark:border-slate-800">
                {pendingCheques.slice(0, 4).map((alert) => {
                  const ch = alert.cheque;
                  const isCritical =
                    alert.severity === 'bounced' ||
                    alert.severity === 'overdue' ||
                    alert.severity === 'today';
                  const isUrgent = alert.severity === 'urgent';
                  return (
                    <button
                      key={ch.id}
                      type="button"
                      onClick={() => onNavigate('treasury', `cheque:${ch.id}`, 'tr-cheques')}
                      className="w-full py-2.5 flex items-center justify-between gap-2 text-xs text-right hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-slate-900 dark:text-slate-100 truncate">
                          {ch.partyName}
                        </div>
                        <div className="text-slate-500 dark:text-slate-400 mt-0.5 flex flex-wrap items-center gap-1.5">
                          <span className="font-code tabular-nums">
                            {toPersianDigits(ch.dueDate)}
                          </span>
                          <span aria-hidden="true">·</span>
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
                          <span
                            className={
                              isCritical
                                ? 'text-rose-700 dark:text-rose-400 font-semibold'
                                : isUrgent
                                  ? 'text-amber-700 dark:text-amber-400 font-semibold'
                                  : 'text-slate-500'
                            }
                          >
                            {alert.urgencyLabel}
                          </span>
                        </div>
                      </div>
                      <div className="font-code tabular-nums font-semibold text-slate-900 dark:text-slate-100 shrink-0">
                        {formatCompactMoney(ch.amount, unit)}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-3">
            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">
              هشدار کسری موجودی انبار (نقطه سفارش)
            </div>
            {lowStockProducts.length === 0 ? (
              <p className="text-xs text-emerald-700 dark:text-emerald-400">
                موجودی تمام کالاها بالاتر از نقطه سفارش است.
              </p>
            ) : (
              <div className="space-y-2">
                {lowStockProducts.map((p) => (
                  <div
                    key={p.id}
                    onClick={() => onNavigate('inventory')}
                    className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-amber-50/80 dark:bg-amber-950/30 border border-amber-200/80 dark:border-amber-900 cursor-pointer text-xs"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                      <span className="font-medium text-slate-900 dark:text-slate-100 truncate">
                        {p.name}
                      </span>
                    </div>
                    <span className="font-code tabular-nums font-semibold text-amber-800 dark:text-amber-300 shrink-0">
                      {formatNumber(p.stock)} / {formatNumber(p.reorderPoint)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="pt-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span className="flex items-center gap-1.5">
              <Package className="w-3.5 h-3.5" />
              کل فاکتورهای صادرشده: {toPersianDigits(invoices.length)}
            </span>
            <button
              onClick={() => onNavigate('invoices')}
              className="text-teal-700 dark:text-teal-400 font-medium hover:underline"
            >
              مدیریت فاکتورها
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
