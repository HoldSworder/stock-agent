// 妙想模拟盘下单前的确定性风控护栏（纯函数、可单测）。
// 复盘发现下单参数错乱导致废单率 31.5%（奇数股数 + 价格量纲错乱），并存在单票超配。
// 本护栏在 mx_trade 发请求前对数量/价格/仓位做硬性归一，从根上消除废单并落实风控。

/** 单票买入金额占总资产上限（0.30 = 30%，与持仓结构目标上限一致） */
export const SINGLE_POS_CAP_PCT = 0.3;

/** A 股最小交易单位（股），委托数量必须为其整数倍 */
export const LOT = 100;

/** 护栏输入 */
export interface GuardInput {
  /** 买卖方向 */
  side: 'buy' | 'sell';
  /** 原始委托数量（股） */
  qty: number;
  /** 原始限价（元）；市价单可省略 */
  price?: number;
  /** 是否市价单（true 时不校验/修正价格） */
  useMarketPrice: boolean;
  /** 当日涨停价（元）；取不到时省略，跳过价格越界修正 */
  limitUp?: number;
  /** 当日跌停价（元）；取不到时省略，跳过价格越界修正 */
  limitDown?: number;
  /** 账户总资产（元）；仅 buy 且提供时启用单票上限 */
  totalAsset?: number;
  /**
   * 该标的当前持仓市值（元）；仅 buy 时参与单票上限。
   * 省略时退化为只看本单金额——同一标的分多次小额买入可累积突破上限，调用方应尽量传入。
   */
  currentPositionValue?: number;
}

/** 护栏结果 */
export interface GuardResult {
  /** 是否放行下单 */
  ok: boolean;
  /** 修正后的委托数量（100 的整数倍） */
  qty: number;
  /** 修正后的限价（元）；市价单/无涨跌停时原样透传 */
  price?: number;
  /** 自动修正说明（供回执/复盘展示） */
  notes: string[];
  /** ok=false 时的拒单原因 */
  rejectReason?: string;
}

/** 向下取整到 LOT 的整数倍 */
function floorLot(qty: number): number {
  return Math.floor(qty / LOT) * LOT;
}

/**
 * 限价越界判定为「量纲错乱」的倍数阈值：偏离量超过涨跌停区间宽度的这么多倍即视为写错单位。
 * 贴边小幅越界（如报价比涨停高几分）是正常的追价意图，按即成修正；
 * 10 元的票报 898 这种量级错误若也改成涨停价，等于替用户下了一笔他没打算下的即成单。
 */
export const PRICE_SCALE_ERROR_MULT = 2;

/**
 * 妙想下单参数确定性护栏：数量取整 100 倍、限价越涨跌停即成修正、买入单票超 30% 自动下调。
 * 纯函数，不含任何 I/O；涨跌停价/总资产/当前持仓市值由调用方取好传入（取不到则对应校验自动跳过）。
 * @param input 原始下单参数 + 校验所需的涨跌停价/总资产/持仓市值
 * @returns 放行标志、修正后的 qty/price、修正说明与拒单原因
 */
