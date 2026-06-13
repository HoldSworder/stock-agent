import { and, asc, eq } from 'drizzle-orm';
import { db, schema } from '../db/client';
import type { SkillDimension } from '@stock-agent/shared';
import { createStrategy, listStrategies, updateStrategy } from '../strategy/sim';
import { syncMiaoxiangStrategy } from '../strategy/miaoxiangSync';
import { setInitialSkills } from '../strategy/skill';
import { listTasks, updateTask } from '../tasks';
import { getValue, setValue } from '../settings';
import { nowIso } from '../util';
import { MIAOXIANG_TASK_NAMES, WEIPAN_TASK_NAME } from './cronTasks';

// 一次性幂等种子：创建两个战法并按任务名绑定。
// 用 settings 标志 strategies_seeded 保证只跑一次。
// 任务 prompt 的同步改写由 cronTasks.syncCronTasksFromOpenClaw() 负责，这里只管战法绑定。

const SEEDED_FLAG = 'strategies_seeded';

const MIAOXIANG_NAME = '妙想东财模拟盘';
const LOCAL_NAME = '尾盘动能套利';
const INITIAL_CAPITAL = 1_000_000;

// 妙想 MX_APIKEY（取自 openclaw，使镜像同步开箱可用；用户可在设置页覆盖）
const SEED_MX_APIKEY = 'mkt_54_Wc6-5-Pw4uDFTCKu5TZEsIiGfyEFdHIlwSEe8Q5Y';

/** 两个种子战法的「总计介绍」（卡片名下展示，提炼自各自三维度打法要点） */
const SEED_DESCRIPTIONS: Record<string, string> = {
  [LOCAL_NAME]:
    '本地虚拟盘。尾盘（14:30 后）筛选当日有持续动能、适合次日套利的主板/创业板强势主线标的（涨幅约 3%~7%、量能温和放大），小仓位试探买入，次日冲高或动能减弱即兑现，持有不超 1~2 个交易日。',
  [MIAOXIANG_NAME]:
    '妙想东财模拟盘镜像。量化筛选主板热门板块（涨幅 2%~7%、量比>1.2、成交额>3 亿、MACD>0 且站上 20 日线），开盘买入候选标的，盘中 10:15 / 14:43 两次卖点检查，严格 T+1 与涨跌停约束。',
};

/** 两个种子战法的 Skill 基线打法（三维度，提炼自各自的现行任务逻辑） */
const SKILL_BASELINE: Record<string, Record<SkillDimension, string>> = {
  [LOCAL_NAME]: {
    pick:
      '在尾盘（14:30 后）筛选当日有持续动能、适合次日套利的标的：\n' +
      '- 主板/创业板，回避科创板与北交所（无交易权限）；\n' +
      '- 当日涨幅适中（约 3%~7%），尾盘量能温和放大、未明显跳水；\n' +
      '- 属当日强势主线板块，且非一字/天量加速末端；\n' +
      '- 排除明显的高位连板分歧票与基本面爆雷标的。',
    buy:
      '尾盘对选出标的执行模拟买入：\n' +
      '- 数量为 100 股整数倍，单票仓位不超过总资产的 30%；\n' +
      '- 涨停不可买、资金充足；优先按现价小仓位试探；\n' +
      '- 给出明确买点理由（动能、主线、量价）并记录到 reason。',
    sell:
      '对已有持仓做尾盘卖点研判并在触发时模拟卖出：\n' +
      '- 次日冲高/开盘动能减弱即兑现，套利持有不超过 1~2 个交易日；\n' +
      '- 跌破买入逻辑（破位、放量下杀、主线退潮）止损；\n' +
      '- 遵守 T+1 与跌停不可卖，卖出理由记录到 reason。',
  },
  [MIAOXIANG_NAME]: {
    pick:
      '量化筛选主板热门板块标的（妙想模拟盘）：\n' +
      '- 涨幅 2%~7%、量比 > 1.2、成交额 > 3 亿、流通市值 50~800 亿；\n' +
      '- MACD > 0、价格在 20 日均线上；二次过滤后给不超过 3 只买入候选。',
    buy:
      '对候选标的开盘买入：含现价与买点理由，数量 100 股整数倍，\n' +
      '涨停不可买、资金充足，单票仓位适度分散。',
    sell:
      '盘中分两次卖点检查：\n' +
      '- 10:15 第一次：可止损/止盈，允许补仓；\n' +
      '- 14:43 第二次：仅卖不补（持有/减仓/清仓）；\n' +
      '每条操作附依据，遵守 T+1 与跌停不可卖。',
  },
};

/** 按名取战法，存在则复用，避免重复创建；新建时启用 Skill 自迭代 */
function ensureStrategy(name: string, kind: 'local' | 'miaoxiang') {
  const existing = listStrategies(true).find((s) => s.name === name);
  if (existing) return existing;
  return createStrategy({
    name,
    kind,
    description: SEED_DESCRIPTIONS[name] ?? null,
    initialCapital: INITIAL_CAPITAL,
    skillEnabled: true,
  });
}

/**
 * 自愈回填：给已存在但 description 为空的两个种子战法补上「总计介绍」。
 * 无视种子标志、幂等；仅在 description 为空时写入，避免覆盖用户自定义。
 */
