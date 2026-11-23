import React, { useMemo, useRef, useState } from 'react';
import { Bot, Cpu, Mic, MicOff, Send, ShieldCheck, Sparkles } from 'lucide-react';
import type { MLCEngine } from '@mlc-ai/web-llm';
import { useAccounting } from '../context/AccountingContext';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

const MODEL_ID = 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC';

function buildLocalAccountingContext(data: {
  companyName: string;
  fiscalYear: string;
  accounts: any[];
  products: any[];
  parties: any[];
  vouchers: any[];
  invoices: any[];
  cheques: any[];
  trialBalance: any[];
  incomeStatement: any;
  balanceSheet: any;
  auditReport: any;
}) {
  const debit = data.trialBalance.reduce((sum, row) => sum + Number(row.totalDebit || 0), 0);
  const credit = data.trialBalance.reduce((sum, row) => sum + Number(row.totalCredit || 0), 0);
  const lowStock = data.products
    .filter((p) => Number(p.stock || 0) <= Number(p.reorderPoint || 0))
    .slice(0, 30)
    .map((p) => ({ کد: p.sku, کالا: p.name, موجودی: p.stock, حد_سفارش: p.reorderPoint, واحد: p.unit }));
  const openInvoices = data.invoices
    .filter((invoice) => invoice.status === 'issued')
    .reduce((sum, invoice) => sum + Number(invoice.creditAmount || 0), 0);
  const pendingReceivableCheques = data.cheques
    .filter((cheque) => cheque.direction === 'receivable' && !['cleared', 'cancelled', 'bounced'].includes(cheque.status))
    .reduce((sum, cheque) => sum + Number(cheque.amount || 0), 0);
  const pendingPayableCheques = data.cheques
    .filter((cheque) => cheque.direction === 'payable' && !['cleared', 'cancelled', 'bounced'].includes(cheque.status))
    .reduce((sum, cheque) => sum + Number(cheque.amount || 0), 0);
  const bouncedCheques = data.cheques
    .filter((cheque) => cheque.status === 'bounced')
    .reduce((sum, cheque) => sum + Number(cheque.amount || 0), 0);

  return JSON.stringify({
    شرکت: data.companyName,
    سال_مالی: data.fiscalYear,
    تعداد_حساب‌ها: data.accounts.length,
    تعداد_کالاها: data.products.length,
    تعداد_طرف_حساب‌ها: data.parties.length,
    تعداد_اسناد: data.vouchers.length,
    تعداد_فاکتورها: data.invoices.length,
    جمع_بدهکار_گردش: debit,
    جمع_بستانکار_گردش: credit,
    اختلاف_تراز_گردش: debit - credit,
    مانده_فاکتورهای_باز: openInvoices,
    چک‌های_دریافتنی_در_جریان: pendingReceivableCheques,
    چک‌های_پرداختنی_در_جریان: pendingPayableCheques,
    مبلغ_چک‌های_برگشتی: bouncedCheques,
    کالاهای_رسیده_به_حد_سفارش: lowStock,
    صورت_سود_و_زیان: data.incomeStatement,
    ترازنامه: data.balanceSheet,
    خلاصه_حسابرسی: data.auditReport,
  });
}

