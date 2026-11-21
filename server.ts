import 'dotenv/config';
import http from 'http';
import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const ALLOWED_SIZES = new Set(['1K', '2K', '4K']);
const ALLOWED_ASPECT_RATIOS = new Set([
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '9:16',
  '16:9',
  '21:9',
]);
const ALLOWED_MODELS = new Set([
  'gemini-3-pro-image-preview',
  'gemini-nano-banana-2.1',
  'gemini-3.1-flash-lite-image',
]);

function createGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'holoo-apex-corporate-erp',
      timestamp: new Date().toISOString(),
    });
  });

  // Live Tehran Free-Market FX Rate Proxy (synced with Chand / AlanChand & TGJU)
  interface LiveFxItem {
    code: 'USD' | 'EUR' | 'AED' | 'CNY';
    name: string;
    symbol: string;
    priceIrr: number;
    buyIrr?: number;
    highIrr?: number;
    lowIrr?: number;
    changeIrr: number;
    changePercent: number;
    direction: 'up' | 'down' | 'flat';
    updatedTime: string;
  }

  interface LiveFxCache {
    fetchedAt: number;
    source: string;
    sourceUrl: string;
    items: LiveFxItem[];
  }

  let liveFxCache: LiveFxCache | null = null;
  const FX_CACHE_TTL_MS = 60_000;

  const parseNumericString = (raw: unknown): number => {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw !== 'string') return 0;
    const persian = '۰۱۲۳۴۵۶۷۸۹';
    const arabic = '٠١٢٣٤٥٦٧٨٩';
    let normalized = '';
    for (const ch of raw) {
      const pIdx = persian.indexOf(ch);
      if (pIdx !== -1) {
        normalized += String(pIdx);
      } else {
        const aIdx = arabic.indexOf(ch);
        normalized += aIdx !== -1 ? String(aIdx) : ch;
      }
    }
    const cleaned = normalized.replace(/[^0-9.-]/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  };

  async function fetchLiveFxRates(): Promise<LiveFxCache> {
    const items: LiveFxItem[] = [];

    // Primary structured JSON source (Tehran Free Market — aligned with chand.app / TGJU)
    try {
      const tgjuResp = await fetch('https://call1.tgju.org/ajax.json', {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HolooApexERP/1.0)' },
        signal: AbortSignal.timeout(6000),
      });
      if (tgjuResp.ok) {
        const json = (await tgjuResp.json()) as {
          current?: Record<
            string,
            {
              p?: string;
              h?: string;
              l?: string;
              d?: string;
              dp?: number | string;
              dt?: string;
              t?: string;
              ts?: string;
            }
          >;
        };
        const cur = json?.current || {};
        const spec: {
          code: 'USD' | 'EUR' | 'AED' | 'CNY';
          key: string;
          name: string;
          symbol: string;
        }[] = [
          { code: 'USD', key: 'price_dollar_rl', name: 'دلار آمریکا', symbol: '$' },
          { code: 'EUR', key: 'price_eur', name: 'یورو اروپا', symbol: '€' },
          { code: 'AED', key: 'price_aed', name: 'درهم امارات', symbol: 'د.إ' },
          { code: 'CNY', key: 'price_cny', name: 'یوان چین', symbol: '¥' },
        ];

        for (const s of spec) {
          const row = cur[s.key];
          if (!row) continue;
          const priceIrr = Math.round(parseNumericString(row.p));
          if (priceIrr <= 0) continue;
          const highIrr = Math.round(parseNumericString(row.h)) || undefined;
          const lowIrr = Math.round(parseNumericString(row.l)) || undefined;
          const rawDelta = Math.round(parseNumericString(row.d));
          const dp = Math.abs(parseNumericString(row.dp));
          const dt = String(row.dt || '').toLowerCase();
          const direction: 'up' | 'down' | 'flat' =
            dt === 'high' ? 'up' : dt === 'low' ? 'down' : 'flat';
          const changeIrr = direction === 'down' ? -Math.abs(rawDelta) : Math.abs(rawDelta);

          items.push({
            code: s.code,
            name: s.name,
            symbol: s.symbol,
            priceIrr,
            highIrr,
            lowIrr,
            changeIrr,
            changePercent: direction === 'down' ? -dp : dp,
            direction,
            updatedTime: String(row.t || row.ts || ''),
          });
        }
      }
    } catch {
      // Fallback below
    }

    // Secondary fallback from AlanChand public currencies page if primary had fewer than 4 items
    if (items.length < 4) {
      try {
        const acResp = await fetch('https://alanchand.com/currencies-price', {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HolooApexERP/1.0)' },
          signal: AbortSignal.timeout(6000),
        });
        if (acResp.ok) {
          const html = await acResp.text();
          const existingCodes = new Set(items.map((i) => i.code));
          const fallbackSpecs: {
            code: 'USD' | 'EUR' | 'AED' | 'CNY';
            slug: string;
            name: string;
            symbol: string;
          }[] = [
            { code: 'USD', slug: 'usd', name: 'دلار آمریکا', symbol: '$' },
            { code: 'EUR', slug: 'eur', name: 'یورو اروپا', symbol: '€' },
            { code: 'AED', slug: 'aed', name: 'درهم امارات', symbol: 'د.إ' },
            { code: 'CNY', slug: 'cny', name: 'یوان چین', symbol: '¥' },
          ];
          for (const fs of fallbackSpecs) {
            if (existingCodes.has(fs.code)) continue;
            const idx = html.indexOf(`currencies-price/${fs.slug}`);
            if (idx === -1) continue;
            const textChunk = html
              .slice(idx, idx + 700)
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ');
            const numMatch = textChunk.match(/([۰-۹0-9]{2,3}[,،][۰-۹0-9]{3})/);
            if (numMatch) {
              const toman = parseNumericString(numMatch[1]);
              if (toman > 1000) {
                items.push({
                  code: fs.code,
                  name: fs.name,
                  symbol: fs.symbol,
                  priceIrr: Math.round(toman * 10),
                  changeIrr: 0,
                  changePercent: 0,
                  direction: 'flat',
                  updatedTime: new Date().toLocaleTimeString('fa-IR', {
                    hour: '2-digit',
                    minute: '2-digit',
                  }),
                });
              }
            }
          }
        }
      } catch {
        // Ignore fallback failure
      }
    }

    return {
      fetchedAt: Date.now(),
      source: 'بازار آزاد تهران (همگام با chand.app)',
      sourceUrl: 'https://chand.app/',
      items,
    };
  }

  app.get('/api/live-fx', async (req: Request, res: Response) => {
    try {
      const forceRefresh = req.query.refresh === '1';
      if (
        !forceRefresh &&
        liveFxCache &&
        liveFxCache.items.length > 0 &&
        Date.now() - liveFxCache.fetchedAt < FX_CACHE_TTL_MS
      ) {
        res.json({
          ...liveFxCache,
          cached: true,
        });
        return;
      }

      const fresh = await fetchLiveFxRates();
      if (fresh.items.length > 0) {
        liveFxCache = fresh;
        res.json({ ...fresh, cached: false });
        return;
      }

      if (liveFxCache && liveFxCache.items.length > 0) {
        res.json({ ...liveFxCache, cached: true, stale: true });
        return;
      }

      res.status(502).json({
        error: 'امکان دریافت لحظه‌ای نرخ ارز از سرور منبع وجود ندارد.',
        items: [],
      });
    } catch {
      res.status(502).json({
        error: 'خطا در ارتباط با منبع نرخ لحظه‌ای ارز.',
        items: [],
      });
    }
  });

  app.post('/api/images/generate', async (req: Request, res: Response) => {
    try {
      const {
        prompt,
        imageSize = '1K',
        aspectRatio = '16:9',
        model = 'gemini-3-pro-image-preview',
      } = req.body ?? {};

      if (typeof prompt !== 'string' || prompt.trim().length < 4 || prompt.trim().length > 1500) {
        res.status(400).json({
          error: 'شرح تصویر (Prompt) باید بین ۴ تا ۱۵۰۰ کاراکتر باشد.',
        });
        return;
      }

      const safeSize = ALLOWED_SIZES.has(imageSize) ? imageSize : '1K';
      const safeRatio = ALLOWED_ASPECT_RATIOS.has(aspectRatio) ? aspectRatio : '16:9';
      const safeModel = ALLOWED_MODELS.has(model) ? model : 'gemini-3-pro-image-preview';

      const ai = createGeminiClient();
      if (!ai) {
        res.status(503).json({
          error:
            'کلید API جمنای تنظیم نشده است. لطفاً از بخش Settings > Secrets در محیط اجرا، کلید API معتبر را متصل کنید.',
          code: 'MISSING_API_KEY',
        });
        return;
      }

      const response = await ai.models.generateContent({
        model: safeModel,
        contents: {
          parts: [{ text: prompt.trim() }],
        },
        config: {
          imageConfig: {
            aspectRatio: safeRatio,
            imageSize: safeSize,
          },
        },
      });

      const parts = response.candidates?.[0]?.content?.parts ?? [];
      let imageDataUrl: string | null = null;
      let textCaption = '';

      for (const part of parts) {
        if (part.inlineData?.data) {
          const mime = part.inlineData.mimeType ?? 'image/png';
          imageDataUrl = `data:${mime};base64,${part.inlineData.data}`;
        } else if (part.text) {
          textCaption += part.text;
        }
      }

      if (!imageDataUrl) {
        res.status(502).json({
          error: 'مدل تصویری خروجی گرافیکی تولید نکرد. لطفاً شرح تصویر را دقیق‌تر وارد کرده و دوباره تلاش کنید.',
          caption: textCaption,
        });
        return;
      }

      res.json({
        imageUrl: imageDataUrl,
        caption: textCaption.trim(),
        model: safeModel,
        imageSize: safeSize,
        aspectRatio: safeRatio,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      let status = 500;
      let userMessage = `خطا در تولید تصویر: ${message}`;

      if (message.includes('403') || message.includes('PERMISSION_DENIED') || message.includes('API_KEY_INVALID')) {
        status = 403;
        userMessage =
          'دسترسی به مدل تصویرسازی رد شد (403/400). لطفاً کلید API دارای صورت‌حساب فعال را در بخش Settings > Secrets بررسی و انتخاب کنید.';
      } else if (message.includes('429') || message.includes('RESOURCE_EXHAUSTED')) {
        status = 429;
        userMessage =
          'سهمیه استفاده از مدل تصویرسازی با کیفیت بالا به پایان رسیده است (429). لطفاً در بخش Settings > Secrets یک کلید API دارای پلن پرداختی متصل کنید.';
      } else if (message.includes('404') || message.includes('NOT_FOUND')) {
        status = 404;
        userMessage =
          'مدل انتخاب‌شده در دسترس نیست. لطفاً مدل gemini-nano-banana-2.1 یا gemini-3-pro-image-preview را بررسی کنید.';
      }

      res.status(status).json({ error: userMessage, details: message });
    }
  });

  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== 'production') {
    // Prevent Vite 8's @vite/client from opening a failing WebSocket to port 24678
    // behind Cloud Run's single-port proxy while keeping CSS injection & HMR stubs working.
    app.get('/@vite/client', (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.send(`
const sheetsMap = new Map();
export function updateStyle(id, content) {
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.setAttribute('data-vite-dev-id', id);
    style.textContent = content;
    document.head.appendChild(style);
    sheetsMap.set(id, style);
  } else {
    style.textContent = content;
  }
}
export function removeStyle(id) {
  const style = sheetsMap.get(id);
  if (style) {
    document.head.removeChild(style);
    sheetsMap.delete(id);
  }
}
export function createHotContext() {
  return {
    data: {},
    accept() {},
    acceptExports() {},
    dispose() {},
    prune() {},
    invalidate() {},
    on() {},
    off() {},
    send() {},
  };
}
export function injectQuery(url) {
  return url;
}
export class ErrorOverlay extends HTMLElement {}
`);
    });

    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Holoo Corporate Apex ERP running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