export function guardMxTradeParams(input: GuardInput): GuardResult {
  const { side, useMarketPrice, limitUp, limitDown, totalAsset } = input;
  const notes: string[] = [];

  // 0. 非有限数量直接拒单：floorLot(NaN) 得 NaN，NaN < LOT 为 false 会一路放行到 qty:NaN
  if (!Number.isFinite(input.qty)) {
    return { ok: false, qty: 0, notes, rejectReason: `委托数量非法（${input.qty}），拒单` };
  }

  // 1. 数量取整到 100 倍（消除奇数股废单）
  let qty = floorLot(input.qty);
  if (qty !== input.qty) {
    notes.push(`数量 ${input.qty} 非 100 整数倍，已下取整为 ${qty} 股`);
  }
  if (qty < LOT) {
    return {
      ok: false,
      qty: 0,
      notes,
      rejectReason: `数量不足 ${LOT} 股（原始 ${input.qty}），拒单防残单/奇数股`,
    };
  }

  // 2. 限价越涨跌停：贴边小幅越界按即成修正，量级错乱直接拒单
  let price = input.price;
  const hasLimits = typeof limitUp === 'number' && typeof limitDown === 'number';
  if (!useMarketPrice && typeof price === 'number' && hasLimits) {
    const up = limitUp as number;
    const down = limitDown as number;
    if (price > up || price < down) {
      const width = Math.max(up - down, 0);
      const deviation = price > up ? price - up : down - price;
      if (width <= 0 || deviation > width * PRICE_SCALE_ERROR_MULT) {
        return {
          ok: false,
          qty: 0,
          price,
          notes,
          rejectReason: `限价 ${price} 远离涨跌停区间 [${down}, ${up}]（偏离 ${deviation.toFixed(2)} 元，超区间宽度 ${PRICE_SCALE_ERROR_MULT} 倍），判为价格量纲错乱，拒单`,
        };
      }
      const fixed = side === 'sell' ? down : up;
      notes.push(
        `限价 ${price} 小幅超出涨跌停区间 [${down}, ${up}]，已按${side === 'sell' ? '跌停' : '涨停'}价即成修正为 ${fixed}`,
      );
      price = fixed;
    }
  }

  // 3. 买入单票上限：按「已有持仓市值 + 本单金额」比对，避免同一标的分多次小额买入累积超配
  if (side === 'buy' && typeof totalAsset === 'number' && totalAsset > 0 && typeof price === 'number' && price > 0) {
    const cap = SINGLE_POS_CAP_PCT * totalAsset;
    const held = Number.isFinite(input.currentPositionValue) ? Math.max(input.currentPositionValue as number, 0) : 0;
    if (held + qty * price > cap) {
      const capQty = floorLot(Math.max(cap - held, 0) / price);
      if (capQty < LOT) {
        return {
          ok: false,
          qty: 0,
          price,
          notes,
          rejectReason:
            held > 0
              ? `该标的已持有 ${held.toFixed(0)} 元，已达单票 ${(SINGLE_POS_CAP_PCT * 100).toFixed(0)}% 上限（${cap.toFixed(0)} 元），剩余预算不足 ${LOT} 股，拒单`
              : `单票预算不足 ${LOT} 股（上限 ${cap.toFixed(0)} 元 / 价 ${price}），拒单`,
        };
      }
      notes.push(
        `买入后单票市值超 ${(SINGLE_POS_CAP_PCT * 100).toFixed(0)}% 上限（${cap.toFixed(0)} 元，已持有 ${held.toFixed(0)} 元），数量由 ${qty} 下调为 ${capQty} 股`,
      );
      qty = capQty;
    }
  }

  return { ok: true, qty, price, notes };
}

// ===== 拒单熔断：同一 run 内同一「方向+标的」被妙想拒单达上限后不再发请求 =====
// 复盘发现模型会对同一只票反复微调限价死磕（1015 一次跑掉 15 步全在改价重下），把 maxSteps 耗尽后
// 整个任务以「超过最大步数」告败、报告丢失。这里按 run+方向+标的计数，达上限即短路，逼模型收敛去写报告。

/** 单 run 内同一「方向+标的」允许的拒单次数，超过即熔断不再下单 */
export const MAX_TRADE_REJECTS = 3;

/** 拒单计数表：key = `${runId}:${side}:${code}` */
const rejectCounts = new Map<string, number>();

/** 计数表上限，超过即整表清空（ponytail: 进程级最简回收，run 结束无显式清理钩子） */
const REJECT_MAP_CAP = 2000;

/** 拒单计数 key（runId 缺失时归入 adhoc 桶，仍能拦住同一次会话内的死磕） */
function rejectKey(runId: string | null, side: 'buy' | 'sell', code: string): string {
  return `${runId ?? 'adhoc'}:${side}:${code}`;
}

/**
 * 记一次妙想拒单，返回该 run 内此「方向+标的」的累计拒单次数。
 * @param runId 当前运行 id（可空）
 * @param side 买卖方向
 * @param code 股票代码
 */
export function noteTradeReject(runId: string | null, side: 'buy' | 'sell', code: string): number {
  if (rejectCounts.size >= REJECT_MAP_CAP) rejectCounts.clear();
  const key = rejectKey(runId, side, code);
  const next = (rejectCounts.get(key) ?? 0) + 1;
  rejectCounts.set(key, next);
  return next;
}

/**
 * 该「方向+标的」是否已拒单达上限（达上限后调用方应直接短路，不再请求妙想）。
 * @param runId 当前运行 id（可空）
 * @param side 买卖方向
 * @param code 股票代码
 */
export function isTradeRejectCapped(runId: string | null, side: 'buy' | 'sell', code: string): boolean {
  return (rejectCounts.get(rejectKey(runId, side, code)) ?? 0) >= MAX_TRADE_REJECTS;
}
