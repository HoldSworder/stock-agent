import { SHARES_PER_LOT, type KlineBar, type KlinePeriod } from '@stock-agent/shared';
import { getJson as getJsonRaw, MarketError, type FetchJsonOptions } from './eastmoney';
import { toTxCode } from './tencent';
import { num } from '../datasource/codes';

// 新浪为独立兜底数据源：调用统计归到 sourceId=sina
const getJson = (url: string, opts: FetchJsonOptions = {}): Promise<Record<string, unknown>> =>
  getJsonRaw(url, { sourceId: 'sina', ...opts });

// 新浪财经 K 线（getKLineData）薄封装，作为东财 / 腾讯之外的第三兜底源。
// 覆盖：日(scale=240) + 5/15/30/60 分钟；不支持 120 分钟与周/月（scale=120 返回 null）。
// 新浪 symbol 与腾讯 code 同为 sh/sz 前缀，故复用 toTxCode。

const SINA_KLINE = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData';
const SINA_HEADERS = { Referer: 'https://finance.sina.com.cn/' };

// 周期 → 新浪 scale（分钟数；日线为 240）。未列出的级别新浪不支持。
const SINA_SCALE: Partial<Record<KlinePeriod, number>> = {
  day: 240,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '60m': 60,
};

interface SinaRow {
  day?: string;
  open?: string;
  high?: string;
  low?: string;
  close?: string;
  volume?: string;
}

/**
 * 新浪单行 → KlineBar。独立导出以便单位不变式自检（klineVolumeUnit.selfcheck）能离线断言换算。
 * @param isMinute 分钟 day 形如 "2026-06-10 14:00:00"，截断为 "YYYY-MM-DD HH:MM"；日线本就 "YYYY-MM-DD"
 */
export function toSinaBar(r: SinaRow, isMinute: boolean): KlineBar {
  const raw = String(r.day ?? '');
  return {
    time: isMinute && raw.length > 10 ? raw.slice(0, 16) : raw,
    open: num(r.open),
    close: num(r.close),
    high: num(r.high),
    low: num(r.low),
    // 新浪 volume 单位是「股」，本项目 KlineBar.volume 统一用「手」（与东财 f56、mootdx vol、前端 fmtVol 一致）。
    // 不归一会让同一张日线缓存表里混两种单位，量比/成交量中位数直接差 100 倍。
    // 2026-08-04 对账：新浪 08-03 给 9301253966，mootdx 同日给 93012544 手，正好 100 倍。
    volume: num(r.volume) / SHARES_PER_LOT,
    // 新浪日线接口不返回成交额
    amount: 0,
  } satisfies KlineBar;
}

/**
 * 新浪 K 线（不复权），支持个股 / 指数的 日 + 5/15/30/60 分钟；
 * 周 / 月 / 120 分钟及板块不支持，抛错由编排回退/兜底。
 */
export async function getKlineSina(
  code: string,
  period: KlinePeriod = 'day',
  limit = 250,
  secid?: string,
): Promise<KlineBar[]> {
  const scale = SINA_SCALE[period];
  if (!scale) throw new MarketError(`新浪行情不支持的周期: ${period}`);
  const symbol = toTxCode(code, secid);
  if (!symbol) throw new MarketError(`新浪行情不支持的代码: ${secid || code}`);

  const url = `${SINA_KLINE}?symbol=${symbol}&scale=${scale}&ma=no&datalen=${limit}`;
  // 新浪返回 JSON 数组（非 {data:...}），校验为非空数组
  const json = (await getJson(url, {
    label: '新浪行情',
    headers: SINA_HEADERS,
    validate: (j) => Array.isArray(j as unknown) && (j as unknown as unknown[]).length > 0,
  })) as unknown as SinaRow[];

  // 分钟与日线共用同一映射（含 /100 归一）：口径只写一处，才谈得上被自检钉住
  return json.map((r) => toSinaBar(r, scale < 240));
}
