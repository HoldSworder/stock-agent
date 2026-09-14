import type { RealTradeGuess, RealTradeGuessKind } from '@stock-agent/shared';

// 从按日持仓快照反推成交。
//
// 为什么需要它：券商账本接口只给「现在拿着什么」，不给成交流水。
// 而「这个系统有没有帮我赚到钱」这个问题，只有逐笔成交能回答。
// 相邻两日的持仓数量变化是唯一现成的线索：1000 → 0 即卖出，0 → 1000 即买入。
//
// 它的天花板必须写在脸上，不能让反推出来的账冒充精确账：
//   · 同日先买后卖：两次动作互相抵消，快照看不出任何变化
//   · 分红送股：数量凭空增加，会被当成买入
//   · 部分减仓改成本：成本价变了，但无法区分是减仓摊薄还是补仓摊薄
//   · T+0 回转：当日买卖不改变收盘数量
// 遇到这几种情形一律标为「说不清」，而不是给一个看起来精确的数字。
// 要精确只有一条路：去接券商的成交流水接口。

/** 一天的持仓快照（只取反推需要的字段） */
export interface SnapshotRow {
  tradeDate: string;
  code: string;
  name: string;
  qty: number;
  avgCost: number;
  price: number;
}

/** 数量变化小于这个比例视为没变，容忍浮点与券商四舍五入 */
const QTY_EPS = 1e-6;

/**
 * 成本价变化超过这个比例，就说明期间发生了改变成本的动作（补仓、分红送股、拆分）。
 * 单纯的部分减仓不改变成本价，所以成本价一动，数量变化的含义就不唯一了。
 */
const COST_DRIFT = 0.005;

function near(a: number, b: number, rel: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / scale <= rel;
}

/**
 * 比较相邻两日的快照，反推这一天发生了什么。
 *
 * @param prev 前一日快照（按标的）
 * @param curr 当日快照（按标的）
 * @param closedCodes 当日清仓台账里出现的标的。它是券商明确给出的清仓事实，
 *        比差分可靠，用来把「数量归零」从猜测升级为确认。
 */
export function diffSnapshots(
  prev: SnapshotRow[],
  curr: SnapshotRow[],
  closedCodes: ReadonlySet<string> = new Set(),
): RealTradeGuess[] {
  const prevMap = new Map(prev.map((r) => [r.code, r]));
  const currMap = new Map(curr.map((r) => [r.code, r]));
  const codes = [...new Set([...prevMap.keys(), ...currMap.keys()])].sort();
  const date = curr[0]?.tradeDate ?? prev[0]?.tradeDate ?? '';

  const out: RealTradeGuess[] = [];
  for (const code of codes) {
    const a = prevMap.get(code);
    const b = currMap.get(code);

    // 新出现：从无到有即买入
    if (!a && b) {
      if (b.qty > QTY_EPS) {
        out.push(mk(date, b, 'buy', b.qty, '之前没有这只，当日新建仓'));
      }
      continue;
    }

    // 消失：券商清仓台账里有就是确认卖出，没有则只能说不清
    // （可能是清仓，也可能是当天没同步到这只）
    if (a && !b) {
      out.push(
        closedCodes.has(code)
          ? mk(date, a, 'sell', a.qty, '券商清仓记录确认，全部卖出')
          : mk(date, a, 'unknown', 0, '这只从快照里消失了，但没有清仓记录，说不清是卖了还是没同步到'),
      );
      continue;
    }
    if (!a || !b) continue;

    const dq = b.qty - a.qty;
    const costMoved = !near(a.avgCost, b.avgCost, COST_DRIFT);

    // 数量没变
    if (Math.abs(dq) <= QTY_EPS * Math.max(a.qty, 1)) {
      // 数量没变但成本变了：分红送股、或者同日买卖后又回到原数量，都说不清
      if (costMoved) {
        out.push(
          mk(date, b, 'unknown', 0, '数量没变但成本价变了，可能是分红送股或当日买卖抵消，说不清'),
        );
      }
      continue;
    }

    if (dq > 0) {
      // 加仓。成本价没动却加了仓是不可能的（除非送股），标出来
      out.push(
        costMoved
          ? mk(date, b, 'buy', dq, '数量增加且成本变化，按加仓计')
          : mk(date, b, 'unknown', dq, '数量增加但成本价没变，像是分红送股而不是买入，说不清'),
      );
      continue;
    }

    // 减仓。部分减仓不改成本价；成本价同时变了说明期间还有别的动作
    out.push(
      costMoved
        ? mk(date, b, 'unknown', -dq, '数量减少但成本价也变了，期间还有别的动作，说不清具体卖了多少')
        : mk(date, b, 'sell', -dq, '数量减少、成本价未变，按部分减仓计'),
    );
  }
  return out;
}

function mk(
  date: string,
  row: SnapshotRow,
  kind: RealTradeGuessKind,
  qty: number,
  note: string,
): RealTradeGuess {
  return {
    tradeDate: date,
    code: row.code,
    name: row.name,
    kind,
    qty,
    price: row.price,
    note,
  };
}

/**
 * 对一串按日快照逐日反推。
 * @param rows 全部快照行，不要求有序
 */
export function guessTrades(
  rows: SnapshotRow[],
  closedByDate: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): RealTradeGuess[] {
  const byDate = new Map<string, SnapshotRow[]>();
  for (const r of rows) {
    const arr = byDate.get(r.tradeDate) ?? [];
    arr.push(r);
    byDate.set(r.tradeDate, arr);
  }
  const dates = [...byDate.keys()].sort();
  const out: RealTradeGuess[] = [];
  for (let i = 1; i < dates.length; i += 1) {
    out.push(
      ...diffSnapshots(
        byDate.get(dates[i - 1]) ?? [],
        byDate.get(dates[i]) ?? [],
        closedByDate.get(dates[i]) ?? new Set(),
      ),
    );
  }
  return out;
}
