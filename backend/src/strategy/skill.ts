import { and, desc, eq, max, ne } from 'drizzle-orm';
import type {
  SkillDimension,
  SkillStatus,
  StrategySkill,
  StrategySkillView,
} from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { newId, nowIso } from '../util';
import { getStrategy, StrategyError } from './sim';

// 战法 Skill（打法）自迭代引擎：选股/买入/卖出 三维度各自独立、追加式版本化。
// active 版本运行时注入 system prompt；复盘 agent 通过 propose 提交 pending 提案，
// 用户审批后才 active；历史版本全部留痕，可回滚（回滚=复制为新 active 版本）。

type SkillRow = typeof schema.strategySkills.$inferSelect;

export const DIMENSIONS: SkillDimension[] = ['pick', 'buy', 'sell'];

const DIM_LABEL: Record<SkillDimension, string> = {
  pick: '选股规则',
  buy: '买入规则',
  sell: '卖出规则',
};

export function dimensionLabel(d: SkillDimension): string {
  return DIM_LABEL[d] ?? d;
}

function isDimension(v: unknown): v is SkillDimension {
  return v === 'pick' || v === 'buy' || v === 'sell';
}

function rowToSkill(row: SkillRow): StrategySkill {
  return {
    id: row.id,
    strategyId: row.strategyId,
    dimension: row.dimension as SkillDimension,
    version: row.version,
    content: row.content,
    status: row.status as SkillStatus,
    reason: row.reason ?? null,
    sourceRunId: row.sourceRunId ?? null,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt ?? null,
  };
}

// ===== 查询 =====

/** 取某维度当前生效（active）版本 */
function getActiveRow(strategyId: string, dimension: SkillDimension): SkillRow | undefined {
  return db
    .select()
    .from(schema.strategySkills)
    .where(
      and(
        eq(schema.strategySkills.strategyId, strategyId),
        eq(schema.strategySkills.dimension, dimension),
        eq(schema.strategySkills.status, 'active'),
      ),
    )
    .get();
}

/** 三维度当前生效 Skill（无则该维度为 null） */
export function getActiveSkills(
  strategyId: string,
): Record<SkillDimension, StrategySkill | null> {
  const out = { pick: null, buy: null, sell: null } as Record<
    SkillDimension,
    StrategySkill | null
  >;
  for (const d of DIMENSIONS) {
    const row = getActiveRow(strategyId, d);
    out[d] = row ? rowToSkill(row) : null;
  }
  return out;
}

/** 某战法 Skill 全景视图（当前生效 + 待确认提案 + 历史版本） */
export function listSkillView(strategyId: string): StrategySkillView {
  const strategy = getStrategy(strategyId);
  const active = getActiveSkills(strategyId);

  const proposals = db
    .select()
    .from(schema.strategySkills)
    .where(
      and(
        eq(schema.strategySkills.strategyId, strategyId),
        eq(schema.strategySkills.status, 'pending'),
      ),
    )
    .orderBy(desc(schema.strategySkills.createdAt))
    .all()
    .map(rowToSkill);

  const history = { pick: [], buy: [], sell: [] } as Record<SkillDimension, StrategySkill[]>;
  for (const d of DIMENSIONS) {
    history[d] = db
      .select()
      .from(schema.strategySkills)
      .where(
        and(
          eq(schema.strategySkills.strategyId, strategyId),
          eq(schema.strategySkills.dimension, d),
          ne(schema.strategySkills.status, 'pending'),
        ),
      )
      .orderBy(desc(schema.strategySkills.version), desc(schema.strategySkills.createdAt))
      .all()
      .map(rowToSkill);
  }

  return {
    strategyId,
    skillEnabled: strategy?.skillEnabled ?? false,
    active,
    proposals,
    history,
  };
}

// ===== Playbook 文本构建（注入 system prompt 用）=====

/** 把三维度 active Skill 拼成带分段标题的 Markdown（空段省略） */
export function buildPlaybook(strategyId: string): string {
  const active = getActiveSkills(strategyId);
  const sections: string[] = [];
  for (const d of DIMENSIONS) {
    const s = active[d];
    if (s && s.content.trim()) {
      sections.push(`### ${dimensionLabel(d)}（v${s.version}）\n${s.content.trim()}`);
    }
  }
  return sections.join('\n\n');
}

