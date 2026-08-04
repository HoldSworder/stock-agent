// 妙想模拟盘响应的统一清洗 + 精简格式化。
// 单一来源：positions 的「滤清仓 count<=0」与「*Dec 价格还原」口径同时供
// mx_simulator 工具（阅读用文本）与 miaoxiangSync（写库归一）复用，避免重复实现。

/**
 * 安全取嵌套 data 对象（妙想响应统一 { data: {...} } 结构）。
 * @param resp 妙想接口原始响应
 * @returns data 子对象；无 data 时回退整对象；非对象返回空对象
 */
export function dataOf(resp: unknown): Record<string, unknown> {
  if (resp && typeof resp === 'object') {
    const obj = resp as Record<string, unknown>;
    const d = obj.data;
    if (d && typeof d === 'object') return d as Record<string, unknown>;
    return obj;
  }
  return {};
}

/**
 * 转有限数字，非法值归 0。
 * @param v 任意值
 * @returns 有限数字，否则 0
 */
export function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 按 *Dec 小数位还原真实价格：rawValue / 10^dec。
 * @param value 放大后的整数原值
 * @param dec 小数位数
 * @returns 还原后的价格
 */
export function scaled(value: unknown, dec: unknown): number {
  const raw = num(value);
  const d = num(dec);
  return d > 0 ? raw / 10 ** d : raw;
}

/**
 * secCode 可能带市场后缀/前缀，统一取 6 位数字代码。
 * @param raw 原始证券代码
 * @returns 6 位数字代码；取不到时返回原字符串
 */
export function normCode(raw: unknown): string {
  const s = String(raw ?? '');
  const m = s.match(/\d{6}/);
  return m ? m[0] : s;
}

/** 清洗后的持仓富字段对象（供工具展示；写库侧仅取其子集）。 */
export interface CleanPosition {
  code: string;
  name: string;
  qty: number;
  availCount: number;
  price: number;
  avgCost: number;
  value: number;
  profit: number;
  profitPct: number;
  dayProfit: number;
  posPct: number;
}

/**
 * 解析 positions 响应为清洗后的持仓列表：滤掉已清仓（count<=0），还原价格。
 * 单一来源：miaoxiangSync.parseAccount 与 mx_simulator 工具共用此过滤/还原口径。
 * @param resp positions 接口原始响应
 * @returns 清洗后的持仓数组（不含清仓项）
 */
export function parsePositions(resp: unknown): CleanPosition[] {
  const list = dataOf(resp).posList;
  if (!Array.isArray(list)) return [];
  const out: CleanPosition[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    const qty = num(p.count);
    if (qty <= 0) continue; // 已清仓跳过
    out.push({
      code: normCode(p.secCode),
      name: String(p.secName ?? ''),
      qty,
      availCount: num(p.availCount),
      price: scaled(p.price, p.priceDec),
      avgCost: scaled(p.costPrice, p.costPriceDec),
      value: num(p.value),
      profit: num(p.profit),
      profitPct: num(p.profitPct),
      dayProfit: num(p.dayProfit),
      posPct: num(p.posPct),
    });
  }
  return out;
}

/**
 * 持仓查询 → 精简文本（滤清仓、还原价格，仅保留关键字段）。
 * @param resp positions 接口原始响应
 * @returns 多行可读文本
 */
export function formatPositions(resp: unknown): string {
  const d = dataOf(resp);
  const positions = parsePositions(resp);
  const header =
    `资金：总资产${num(d.totalAssets).toFixed(2)} 可用${num(d.availBalance).toFixed(2)} ` +
    `持仓市值${num(d.totalPosValue).toFixed(2)} 总盈亏${num(d.totalProfit).toFixed(2)}`;
  if (positions.length === 0) {
    return `${header}\n当前无持仓（已过滤清仓项）`;
  }
  const lines = positions.map(
    (p) =>
      `- ${p.name}(${p.code}) 现价${p.price} 成本${p.avgCost.toFixed(3)} ${p.qty}股 可卖${p.availCount} ` +
      `市值${p.value.toFixed(0)} 浮盈${p.profit.toFixed(0)}(${p.profitPct.toFixed(2)}%) ` +
      `当日${p.dayProfit.toFixed(0)} 仓位${p.posPct.toFixed(1)}%`,
  );
  return `${header}\n持仓 ${positions.length} 只：\n${lines.join('\n')}`;
}

/**
 * 资金查询 → 单行精简文本。
 * @param resp balance 接口原始响应
 * @returns 可读文本
 */
export function formatBalance(resp: unknown): string {
  const d = dataOf(resp);
  return (
    `总资产${num(d.totalAssets).toFixed(2)} 可用${num(d.availBalance).toFixed(2)} ` +
    `冻结${num(d.frozenMoney).toFixed(2)} 持仓市值${num(d.totalPosValue).toFixed(2)} ` +
    `仓位${num(d.totalPosPct).toFixed(1)}% 初始资金${num(d.initMoney).toFixed(2)}`
  );
}

/** 委托状态码 → 中文标签。 */
const ORDER_STATUS_LABEL: Record<number, string> = {
  1: '未报',
  2: '已报',
  3: '部成',
  4: '已成',
  5: '部成待撤',
  6: '已报待撤',
  7: '部撤',
  8: '已撤',
  9: '废单',
  10: '撤单失败',
};

/** 需过滤掉的无效委托状态（废单 / 撤单失败）。 */
const ORDER_STATUS_DROP = new Set([9, 10]);

/**
 * unix 秒 → Asia/Shanghai HH:mm（委托时间展示用）。
 * @param sec unix 秒（或毫秒）
 * @returns HH:mm 字符串，无效返回空串
 */
function shanghaiTimeFromUnix(sec: number): string {
  if (sec <= 0) return '';
  const ms = sec > 1e12 ? sec : sec * 1000;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms));
}

/**
 * 委托查询 → 精简文本（默认过滤废单/撤单失败，还原价格，字段精简）。
 * @param resp orders 接口原始响应
 * @returns 多行可读文本
 */
export function formatOrders(resp: unknown): string {
  const list = dataOf(resp).orders;
  if (!Array.isArray(list)) return '无委托记录';
  const lines: string[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const status = num(o.status);
    if (ORDER_STATUS_DROP.has(status)) continue; // 废单/撤单失败跳过
    const side = num(o.drt) === 2 ? '卖' : '买';
    const price = scaled(o.price, o.priceDec);
    const tradePrice = scaled(o.tradePrice, o.priceDec);
    const count = num(o.count);
    const tradeCount = num(o.tradeCount);
    const time = shanghaiTimeFromUnix(num(o.time));
    const statusLabel = ORDER_STATUS_LABEL[status] ?? `状态${status}`;
    lines.push(
      `- ${time} ${side} ${String(o.secName ?? '')}(${normCode(o.secCode)}) ` +
        `委托${price}×${count} 成交${tradePrice}×${tradeCount} [${statusLabel}]`,
    );
  }
  if (lines.length === 0) return '无有效委托记录（已过滤废单/撤单失败）';
  return `有效委托 ${lines.length} 条：\n${lines.join('\n')}`;
}
