<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '@/api';
import type {
  SymbolMarketPhase,
  SymbolPlanAction,
  SymbolPlanEvaluation,
  SymbolPlanHorizon,
  SymbolTradePlan,
} from '@stock-agent/shared';

/**
 * 标的交易计划面板。首屏只给「一个阶段 + 一个主动作 + 三条关键线」，
 * 专业证据放折叠区，避免同时出现互相冲突的建议（计划 10.2 / 10.3）。
 */
const props = defineProps<{ code: string; name?: string }>();
/** 空状态一键生成：由父组件切到 Agent 页签并触发对应车道的计划生成 */
const emit = defineEmits<{ generate: [SymbolPlanHorizon] }>();

/**
 * 车道由父组件持有：agent 生成完一版后父组件会 bump key 重挂本面板，
 * 车道若是本地 state 就会被重置回下一交易日，刚生成的波段计划反而看不到。
 */
const horizon = defineModel<SymbolPlanHorizon>('horizon', { default: 'next_session' });
const plan = ref<SymbolTradePlan | null>(null);
const loading = ref(false);
const evaluating = ref(false);
const loadError = ref('');
const evaluation = ref<SymbolPlanEvaluation | null>(null);
/** 展开的证据区块 */
const openPanels = ref<string[]>([]);

const PHASE_LABEL: Record<SymbolMarketPhase, string> = {
  decline: '下跌防守',
  bottoming: '筑底观察',
  recovery: '右侧修复',
  uptrend: '上升持有',
  acceleration: '加速谨慎',
  distribution: '高位分歧',
  uncertain: '不确定',
};

const ACTION_LABEL: Record<SymbolPlanAction, string> = {
  wait: '等待',
  probe: '小仓试错',
  add: '加仓',
  hold: '持有',
  reduce: '减仓',
  exit: '退出',
};

/** 阶段配色：防守类偏绿（跌）、进攻类偏红（涨），与 A 股红涨绿跌一致 */
const PHASE_TONE: Record<SymbolMarketPhase, string> = {
  decline: 'is-down',
  bottoming: 'is-flat',
  recovery: 'is-up',
  uptrend: 'is-up',
  acceleration: 'is-warn',
  distribution: 'is-warn',
  uncertain: 'is-flat',
};

/** 请求令牌：快速切换标的/车道时先发后到的响应必须丢弃，否则会把旧车道的计划显示成新车道 */
let loadToken = 0;

async function load(): Promise<void> {
  if (!props.code) return;
  const t = ++loadToken;
  loading.value = true;
  loadError.value = '';
  evaluation.value = null;
  try {
    const p = await api.symbolPlans.active(props.code, horizon.value);
    if (t !== loadToken) return;
    plan.value = p;
  } catch (e) {
    if (t !== loadToken) return;
    loadError.value = e instanceof Error ? e.message : String(e);
    plan.value = null;
  } finally {
    if (t === loadToken) loading.value = false;
  }
}

