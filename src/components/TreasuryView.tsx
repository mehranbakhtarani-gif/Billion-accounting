import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeftRight,
  Calculator,
  CheckCircle2,
  Edit3,
  FileSpreadsheet,
  Plus,
  Printer,
  RotateCcw,
  Send,
  X,
} from 'lucide-react';
import { useAccounting } from '../context/AccountingContext';
import { Cheque, ChequeDirection, ChequeStatus } from '../types/accounting';
import {
  calculateChequeRasGiri,
  formatMoney,
  getTodayShamsi,
  toPersianDigits,
} from '../lib/format';
import { addDaysToShamsi, diffShamsiDays, useChequeAlertPreferences } from '../lib/chequeAlerts';
import { fuzzyFilterAndRank } from '../lib/fuzzySearch';
import { numberToPersianWords } from '../lib/enterpriseAccounting';
import { parseCsvRow, reconcileBankLines } from '../lib/enterpriseControls';
import { computeFxRevaluationReport } from '../lib/enterpriseAccounting';
import { SmartSearchCombobox, SmartSearchOption } from './SmartSearchCombobox';
import { FuzzyTableOption, FuzzyTableSearch } from './FuzzyTableSearch';

const CHEQUE_STATUS_LABELS: Record<ChequeStatus, string> = {
  in_box: 'نزد صندوق',
  deposited: 'واگذار به بانک',
  endorsed: 'خرج‌شده (واگذار به غیر)',
  cleared: 'پاس / وصول‌شده',
  bounced: 'برگشتی',
  cancelled: 'ابطال‌شده',
};

interface TreasuryViewProps {
  initialIntent?: string;
  clearIntent?: () => void;
}

