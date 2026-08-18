import { z } from 'zod';
import type { PlaybookSpec } from '@stock-agent/shared';

// 战法 spec 的运行时校验。全仓原先只有编译期类型：`PUT /api/playbooks/:id/spec` 与回测入口
// 都直接把 body 里的 spec 存库并执行，`days: 0` 这种值能一路跑到 `bars.slice(i, i)`，
// Math.max() 得 -Infinity，于是每根 bar 都判「创新高」，产出一条看似正常实则每日开仓的曲线。
// zod 已是仓库既有依赖，不新增。

/** 窗口类参数：至少 1 根，上限对齐回测最多取 2000 根 K 线 */
const days = z.number().int().min(1).max(2000);
const period = z.number().int().min(1).max(1000);
const op = z.enum(['gte', 'lte', 'gt', 'lt']);
const maType = z.enum(['sma', 'ema']);
const finite = z.number().finite();

const ruleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ma'),
    maType,
    left: z.enum(['close', 'ma']),
    leftPeriod: period.optional(),
    period,
    relation: z.enum(['above', 'below', 'crossUp', 'crossDown']),
  }),
  z.object({
    kind: z.literal('maAlign'),
    maType,
    periods: z.array(period).min(2).max(6),
    dir: z.enum(['up', 'down']),
  }),
  z.object({ kind: z.literal('pctChange'), days, op, value: finite }),
  z.object({ kind: z.literal('extreme'), extreme: z.enum(['newHigh', 'newLow']), days }),
  z.object({ kind: z.literal('volRatio'), days, op, value: finite.positive() }),
  z.object({
    kind: z.literal('macd'),
    signal: z.enum(['goldCross', 'deadCross', 'barAbove0', 'barBelow0']),
  }),
  z.object({
    kind: z.literal('kdj'),
    signal: z.enum(['goldCross', 'deadCross', 'kAbove', 'kBelow']),
    value: z.number().min(0).max(100).optional(),
  }),
  z.object({ kind: z.literal('rsi'), period, op, value: z.number().min(0).max(100) }),
  z.object({
    kind: z.literal('boll'),
    pos: z.enum(['aboveUpper', 'belowLower', 'aboveMid', 'belowMid']),
  }),
  z.object({ kind: z.literal('drawdown'), days, op, value: finite }),
  z.object({ kind: z.literal('consecutive'), dir: z.enum(['up', 'down']), bars: days }),
  z.object({ kind: z.literal('limit'), dir: z.enum(['up', 'down']) }),
  z.object({ kind: z.literal('pnlPct'), op, value: finite }),
  z.object({ kind: z.literal('heldBars'), op, value: z.number().int().min(0).max(2000) }),
  z.object({ kind: z.literal('amountRatio'), days, op, value: finite.positive() }),
  z.object({ kind: z.literal('closeLocation'), op, value: z.number().min(0).max(1) }),
  z.object({
    kind: z.literal('priceLevel'),
    level: finite.positive(),
    relation: z.enum(['crossUp', 'crossDown', 'holdAbove', 'holdBelow', 'touch']),
  }),
  z.object({
    kind: z.literal('barsSincePlan'),
    op,
    value: z.number().int().min(0).max(2000),
  }),
]);

const groupSchema = z.object({
  mode: z.enum(['all', 'any']),
  rules: z.array(ruleSchema).max(20),
});

const costsSchema = z
  .object({
    commissionBps: z.number().min(0).max(500).optional(),
    minCommission: z.number().min(0).max(1000).optional(),
    stampDutyBps: z.number().min(0).max(500).optional(),
    transferFeeBps: z.number().min(0).max(500).optional(),
    slippageBps: z.number().min(0).max(500).optional(),
  })
  .strict();

const specSchema = z.object({
  // universe / entry / exit 整体缺失是合法的：resolveUniverse 用 `spec.universe?.kind ?? 'codes'`、
  // assertRunnableSpec 用 `spec.exit?.rules?.length ?? 0`（正是为「没有 exit 字段、只配止损」的
  // spec 准备的分支）。要求它们必须存在，等于用一道新校验把这类 spec 判成 400。
  // 「买入规则缺失」「无任何离场手段」由 assertRunnableSpec 给出人话报错，不归 zod 管。
  universe: z
    .object({
      kind: z.enum(['codes', 'watchlist', 'etfPool', 'researchUniverse']),
      // 先 trim 再校验：resolveUniverse 本来就 `.trim()`，历史上存过带空白的代码不该被判非法
      codes: z.array(z.string().trim().regex(/^\d{6}$/)).max(200).nullish(),
    })
    .optional(),
  period: z.enum(['day', 'week']),
  barLimit: z.number().int().min(30).max(2000),
  entry: groupSchema.optional(),
  exit: groupSchema.optional(),
  // 允许 0：UI 的 :min="0" 放行 0，后端语义也把 0 当「已启用」（判空用 `!= null`），
  // 止损 0% = 亏损即走、止盈 0% = 转正即走，都是可表达的意图，不该被 schema 单方面拒掉
  stopLossPct: z.number().min(0).max(100).nullish(),
  takeProfitPct: z.number().min(0).max(1000).nullish(),
  maxHoldBars: z.number().int().min(1).max(2000).nullish(),
  fill: z.enum(['nextOpen', 'nextClose']),
  // nullish 而非 optional：库里既有 spec 存的是 costs: null（JSON 序列化的产物），
  // 而 resolveCosts 用 `input ?? {}` 本来就容忍 null。只认 undefined 会把这些
  // 早于本次校验落库的战法全部判为非法，等于用一道新校验废掉用户已有的战法。
  costs: costsSchema.nullish(),
});

export class PlaybookSpecError extends Error {}

/** 校验并原样返回 spec；非法值抛 PlaybookSpecError，由调用方转 400 */
export function validatePlaybookSpec(spec: unknown): PlaybookSpec {
  const r = specSchema.safeParse(spec);
  if (!r.success) {
    const detail = r.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || 'spec'}：${i.message}`)
      .join('；');
    throw new PlaybookSpecError(`战法规则参数非法 — ${detail}`);
  }
  // zod 只做值域校验，形状与 PlaybookSpec 一致，直接透传原对象保留未来新增的可选字段
  return spec as PlaybookSpec;
}