async function reevaluate(): Promise<void> {
  if (!plan.value || evaluating.value) return;
  evaluating.value = true;
  try {
    evaluation.value = await api.symbolPlans.evaluate(plan.value.id);
    ElMessage.success(evaluation.value.summary);
    // 状态可能已迁移，重新拉一次
    await load();
  } catch (e) {
    ElMessage.error(`复核失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    evaluating.value = false;
  }
}

/** 三条关键线：触发 / 结构失效 / 第一目标 */
const keyLines = computed(() => {
  const p = plan.value;
  if (!p) return [];
  const pick = (roles: string[]): (typeof p.levels)[number] | undefined =>
    p.levels.find((l) => roles.includes(l.role));
  const fmt = (l?: (typeof p.levels)[number]): string => {
    if (!l) return '—';
    if (l.price != null) return l.price.toFixed(3);
    if (l.zoneLow != null && l.zoneHigh != null) return `${l.zoneLow.toFixed(3)}~${l.zoneHigh.toFixed(3)}`;
    return '—';
  };
  const trigger = pick(['entry_trigger', 'add_trigger', 'resistance']);
  const invalid = pick(['invalidation', 'stop', 'support']);
  const target = p.exitPlan.firstTakeProfitLevelId
    ? p.levels.find((l) => l.id === p.exitPlan.firstTakeProfitLevelId)
    : pick(['target']);
  return [
    { label: '触发线', value: fmt(trigger), tone: 'is-up', detail: trigger?.label ?? '' },
    { label: '结构失效线', value: fmt(invalid), tone: 'is-down', detail: invalid?.label ?? '' },
    { label: '第一目标', value: fmt(target), tone: 'is-warn', detail: target?.label ?? '' },
  ];
});

/** 首屏固定行动句式（计划 10.2） */
const actionSentence = computed(() => {
  const p = plan.value;
  if (!p) return '';
  const trig = keyLines.value[0]?.value ?? '—';
  const inval = keyLines.value[1]?.value ?? '—';
  return (
    `当前处于【${PHASE_LABEL[p.marketPhase]}】；你现在应【${ACTION_LABEL[p.primaryAction]}】；` +
    `只有【${trig}】被有效突破才改变动作；跌破【${inval}】进入防守。`
  );
});

const primaryScenario = computed(() => plan.value?.scenarios.find((s) => s.rank === 'primary') ?? null);
const otherScenarios = computed(() => plan.value?.scenarios.filter((s) => s.rank !== 'primary') ?? []);

/** 条件状态索引：模板里每个条件要查两三次，线性查找会退化成 O(n²)，这里一次建表 */
const condStates = computed(() => {
  const m = new Map<string, SymbolPlanEvaluation['conditions'][number]>();
  for (const c of evaluation.value?.conditions ?? []) m.set(c.conditionId, c);
  return m;
});

/** 条件状态查表，供复核后在条件旁标注 */
function condState(id: string): SymbolPlanEvaluation['conditions'][number] | undefined {
  return condStates.value.get(id);
}

const dataStatusText: Record<SymbolTradePlan['dataStatus'], string> = {
  complete: '数据完整',
  provisional: '盘中未收盘，结论为暂定',
  degraded: '关键数据降级，仅供观察',
};

watch(() => [props.code, horizon.value], load, { immediate: true });
</script>

<template>
  <div class="tp">
    <div class="tp__head">
      <el-radio-group v-model="horizon" size="small">
        <el-radio-button value="next_session">下一交易日</el-radio-button>
        <el-radio-button value="swing">1~4周波段</el-radio-button>
      </el-radio-group>
      <el-button
        v-if="plan"
        size="small"
        :loading="evaluating"
        class="tp__recheck"
        @click="reevaluate"
      >
        复核条件
      </el-button>
    </div>

    <div v-loading="loading" class="tp__body">
      <div v-if="loadError" class="tp__error">加载失败：{{ loadError }}</div>

      <div v-else-if="!plan" class="tp__empty">
        <div class="tp__empty-title">尚无交易计划</div>
        <div class="tp__empty-sub">
          点下方按钮（或切到「Agent」页签用同名快捷按钮），让它生成本标的的技术交易计划。计划会给出
          当前阶段、唯一主动作、触发与失效条件，并把关键位同步到左侧 K 线图。
        </div>
        <div class="tp__empty-actions">
          <el-button size="small" type="primary" plain @click="emit('generate', 'next_session')">
            生成下一交易日计划
          </el-button>
          <el-button size="small" type="primary" plain @click="emit('generate', 'swing')">
            生成1~4周波段计划
          </el-button>
        </div>
      </div>

      <template v-else>
        <!-- 阶段与唯一主动作 -->
        <div class="tp__phase" :class="PHASE_TONE[plan.marketPhase]">
          <div class="tp__phase-row">
            <span class="tp__phase-tag">{{ PHASE_LABEL[plan.marketPhase] }}</span>
            <span class="tp__action">{{ ACTION_LABEL[plan.primaryAction] }}</span>
            <span class="tp__ver">v{{ plan.version }} · {{ plan.status }}</span>
          </div>
          <div class="tp__sentence">{{ actionSentence }}</div>
          <div class="tp__summary">{{ plan.summary }}</div>
        </div>

        <!-- 相比上一版本的变化 -->
        <div v-if="plan.changes.length" class="tp__changes">
          <span class="tp__changes-label">相比上一版</span>
          <ul>
            <li v-for="(c, i) in plan.changes.slice(0, 3)" :key="i">{{ c }}</li>
          </ul>
        </div>

        <!-- 三条关键线 -->
        <div class="tp__lines">
          <div v-for="l in keyLines" :key="l.label" class="tp__line" :class="l.tone">
            <span class="tp__line-label">{{ l.label }}</span>
            <span class="tp__line-value num">{{ l.value }}</span>
            <span v-if="l.detail" class="tp__line-detail">{{ l.detail }}</span>
          </div>
        </div>

        <!-- 仓位与有效期 -->
        <div class="tp__meta">
          <span>建议仓位上限 <b class="num">{{ plan.risk.suggestedPositionPct ?? '—' }}%</b></span>
          <span>单笔风险 <b class="num">{{ plan.risk.maxAccountRiskPct }}%</b></span>
          <span>时间止损 <b class="num">{{ plan.risk.timeStopBars ?? '—' }}</b> 根</span>
          <span>有效期至 {{ plan.expiresAt?.slice(0, 10) ?? '未设定' }}</span>
        </div>
        <div class="tp__status" :class="{ 'is-warn': plan.dataStatus !== 'complete' }">
          {{ dataStatusText[plan.dataStatus] }}（数据截至 {{ plan.asOf }}）
        </div>

        <!-- 主路径条件 -->
        <div v-if="primaryScenario" class="tp__scenario">
          <div class="tp__scenario-name">{{ primaryScenario.name }}</div>
          <div class="tp__cond-group">
            <span class="tp__cond-label">触发</span>
            <div class="tp__conds">
              <div v-for="c in primaryScenario.conditions" :key="c.id" class="tp__cond">
                <span
                  class="tp__cond-dot"
                  :class="{
                    'is-hit': condState(c.id)?.satisfied,
                    'is-miss': condState(c.id) && !condState(c.id)?.satisfied,
                  }"
                />
                <span>{{ c.description }}</span>
                <span class="tp__cadence">{{ condState(c.id)?.cadence === 'tick' ? '盘中' : '收盘' }}</span>
              </div>
            </div>
          </div>
          <div class="tp__cond-group">
            <span class="tp__cond-label is-down">失效</span>
            <div class="tp__conds">
              <div v-for="c in primaryScenario.invalidConditions" :key="c.id" class="tp__cond">
                <span
                  class="tp__cond-dot"
                  :class="{
                    'is-hit': condState(c.id)?.satisfied,
                    'is-miss': condState(c.id) && !condState(c.id)?.satisfied,
                  }"
                />
                <span>{{ c.description }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 折叠的专业证据 -->
        <el-collapse v-model="openPanels" class="tp__collapse">
          <el-collapse-item v-if="otherScenarios.length" title="备选与风险路径" name="scenarios">
            <div v-for="s in otherScenarios" :key="s.id" class="tp__alt">
              <div class="tp__alt-name">
                {{ s.rank === 'risk' ? '风险路径' : '备选路径' }}：{{ s.name }}
              </div>
              <div v-for="c in s.conditions" :key="c.id" class="tp__alt-cond">触发：{{ c.description }}</div>
              <div v-for="c in s.invalidConditions" :key="c.id" class="tp__alt-cond">失效：{{ c.description }}</div>
            </div>
          </el-collapse-item>

          <el-collapse-item title="止盈与保护" name="exit">
            <div class="tp__kv">
              <span>移动保护</span><span>{{ plan.exitPlan.trailingRule ?? '—' }}</span>
            </div>
            <div class="tp__kv">
              <span>利润保护</span><span>{{ plan.exitPlan.profitProtectionRule ?? '—' }}</span>
            </div>
            <div class="tp__kv">
              <span>分批比例</span>
              <span>{{ plan.exitPlan.reduceFractions.map((f) => `${Math.round(f * 100)}%`).join(' + ') || '—' }}</span>
            </div>
            <div class="tp__kv">
              <span>结构/波动/执行止损</span>
              <span class="num">
                {{ plan.risk.structuralStop ?? '—' }} / {{ plan.risk.volatilityStop ?? '—' }} /
                {{ plan.risk.executionStop ?? '—' }}
              </span>
            </div>
            <div v-if="plan.risk.gapRiskNote" class="tp__kv"><span>跳空</span><span>{{ plan.risk.gapRiskNote }}</span></div>
          </el-collapse-item>

          <el-collapse-item title="执行闸门与资产风险" name="exec">
            <div class="tp__kv">
              <span>触发口径</span>
              <span>{{ plan.execution.triggerMode === 'close_confirmed' ? '收盘确认' : '盘中预警' }}</span>
            </div>
            <div class="tp__kv">
              <span>追涨保护</span><span class="num">{{ plan.execution.chaseGuardAtr ?? '—' }}×ATR</span>
            </div>
            <div v-if="plan.execution.maxPremiumPct != null" class="tp__kv">
              <span>折溢价上限</span><span class="num">{{ plan.execution.maxPremiumPct }}%</span>
            </div>
            <div v-for="(r, i) in plan.assetSpecificRisks" :key="i" class="tp__risk">{{ r }}</div>
          </el-collapse-item>

          <el-collapse-item title="模型证据（道氏 / 缠论 / 阶段）" name="evidence">
            <div class="tp__kv"><span>道氏趋势</span><span>{{ plan.trendState }}</span></div>
            <div class="tp__kv"><span>缠论候选</span><span>{{ plan.chanSetup }}</span></div>
            <div class="tp__kv"><span>市场动作（不含账户）</span><span>{{ ACTION_LABEL[plan.marketAction] }}</span></div>
            <div class="tp__kv"><span>口径版本</span>
              <span class="tp__ver-note">
                {{ plan.evidenceVersion }} / {{ plan.phaseModelVersion }} / {{ plan.candidateModelVersion }}
              </span>
            </div>
            <div v-for="b in plan.benchmarks" :key="b.code" class="tp__kv">
              <span>基准（{{ b.role }}）</span><span>{{ b.code }} {{ b.name }}</span>
            </div>
            <div class="tp__note">
              缠论结果一律是候选，不单独构成买卖依据；波浪首期不进结构化字段。
            </div>
          </el-collapse-item>
        </el-collapse>
      </template>
    </div>
  </div>
</template>

<style scoped>
.tp {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.02);
  overflow: hidden;
}
.tp__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.tp__recheck {
  margin-left: auto;
}
.tp__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px;
}
.tp__error {
  color: var(--el-color-danger);
  font-size: 12px;
}
.tp__empty {
  padding: 16px 4px;
  color: var(--text-2);
}
.tp__empty-title {
  font-size: 13px;
  font-weight: 600;
  color: #cfd3dc;
  margin-bottom: 4px;
}
.tp__empty-sub {
  font-size: 12px;
  line-height: 1.7;
}
.tp__empty-actions {
  display: flex;
  gap: 6px;
  margin-top: 12px;
}
.tp__empty-actions .el-button {
  flex: 1;
  font-size: 12px;
}
/* 阶段带：唯一阶段 + 唯一主动作 */
.tp__phase {
  padding: 10px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
}
.tp__phase.is-up {
  border-color: rgba(240, 69, 74, 0.35);
}
.tp__phase.is-down {
  border-color: rgba(18, 184, 134, 0.35);
}
.tp__phase.is-warn {
  border-color: rgba(255, 176, 0, 0.35);
}
.tp__phase-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.tp__phase-tag {
  font-size: 15px;
  font-weight: 700;
  color: #cfd3dc;
}
.tp__action {
  font-size: 13px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 3px;
  background: rgba(31, 111, 235, 0.18);
  color: #7aa7ff;
}
.tp__ver {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-2);
}
.tp__sentence {
  margin-top: 7px;
  font-size: 12px;
  line-height: 1.7;
  color: #cfd3dc;
}
.tp__summary {
  margin-top: 5px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
}
.tp__changes {
  margin-top: 10px;
  font-size: 12px;
}
.tp__changes-label {
  color: var(--text-2);
  font-size: 11px;
}
.tp__changes ul {
  margin: 4px 0 0;
  padding-left: 18px;
  color: #cfd3dc;
  line-height: 1.7;
}
/* 三条关键线 */
.tp__lines {
  display: flex;
  margin-top: 10px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  overflow: hidden;
}
.tp__line {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 9px;
  border-left: 1px solid rgba(255, 255, 255, 0.06);
  min-width: 0;
}
.tp__line:first-child {
  border-left: none;
}
.tp__line-label {
  font-size: 10px;
  color: var(--text-2);
}
.tp__line-value {
  font-size: 14px;
  font-weight: 600;
}
.tp__line.is-up .tp__line-value {
  color: #f0454a;
}
.tp__line.is-down .tp__line-value {
  color: #12b886;
}
.tp__line.is-warn .tp__line-value {
  color: #ffb000;
}
.tp__line-detail {
  font-size: 10px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tp__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-top: 9px;
  font-size: 11px;
  color: var(--text-2);
}
.tp__meta b {
  color: #cfd3dc;
}
.tp__status {
  margin-top: 5px;
  font-size: 11px;
  color: var(--text-2);
}
.tp__status.is-warn {
  color: #ffb000;
}
/* 主路径条件 */
.tp__scenario {
  margin-top: 11px;
  padding-top: 9px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
.tp__scenario-name {
  font-size: 12px;
  font-weight: 600;
  color: #cfd3dc;
  margin-bottom: 6px;
}
.tp__cond-group {
  display: flex;
  gap: 8px;
  margin-bottom: 6px;
}
.tp__cond-label {
  flex-shrink: 0;
  font-size: 11px;
  color: #f0454a;
  padding-top: 2px;
}
.tp__cond-label.is-down {
  color: #12b886;
}
.tp__conds {
  flex: 1;
  min-width: 0;
}
.tp__cond {
  display: flex;
  align-items: baseline;
  gap: 5px;
  font-size: 12px;
  line-height: 1.7;
  color: #cfd3dc;
}
.tp__cond-dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.2);
}
.tp__cond-dot.is-hit {
  background: #f0454a;
}
.tp__cond-dot.is-miss {
  background: rgba(255, 255, 255, 0.15);
}
.tp__cadence {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-2);
}
.tp__collapse {
  margin-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
.tp__collapse :deep(.el-collapse-item__header),
.tp__collapse :deep(.el-collapse-item__wrap) {
  background: transparent;
  border-color: rgba(255, 255, 255, 0.06);
}
.tp__collapse :deep(.el-collapse-item__header) {
  font-size: 12px;
}
.tp__kv {
  display: flex;
  gap: 10px;
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-2);
}
.tp__kv span:last-child {
  color: #cfd3dc;
  text-align: right;
  margin-left: auto;
}
.tp__ver-note {
  font-size: 10px;
}
.tp__alt {
  margin-bottom: 8px;
}
.tp__alt-name {
  font-size: 12px;
  font-weight: 600;
  color: #cfd3dc;
}
.tp__alt-cond,
.tp__risk,
.tp__note {
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-2);
}
.tp__note {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed rgba(255, 255, 255, 0.08);
}
</style>
