import React from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Download,
  ListOrdered,
  Printer,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { useAccounting } from '../context/AccountingContext';
import { ActiveModule } from '../types/accounting';
import { exportToCsv, formatMoney, toPersianDigits } from '../lib/format';
import { getBillionDeviceSyncStatus, BillionDeviceSyncStatus } from '../lib/supabaseStore';

export const AuditView: React.FC<{
  onNavigate: (mod: ActiveModule, intent?: string) => void;
}> = ({ onNavigate }) => {
  const { auditReport, profile, vouchers, renumberVouchersChronologically, isCloudMode } = useAccounting();
  const [deviceSyncStatus, setDeviceSyncStatus] = React.useState<BillionDeviceSyncStatus | null>(null);
  const [deviceSyncError, setDeviceSyncError] = React.useState<string | null>(null);
  const [deviceSyncLoading, setDeviceSyncLoading] = React.useState(false);
  const refreshDeviceSyncStatus = React.useCallback(async () => {
    if (!isCloudMode) {
      setDeviceSyncStatus(null);
      setDeviceSyncError(null);
      return;
    }
    setDeviceSyncLoading(true);
    try {
      setDeviceSyncStatus(await getBillionDeviceSyncStatus());
      setDeviceSyncError(null);
    } catch (error) {
      setDeviceSyncError(error instanceof Error ? error.message : 'دریافت وضعیت دستگاه‌ها ناموفق بود.');
    } finally {
      setDeviceSyncLoading(false);
    }
  }, [isCloudMode]);
  React.useEffect(() => {
    void refreshDeviceSyncStatus();
  }, [refreshDeviceSyncStatus]);
  const unit = profile.currencyUnit;
  const rec = auditReport.reconciliation;

  const reconciliationRows = [
    {
      label: 'بدهکاران تجاری (معین ۱۰۴۰۱) در برابر تفصیلی مشتریان',
      bookLabel: 'مانده معین ۱۰۴۰۱',
      subLabel: 'جمع تفصیلی مشتریان',
      a: rec.glReceivables,
      b: rec.subReceivables,
    },
    {
      label: 'بستانکاران تجاری (معین ۳۰۱۰۱) در برابر تفصیلی تأمین‌کنندگان',
      bookLabel: 'مانده معین ۳۰۱۰۱',
      subLabel: 'جمع تفصیلی تأمین‌کنندگان',
      a: rec.glPayables,
      b: rec.subPayables,
    },
    {
      label: 'مالیات ارزش افزوده فروش (معین ۳۰۳۰۱) در برابر فاکتورهای مودیان',
      bookLabel: 'مانده معین ۳۰۳۰۱',
      subLabel: 'خالص مالیات فاکتور فروش',
      a: rec.glSalesVat,
      b: rec.invSalesVat,
    },
    {
      label: 'مالیات ارزش افزوده خرید (معین ۳۰۳۰۲) در برابر فاکتورهای خرید',
      bookLabel: 'مانده معین ۳۰۳۰۲',
      subLabel: 'خالص مالیات فاکتور خرید',
      a: rec.glPurchaseVat,
      b: rec.invPurchaseVat,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 no-print">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">
            مرکز حسابرسی هوشمند و کنترل یکپارچگی دفاتر
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            بررسی خودکار تراز اسناد، توالی شماره‌گذاری، معادله ترازنامه، تطبیق معین با تفصیلی، مالیات مودیان و کنترل‌های داخلی
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => renumberVouchersChronologically()}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
          >
            <ListOrdered className="w-4 h-4 text-teal-700 dark:text-teal-400" />
            <span>مرتب‌سازی و شماره‌گذاری مجدد اسناد</span>
          </button>
          <button
            onClick={() => exportToCsv(
              `billion-audit-report-${profile.fiscalYear}.csv`,
              ['شناسه کنترل', 'حوزه', 'عنوان کنترل', 'وضعیت', 'خلاصه', 'جزئیات'],
              auditReport.checks.map((check) => [
                check.id,
                check.category,
                check.title,
                check.status === 'pass' ? 'تأیید' : check.status === 'warning' ? 'هشدار' : 'خطا',
                check.summary,
                check.details.join(' | '),
              ])
            )}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 whitespace-nowrap"
          >
            <Download className="w-4 h-4" />
            <span>خروجی حسابرسی (CSV)</span>
          </button>
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg whitespace-nowrap"
          >
            <Printer className="w-4 h-4" />
            <span>چاپ گزارش حسابرسی</span>
          </button>
        </div>
      </div>

      {/* Audit Summary KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 print-container">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500">امتیاز سلامت حسابداری</span>
            <ShieldCheck className="w-4 h-4 text-teal-700 dark:text-teal-400" />
          </div>
          <div className="mt-2.5 text-2xl font-bold font-code tabular-nums text-slate-900 dark:text-white">
            {toPersianDigits(auditReport.score)}٪
          </div>
          <div className="mt-1 text-xs text-slate-500">
            بررسی‌شده روی {toPersianDigits(vouchers.length)} سند حسابداری
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500">کنترل‌های تأییدشده</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          </div>
          <div className="mt-2.5 text-2xl font-bold font-code tabular-nums text-emerald-700 dark:text-emerald-400">
            {toPersianDigits(auditReport.passedCount)} از {toPersianDigits(auditReport.checks.length)}
          </div>
          <div className="mt-1 text-xs text-slate-500">تطابق کامل ریاضی و قانونی</div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500">هشدارهای عملیاتی</span>
            <AlertTriangle className="w-4 h-4 text-amber-600" />
          </div>
          <div className="mt-2.5 text-2xl font-bold font-code tabular-nums text-amber-700 dark:text-amber-400">
            {toPersianDigits(auditReport.warningCount)} مورد
          </div>
          <div className="mt-1 text-xs text-slate-500">نیازمند پیگیری حسابدار</div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500">خطاهای بحرانی تراز</span>
            <XCircle className="w-4 h-4 text-rose-600" />
          </div>
          <div className="mt-2.5 text-2xl font-bold font-code tabular-nums text-rose-700 dark:text-rose-400">
            {toPersianDigits(auditReport.errorCount)} خطا
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {auditReport.errorCount === 0 ? 'بدون خطای ریاضی در دفاتر' : 'نیازمند اصلاح فوری'}
          </div>
        </div>
      </div>

      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden print-container">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">وضعیت همگام‌سازی و دستگاه‌های ثبت‌شده</h2>
            <p className="mt-1 text-xs text-slate-500">آخرین فعالیت هر دستگاه و ترتیب قطعی عملیات ثبت‌شده در Supabase</p>
          </div>
          <div className="flex items-center gap-2 no-print">
            {deviceSyncStatus && (
              <button
                onClick={() => exportToCsv(
                  `billion-device-activity-${profile.fiscalYear}.csv`,
                  ['دستگاه', 'شماره عملیات دستگاه', 'نوع عملیات', 'شرح', 'زمان دستگاه', 'زمان ثبت سرور'],
                  deviceSyncStatus.operations.map((operation) => [
                    deviceSyncStatus.devices.find((device) => device.device_id === operation.device_id)?.device_label ?? 'دستگاه ناشناس',
                    operation.device_sequence,
                    operation.operation_type,
                    operation.summary,
                    operation.client_created_at,
                    operation.server_applied_at,
                  ])
                )}
                className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200"
              >
                <Download className="w-4 h-4" />
                خروجی گردش دستگاه‌ها
              </button>
            )}
            <button
              onClick={() => void refreshDeviceSyncStatus()}
              disabled={!isCloudMode || deviceSyncLoading}
              className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${deviceSyncLoading ? 'animate-spin' : ''}`} />
              تازه‌سازی
            </button>
          </div>
        </div>
        {!isCloudMode ? (
          <div className="px-5 py-8 text-center text-xs text-slate-500">برای مشاهده دستگاه‌های ثبت‌شده و گردش همگام‌سازی، ابتدا شرکت را به Supabase متصل کنید.</div>
        ) : deviceSyncError ? (
          <div className="px-5 py-8 text-center text-xs text-rose-600">{deviceSyncError}</div>
        ) : deviceSyncLoading && !deviceSyncStatus ? (
          <div className="px-5 py-8 text-center text-xs text-slate-500">در حال دریافت وضعیت دستگاه‌ها...</div>
        ) : (
          <div className="p-5 space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {(deviceSyncStatus?.devices ?? []).map((device) => (
                <div key={device.device_id} className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-900 dark:text-white">{device.device_label}</span>
                    <span className={device.status === 'active' ? 'text-[10px] rounded-full px-2 py-1 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400' : 'text-[10px] rounded-full px-2 py-1 bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400'}>
                      {device.status === 'active' ? 'فعال' : 'لغوشده'}
                    </span>
                  </div>
                  <div className="mt-2 text-xs text-slate-500">{device.platform === 'android' ? 'اندروید' : device.platform === 'ios' ? 'iOS' : 'مرورگر'}</div>
                  <div className="mt-2 flex items-center justify-between text-xs">
                    <span className="text-slate-500">آخرین مشاهده</span>
                    <span className="tabular-nums text-slate-700 dark:text-slate-300">{device.last_seen_at ? new Date(device.last_seen_at).toLocaleString('fa-IR') : 'نامشخص'}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-xs">
                    <span className="text-slate-500">آخرین شماره عملیات</span>
                    <span className="font-semibold tabular-nums">{toPersianDigits(device.last_sequence)}</span>
                  </div>
                </div>
              ))}
              {deviceSyncStatus?.devices.length === 0 && <div className="text-xs text-slate-500">هیچ دستگاهی ثبت نشده است.</div>}
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-bold text-slate-800 dark:text-slate-200">آخرین عملیات ثبت‌شده</h3>
                <span className="text-[10px] text-slate-500">{toPersianDigits(deviceSyncStatus?.operations.length ?? 0)} عملیات</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-right text-xs border-collapse">
                  <thead>
                    <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500">
                      <th className="py-2.5 px-3">دستگاه</th>
                      <th className="py-2.5 px-3 text-left">ترتیب</th>
                      <th className="py-2.5 px-3">شرح عملیات</th>
                      <th className="py-2.5 px-3">زمان ثبت سرور</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {(deviceSyncStatus?.operations ?? []).map((operation) => (
                      <tr key={operation.operation_id}>
                        <td className="py-2.5 px-3">{deviceSyncStatus?.devices.find((device) => device.device_id === operation.device_id)?.device_label ?? 'دستگاه ناشناس'}</td>
                        <td className="py-2.5 px-3 text-left tabular-nums">{toPersianDigits(operation.device_sequence)}</td>
                        <td className="py-2.5 px-3">{operation.summary}</td>
                        <td className="py-2.5 px-3 tabular-nums">{new Date(operation.server_applied_at).toLocaleString('fa-IR')}</td>
                      </tr>
                    ))}
                    {deviceSyncStatus?.operations.length === 0 && <tr><td colSpan={4} className="py-7 text-center text-slate-500">هنوز عملیات ابری ثبت نشده است.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* GL-to-Subsidiary & Tax Reconciliation Matrix */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden print-container">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white">
            ماتریس تطبیق دفتر کل و معین با تفصیلی و سامانه مودیان
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 text-slate-500">
                <th className="py-3 px-4 font-medium">محور تطبیق حسابرسی</th>
                <th className="py-3 px-4 font-medium text-left">مانده دفتر معین</th>
                <th className="py-3 px-4 font-medium text-left">مجموع تفصیلی / فاکتورها</th>
                <th className="py-3 px-4 font-medium text-left">اختلاف</th>
                <th className="py-3 px-4 font-medium">وضعیت تطبیق</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {reconciliationRows.map((row) => {
                const diff = row.a - row.b;
                const ok = Math.abs(diff) < 1;
                return (
                  <tr key={row.label}>
                    <td className="py-3 px-4 font-medium text-slate-900 dark:text-slate-100">
                      {row.label}
                    </td>
                    <td className="py-3 px-4 text-left font-code tabular-nums">
                      {formatMoney(row.a, unit)}
                    </td>
                    <td className="py-3 px-4 text-left font-code tabular-nums">
                      {formatMoney(row.b, unit)}
                    </td>
                    <td className="py-3 px-4 text-left font-code tabular-nums font-semibold">
                      {ok ? '۰' : formatMoney(Math.abs(diff), unit)}
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      <span
                        className={
                          ok
                            ? 'text-emerald-700 dark:text-emerald-400 font-semibold'
                            : 'text-amber-700 dark:text-amber-400 font-semibold'
                        }
                      >
                        {ok ? 'تطبیق ۱۰۰٪ دقیق' : 'نیازمند بررسی اختلاف'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detailed Audit Checklist */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden print-container">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white">
            چک‌لیست کنترل‌های حسابرسی استاندارد بیلیون
          </h2>
        </div>
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {auditReport.checks.map((chk) => (
            <div
              key={chk.id}
              className="p-4 flex flex-col md:flex-row md:items-start justify-between gap-4"
            >
              <div className="flex items-start gap-3 min-w-0">
                {chk.status === 'pass' ? (
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                ) : chk.status === 'warning' ? (
                  <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                ) : (
                  <XCircle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
                )}
                <div className="space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-bold text-slate-900 dark:text-white">
                      {chk.title}
                    </span>
                    <span className="text-[11px] text-slate-400">· {chk.category}</span>
                    <span
                      className={`text-[11px] font-semibold ${
                        chk.status === 'pass'
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : chk.status === 'warning'
                            ? 'text-amber-700 dark:text-amber-400'
                            : 'text-rose-700 dark:text-rose-400'
                      }`}
                    >
                      ·{' '}
                      {chk.status === 'pass'
                        ? 'تأیید‌شده'
                        : chk.status === 'warning'
                          ? 'هشدار'
                          : 'خطای بحرانی'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-400">{chk.summary}</p>
                  {chk.details.length > 0 && (
                    <ul className="mt-2 space-y-1 text-[11px] text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-2.5">
                      {chk.details.map((d, idx) => (
                        <li key={idx} className="font-code">
                          • {d}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              <div className="shrink-0 flex items-center gap-2 no-print">
                {chk.id === 'voucher-sequence' && chk.status !== 'pass' && (
                  <button
                    onClick={() => renumberVouchersChronologically()}
                    className="px-3 py-1.5 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg whitespace-nowrap"
                  >
                    مرتب‌سازی خودکار
                  </button>
                )}
                <button
                  onClick={() => onNavigate(chk.targetModule)}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-teal-700 dark:text-teal-400 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                >
                  <span>بررسی در ماژول</span>
                  <ArrowLeft className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