/**
 * 返回注入 system prompt 的战法打法片段：
 * 未启用 Skill 或无 active 内容时返回 ''。
 */
export function getStrategyDirectiveAddon(strategyId: string): string {
  const strategy = getStrategy(strategyId);
  if (!strategy || !strategy.skillEnabled) return '';
  const playbook = buildPlaybook(strategyId);
  if (!playbook) return '';
  return (
    `\n\n## 本战法打法（Skill，须严格遵循）\n${playbook}\n\n` +
    '- 本次运行务必按上述【现行打法】执行选股/买入/卖出决策。\n' +
    '- 仅在复盘类运行中，若你基于持仓表现与近期成交发现现行打法存在可改进之处，' +
    '可调用 propose_skill_update 提交对应维度（pick/buy/sell）的修订提案；' +
    '提案不会立刻生效，需用户在战法页确认后才采用，本次运行仍按现行打法处理。'
  );
}

// ===== 提案 / 审批 / 回滚 / 初始化 =====

export interface ProposeSkillInput {
  strategyId: string;
  dimension: SkillDimension;
  content: string;
  reason?: string | null;
  sourceRunId?: string | null;
}

/** agent 提交一条修订提案（pending，不改 active） */
export function proposeSkillUpdate(input: ProposeSkillInput): StrategySkill {
  const strategy = getStrategy(input.strategyId);
  if (!strategy) throw new StrategyError('战法不存在');
  if (!strategy.skillEnabled) throw new StrategyError('该战法未启用 Skill 自迭代');
  if (!isDimension(input.dimension)) throw new StrategyError('维度需为 pick/buy/sell');
  const content = String(input.content ?? '').trim();
  if (!content) throw new StrategyError('提案内容不能为空');

  const id = newId();
  const now = nowIso();
  db.insert(schema.strategySkills)
    .values({
      id,
      strategyId: input.strategyId,
      dimension: input.dimension,
      version: 0,
      content,
      status: 'pending',
      reason: input.reason?.trim() || null,
      sourceRunId: input.sourceRunId ?? null,
      createdAt: now,
      decidedAt: null,
    })
    .run();
  return rowToSkill(getRow(id)!);
}

function getRow(id: string): SkillRow | undefined {
  return db.select().from(schema.strategySkills).where(eq(schema.strategySkills.id, id)).get();
}

/** 某维度下一个版本号（非 pending 的最大值 + 1） */
function nextVersion(strategyId: string, dimension: SkillDimension): number {
  const row = db
    .select({ m: max(schema.strategySkills.version) })
    .from(schema.strategySkills)
    .where(
      and(
        eq(schema.strategySkills.strategyId, strategyId),
        eq(schema.strategySkills.dimension, dimension),
        ne(schema.strategySkills.status, 'pending'),
      ),
    )
    .get();
  return (row?.m ?? 0) + 1;
}

/** 通过提案：旧 active 转 archived，pending 转 active 并分配版本号 */
export function approveProposal(id: string): StrategySkill {
  const proposal = getRow(id);
  if (!proposal) throw new StrategyError('提案不存在');
  if (proposal.status !== 'pending') throw new StrategyError('该提案已处理');
  const dimension = proposal.dimension as SkillDimension;
  const now = nowIso();
  db.transaction((tx) => {
    tx.update(schema.strategySkills)
      .set({ status: 'archived', decidedAt: now })
      .where(
        and(
          eq(schema.strategySkills.strategyId, proposal.strategyId),
          eq(schema.strategySkills.dimension, dimension),
          eq(schema.strategySkills.status, 'active'),
        ),
      )
      .run();
    tx.update(schema.strategySkills)
      .set({
        status: 'active',
        version: nextVersion(proposal.strategyId, dimension),
        decidedAt: now,
      })
      .where(eq(schema.strategySkills.id, id))
      .run();
  });
  return rowToSkill(getRow(id)!);
}

