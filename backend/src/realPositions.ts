import { eq } from 'drizzle-orm';
import type { RealPortfolio, RealPosition } from '@stock-agent/shared';
import { db, schema } from './db/client';
import { getValue } from './settings';
import { newId, nowIso } from './util';

// 真实持仓数据源：LXC 上的 portfolio-sync 用同花顺 cookie 拉持仓、用 mx 校正当日盈亏，
// 再把含结构化 JSON 块的 Markdown 快照写入 OpenViking。
// 本模块按日期回溯读取最新快照，解析后归一化，并镜像落 positions 表（account=real）。

export class RealPositionError extends Error {}

const MAX_LOOKBACK_DAYS = 10;

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}

/** 取指定时间在 Asia/Shanghai 的 YYYY/MM/DD 路径片段 */
function shanghaiYmd(d: Date): { y: string; m: string; day: string; ymd: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  const [y, m, day] = parts.split('-');
  return { y, m, day, ymd: parts };
}

/** 调 OpenViking content/read（GET），不存在或失败返回 null */
async function ovRead(uri: string): Promise<string | null> {
  const base = getValue('ovBaseUrl').replace(/\/$/, '');
  const apiKey = getValue('ovApiKey');
  const account = getValue('ovAccount') || 'user';
  const user = getValue('ovUser') || 'default';
  if (!apiKey) throw new RealPositionError('OpenViking API Key 未配置，请到设置页填写');
  if (!base) throw new RealPositionError('OpenViking Base URL 未配置');

  const url = `${base}/api/v1/content/read?uri=${encodeURIComponent(uri)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-OpenViking-Account': account,
        'X-OpenViking-User': user,
      },
    });
  } catch (e) {
    throw new RealPositionError(`OpenViking 请求失败: ${e instanceof Error ? e.message : e}`);
  }
  if (!res.ok) return null;
  const json = (await res.json()) as { status?: string; result?: unknown };
  if (json.status !== 'ok' || typeof json.result !== 'string') return null;
  return json.result;
}

interface RawSnapshot {
  cash: number;
  asOf: string;
  positions: Array<Record<string, unknown>>;
}

/** 从快照 Markdown 提取结构化 JSON 块与数据时间 */
function parseSnapshot(md: string): RawSnapshot | null {
  const fence = md.indexOf('```json');
  if (fence < 0) return null;
  const end = md.indexOf('```', fence + 7);
  if (end < 0) return null;
  let obj: { money_remain?: unknown; positions?: unknown };
  try {
    obj = JSON.parse(md.slice(fence + 7, end).trim());
  } catch {
    return null;
  }
  const timeMatch = md.match(/数据时间:\s*([0-9T:.+\-]+)/);
  return {
    cash: num(obj.money_remain),
    asOf: timeMatch?.[1] ?? nowIso(),
    positions: Array.isArray(obj.positions)
      ? (obj.positions as Array<Record<string, unknown>>)
      : [],
  };
}

function normalize(raw: Record<string, unknown>): RealPosition {
  return {
    code: String(raw.code ?? ''),
    name: String(raw.name ?? ''),
    market: String(raw.market ?? ''),
    qty: num(raw.count),
    avgCost: num(raw.cost),
    price: num(raw.price),
    marketValue: num(raw.value),
    holdProfit: num(raw.hold_profit),
    holdRate: num(raw.hold_rate),
    todayProfit: num(raw.pre_profit),
    todayRate: num(raw.pre_rate),
    positionRate: num(raw.position_rate),
    holdDays: num(raw.hold_days),
  };
}

/** 把真实持仓镜像写入 positions 表（先清旧 real 行，再写当前快照） */
function persist(portfolio: RealPortfolio): void {
  db.delete(schema.positions).where(eq(schema.positions.account, 'real')).run();
  for (const p of portfolio.positions) {
    db.insert(schema.positions)
      .values({
        id: newId(),
        account: 'real',
        code: p.code,
        name: p.name,
        qty: p.qty,
        avgCost: p.avgCost,
        price: p.price,
        marketValue: p.marketValue,
        profit: p.holdProfit,
        snapshotAt: portfolio.asOf,
      })
      .run();
  }
}

/**
 * 读取最新真实持仓快照。
 * 从今天起按 Asia/Shanghai 日期回溯，命中第一个存在的快照即返回并落库。
 */
export async function fetchRealPositions(persistSnapshot = true): Promise<RealPortfolio> {
  const prefix = getValue('ovEventsPrefix').replace(/\/$/, '');
  const now = Date.now();

  for (let i = 0; i < MAX_LOOKBACK_DAYS; i++) {
    const { y, m, day, ymd } = shanghaiYmd(new Date(now - i * 86400000));
    const uri = `${prefix}/${y}/${m}/${day}/portfolio_snapshot.md`;
    const md = await ovRead(uri);
    if (!md) continue;
    const snap = parseSnapshot(md);
    if (!snap) continue;

    const positions = snap.positions.map(normalize);
    const totalMarketValue = positions.reduce((s, p) => s + p.marketValue, 0);
    const portfolio: RealPortfolio = {
      asOf: snap.asOf,
      sourceDate: ymd,
      sourceUri: uri,
      cash: snap.cash,
      positionCount: positions.length,
      totalMarketValue,
      totalAsset: snap.cash + totalMarketValue,
      totalHoldProfit: positions.reduce((s, p) => s + p.holdProfit, 0),
      totalTodayProfit: positions.reduce((s, p) => s + p.todayProfit, 0),
      positions,
    };
    if (persistSnapshot) persist(portfolio);
    return portfolio;
  }

  throw new RealPositionError(
    `近 ${MAX_LOOKBACK_DAYS} 天内未在 OpenViking 找到持仓快照，请确认 LXC portfolio-sync 已运行`,
  );
}
