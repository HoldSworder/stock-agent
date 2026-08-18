import type { TradeLevel } from '@stock-agent/shared';

// 交易计划面板里有明确边界语义的纯函数。抽出来是为了能单独推敲与复用：
// 它们的输出会直接变成用户照着挂的单价与股数，边界错了不会报错、只会算错钱。

/**
 * 按角色优先级取价位：外层遍历 roles，内层才在 levels 里找。
 *
 * 不能写成 `levels.find(l => roles.includes(l.role))`——那取的是 levels 数组顺序里
 * 第一个命中项，而 plan.levels 的顺序完全等于 LLM 提交 levelSelections 的顺序
 * （后端直接 map、不排序）。模型先列了 resistance，「触发线」就会显示一条压力位
 * 而不是 entry_trigger，而这条线还要作为 entry 参与股数与最大亏损换算。
 */
export function pickLevelByRolePriority(
  levels: TradeLevel[],
  roles: readonly string[],
): TradeLevel | undefined {
  for (const role of roles) {
    const hit = levels.find((l) => l.role === role);
    if (hit) return hit;
  }
  return undefined;
}

/** 比例合计是否可视为 1（允许 LLM 给出 0.33+0.33+0.34 这类取整误差） */
const FRACTION_SUM_EPS = 0.02;

/**
 * 分批股数：按比例向下取整到整手。
 *
 * 只有「比例合计≈1」时才把余数并进最后一批——各批独立向下取整会让合计少于总股数
 * （700 股按 0.5/0.5 分成 300+300），用户照着挂完单会莫名剩一笔零股。
 * 但 reduceFractions 并无「合计必须为 1」的约束，合计 0.6 时无条件并入余数，
 * 界面写着「30% + 30%」、指令却给出「200 股 → 500 股」，第二批会把不该减的一起卖掉。
 */
export function splitBatchShares(shares: number, fractions: number[]): number[] {
  const sum = fractions.reduce((a, b) => a + b, 0);
  const absorbRemainder = Math.abs(sum - 1) <= FRACTION_SUM_EPS;
  const out: number[] = [];
  let left = shares;
  fractions.forEach((f, i) => {
    const byFraction = Math.min(left, Math.floor((shares * f) / 100) * 100);
    const isLast = i === fractions.length - 1;
    const n = isLast && absorbRemainder ? left : byFraction;
    out.push(n);
    left -= n;
  });
  return out.filter((n) => n > 0);
}