export const TreasuryView: React.FC<TreasuryViewProps> = ({ initialIntent, clearIntent }) => {
  const {
    cheques,
    parties,
    accounts,
    vouchers,
    currencies,
    exchangeRates,
    trialBalance,
    profile,
    addCheque,
    updateCheque,
    updateChequeStatus,
    recordQuickTreasury,
    recordBankTransfer,
    createVoucher,
    postFxRevaluationVoucher,
    showToast,
  } = useAccounting();
  const unit = profile.currencyUnit;
  const { prefs: alertPrefs } = useChequeAlertPreferences();

  const [tab, setTab] = useState<
    'cheques' | 'quick' | 'transfer' | 'rasgiri' | 'reconciliation' | 'cheque-print' | 'fx' | 'fx-revaluation'
  >('cheques');
  const [showAddCheque, setShowAddCheque] = useState(false);

  // Bank Reconciliation state
  const [reconBankCode, setReconBankCode] = useState('10201');
  const [bankCsvText, setBankCsvText] = useState(
    '1405/08/18,واریز تسویه فاکتور فروش نخ,12500000000,0\n1405/08/22,کارمزد صدور ضمانت‌نامه و حواله ساتنا,0,18500000\n1405/08/25,سود سپرده کوتاه‌مدت ماهانه,42000000,0'
  );

  // Calibrated Sayadi Cheque Physical Print state
  const [printChequeId, setPrintChequeId] = useState<string>('');
  const [printOffsetXmm, setPrintOffsetXmm] = useState<number>(0);
  const [printOffsetYmm, setPrintOffsetYmm] = useState<number>(0);
  const [printNationalId, setPrintNationalId] = useState<string>('14008912345');
  const [dirFilter, setDirFilter] = useState<'all' | ChequeDirection>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | ChequeStatus>('all');
  const [chequeSearch, setChequeSearch] = useState('');
  const [highlightedChequeId, setHighlightedChequeId] = useState<string | null>(null);

  // Cash & Bank Moein Accounts
  const treasuryAccounts = useMemo(
    () =>
      accounts
        .filter((a) => a.level === 'moein' && (a.code.startsWith('101') || a.code.startsWith('102')))
        .sort((a, b) => a.code.localeCompare(b.code)),
    [accounts]
  );

  const bankAccounts = useMemo(
    () => treasuryAccounts.filter((a) => a.code.startsWith('102')),
    [treasuryAccounts]
  );

  const accountBalanceMap = useMemo(() => {
    const map = new Map<string, number>();
    trialBalance.forEach((r) => map.set(r.accountCode, r.balanceDebit - r.balanceCredit));
    return map;
  }, [trialBalance]);

  // Global Fuzzy Search options for Cheques
  const chequeSearchOptions: FuzzyTableOption[] = useMemo(
    () =>
      cheques.map((c) => ({
        id: c.id,
        code: toPersianDigits(c.sayadiId),
        label: `${c.partyName} — ${c.direction === 'receivable' ? 'دریافتی' : 'پرداختی'} (${CHEQUE_STATUS_LABELS[c.status]})`,
        sublabel: `سریال ${c.serial} · ${c.bankName} · سررسید ${toPersianDigits(c.dueDate)}`,
        meta: formatMoney(c.amount, unit),
        metaTone:
          c.status === 'cleared'
            ? 'positive'
            : c.status === 'bounced' || c.status === 'cancelled'
              ? 'negative'
              : 'warning',
        keywords: `${c.sayadiId} ${c.serial} ${c.partyName} ${c.bankName} ${c.dueDate} ${c.amount} ${CHEQUE_STATUS_LABELS[c.status]} ${c.notes || ''}`,
      })),
    [cheques, unit]
  );

  const partyOptions: SmartSearchOption[] = useMemo(
    () =>
      parties.map((p) => ({
        id: p.id,
        code: p.code,
        label: p.name,
        sublabel: p.phone || p.nationalId || 'طرف‌حساب شرکتی',
        keywords: `${p.code} ${p.name} ${p.phone ?? ''} ${p.nationalId ?? ''}`,
      })),
    [parties]
  );

  const treasuryAccountOptions: SmartSearchOption[] = useMemo(
    () =>
      treasuryAccounts.map((acc) => ({
        id: acc.code,
        code: acc.code,
        label: acc.title,
        meta: formatMoney(accountBalanceMap.get(acc.code) ?? 0, unit),
        metaTone: (accountBalanceMap.get(acc.code) ?? 0) < 0 ? 'negative' : 'positive',
        keywords: `${acc.code} ${acc.title}`,
      })),
    [treasuryAccounts, accountBalanceMap, unit]
  );

  // Add Cheque state
  const [direction, setDirection] = useState<ChequeDirection>('receivable');
  const [sayadiId, setSayadiId] = useState('');
  const [serial, setSerial] = useState('');
  const [partyId, setPartyId] = useState(parties[0]?.id ?? '');
  const [bankName, setBankName] = useState('بانک ملت');
  const [branch, setBranch] = useState('شعبه مرکزی');
  const [amount, setAmount] = useState(2_500_000_000);
  const [issueDate, setIssueDate] = useState(getTodayShamsi());
  const [dueDate, setDueDate] = useState(() => addDaysToShamsi(getTodayShamsi(), 2));
  const [notes, setNotes] = useState('');

  // Edit Cheque modal
  const [editingCheque, setEditingCheque] = useState<Cheque | null>(null);
  const [editBankName, setEditBankName] = useState('');
  const [editBranch, setEditBranch] = useState('');
  const [editDueDate, setEditDueDate] = useState('');
  const [editNotes, setEditNotes] = useState('');

  // Status Transition Modal (cleared / endorsed / revert from cleared)
  const [pendingTransition, setPendingTransition] = useState<{
    cheque: Cheque;
    targetStatus: ChequeStatus;
  } | null>(null);
  const [transitionBankCode, setTransitionBankCode] = useState('10201');
  const [transitionEndorsePartyId, setTransitionEndorsePartyId] = useState(parties[0]?.id ?? '');

  // Quick Receipt / Payment state
  const [txDir, setTxDir] = useState<'receipt' | 'payment'>('receipt');
  const [txAccountCode, setTxAccountCode] = useState(treasuryAccounts[0]?.code ?? '10201');
  const [txPartyId, setTxPartyId] = useState(parties[0]?.id ?? '');
  const [txAmount, setTxAmount] = useState(1_000_000_000);
  const [txDate, setTxDate] = useState(getTodayShamsi());
  const [txDesc, setTxDesc] = useState('');

  // Bank/Cash Transfer state
  const [fromAccountCode, setFromAccountCode] = useState(treasuryAccounts[0]?.code ?? '10101');
  const [toAccountCode, setToAccountCode] = useState(
    treasuryAccounts[1]?.code ?? treasuryAccounts[0]?.code ?? '10201'
  );
  const [transferAmount, setTransferAmount] = useState(500_000_000);
  const [transferDate, setTransferDate] = useState(getTodayShamsi());
  const [transferDesc, setTransferDesc] = useState('');

  // Ras-Giri
  const [baseDate, setBaseDate] = useState(getTodayShamsi());
  const [rasItems, setRasItems] = useState<{ amount: number; dueDate: string }[]>([
    { amount: 5_000_000_000, dueDate: '1405/09/15' },
    { amount: 3_000_000_000, dueDate: '1405/10/15' },
    { amount: 4_000_000_000, dueDate: '1405/11/20' },
  ]);

  useEffect(() => {
    if (!initialIntent) return;
    if (initialIntent.startsWith('cheque:')) {
      const targetId = initialIntent.slice('cheque:'.length);
      setTab('cheques');
      setDirFilter('all');
      setStatusFilter('all');
      setChequeSearch('');
      setHighlightedChequeId(targetId);
    } else if (initialIntent === 'cheques') {
      setTab('cheques');
    } else if (initialIntent === 'new-cheque') {
      setTab('cheques');
      setShowAddCheque(true);
    } else if (initialIntent === 'quick') {
      setTab('quick');
    } else if (initialIntent === 'transfer') {
      setTab('transfer');
    } else if (initialIntent === 'rasgiri') {
      setTab('rasgiri');
    } else if (initialIntent === 'reconciliation') {
      setTab('reconciliation');
    } else if (initialIntent === 'cheque-print') {
      setTab('cheque-print');
    } else if (initialIntent === 'fx') {
      setTab('fx');
    } else if (initialIntent === 'fx-revaluation') {
      setTab('fx-revaluation');
    }
    clearIntent?.();
  }, [initialIntent, clearIntent]);

  useEffect(() => {
    if (!txAccountCode && treasuryAccounts.length > 0) {
      setTxAccountCode(treasuryAccounts[0].code);
    }
  }, [treasuryAccounts, txAccountCode]);

  const rasResult = useMemo(
    () => calculateChequeRasGiri(rasItems, baseDate),
    [rasItems, baseDate]
  );

  // Match statement lines one-to-one by signed amount and date; ambiguous matches require review.
  // CSV: date,description,deposit,withdrawal,reference (reference is optional).
  const reconResult = useMemo(() => {
    const ledgerTx: { id: string; voucherNumber: number; date: string; desc: string; debit: number; credit: number; amount: number; reference?: string }[] = [];
    vouchers.forEach((v) => v.lines.forEach((l, index) => {
      if (l.accountCode === reconBankCode) ledgerTx.push({
        id: `${v.id}:${index}`, voucherNumber: v.voucherNumber, date: v.date,
        desc: l.description || v.description, debit: l.debit || 0, credit: l.credit || 0,
        amount: (l.debit || 0) - (l.credit || 0), reference: v.referenceId || v.id,
      });
    }));
    const parsedBankRows = bankCsvText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, idx) => {
      const parts = parseCsvRow(line);
      const date = (parts[0] || '').trim();
      const desc = (parts[1] || '').trim() || ('تراکنش بانکی ' + (idx + 1));
      const parseAmount = (raw: string | undefined) => {
        if (!raw?.trim()) return 0;
        const normalized = raw.replace(/[،٬,\s]/g, '');
        return /^-?\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : Number.NaN;
      };
      const deposit = parseAmount(parts[2]);
      const withdrawal = parseAmount(parts[3]);
      let validationError: string | undefined;
      if (!/^14\d{2}\/\d{2}\/\d{2}$/.test(date) || diffShamsiDays(date, date) !== 0) validationError = 'تاریخ شمسی معتبر نیست.';
      else if (!Number.isFinite(deposit) || !Number.isFinite(withdrawal) || deposit < 0 || withdrawal < 0) validationError = 'مبلغ واریز یا برداشت معتبر نیست.';
      else if ((deposit > 0 && withdrawal > 0) || (deposit === 0 && withdrawal === 0)) validationError = 'هر ردیف باید فقط یک مبلغ مثبت در ستون واریز یا برداشت داشته باشد.';
      return { id: 'bk_' + idx, date, desc, deposit, withdrawal, reference: parts[4]?.trim() || undefined, amount: deposit - withdrawal, validationError };
    });
    const validBankRows = parsedBankRows.filter((row) => !row.validationError);
    const matching = reconcileBankLines(
      validBankRows.map((row) => ({ id: row.id, accountId: reconBankCode, date: row.date, amount: row.amount, reference: row.reference })),
      ledgerTx.map((tx) => ({ id: tx.id, accountId: reconBankCode, date: tx.date, amount: tx.amount, reference: tx.reference })),
      2, (from, to) => diffShamsiDays(from, to) ?? Number.POSITIVE_INFINITY,
    );
    const matchByStatement = new Map(matching.matches.map((match) => [match.statementLineId, match.ledgerLineId]));
    const ambiguousIds = new Set(matching.ambiguousStatementIds);
    const bankRows = parsedBankRows.map((row) => ({ ...row, matched: ledgerTx.find((tx) => tx.id === matchByStatement.get(row.id)), ambiguous: ambiguousIds.has(row.id) }));
    return {
      ledgerTx, bankRows, matchedCount: matching.matches.length,
      unmatchedRows: bankRows.filter((row) => !row.validationError && !row.matched && !row.ambiguous),
      invalidCount: bankRows.filter((row) => row.validationError).length,
      ambiguousCount: matching.ambiguousStatementIds.length, unmatchedLedgerCount: matching.unmatchedLedgerIds.length,
    };
  }, [bankCsvText, reconBankCode, vouchers]);

  const handlePostBankAdjustment = async (row: {
    date: string;
    desc: string;
    deposit: number;
    withdrawal: number;
  }) => {
    const bankAcc = accounts.find((a) => a.code === reconBankCode && a.level === 'moein' && a.code.startsWith('102'));
    if (!bankAcc) throw new Error('حساب بانکی انتخاب‌شده معتبر نیست.');
    if (!/^14\d{2}\/\d{2}\/\d{2}$/.test(row.date) || diffShamsiDays(row.date, row.date) !== 0 ||
        !Number.isFinite(row.deposit) || !Number.isFinite(row.withdrawal) || row.deposit < 0 || row.withdrawal < 0 ||
        (row.deposit > 0 && row.withdrawal > 0) || (row.deposit === 0 && row.withdrawal === 0)) {
      throw new Error('ردیف صورت‌حساب بانک دارای تاریخ یا مبلغ نامعتبر است.');
    }
    const bankTitle = bankAcc.title;
    const referenceId = 'bank-recon:' + reconBankCode + ':' + row.date + ':' + row.id + ':' + row.deposit + ':' + row.withdrawal;
    if (vouchers.some((voucher) => voucher.referenceId === referenceId)) {
      showToast('برای این ردیف صورت‌حساب قبلاً سند مغایرت ثبت شده است.');
      return;
    }
    if (row.withdrawal > 0) {
      await createVoucher({
        date: row.date,
        description: `سند مغایرت‌گیری بانکی (کارمزد/برداشت): ${row.desc}`,
        voucherType: 'treasury',
        status: 'permanent',
        referenceId,
        lines: [
          {
            accountCode: '80901',
            accountTitle: 'زیان تسعیر ارز و کارمزد خدمات بانکی',
            description: row.desc,
            debit: row.withdrawal,
            credit: 0,
          },
          {
            accountCode: reconBankCode,
            accountTitle: bankTitle,
            description: `برداشت بانکی — ${row.desc}`,
            debit: 0,
            credit: row.withdrawal,
          },
        ],
      });
    } else if (row.deposit > 0) {
      await createVoucher({
        date: row.date,
        description: `سند مغایرت‌گیری بانکی (سود/واریزی): ${row.desc}`,
        voucherType: 'treasury',
        status: 'permanent',
        referenceId,
        lines: [
          {
            accountCode: reconBankCode,
            accountTitle: bankTitle,
            description: row.desc,
            debit: row.deposit,
            credit: 0,
          },
          {
            accountCode: '60301',
            accountTitle: 'اضافی انبارگردانی و درآمدهای متفرقه',
            description: `درآمد بانکی — ${row.desc}`,
            debit: 0,
            credit: row.deposit,
          },
        ],
      });
    }
  };

  const [fxAsOfDate, setFxAsOfDate] = useState(getTodayShamsi());
  const fxRevaluationRows = useMemo(
    () => computeFxRevaluationReport(vouchers, exchangeRates, currencies, fxAsOfDate),
    [vouchers, exchangeRates, currencies, fxAsOfDate]
  );
  const fxRevaluationNet = fxRevaluationRows.reduce((sum, row) => sum + row.revaluationDiffIrr, 0);
  const foreignBalances = useMemo(() => {
    const balances = new Map<string, { currencyCode: string; accountCode: string; accountTitle: string; foreignBalance: number; baseBalance: number }>();
    vouchers.filter((voucher) => voucher.status === 'permanent' && voucher.currencyCode && voucher.currencyCode !== 'IRR').forEach((voucher) => {
      voucher.lines.forEach((line) => {
        if (!['101', '102', '103', '104', '301', '302'].some((prefix) => line.accountCode.startsWith(prefix))) return;
        const key = `${voucher.currencyCode}:${line.accountCode}`;
        const current = balances.get(key) || { currencyCode: voucher.currencyCode!, accountCode: line.accountCode, accountTitle: line.accountTitle, foreignBalance: 0, baseBalance: 0 };
        const rate = voucher.exchangeRate && voucher.exchangeRate > 0 ? voucher.exchangeRate : 1;
        const foreignDebit = line.foreignDebit ?? ((line.debit || 0) > 0 ? (line.debit || 0) / rate : 0);
        const foreignCredit = line.foreignCredit ?? ((line.credit || 0) > 0 ? (line.credit || 0) / rate : 0);
        current.foreignBalance += foreignDebit - foreignCredit;
        current.baseBalance += (line.debit || 0) - (line.credit || 0);
        balances.set(key, current);
      });
    });
    return [...balances.values()].filter((row) => Math.abs(row.foreignBalance) > 0.000001 || Math.abs(row.baseBalance) > 0.5).sort((a, b) => a.currencyCode.localeCompare(b.currencyCode) || a.accountCode.localeCompare(b.accountCode));
  }, [vouchers]);
  const selectedPrintCheque = useMemo(() => {
    const target = cheques.find((c) => c.id === printChequeId);
    return target || cheques.find((c) => c.direction === 'payable') || cheques[0] || null;
  }, [cheques, printChequeId]);

  const scopedCheques = useMemo(
    () =>
      cheques.filter((c) => {
        if (dirFilter !== 'all' && c.direction !== dirFilter) return false;
        if (statusFilter !== 'all' && c.status !== statusFilter) return false;
        return true;
      }),
    [cheques, dirFilter, statusFilter]
  );

  const filteredCheques = useMemo(() => {
    const ranked = fuzzyFilterAndRank(scopedCheques, chequeSearch, (c) => [
      { text: c.sayadiId, weight: 1.45 },
      { text: c.serial, weight: 1.3 },
      { text: c.partyName, weight: 1.25 },
      { text: c.bankName, weight: 1.0 },
      { text: c.dueDate, weight: 1.05 },
      { text: String(c.amount), weight: 0.9 },
      { text: CHEQUE_STATUS_LABELS[c.status], weight: 0.85 },
      { text: c.notes, weight: 0.8 },
    ]);
    return ranked.map((r) => r.item);
  }, [scopedCheques, chequeSearch]);

  const handleCreateCheque = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sayadiId.trim().length < 6 || !serial.trim() || amount <= 0) {
      showToast('شناسه صیادی، شماره سریال و مبلغ معتبر چک را وارد کنید.');
      return;
    }
    const p = parties.find((x) => x.id === partyId);
    if (!p) {
      showToast('لطفاً طرف‌حساب را انتخاب کنید.');
      return;
    }
    await addCheque({
      sayadiId: sayadiId.trim(),
      serial: serial.trim(),
      direction,
      partyId: p.id,
      partyName: p.name,
      bankName,
      branch,
      amount,
      issueDate,
      dueDate,
      status: 'in_box',
      notes: notes.trim() || undefined,
    });
    setSayadiId('');
    setSerial('');
    setNotes('');
    setShowAddCheque(false);
  };

  const openEditCheque = (ch: Cheque) => {
    setEditingCheque(ch);
    setEditBankName(ch.bankName);
    setEditBranch(ch.branch ?? '');
    setEditDueDate(ch.dueDate);
    setEditNotes(ch.notes ?? '');
  };

  const handleSaveChequeEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingCheque) return;
    await updateCheque(editingCheque.id, {
      bankName: editBankName.trim() || editingCheque.bankName,
      branch: editBranch.trim() || undefined,
      dueDate: editDueDate.trim() || editingCheque.dueDate,
      notes: editNotes.trim() || undefined,
    });
    setEditingCheque(null);
  };

  const handleStatusSelectChange = async (ch: Cheque, nextStatus: ChequeStatus) => {
    if (nextStatus === ch.status) return;
    if (nextStatus === 'endorsed') {
      if (ch.direction !== 'receivable') {
        showToast('تنها چک‌های دریافتی قابل خرج کردن (واگذاری به غیر) هستند.');
        return;
      }
      setTransitionEndorsePartyId(parties.find((p) => p.id !== ch.partyId)?.id ?? parties[0]?.id ?? '');
      setPendingTransition({ cheque: ch, targetStatus: 'endorsed' });
      return;
    }
    if (nextStatus === 'cleared' || (ch.status === 'cleared' && nextStatus === 'in_box')) {
      setTransitionBankCode(bankAccounts[0]?.code ?? '10201');
      setPendingTransition({ cheque: ch, targetStatus: nextStatus });
      return;
    }
    await updateChequeStatus(ch.id, nextStatus);
  };

  const confirmPendingTransition = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingTransition) return;
    const { cheque, targetStatus } = pendingTransition;
    if (targetStatus === 'endorsed') {
      if (!transitionEndorsePartyId) {
        showToast('طرف‌حساب دریافت‌کننده چک خرج‌شده را انتخاب کنید.');
        return;
      }
      await updateChequeStatus(cheque.id, 'endorsed', {
        endorsePartyId: transitionEndorsePartyId,
      });
    } else {
      await updateChequeStatus(cheque.id, targetStatus, {
        bankAccountCode: transitionBankCode,
      });
    }
    setPendingTransition(null);
  };

  const handleQuickTx = async (e: React.FormEvent) => {
    e.preventDefault();
    if (txAmount <= 0 || !txDesc.trim() || !txAccountCode) {
      showToast('حساب خزانه، مبلغ و شرح دریافت/پرداخت را وارد کنید.');
      return;
    }
    await recordQuickTreasury({
      direction: txDir,
      accountCode: txAccountCode,
      partyId: txPartyId,
      amount: txAmount,
      date: txDate,
      description: txDesc.trim(),
    });
    setTxDesc('');
  };

  const handleTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fromAccountCode || !toAccountCode || fromAccountCode === toAccountCode) {
      showToast('حساب مبدأ و مقصد انتقال باید متفاوت باشند.');
      return;
    }
    if (transferAmount <= 0) {
      showToast('مبلغ انتقال باید بزرگ‌تر از صفر باشد.');
      return;
    }
    await recordBankTransfer({
      fromAccountCode,
      toAccountCode,
      amount: transferAmount,
      date: transferDate,
      description: transferDesc.trim() || 'انتقال وجه بین حساب‌های خزانه',
    });
    setTransferDesc('');
  };

  const receivableTotal = cheques
    .filter((c) => c.direction === 'receivable' && c.status !== 'cleared' && c.status !== 'cancelled')
    .reduce((s, c) => s + c.amount, 0);
  const payableTotal = cheques
    .filter((c) => c.direction === 'payable' && c.status !== 'cleared' && c.status !== 'cancelled')
    .reduce((s, c) => s + c.amount, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">
            خزانه‌داری، چک صیادی، بانک و راس‌گیری (F7)
          </h1>
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 flex flex-wrap gap-2">
            <span>
              چک‌های دریافتنی در جریان:{' '}
              <strong className="font-code tabular-nums text-emerald-700 dark:text-emerald-400">
                {formatMoney(receivableTotal, unit)}
              </strong>
            </span>
            <span>·</span>
            <span>
              چک‌های پرداختنی در جریان:{' '}
              <strong className="font-code tabular-nums text-rose-700 dark:text-rose-400">
                {formatMoney(payableTotal, unit)}
              </strong>
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 overflow-x-auto">
          {[
            { id: 'cheques', label: 'مدیریت چک صیادی' },
            { id: 'quick', label: 'دریافت و پرداخت سریع' },
            { id: 'transfer', label: 'انتقال بین بانکی' },
            { id: 'rasgiri', label: 'راس‌گیری چک' },
            { id: 'reconciliation', label: 'مغایرت‌گیری بانکی' },
            { id: 'cheque-print', label: 'چاپ چک صیادی' },
            { id: 'fx', label: 'مانده حساب‌های ارزی' },
            { id: 'fx-revaluation', label: 'گزارش و سند تسعیر ارز' },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id as typeof tab)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                tab === t.id
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Live Cash & Bank Balances Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {treasuryAccounts.map((acc) => {
          const bal = accountBalanceMap.get(acc.code) ?? 0;
          return (
            <div
              key={acc.id}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5"
            >
              <div className="flex items-center justify-between text-[11px] text-slate-500">
                <span className="truncate">{acc.title}</span>
                <span className="font-code text-teal-700 dark:text-teal-400">{acc.code}</span>
              </div>
              <div
                className={`mt-1.5 text-sm font-bold font-code tabular-nums ${
                  bal < 0
                    ? 'text-rose-700 dark:text-rose-400'
                    : 'text-slate-900 dark:text-white'
                }`}
              >
                {formatMoney(bal, unit)}
              </div>
            </div>
          );
        })}
      </div>

      {tab === 'fx-revaluation' && (
        <div className="space-y-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-wrap items-end justify-between gap-3">
            <div><label className="block text-xs text-slate-500 mb-1">تاریخ مبنای تسعیر</label>
              <input value={fxAsOfDate} onChange={(e) => setFxAsOfDate(e.target.value)} className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 font-code text-xs" /></div>
            <div className="text-xs"><div className="text-slate-500">خالص سود / (زیان) تسعیر</div>
              <strong className={`font-code text-base ${fxRevaluationNet >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{formatMoney(fxRevaluationNet, unit)}</strong></div>
            <button disabled={fxRevaluationRows.every((row) => Math.abs(row.revaluationDiffIrr) < 1) || vouchers.some((v) => v.referenceId === `fx-revaluation:${fxAsOfDate}`)}
              onClick={async () => {
                await postFxRevaluationVoucher(fxRevaluationRows, fxAsOfDate);
              }} className="px-4 py-2 rounded-lg bg-teal-700 text-white text-xs font-semibold disabled:opacity-40">صدور سند تسعیر ارز</button>
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/20 p-3 text-xs text-amber-900 dark:text-amber-200">
            این گزارش فقط اسناد دائم و حساب‌های پولی ارزی را لحاظ می‌کند. نرخ مؤثر از نرخ‌های ثبت‌شده تا تاریخ مبنا گرفته می‌شود؛ قبل از صدور سند، نرخ‌های روز و طبقه‌بندی حساب‌ها را بررسی کنید. سند هر تاریخ فقط یک‌بار قابل صدور است.
          </div>
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="overflow-x-auto"><table className="w-full text-right text-xs">
              <thead><tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                <th className="px-3 py-3">حساب / طرف‌حساب</th><th className="px-3 py-3">ارز</th><th className="px-3 py-3 text-left">مانده ارزی</th>
                <th className="px-3 py-3 text-left">نرخ مبنا</th><th className="px-3 py-3 text-left">مانده تسعیرشده</th><th className="px-3 py-3 text-left">اختلاف تسعیر</th>
              </tr></thead><tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {fxRevaluationRows.length === 0 ? <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-500">مانده پولی ارزی برای تسعیر وجود ندارد یا نرخ معتبری ثبت نشده است.</td></tr> : fxRevaluationRows.map((row) => (
                  <tr key={row.key}><td className="px-3 py-3"><div className="font-semibold">{row.accountTitle}</div><div className="text-[10px] text-slate-500">{row.accountCode}{row.partyName ? ` · ${row.partyName}` : ''}</div></td>
                    <td className="px-3 py-3 font-bold text-sky-700">{row.currencyCode}</td>
                    <td className="px-3 py-3 text-left font-code">{toPersianDigits(row.netForeignBalance.toLocaleString('en-US', { maximumFractionDigits: 4 }))}</td>
                    <td className="px-3 py-3 text-left font-code">{toPersianDigits(row.currentRateToIrr.toLocaleString('en-US'))}</td>
                    <td className="px-3 py-3 text-left font-code">{formatMoney(row.revaluedIrrBalance, unit, false)}</td>
                    <td className={`px-3 py-3 text-left font-code font-bold ${row.revaluationDiffIrr >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{formatMoney(row.revaluationDiffIrr, unit, false)}</td>
                  </tr>
                ))}
              </tbody></table></div>
          </div>
        </div>
      )}

      {tab === 'fx' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-sky-200 bg-sky-50 dark:border-sky-900/60 dark:bg-sky-950/20 p-4 text-xs text-sky-900 dark:text-sky-200">
            مانده ارزی بر اساس اسناد دائم دارای ارز و مبالغ ارزی ثبت‌شده در ردیف‌های سند محاسبه می‌شود. این گزارش جایگزین دفتر تفصیلی بانک ارزی یا تطبیق صورت‌حساب ارزی نیست.
          </div>
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h2 className="font-bold text-sm text-slate-900 dark:text-white">دفتر مانده حساب‌های ارزی</h2>
              <span className="text-[11px] text-slate-500">{toPersianDigits(foreignBalances.length)} ردیف حساب / ارز</span>
            </div>
            <div className="overflow-x-auto"><table className="w-full text-right text-xs">
              <thead><tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                <th className="px-4 py-3">ارز</th><th className="px-4 py-3">کد حساب</th><th className="px-4 py-3">عنوان حساب</th>
                <th className="px-4 py-3 text-left">مانده ارزی</th><th className="px-4 py-3 text-left">معادل ریالی ثبت‌شده</th>
              </tr></thead><tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {foreignBalances.length === 0 ? <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-500">سند دائم ارزی برای نمایش مانده ثبت نشده است.</td></tr> : foreignBalances.map((row) => (
                  <tr key={`${row.currencyCode}:${row.accountCode}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="px-4 py-3 font-bold text-sky-700 dark:text-sky-300">{row.currencyCode}</td>
                    <td className="px-4 py-3 font-code">{row.accountCode}</td><td className="px-4 py-3">{row.accountTitle}</td>
                    <td className="px-4 py-3 text-left font-code font-bold">{toPersianDigits(row.foreignBalance.toLocaleString('en-US', { maximumFractionDigits: 4 }))}</td>
                    <td className="px-4 py-3 text-left font-code">{formatMoney(row.baseBalance, unit, false)}</td>
                  </tr>
                ))}
              </tbody></table></div>
          </div>
        </div>
      )}

      {tab === 'cheques' && (
        <div className="space-y-4">
          {/* Smart Cheque Search Bar */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-col lg:flex-row lg:items-end justify-between gap-3">
            <div className="flex-1 min-w-[260px]">
              <label className="block text-[11px] font-medium text-slate-500 mb-1">
                جستجوی هوشمند چک (اولین ارقام صیادی، سریال، مبلغ، سررسید یا نام طرف‌حساب را تایپ کنید)
              </label>
              <FuzzyTableSearch
                options={chequeSearchOptions}
                query={chequeSearch}
                onQueryChange={(q) => {
                  setChequeSearch(q);
                  if (!q) setHighlightedChequeId(null);
                }}
                totalCount={scopedCheques.length}
                matchedCount={filteredCheques.length}
                entityLabel="چک صیادی"
                onSelect={(opt) => {
                  const found = cheques.find((c) => c.id === opt.id);
                  if (found) {
                    setHighlightedChequeId(found.id);
                    setChequeSearch(found.sayadiId);
                  }
                }}
                placeholder="جستجوی فازی چک (صیادی، سریال، طرف‌حساب، بانک، سررسید یا مبلغ)..."
                emptyText="چکی با این مشخصات یافت نشد."
              />
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <select
                value={dirFilter}
                onChange={(e) => setDirFilter(e.target.value as 'all' | ChequeDirection)}
                className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="all">همه چک‌ها</option>
                <option value="receivable">فقط دریافتی</option>
                <option value="payable">فقط پرداختی</option>
              </select>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as 'all' | ChequeStatus)}
                className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="all">همه وضعیت‌ها</option>
                {Object.entries(CHEQUE_STATUS_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
              <button
                onClick={() => setShowAddCheque(true)}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg whitespace-nowrap"
              >
                <Plus className="w-4 h-4" />
                <span>ثبت چک صیادی جدید</span>
              </button>
            </div>
          </div>

          {showAddCheque && (
            <form
              onSubmit={handleCreateCheque}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4 text-xs"
            >
              <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
                <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                  ثبت چک صیادی با صدور سند دوبل اتوماتیک
                </h2>
                <button type="button" onClick={() => setShowAddCheque(false)}>
                  <X className="w-4 h-4 text-slate-500" />
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-3">
                <div>
                  <label className="block text-slate-500 mb-1">نوع چک</label>
                  <select
                    value={direction}
                    onChange={(e) => setDirection(e.target.value as ChequeDirection)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    <option value="receivable">چک دریافتی از مشتری</option>
                    <option value="payable">چک پرداختی به تأمین‌کننده</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-500 mb-1">شناسه ۱۶ رقمی صیادی</label>
                  <input
                    value={sayadiId}
                    onChange={(e) => setSayadiId(e.target.value)}
                    placeholder="2849103847561920"
                    className="w-full px-3 py-2 font-code rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-slate-500 mb-1">شماره سریال چک</label>
                  <input
                    value={serial}
                    onChange={(e) => setSerial(e.target.value)}
                    placeholder="449812/05"
                    className="w-full px-3 py-2 font-code rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-slate-500 mb-1">طرف‌حساب (جستجوی هوشمند)</label>
                  <SmartSearchCombobox
                    options={partyOptions}
                    value={partyId}
                    onSelect={(opt) => setPartyId(opt.id)}
                    placeholder="جستجوی طرف‌حساب..."
                    mode="picker"
                  />
                </div>
                <div>
                  <label className="block text-slate-500 mb-1">بانک</label>
                  <input
                    value={bankName}
                    onChange={(e) => setBankName(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-slate-500 mb-1">شعبه</label>
                  <input
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-slate-500 mb-1">مبلغ چک (ریال)</label>
                  <input
                    type="number"
                    min={1}
                    value={amount}
                    onChange={(e) => setAmount(Number(e.target.value))}
                    className="w-full px-3 py-2 font-code rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-slate-500 mb-1">تاریخ سررسید</label>
                  <input
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className="w-full px-3 py-2 font-code rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-slate-500 mb-1">تاریخ صدور</label>
                  <input
                    value={issueDate}
                    onChange={(e) => setIssueDate(e.target.value)}
                    className="w-full px-3 py-2 font-code rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div className="md:col-span-2 lg:col-span-3">
                  <label className="block text-slate-500 mb-1">توضیحات / بابت</label>
                  <input
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="بابت تسویه فاکتور فروش..."
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  type="submit"
                  className="px-5 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg"
                >
                  ثبت چک و صدور سند خزانه
                </button>
              </div>
            </form>
          )}

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 text-slate-500">
                    <th className="py-3 px-4">شناسه صیادی</th>
                    <th className="py-3 px-4">نوع</th>
                    <th className="py-3 px-4">طرف‌حساب / بانک</th>
                    <th className="py-3 px-4">سررسید</th>
                    <th className="py-3 px-4 text-left">مبلغ</th>
                    <th className="py-3 px-4">وضعیت فعلی</th>
                    <th className="py-3 px-4">عملیات و گردش چک</th>
                    <th className="py-3 px-4 text-center">ویرایش</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {filteredCheques.map((ch) => (
                    <tr
                      key={ch.id}
                      className={
                        highlightedChequeId === ch.id
                          ? 'bg-teal-50/80 dark:bg-teal-950/40'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                      }
                    >
                      <td className="py-3 px-4 font-code font-semibold text-slate-900 dark:text-white">
                        {toPersianDigits(ch.sayadiId)}
                        <div className="text-[11px] text-slate-500">سریال {ch.serial}</div>
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span
                          className={
                            ch.direction === 'receivable'
                              ? 'text-emerald-700 dark:text-emerald-400 font-medium'
                              : 'text-rose-700 dark:text-rose-400 font-medium'
                          }
                        >
                          {ch.direction === 'receivable' ? 'دریافتی' : 'پرداختی'}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-900 dark:text-slate-100">
                          {ch.partyName}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {ch.bankName} {ch.branch ? `· ${ch.branch}` : ''}
                          {ch.notes ? ` · ${ch.notes}` : ''}
                        </div>
                      </td>
                      <td className="py-3 px-4 font-code font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap">
                        <div>{toPersianDigits(ch.dueDate)}</div>
                        {(ch.status === 'in_box' || ch.status === 'deposited') && (() => {
                          const days = diffShamsiDays(ch.dueDate);
                          if (days === null) return null;
                          if (days < 0) {
                            return (
                              <div className="text-[11px] font-sans font-semibold text-rose-700 dark:text-rose-400">
                                {toPersianDigits(Math.abs(days))} روز تاخیر
                              </div>
                            );
                          }
                          if (days === 0) {
                            return (
                              <div className="text-[11px] font-sans font-semibold text-rose-700 dark:text-rose-400">
                                سررسید امروز
                              </div>
                            );
                          }
                          if (days <= alertPrefs.leadDays) {
                            return (
                              <div className="text-[11px] font-sans font-semibold text-amber-700 dark:text-amber-400">
                                {days === 1 ? 'فردا (۱ روز مانده)' : `${toPersianDigits(days)} روز مانده`}
                              </div>
                            );
                          }
                          return (
                            <div className="text-[11px] font-sans font-normal text-slate-400">
                              {toPersianDigits(days)} روز دیگر
                            </div>
                          );
                        })()}
                      </td>
                      <td className="py-3 px-4 text-left font-code tabular-nums font-bold text-slate-900 dark:text-white">
                        {formatMoney(ch.amount, unit, false)}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span
                          className={`font-medium ${
                            ch.status === 'cleared'
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : ch.status === 'bounced' || ch.status === 'cancelled'
                                ? 'text-rose-700 dark:text-rose-400'
                                : 'text-amber-700 dark:text-amber-400'
                          }`}
                        >
                          {CHEQUE_STATUS_LABELS[ch.status]}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        {ch.status === 'cleared' ? (
                          <button
                            onClick={() => handleStatusSelectChange(ch, 'in_box')}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40 whitespace-nowrap"
                          >
                            <RotateCcw className="w-3 h-3" />
                            <span>عودت از وصول</span>
                          </button>
                        ) : ch.status !== 'cancelled' ? (
                          <select
                            value={ch.status}
                            onChange={(e) =>
                              handleStatusSelectChange(ch, e.target.value as ChequeStatus)
                            }
                            className="px-2.5 py-1 text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                          >
                            {Object.entries(CHEQUE_STATUS_LABELS)
                              .filter(
                                ([k]) =>
                                  !(ch.direction === 'payable' && (k === 'endorsed' || k === 'deposited'))
                              )
                              .map(([k, v]) => (
                                <option key={k} value={k}>
                                  {v}
                                </option>
                              ))}
                          </select>
                        ) : (
                          <span className="text-slate-400">ابطال‌شده</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <button
                          onClick={() => openEditCheque(ch)}
                          title="ویرایش مشخصات چک"
                          className="p-1.5 rounded-lg text-slate-500 hover:text-teal-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {filteredCheques.length === 0 && (
                    <tr>
                      <td colSpan={8} className="py-8 text-center text-slate-500">
                        چکی مطابق جستجو یا فیلتر انتخاب‌شده یافت نشد.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === 'quick' && (
        <form
          onSubmit={handleQuickTx}
          className="max-w-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 text-xs"
        >
          <h2 className="text-base font-bold text-slate-900 dark:text-white">
            عملیات دریافت و پرداخت سریع صندوق، تنخواه و بانک‌ها
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-slate-500 mb-1">نوع تراکنش</label>
              <select
                value={txDir}
                onChange={(e) => setTxDir(e.target.value as 'receipt' | 'payment')}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="receipt">دریافت وجه از طرف‌حساب</option>
                <option value="payment">پرداخت وجه به طرف‌حساب</option>
              </select>
            </div>
            <div>
              <label className="block text-slate-500 mb-1">حساب صندوق / تنخواه / بانک</label>
              <SmartSearchCombobox
                options={treasuryAccountOptions}
                value={txAccountCode}
                onSelect={(opt) => setTxAccountCode(opt.id)}
                placeholder="جستجوی صندوق یا بانک..."
                mode="picker"
              />
            </div>
            <div>
              <label className="block text-slate-500 mb-1">طرف‌حساب (جستجوی هوشمند)</label>
              <SmartSearchCombobox
                options={partyOptions}
                value={txPartyId}
                onSelect={(opt) => setTxPartyId(opt.id)}
                placeholder="نام یا کد طرف‌حساب..."
                mode="picker"
              />
            </div>
            <div>
              <label className="block text-slate-500 mb-1">مبلغ (ریال)</label>
              <input
                type="number"
                min={1}
                value={txAmount}
                onChange={(e) => setTxAmount(Number(e.target.value))}
                className="w-full px-3 py-2 font-code rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block text-slate-500 mb-1">تاریخ</label>
              <input
                value={txDate}
                onChange={(e) => setTxDate(e.target.value)}
                className="w-full px-3 py-2 font-code rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block text-slate-500 mb-1">شرح سند دریافت/پرداخت</label>
              <input
                value={txDesc}
                onChange={(e) => setTxDesc(e.target.value)}
                placeholder="بابت تسویه علی‌الحساب فاکتور..."
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
          </div>
          <div className="flex justify-end pt-2">
            <button
              type="submit"
              className="inline-flex items-center gap-2 px-5 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg"
            >
              <Send className="w-4 h-4" />
              <span>ثبت در خزانه و صدور سند دوبل</span>
            </button>
          </div>
        </form>
      )}

      {tab === 'transfer' && (
        <form
          onSubmit={handleTransfer}
          className="max-w-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 text-xs"
        >
          <div className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-800 pb-3">
            <ArrowLeftRight className="w-4 h-4 text-teal-700 dark:text-teal-400" />
            <h2 className="text-base font-bold text-slate-900 dark:text-white">
              حواله انتقال وجه بین صندوق، تنخواه‌گردان و حساب‌های بانکی
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-slate-500 mb-1">از حساب (بستانکار)</label>
              <SmartSearchCombobox
                options={treasuryAccountOptions}
                value={fromAccountCode}
                onSelect={(opt) => setFromAccountCode(opt.id)}
                placeholder="جستجوی حساب مبدأ..."
                mode="picker"
              />
            </div>
            <div>
              <label className="block text-slate-500 mb-1">به حساب (بدهکار)</label>
              <SmartSearchCombobox
                options={treasuryAccountOptions}
                value={toAccountCode}
                onSelect={(opt) => setToAccountCode(opt.id)}
                placeholder="جستجوی حساب مقصد..."
                mode="picker"
              />
            </div>
            <div>
              <label className="block text-slate-500 mb-1">مبلغ انتقال (ریال)</label>
              <input
                type="number"
                min={1}
                value={transferAmount}
                onChange={(e) => setTransferAmount(Number(e.target.value))}
                className="w-full px-3 py-2 font-code rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block text-slate-500 mb-1">تاریخ انتقال</label>
              <input
                value={transferDate}
                onChange={(e) => setTransferDate(e.target.value)}
                className="w-full px-3 py-2 font-code rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-slate-500 mb-1">شرح سند انتقال</label>
              <input
                value={transferDesc}
                onChange={(e) => setTransferDesc(e.target.value)}
                placeholder="مثلاً واریز وجه نقد صندوق به حساب جاری بانک ملت یا شارژ تنخواه"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
          </div>
          <div className="flex justify-end pt-2">
            <button
              type="submit"
              className="inline-flex items-center gap-2 px-5 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg"
            >
              <ArrowLeftRight className="w-4 h-4" />
              <span>ثبت انتقال وجه و صدور سند حسابداری</span>
            </button>
          </div>
        </form>
      )}

      {tab === 'rasgiri' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-8 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Calculator className="w-4 h-4 text-teal-700 dark:text-teal-400" />
                <span>محاسبه‌گر راس‌گیری چک</span>
              </h2>
              <div className="flex items-center gap-2">
                <span className="text-slate-500">تاریخ مبنا:</span>
                <input
                  value={baseDate}
                  onChange={(e) => setBaseDate(e.target.value)}
                  className="w-28 px-2.5 py-1.5 font-code rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>

            <div className="space-y-2">
              {rasItems.map((it, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                  <div className="col-span-1 font-code text-slate-400">
                    {toPersianDigits(idx + 1)}
                  </div>
                  <div className="col-span-5">
                    <input
                      type="number"
                      min={0}
                      value={it.amount}
                      onChange={(e) =>
                        setRasItems((prev) =>
                          prev.map((r, i) => (i === idx ? { ...r, amount: Number(e.target.value) } : r))
                        )
                      }
                      className="w-full px-3 py-1.5 font-code rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                  <div className="col-span-5">
                    <input
                      value={it.dueDate}
                      onChange={(e) =>
                        setRasItems((prev) =>
                          prev.map((r, i) => (i === idx ? { ...r, dueDate: e.target.value } : r))
                        )
                      }
                      placeholder="1405/10/15"
                      className="w-full px-3 py-1.5 font-code rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                  <div className="col-span-1 text-left">
                    {rasItems.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setRasItems((prev) => prev.filter((_, i) => i !== idx))}
                        className="text-rose-600 p-1"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-2">
              <button
                type="button"
                onClick={() =>
                  setRasItems((prev) => [...prev, { amount: 2_000_000_000, dueDate: '1405/12/01' }])
                }
                className="text-teal-700 dark:text-teal-400 font-semibold hover:underline"
              >
                + افزودن فقره چک
              </button>
              <span className="text-slate-300">·</span>
              <button
                type="button"
                onClick={() => {
                  const rec = cheques
                    .filter((c) => c.direction === 'receivable' && c.status !== 'cleared' && c.status !== 'cancelled')
                    .map((c) => ({ amount: c.amount, dueDate: c.dueDate }));
                  if (rec.length > 0) setRasItems(rec);
                  else showToast('چک دریافتی در جریانی ثبت نشده است.');
                }}
                className="text-slate-600 dark:text-slate-300 hover:underline"
              >
                بارگذاری چک‌های دریافتی
              </button>
              <span className="text-slate-300">·</span>
              <button
                type="button"
                onClick={() => {
                  const pay = cheques
                    .filter((c) => c.direction === 'payable' && c.status !== 'cleared' && c.status !== 'cancelled')
                    .map((c) => ({ amount: c.amount, dueDate: c.dueDate }));
                  if (pay.length > 0) setRasItems(pay);
                  else showToast('چک پرداختی در جریانی ثبت نشده است.');
                }}
                className="text-slate-600 dark:text-slate-300 hover:underline"
              >
                بارگذاری چک‌های پرداختی
              </button>
            </div>
          </div>

          <div className="lg:col-span-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
            <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <span>نتیجه راس‌گیری</span>
            </h3>
            <div className="space-y-3 text-xs">
              <div className="flex justify-between py-2 border-b border-slate-100 dark:border-slate-800">
                <span className="text-slate-500">جمع کل مبالغ چک‌ها:</span>
                <span className="font-code tabular-nums font-bold text-slate-900 dark:text-white">
                  {formatMoney(rasResult.totalAmount, unit)}
                </span>
              </div>
              <div className="flex justify-between py-2 border-b border-slate-100 dark:border-slate-800">
                <span className="text-slate-500">مدت راس از تاریخ مبنا:</span>
                <span className="font-code tabular-nums font-bold text-teal-700 dark:text-teal-400">
                  {toPersianDigits(rasResult.weightedDaysFromBase)} روز
                </span>
              </div>
              <div className="flex justify-between py-2">
                <span className="text-slate-500">تاریخ دقیق راس چک‌ها:</span>
                <span className="font-code text-base font-extrabold text-slate-900 dark:text-white">
                  {toPersianDigits(rasResult.averageDueDate)}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'reconciliation' && (
        <div className="space-y-4 text-xs">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <FileSpreadsheet className="w-4 h-4 text-teal-700 dark:text-teal-400" />
                  <span>صورت مغایرت بانکی هوشمند (تطبیق اکسل/CSV بانک با دفتر معین)</span>
                </h2>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  ردیف‌های صورت‌حساب بانک را با فرمت <span className="font-code">تاریخ,شرح,واریز(ریال),برداشت(ریال)</span> وارد یا بارگذاری کنید؛ سیستم ردیف‌های هم‌مبلغ را تطبیق داده و برای کارمزدهای مغایر سند اتوماتیک صادر می‌کند.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={reconBankCode}
                  onChange={(e) => setReconBankCode(e.target.value)}
                  className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  {bankAccounts.map((b) => (
                    <option key={b.id} value={b.code}>
                      {b.code} — {b.title}
                    </option>
                  ))}
                </select>
                <label className="cursor-pointer px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 font-medium">
                  <span>بارگذاری فایل CSV بانک</span>
                  <input
                    type="file"
                    accept=".csv,.txt"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = () => setBankCsvText(String(reader.result || ''));
                      reader.readAsText(file);
                    }}
                  />
                </label>
              </div>
            </div>

            <textarea
              rows={4}
              dir="ltr"
              value={bankCsvText}
              onChange={(e) => setBankCsvText(e.target.value)}
              className="w-full p-3 font-code text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-left"
              placeholder="1405/08/22,کارمزد حواله ساتنا,0,18500000,شناسه تراکنش (اختیاری)"
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
              <div>
                <span className="text-slate-500">تعداد ردیف صورت‌حساب بانک:</span>{' '}
                <strong className="font-code">{toPersianDigits(reconResult.bankRows.length)}</strong>
              </div>
              <div>
                <span className="text-emerald-700 dark:text-emerald-400">تطبیق‌شده با دفتر بانک:</span>{' '}
                <strong className="font-code text-emerald-700 dark:text-emerald-400">
                  {toPersianDigits(reconResult.matchedCount)}
                </strong>
              </div>
              <div>
                <span className="text-rose-700 dark:text-rose-400">اقلام باز / مغایر:</span>{' '}
                <strong className="font-code text-rose-700 dark:text-rose-400">
                  {toPersianDigits(reconResult.unmatchedRows.length)}
                </strong>
              <div>
                <span className="text-rose-700 dark:text-rose-400">ردیف‌های نامعتبر فایل:</span>{' '}
                <strong className="font-code text-rose-700 dark:text-rose-400">{toPersianDigits(reconResult.invalidCount)}</strong>
              </div>
              <div>
                <span className="text-amber-700 dark:text-amber-400">تطبیق‌های مبهم (نیازمند بررسی):</span>{' '}
                <strong className="font-code text-amber-700 dark:text-amber-400">{toPersianDigits(reconResult.ambiguousCount)}</strong>
              </div>
              <div>
                <span className="text-slate-500">ردیف‌های باز دفتر بانک:</span>{' '}
                <strong className="font-code">{toPersianDigits(reconResult.unmatchedLedgerCount)}</strong>
              </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-right border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] text-slate-500 bg-slate-50/70 dark:bg-slate-950/60">
                    <th className="py-2.5 px-3">تاریخ</th>
                    <th className="py-2.5 px-3">شرح صورت‌حساب بانک</th>
                    <th className="py-2.5 px-3 text-left">واریز (بدهکار بانک)</th>
                    <th className="py-2.5 px-3 text-left">برداشت (بستانکار بانک)</th>
                    <th className="py-2.5 px-3">وضعیت تطبیق</th>
                    <th className="py-2.5 px-3 text-left">اقدام حسابداری</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {reconResult.bankRows.map((row) => (
                    <tr key={row.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                      <td className="py-2.5 px-3 font-code">{toPersianDigits(row.date)}</td>
                      <td className="py-2.5 px-3 font-medium text-slate-900 dark:text-white">{row.desc}</td>
                      <td className="py-2.5 px-3 text-left font-code tabular-nums text-emerald-700 dark:text-emerald-400">
                        {row.deposit > 0 ? formatMoney(row.deposit, unit, false) : '—'}
                      </td>
                      <td className="py-2.5 px-3 text-left font-code tabular-nums text-rose-700 dark:text-rose-400">
                        {row.withdrawal > 0 ? formatMoney(row.withdrawal, unit, false) : '—'}
                      </td>
                      <td className="py-2.5 px-3">
                        {row.validationError ? (
                          <span className="text-rose-700 dark:text-rose-400 font-semibold">{row.validationError}</span>
                        ) : row.matched ? (
                          <span className="text-emerald-700 dark:text-emerald-400 font-semibold">
                            تطبیق یکتای سند #{toPersianDigits(row.matched.voucherNumber)}
                          </span>
                        ) : row.ambiguous ? (
                          <span className="text-amber-700 dark:text-amber-400 font-semibold">چند گزینه هم‌مبلغ؛ بررسی دستی الزامی</span>
                        ) : (
                          <span className="text-rose-700 dark:text-rose-400 font-semibold">بدون تطبیق در دفتر</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-left">
                        {!row.validationError && !row.matched && !row.ambiguous ? (
                          <button
                            type="button"
                            onClick={() => handlePostBankAdjustment(row)}
                            className="px-2.5 py-1 rounded bg-teal-700 hover:bg-teal-800 text-white font-semibold"
                          >
                            ثبت سند مغایرت
                          </button>
                        ) : (
                          <span className="text-slate-400">تراز</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === 'cheque-print' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 text-xs">
          <div className="lg:col-span-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
            <h2 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Printer className="w-4 h-4 text-teal-700 dark:text-teal-400" />
              <span>تنظیم و کالیبراسیون چاپ برگه چک صیادی</span>
            </h2>
            <div>
              <label className="block text-slate-500 mb-1">انتخاب چک از لیست خزانه</label>
              <select
                value={selectedPrintCheque?.id || ''}
                onChange={(e) => setPrintChequeId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                {cheques.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.sayadiId} — {c.partyName} ({formatMoney(c.amount, unit)})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-slate-500 mb-1">شناسه / کد ملی ذینفع روی برگه چک</label>
              <input
                value={printNationalId}
                onChange={(e) => setPrintNationalId(e.target.value)}
                className="w-full px-3 py-2 font-code rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-500 mb-1">
                  تنظیم افقی X ({toPersianDigits(printOffsetXmm)} mm)
                </label>
                <input
                  type="range"
                  min={-15}
                  max={15}
                  value={printOffsetXmm}
                  onChange={(e) => setPrintOffsetXmm(Number(e.target.value))}
                  className="w-full accent-teal-700"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">
                  تنظیم عمودی Y ({toPersianDigits(printOffsetYmm)} mm)
                </label>
                <input
                  type="range"
                  min={-15}
                  max={15}
                  value={printOffsetYmm}
                  onChange={(e) => setPrintOffsetYmm(Number(e.target.value))}
                  className="w-full accent-teal-700"
                />
              </div>
            </div>
            <button
              type="button"
              onClick={() => window.print()}
              disabled={!selectedPrintCheque}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-teal-700 hover:bg-teal-800 text-white font-semibold disabled:opacity-50"
            >
              <Printer className="w-4 h-4" />
              <span>چاپ مستقیم روی برگه چک صیادی</span>
            </button>
          </div>

          <div className="lg:col-span-8 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 overflow-x-auto">
            {selectedPrintCheque ? (
              <div
                className="relative mx-auto bg-purple-50/40 dark:bg-slate-950 border-2 border-dashed border-purple-300 dark:border-purple-900 rounded-lg p-6 text-slate-900 dark:text-slate-100"
                style={{
                  width: '175mm',
                  minHeight: '85mm',
                  transform: `translate(${printOffsetXmm}mm, ${printOffsetYmm}mm)`,
                }}
              >
                <div className="flex items-start justify-between border-b border-purple-200 dark:border-slate-800 pb-3">
                  <div>
                    <div className="text-[11px] text-slate-500">شناسه ۱۶ رقمی صیادی</div>
                    <div className="font-code text-sm font-bold tracking-widest mt-0.5">
                      {toPersianDigits(selectedPrintCheque.sayadiId)}
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="font-bold text-sm">{selectedPrintCheque.bankName}</div>
                    <div className="text-[11px] text-slate-500">{selectedPrintCheque.branch || 'شعبه مرکزی'}</div>
                  </div>
                  <div className="text-left">
                    <div className="text-[11px] text-slate-500">تاریخ سررسید به عدد</div>
                    <div className="font-code font-bold text-sm mt-0.5">
                      {toPersianDigits(selectedPrintCheque.dueDate)}
                    </div>
                  </div>
                </div>

                <div className="mt-4 space-y-3 text-xs">
                  <div className="flex items-baseline gap-2 border-b border-dotted border-slate-300 dark:border-slate-700 pb-1.5">
                    <span className="text-slate-500 shrink-0">به موجب این چک مبلغ:</span>
                    <span className="font-bold text-slate-900 dark:text-white">
                      {numberToPersianWords(selectedPrintCheque.amount, 'ریال تمام')}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between gap-2 border-b border-dotted border-slate-300 dark:border-slate-700 pb-1.5">
                    <div>
                      <span className="text-slate-500 ml-2">در وجه:</span>
                      <span className="font-bold text-slate-900 dark:text-white">
                        {selectedPrintCheque.partyName}
                      </span>
                    </div>
                    <div className="font-code text-[11px] text-slate-600 dark:text-slate-400">
                      شناسه/کد ملی: {toPersianDigits(printNationalId)}
                    </div>
                  </div>
                  <div className="flex items-center justify-between pt-2">
                    <div className="text-[11px] text-slate-500">
                      بابت: {selectedPrintCheque.notes || 'تسویه معاملات تجاری نخ'}
                    </div>
                    <div className="px-4 py-1.5 rounded border border-slate-400 dark:border-slate-600 font-code tabular-nums font-extrabold text-sm">
                      *** {formatMoney(selectedPrintCheque.amount, 'IRR', false)} ریال ***
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="py-12 text-center text-slate-500">چکی برای چاپ موجود نیست.</div>
            )}
          </div>
        </div>
      )}

      {/* Edit Cheque Modal */}
      {editingCheque && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <form
            onSubmit={handleSaveChequeEdit}
            className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 space-y-4 text-xs"
          >
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                ویرایش مشخصات چک صیادی {toPersianDigits(editingCheque.sayadiId)}
              </h3>
              <button type="button" onClick={() => setEditingCheque(null)}>
                <X className="w-4 h-4 text-slate-500" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-slate-500 mb-1">نام بانک</label>
                <input
                  value={editBankName}
                  onChange={(e) => setEditBankName(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">شعبه</label>
                <input
                  value={editBranch}
                  onChange={(e) => setEditBranch(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">تاریخ سررسید</label>
                <input
                  value={editDueDate}
                  onChange={(e) => setEditDueDate(e.target.value)}
                  className="w-full px-3 py-2 font-code rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">یادداشت / بابت</label>
                <input
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditingCheque(null)}
                className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700"
              >
                انصراف
              </button>
              <button
                type="submit"
                className="px-5 py-2 font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg"
              >
                ذخیره تغییرات
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Cheque Clearing / Endorsement / Revert Modal */}
      {pendingTransition && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <form
            onSubmit={confirmPendingTransition}
            className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 space-y-4 text-xs"
          >
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                {pendingTransition.targetStatus === 'endorsed'
                  ? 'خرج چک دریافتی (واگذاری به غیر)'
                  : pendingTransition.cheque.status === 'cleared'
                    ? 'عودت چک از حالت وصول (اصلاحیه خزانه)'
                    : pendingTransition.cheque.direction === 'receivable'
                      ? 'وصول چک دریافتی به حساب بانکی'
                      : 'پاس شدن چک پرداختی از حساب بانکی'}
              </h3>
              <button type="button" onClick={() => setPendingTransition(null)}>
                <X className="w-4 h-4 text-slate-500" />
              </button>
            </div>

            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 space-y-1">
              <div>
                شناسه صیادی:{' '}
                <strong className="font-code">{toPersianDigits(pendingTransition.cheque.sayadiId)}</strong>
              </div>
              <div>
                مبلغ چک:{' '}
                <strong className="font-code tabular-nums">
                  {formatMoney(pendingTransition.cheque.amount, unit)}
                </strong>
              </div>
              <div>طرف‌حساب اولیه: {pendingTransition.cheque.partyName}</div>
            </div>

            {pendingTransition.targetStatus === 'endorsed' ? (
              <div>
                <label className="block text-slate-500 mb-1">
                  انتخاب طرف‌حساب دریافت‌کننده چک (جستجوی هوشمند)
                </label>
                <SmartSearchCombobox
                  options={partyOptions}
                  value={transitionEndorsePartyId}
                  onSelect={(opt) => setTransitionEndorsePartyId(opt.id)}
                  placeholder="نام یا کد طرف‌حساب..."
                  mode="picker"
                />
              </div>
            ) : (
              <div>
                <label className="block text-slate-500 mb-1">
                  انتخاب حساب بانکی مرتبط با سند وصول / عودت
                </label>
                <select
                  value={transitionBankCode}
                  onChange={(e) => setTransitionBankCode(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  {bankAccounts.map((b) => (
                    <option key={b.id} value={b.code}>
                      {b.code} — {b.title}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setPendingTransition(null)}
                className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700"
              >
                انصراف
              </button>
              <button
                type="submit"
                className="px-5 py-2 font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg"
              >
                تایید و صدور سند حسابداری
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
