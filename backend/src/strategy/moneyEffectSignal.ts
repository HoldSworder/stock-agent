import { requestText } from '../datasource/httpClient';
import { cached } from '../lib/ttlCache';

// 首板赚钱效应择时信号：同花顺自建指数 883994「昨日打首板表现」（首板隔日溢价累积指数）。
// 该指数升温=打板追涨赚钱、退潮=打板亏钱，与题材动量短线战法高度同步，用作其仓位择时的温度计。
// 通达信 mootdx 无此指数，改直取同花顺公开日线 JSONP 接口（仅需 Referer，无需 cookie）。
// 纯只读、best-effort：取数失败由上层默认「满仓」不误杀。

/** 同花顺自建指数日线 JSONP（48_ 前缀为同花顺自研指数，01=日线，last1800≈近 1800 根） */
const THS_LINE_URL = 'https://d.10jqka.com.cn/v6/line/48_883994/01/last1800.js';
/** 序列缓存时长（日线慢变，1 小时足够；盘后重放时取当日之前的收盘，不依赖盘中） */
const SERIES_TTL_MS = 60 * 60 * 1000;

/** 883994 单根日线（仅取择时所需的日期与收盘） */
export interface MoneyEffectBar {
  /** YYYY-MM-DD */
  date: string;
  close: number;
}

/** YYYYMMDD → YYYY-MM-DD */
function toIsoDate(d: string): string {
  const s = String(d).trim();
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s.slice(0, 10);
}

/**
 * 抓取并解析 883994 日线序列（升序），缓存 1h。
 * 同花顺返回 JSONP：`quotebridge_..._last1800({...})`，其中 data 为
 * `日期,开,高,低,收,量,额,...;日期,...` 分号分隔的行串。best-effort：失败抛错。
 */
export async function fetchMoneyEffectSeries(): Promise<MoneyEffectBar[]> {
  return cached('signal:ths883994:series', SERIES_TTL_MS, async () => {
    const raw = await requestText({
      sourceId: 'ths-883994',
      url: THS_LINE_URL,
      headers: {
        Referer: 'https://stockpage.10jqka.com.cn/',
        'User-Agent': 'Mozilla/5.0',
      },
      timeoutMs: 15000,
      maxAttempts: 2,
      retryBaseMs: 600,
      errorLabel: '同花顺 883994',
    });
    const m = raw.match(/\((\{[\s\S]*\})\)/);
    if (!m) throw new Error('同花顺 883994 返回非预期 JSONP');
    const obj = JSON.parse(m[1]) as { data?: string };
    const rows = String(obj.data ?? '').split(';');
    const out: MoneyEffectBar[] = [];
    for (const row of rows) {
      const f = row.split(',');
      if (f.length < 5) continue;
      const close = Number(f[4]);
      const date = toIsoDate(f[0]);
      if (!date || !Number.isFinite(close)) continue;
      out.push({ date, close });
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
    if (out.length === 0) throw new Error('同花顺 883994 解析为空');
    return out;
  });
}

/** 末 n 个数的简单均值（数组已按需截取），空数组返回 0 */
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/**
 * 计算某交易日的择时目标仓位（无未来函数）：仅用 tradeDate **之前**的收盘。
 *  满(1) = 收盘[D-1] ≥ MA5[D-1] 且 MA5[D-1] > MA5[D-2]（站上 MA5 且 MA5 向上）；否则空(0)。
 * 数据不足（前值 < 6 根）默认满仓(1)，不误杀。
 * @param series 预取的升序序列（避免逐日重复抓取）
 */
export function positionForDate(series: MoneyEffectBar[], tradeDate: string): 0 | 1 {
  const prev = series.filter((b) => b.date < tradeDate).map((b) => b.close);
  if (prev.length < 6) return 1;
  const cPrev = prev[prev.length - 1];
  const ma5Now = mean(prev.slice(-5)); // MA5[D-1]
  const ma5Past = mean(prev.slice(-6, -1)); // MA5[D-2]
  return cPrev >= ma5Now && ma5Now > ma5Past ? 1 : 0;
}

/** 便捷：抓取序列并算当前 tradeDate 的仓位（best-effort，失败默认满仓 1 由调用方处理） */
export async function moneyEffectPosition(tradeDate: string): Promise<0 | 1> {
  const series = await fetchMoneyEffectSeries();
  return positionForDate(series, tradeDate);
}
