// 股票代码映射与通用数值/时区工具，统一收口（原分散于 eastmoney / etf / idingpan / thsFavorites / realPositions）。

/** 东方财富 push2 行情 API 基址（实时行情/榜单/批量报价共用） */
export const PUSH2_QT = 'https://push2.eastmoney.com/api/qt';

/** 东财数值字段常为字符串：非数字/空归一为 0（行情聚合用） */
export function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}

/** 同上但空串/'-'/非数字归一为 null（需区分「0」与「无数据」时用，如 IOPV/折溢价） */
export function numOrNull(v: unknown): number | null {
  if (v == null || v === '' || v === '-') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/** 6 位代码 → 东财 secid。沪市 5/6/9 开头前缀 1，其余（深市 0/1/3 开头）前缀 0。 */
export function toSecid(code: string): string {
  const prefix = /^(6|5|9)/.test(code) ? '1' : '0';
  return `${prefix}.${code}`;
}

/** 6 位代码 → 网易行情代码。沪市 5/6/9 开头前缀 0，深市前缀 1（与东财 secid 前缀相反）。 */
export function toNetease(code: string): string {
  return `${/^(6|5|9)/.test(code) ? '0' : '1'}${code}`;
}

/** 6 位代码 → 爱盯盘 codeId（市场.代码）；非 A 股/ETF（北交所 8/4、指数等）返回 null */
export function toCodeId(code: string): string | null {
  if (!/^\d{6}$/.test(code)) return null;
  if (/^(8|4)/.test(code)) return null; // 北交所，东财报价不覆盖、不可交易
  const market = /^(6|5|9)/.test(code) ? '1' : '0'; // 1=沪 0=深
  return `${market}.${code}`;
}

/** 按代码前缀推断同花顺 api_type（写透自选时用） */
export function inferApiType(code: string): string {
  if (/^688/.test(code)) return '18'; // 科创板
  if (/^(51|56|58|50|52)/.test(code)) return '20'; // 沪市 ETF
  if (/^(15|16|18)/.test(code)) return '36'; // 深市 ETF
  if (/^6/.test(code)) return '17'; // 沪市主板
  if (/^(00|30)/.test(code)) return '33'; // 深市主板/创业板
  if (/^(8|4)/.test(code)) return '71'; // 北交所
  return '17';
}

/** 取指定时间在 Asia/Shanghai 的 YYYY-MM-DD 与 YYYYMMDD */
export function shanghaiYmd(d: Date = new Date()): { ymd: string; compact: string } {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  return { ymd, compact: ymd.replace(/-/g, '') };
}