/** 驳回提案 */
export function rejectProposal(id: string): StrategySkill {
  const proposal = getRow(id);
  if (!proposal) throw new StrategyError('提案不存在');
  if (proposal.status !== 'pending') throw new StrategyError('该提案已处理');
  db.update(schema.strategySkills)
    .set({ status: 'rejected', decidedAt: nowIso() })
    .where(eq(schema.strategySkills.id, id))
    .run();
  return rowToSkill(getRow(id)!);
}

/** 回滚：复制目标历史版本内容为新的 active 版本（旧 active 转 archived），留痕追加 */
export function rollbackSkill(
  strategyId: string,
  dimension: SkillDimension,
  version: number,
): StrategySkill {
  if (!isDimension(dimension)) throw new StrategyError('维度需为 pick/buy/sell');
  const target = db
    .select()
    .from(schema.strategySkills)
    .where(
      and(
        eq(schema.strategySkills.strategyId, strategyId),
        eq(schema.strategySkills.dimension, dimension),
        eq(schema.strategySkills.version, version),
      ),
    )
    .get();
  if (!target || target.status === 'pending') throw new StrategyError('目标版本不存在');

  const id = newId();
  const now = nowIso();
  db.transaction((tx) => {
    tx.update(schema.strategySkills)
      .set({ status: 'archived', decidedAt: now })
      .where(
        and(
          eq(schema.strategySkills.strategyId, strategyId),
          eq(schema.strategySkills.dimension, dimension),
          eq(schema.strategySkills.status, 'active'),
        ),
      )
      .run();
    tx.insert(schema.strategySkills)
      .values({
        id,
        strategyId,
        dimension,
        version: nextVersion(strategyId, dimension),
        content: target.content,
        status: 'active',
        reason: `回滚至 v${version}`,
        sourceRunId: null,
        createdAt: now,
        decidedAt: now,
      })
      .run();
  });
  return rowToSkill(getRow(id)!);
}

/** 用户手动编辑：写入新的 active 版本（旧 active 转 archived），留痕 */
export function updateSkillManually(
  strategyId: string,
  dimension: SkillDimension,
  content: string,
  reason?: string | null,
): StrategySkill {
  if (!isDimension(dimension)) throw new StrategyError('维度需为 pick/buy/sell');
  const text = String(content ?? '').trim();
  if (!text) throw new StrategyError('内容不能为空');
  const id = newId();
  const now = nowIso();
  db.transaction((tx) => {
    tx.update(schema.strategySkills)
      .set({ status: 'archived', decidedAt: now })
      .where(
        and(
          eq(schema.strategySkills.strategyId, strategyId),
          eq(schema.strategySkills.dimension, dimension),
          eq(schema.strategySkills.status, 'active'),
        ),
      )
      .run();
    tx.insert(schema.strategySkills)
      .values({
        id,
        strategyId,
        dimension,
        version: nextVersion(strategyId, dimension),
        content: text,
        status: 'active',
        reason: reason?.trim() || '手动编辑',
        sourceRunId: null,
        createdAt: now,
        decidedAt: now,
      })
      .run();
  });
  return rowToSkill(getRow(id)!);
}

/** 建战法启用 Skill 时写入三维度 v1 active 基线（仅当该维度无任何记录时） */
export function setInitialSkills(
  strategyId: string,
  baseline: Partial<Record<SkillDimension, string>>,
): void {
  const now = nowIso();
  for (const d of DIMENSIONS) {
    const content = baseline[d]?.trim();
    if (!content) continue;
    const existing = db
      .select({ id: schema.strategySkills.id })
      .from(schema.strategySkills)
      .where(
        and(
          eq(schema.strategySkills.strategyId, strategyId),
          eq(schema.strategySkills.dimension, d),
        ),
      )
      .get();
    if (existing) continue;
    db.insert(schema.strategySkills)
      .values({
        id: newId(),
        strategyId,
        dimension: d,
        version: 1,
        content,
        status: 'active',
        reason: '初始基线',
        sourceRunId: null,
        createdAt: now,
        decidedAt: now,
      })
      .run();
  }
}