export const LocalAIView: React.FC = () => {
  const {
    profile, accounts, products, parties, vouchers, invoices, cheques,
    trialBalance, incomeStatement, balanceSheet, auditReport,
  } = useAccounting();
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'assistant', content: 'دستیار محلی Billion آماده راه‌اندازی است. ابتدا مدل را روی همین دستگاه بارگیری کن؛ پس از آن پرسش‌ها بدون ارسال اطلاعات مالی به سرورهای هوش مصنوعی پردازش می‌شوند.' },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [modelReady, setModelReady] = useState(false);
  const [modelProgress, setModelProgress] = useState('');
  const [error, setError] = useState('');
  const [voiceState, setVoiceState] = useState<'idle' | 'listening'>('idle');
  const [deviceCheck, setDeviceCheck] = useState<'not_checked' | 'checking' | 'ready' | 'unsupported'>('not_checked');
  const [deviceInfo, setDeviceInfo] = useState('');
  const engineRef = useRef<MLCEngine | null>(null);

  const localContext = useMemo(() => buildLocalAccountingContext({
    companyName: profile.companyName,
    fiscalYear: profile.fiscalYear,
    accounts, products, parties, vouchers, invoices, cheques,
    trialBalance, incomeStatement, balanceSheet, auditReport,
  }), [profile.companyName, profile.fiscalYear, accounts, products, parties, vouchers, invoices, cheques, trialBalance, incomeStatement, balanceSheet, auditReport]);

  const startModel = async () => {
    setError('');
    setDeviceCheck('checking');
    setDeviceInfo('');
    if (!window.isSecureContext) {
      setDeviceCheck('unsupported');
      setError('برای دسترسی امن به WebGPU، برنامه باید از HTTPS یا محیط امن اجرا شود.');
      return;
    }
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<{ features?: Set<string>; limits?: { maxBufferSize?: number } } | null> } }).gpu;
    if (!gpu) {
      setDeviceCheck('unsupported');
      setError('این مرورگر WebGPU را ارائه نمی‌کند. در این دستگاه، موتور هوش مصنوعی محلی اجرا نشد و هیچ سرویس ابری جایگزین نمی‌شود.');
      return;
    }
    try {
      setLoading(true);
      setModelProgress('در حال بررسی توان گرافیکی دستگاه…');
      const adapter = await gpu.requestAdapter();
      if (!adapter) {
        setDeviceCheck('unsupported');
        throw new Error('مرورگر WebGPU را دارد، اما آداپتور گرافیکی قابل استفاده پیدا نشد. ممکن است دستگاه، درایور یا تنظیمات مرورگر محدودیت داشته باشد.');
      }
      const maxBuffer = Number(adapter.limits?.maxBufferSize || 0);
      const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
      setDeviceInfo([
        'WebGPU فعال',
        memory ? `حافظه تقریبی دستگاه: ${memory} GB` : '',
        maxBuffer ? `حداکثر بافر GPU: ${Math.round(maxBuffer / 1024 / 1024)} MB` : '',
      ].filter(Boolean).join(' • '));
      setDeviceCheck('ready');
      setModelProgress('سخت‌افزار سازگار شناسایی شد؛ در حال آماده‌سازی موتور محلی…');
      const { CreateMLCEngine } = await import('@mlc-ai/web-llm');
      const engine = await CreateMLCEngine(MODEL_ID, {
        initProgressCallback: (report) => setModelProgress(report.text || 'در حال بارگیری مدل…'),
      });
      engineRef.current = engine;
      setModelReady(true);
      setModelProgress('مدل روی این دستگاه آماده است.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'بارگیری مدل محلی ناموفق بود.');
    } finally {
      setLoading(false);
    }
  };

  const sendMessage = async (rawText = input) => {
    const question = rawText.trim();
    if (!question || !engineRef.current || loading) return;
    const nextMessages: ChatMessage[] = [...messages, { role: 'user', content: question }];
    setMessages(nextMessages);
    setInput('');
    setLoading(true);
    setError('');
    try {
      const response = await engineRef.current.chat.completions.create({
        messages: [
          {
            role: 'system',
            content: 'تو دستیار حسابداری محلی نرم‌افزار Billion هستی. فقط بر اساس داده‌های ارائه‌شده پاسخ بده. اگر داده کافی نیست صریح بگو. اعداد را حدس نزن. محاسبات قطعی را از داده‌های خلاصه‌شده نقل کن و برای نتیجه‌گیری حسابرسی محدودیت را بیان کن. هرگز ادعا نکن سند، فاکتور، کالا یا پرداختی ثبت کرده‌ای. هر عملیات ثبتی فقط پیش‌نویس پیشنهادی است و باید در فرم رسمی و با تأیید کاربر ثبت شود. اطلاعات مالی محرمانه است و این مدل باید فقط روی دستگاه اجرا شود.\nداده‌های محلی شرکت:\n' + localContext,
          },
          ...nextMessages.map((message) => ({ role: message.role, content: message.content })),
        ],
        temperature: 0.2,
        max_tokens: 700,
      });
      const answer = response.choices[0]?.message?.content;
      setMessages((current) => [...current, { role: 'assistant', content: typeof answer === 'string' ? answer : 'پاسخی از مدل دریافت نشد.' }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'پردازش محلی ناموفق بود.');
    } finally {
      setLoading(false);
    }
  };

  const startLocalVoice = async () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setError('تشخیص گفتار در این مرورگر در دسترس نیست. برای حفظ حریم خصوصی، از سرویس گفتار ابری استفاده نمی‌کنیم.');
      return;
    }
    try {
      if (typeof SpeechRecognition.available !== 'function' || typeof SpeechRecognition.install !== 'function') {
        setError('این مرورگر ابزار بررسی و نصب بسته گفتار کاملاً محلی را ندارد؛ فرمان صوتی برای جلوگیری از ارسال صدا به سرویس بیرونی غیرفعال ماند.');
        return;
      }
      const languageOptions = { langs: ['fa-IR'], processLocally: true };
      const availability = await SpeechRecognition.available(languageOptions);
      if (availability === 'unavailable') {
        setError('بسته تشخیص گفتار فارسی برای پردازش محلی در این مرورگر قابل دریافت نیست. هیچ پردازش ابری فعال نمی‌شود.');
        return;
      }
      if (availability !== 'available') {
        setError('در حال نصب بسته زبان فارسی برای تشخیص گفتار محلی…');
        const installed = await SpeechRecognition.install(languageOptions);
        if (!installed) {
          setError('نصب بسته گفتار فارسی موفق نشد. می‌توانی بعداً دوباره تلاش کنی؛ صدای تو به سرویس ابری ارسال نمی‌شود.');
          return;
        }
        setError('بسته زبان فارسی نصب شد. دوباره دکمه میکروفون را بزن تا گفتار به‌صورت محلی تشخیص داده شود.');
        return;
      }

      const recognition = new SpeechRecognition();
      if (!('processLocally' in recognition)) {
        setError('این مرورگر امکان اجبار پردازش گفتار روی دستگاه را ندارد؛ فرمان صوتی غیرفعال ماند.');
        return;
      }
      recognition.processLocally = true;
      recognition.lang = 'fa-IR';
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      recognition.onresult = (event: any) => {
        const transcript = event.results?.[0]?.[0]?.transcript || '';
        setInput(transcript);
        setVoiceState('idle');
      };
      recognition.onerror = (event: any) => {
        setVoiceState('idle');
        setError(event?.error === 'language-not-supported'
          ? 'بسته زبان فارسی روی دستگاه در دسترس نیست.'
          : 'تشخیص گفتار محلی انجام نشد. مجوز میکروفون و بسته زبان فارسی را بررسی کن.');
      };
      recognition.onend = () => setVoiceState('idle');
      setVoiceState('listening');
      recognition.start();
    } catch (err) {
      setVoiceState('idle');
      setError(err instanceof Error ? err.message : 'شروع میکروفون محلی ناموفق بود.');
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5" dir="rtl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2"><Sparkles className="w-5 h-5 text-teal-600" /> موتور هوش مصنوعی محلی Billion</h1>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">پردازش روی دستگاه؛ بدون کلید API و بدون ارسال اطلاعات مالی به سرویس هوش مصنوعی ابری</p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"><ShieldCheck className="h-4 w-4" /> حالت فقط محلی</span>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-start gap-3">
          <Cpu className="mt-0.5 h-5 w-5 shrink-0 text-teal-700" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold text-slate-900 dark:text-white">مدل روی دستگاه: Qwen 2.5 — 0.5B</div>
            <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">حجم حافظه گرافیکی تخمینی این مدل حدود ۹۴۵ مگابایت است. بارگیری اولیه مدل به اینترنت و فضای ذخیره‌سازی نیاز دارد؛ پس از ذخیره شدن مدل، استنتاج روی دستگاه انجام می‌شود. پشتیبانی WebGPU و حافظه کافی الزامی است.</p>
            {deviceInfo && <p className="mt-2 text-[11px] text-emerald-700 dark:text-emerald-300">{deviceInfo}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button onClick={startModel} disabled={loading || modelReady} className="rounded-lg bg-teal-700 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">{modelReady ? 'مدل آماده است' : loading ? 'در حال آماده‌سازی…' : 'بارگیری و راه‌اندازی مدل محلی'}</button>
              {modelReady && <span className="text-xs font-semibold text-emerald-600">آماده پردازش محلی</span>}
              {deviceCheck === 'checking' && <span className="text-xs text-slate-500">در حال بررسی WebGPU…</span>}
              {deviceCheck === 'unsupported' && <span className="text-xs text-rose-600">این دستگاه فعلاً سازگار تشخیص داده نشد</span>}
            </div>
            {modelProgress && <p className="mt-2 break-words text-xs text-slate-500">{modelProgress}</p>}
          </div>
        </div>
      </div>

      {error && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs leading-5 text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300">{error}</div>}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800"><Bot className="h-4 w-4 text-teal-700" /><span className="text-sm font-bold text-slate-800 dark:text-white">گفت‌وگو و تحلیل حسابداری</span><span className="mr-auto text-[10px] text-slate-400">{modelReady ? 'پردازش روی همین دستگاه' : 'ابتدا مدل را راه‌اندازی کن'}</span></div>
        <div className="max-h-[420px] min-h-[220px] space-y-3 overflow-y-auto p-4">
          {messages.map((message, index) => <div key={index} className={message.role === 'user' ? 'mr-8 rounded-xl bg-teal-50 p-3 text-xs leading-6 text-slate-800 dark:bg-teal-950/40 dark:text-slate-100' : 'ml-8 rounded-xl bg-slate-100 p-3 text-xs leading-6 text-slate-800 dark:bg-slate-800 dark:text-slate-100'}><div className="mb-1 text-[10px] font-bold text-slate-500">{message.role === 'user' ? 'شما' : 'دستیار محلی'}</div><p className="whitespace-pre-wrap">{message.content}</p></div>)}
          {loading && <div className="text-xs text-slate-500">مدل محلی در حال پردازش است…</div>}
        </div>
        <div className="border-t border-slate-200 p-3 dark:border-slate-800">
          <div className="flex items-end gap-2">
            <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder="مثلاً: کالاهای زیر حد سفارش را تحلیل کن…" rows={2} className="min-h-11 flex-1 resize-y rounded-lg border border-slate-200 bg-white p-3 text-xs outline-none focus:border-teal-600 dark:border-slate-700 dark:bg-slate-950" />
            <button type="button" onClick={startLocalVoice} disabled={voiceState === 'listening'} title="ورودی گفتار فقط محلی" className="rounded-lg border border-slate-200 p-3 text-slate-600 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300">{voiceState === 'listening' ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}</button>
            <button type="button" onClick={() => void sendMessage()} disabled={!modelReady || loading || !input.trim()} className="rounded-lg bg-teal-700 p-3 text-white disabled:opacity-40"><Send className="h-4 w-4" /></button>
          </div>
          <p className="mt-2 text-[10px] text-slate-400">فرمان‌های ثبت کالا و فاکتور در این مرحله فقط به پیش‌نویس تبدیل می‌شوند؛ هیچ سندی بدون تأیید در دفاتر ثبت نمی‌شود.</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800"><div className="text-xs font-bold">دستیار حسابداری</div><p className="mt-1 text-[11px] text-slate-500">پاسخ بر اساس داده‌های موجود شرکت</p></div>
        <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800"><div className="text-xs font-bold">تحلیل مالی و حسابرسی</div><p className="mt-1 text-[11px] text-slate-500">خلاصه تراز، موجودی و کنترل‌های قابل دسترس</p></div>
        <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800"><div className="text-xs font-bold">فرمان صوتی محلی</div><p className="mt-1 text-[11px] text-slate-500">فعال فقط در مرورگر دارای تشخیص گفتار روی دستگاه</p></div>
      </div>
    </div>
  );
};