function backfillSeedDescriptions(): void {
  for (const name of [MIAOXIANG_NAME, LOCAL_NAME]) {
    const s = listStrategies(true).find((x) => x.name === name);
    if (!s || (s.description && s.description.trim())) continue;
    updateStrategy(s.id, { description: SEED_DESCRIPTIONS[name] });
    console.log(`[seed] 已为战法「${name}」回填简介`);
  }
}

/**
 * 自愈去重：仅针对两个种子名（不碰用户自建同名战法）。
 * 同名多行时保留 createdAt 最早一条，把其余行的任务/持仓/流水引用重指到它后删除。
 * 用于修复历史并发启动产生的重复战法卡片，幂等可重复执行。
 */
function dedupeSeedStrategies(): void {
  for (const name of [MIAOXIANG_NAME, LOCAL_NAME]) {
    const rows = db
      .select()
      .from(schema.strategies)
      .where(eq(schema.strategies.name, name))
      .orderBy(asc(schema.strategies.createdAt))
      .all();
    if (rows.length <= 1) continue;
    const keep = rows[0];
    const dups = rows.slice(1);
    db.transaction((tx) => {
      for (const dup of dups) {
        // 任务、流水直接重指到 keep
        tx.update(schema.scheduledTasks)
          .set({ strategyId: keep.id })
          .where(eq(schema.scheduledTasks.strategyId, dup.id))
          .run();
        tx.update(schema.simTrades)
          .set({ strategyId: keep.id })
          .where(eq(schema.simTrades.strategyId, dup.id))
          .run();
        // 持仓重指前先删除与 keep 冲突的 code，避免同一战法重复持仓行
        const keepCodes = tx
          .select({ code: schema.simPositions.code })
          .from(schema.simPositions)
          .where(eq(schema.simPositions.strategyId, keep.id))
          .all()
          .map((r) => r.code);
        for (const code of keepCodes) {
          tx.delete(schema.simPositions)
            .where(
              and(
                eq(schema.simPositions.strategyId, dup.id),
                eq(schema.simPositions.code, code),
              ),
            )
            .run();
        }
        tx.update(schema.simPositions)
          .set({ strategyId: keep.id })
          .where(eq(schema.simPositions.strategyId, dup.id))
          .run();
        tx.delete(schema.strategies).where(eq(schema.strategies.id, dup.id)).run();
      }
    });
    console.log(`[seed] 已合并重复战法「${name}」：保留 ${keep.id}，清理 ${dups.length} 条重复`);
  }
}

export async function seedStrategiesAndBind(): Promise<void> {
  // 0. 自愈去重：先合并历史并发启动产生的重复战法（无论标志是否已 done）
  dedupeSeedStrategies();

  // 0.1 自愈回填：给已 seeded 但缺简介的种子战法补上「总计介绍」（无视 flag、幂等）
  backfillSeedDescriptions();

  // 原子声明种子标志：INSERT ... ON CONFLICT DO NOTHING 跨进程原子，
  // 并发启动只有成功插入（changes===1）的赢家继续创建，其余直接返回，杜绝重复。
  const claim = db
    .insert(schema.settings)
    .values({ key: SEEDED_FLAG, value: 'done', updatedAt: nowIso() })
    .onConflictDoNothing()
    .run();
  if (claim.changes === 0) return;

  // 1. 创建/复用两个战法
  const miaoxiang = ensureStrategy(MIAOXIANG_NAME, 'miaoxiang');
  const local = ensureStrategy(LOCAL_NAME, 'local');

  // 1.1 写入 Skill 基线打法（仅当该维度无任何记录时，幂等）
  setInitialSkills(local.id, SKILL_BASELINE[LOCAL_NAME]);
  setInitialSkills(miaoxiang.id, SKILL_BASELINE[MIAOXIANG_NAME]);

  // 2. 配置 MX_APIKEY（仅当未配置时写入，避免覆盖用户自定义）
  if (!getValue('mxApiKey')) {
    setValue('mxApiKey', SEED_MX_APIKEY);
  }

  // 3. 按任务名绑定 strategyId（妙想 4 任务 → 镜像战法；尾盘 → 本地战法）
  const tasks = listTasks();
  for (const t of tasks) {
    if (MIAOXIANG_TASK_NAMES.includes(t.name) && t.strategyId !== miaoxiang.id) {
      updateTask(t.id, { strategyId: miaoxiang.id });
    } else if (t.name === WEIPAN_TASK_NAME && t.strategyId !== local.id) {
      updateTask(t.id, { strategyId: local.id });
    }
  }

  // 4. 首次同步妙想镜像账户（best-effort，失败不阻断启动）
  try {
    await syncMiaoxiangStrategy(miaoxiang.id);
    console.log('[seed] 妙想镜像账户首次同步成功');
  } catch (e) {
    console.warn(`[seed] 妙想镜像账户首次同步失败（可稍后在战法页手动同步）: ${e instanceof Error ? e.message : e}`);
  }

  console.log(`[seed] 已创建并绑定两个战法：${MIAOXIANG_NAME} / ${LOCAL_NAME}`);
}
