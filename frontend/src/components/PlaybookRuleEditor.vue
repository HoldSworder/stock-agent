<script setup lang="ts">
import { computed } from 'vue';
import type { PlaybookRule, PlaybookRuleGroup } from '@stock-agent/shared';

// 战法规则编辑器：元数据驱动渲染，每种条件声明自己的字段，避免为 14 种条件各写一套表单。
// 条件全部可由日/周线严格算出，页面文案与后端 describeRule 保持同一口径。

const props = defineProps<{
  modelValue: PlaybookRuleGroup;
  title: string;
  hint?: string;
  /** 是否放开「仅卖出」条件（浮动盈亏 / 已持有根数）。由父组件显式声明，不靠标题文案推断 */
  allowExitOnly?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [PlaybookRuleGroup] }>();

type FieldType = 'number' | 'select' | 'periods';
interface Field {
  prop: string;
  label: string;
  type: FieldType;
  options?: Array<{ label: string; value: string | number }>;
  width?: number;
}
interface RuleMeta {
  label: string;
  fields: Field[];
  /** 新建该条件时的默认值 */
  make: () => PlaybookRule;
}

const OPS = [
  { label: '≥', value: 'gte' },
  { label: '≤', value: 'lte' },
  { label: '>', value: 'gt' },
  { label: '<', value: 'lt' },
];
const MA_TYPES = [
  { label: 'SMA', value: 'sma' },
  { label: 'EMA', value: 'ema' },
];

const META: Record<string, RuleMeta> = {
  ma: {
    label: '均线关系',
    fields: [
      { prop: 'maType', label: '类型', type: 'select', options: MA_TYPES, width: 90 },
      {
        prop: 'left',
        label: '左侧',
        type: 'select',
        options: [
          { label: '收盘价', value: 'close' },
          { label: '另一条均线', value: 'ma' },
        ],
        width: 120,
      },
      { prop: 'leftPeriod', label: '左侧周期', type: 'number', width: 100 },
      {
        prop: 'relation',
        label: '关系',
        type: 'select',
        options: [
          { label: '在上方', value: 'above' },
          { label: '在下方', value: 'below' },
          { label: '上穿', value: 'crossUp' },
          { label: '下穿', value: 'crossDown' },
        ],
        width: 110,
      },
      { prop: 'period', label: '目标周期', type: 'number', width: 100 },
    ],
    make: () => ({ kind: 'ma', maType: 'sma', left: 'close', period: 5, relation: 'crossUp' }),
  },
  maAlign: {
    label: '均线排列',
    fields: [
      { prop: 'maType', label: '类型', type: 'select', options: MA_TYPES, width: 90 },
      { prop: 'periods', label: '周期（逗号分隔）', type: 'periods', width: 160 },
      {
        prop: 'dir',
        label: '方向',
        type: 'select',
        options: [
          { label: '多头', value: 'up' },
          { label: '空头', value: 'down' },
        ],
        width: 100,
      },
    ],
    make: () => ({ kind: 'maAlign', maType: 'sma', periods: [5, 10, 20], dir: 'up' }),
  },
  pctChange: {
    label: '区间涨跌幅',
    fields: [
      { prop: 'days', label: '近 N 根', type: 'number', width: 100 },
      { prop: 'op', label: '比较', type: 'select', options: OPS, width: 80 },
      { prop: 'value', label: '幅度 %', type: 'number', width: 100 },
    ],
    make: () => ({ kind: 'pctChange', days: 5, op: 'gte', value: 5 }),
  },
  extreme: {
    label: '新高 / 新低',
    fields: [
      {
        prop: 'extreme',
        label: '类型',
        type: 'select',
        options: [
          { label: '创新高', value: 'newHigh' },
          { label: '创新低', value: 'newLow' },
        ],
        width: 110,
      },
      { prop: 'days', label: 'N 根窗口', type: 'number', width: 110 },
    ],
    make: () => ({ kind: 'extreme', extreme: 'newHigh', days: 20 }),
  },
  volRatio: {
    label: '量比（缩量 / 放量）',
    fields: [
      { prop: 'days', label: '对比前 N 根均量', type: 'number', width: 140 },
      { prop: 'op', label: '比较', type: 'select', options: OPS, width: 80 },
      { prop: 'value', label: '倍数', type: 'number', width: 100 },
    ],
    make: () => ({ kind: 'volRatio', days: 5, op: 'lte', value: 0.7 }),
  },
  macd: {
    label: 'MACD(12,26,9)',
    fields: [
      {
        prop: 'signal',
        label: '状态',
        type: 'select',
        options: [
          { label: '金叉', value: 'goldCross' },
          { label: '死叉', value: 'deadCross' },
          { label: '柱翻红', value: 'barAbove0' },
          { label: '柱翻绿', value: 'barBelow0' },
        ],
        width: 130,
      },
    ],
    make: () => ({ kind: 'macd', signal: 'goldCross' }),
  },
  kdj: {
    label: 'KDJ(9,3,3)',
    fields: [
      {
        prop: 'signal',
        label: '状态',
        type: 'select',
        options: [
          { label: '金叉', value: 'goldCross' },
          { label: '死叉', value: 'deadCross' },
          { label: 'K 大于', value: 'kAbove' },
          { label: 'K 小于', value: 'kBelow' },
        ],
        width: 130,
      },
      { prop: 'value', label: '阈值', type: 'number', width: 100 },
    ],
    make: () => ({ kind: 'kdj', signal: 'goldCross' }),
  },
  rsi: {
    label: 'RSI',
    fields: [
      { prop: 'period', label: '周期', type: 'number', width: 90 },
      { prop: 'op', label: '比较', type: 'select', options: OPS, width: 80 },
      { prop: 'value', label: '阈值', type: 'number', width: 100 },
    ],
    make: () => ({ kind: 'rsi', period: 6, op: 'lte', value: 20 }),
  },
  boll: {
    label: 'BOLL(20,2)',
    fields: [
      {
        prop: 'pos',
        label: '位置',
        type: 'select',
        options: [
          { label: '上穿上轨', value: 'aboveUpper' },
          { label: '跌破下轨', value: 'belowLower' },
          { label: '中轨上方', value: 'aboveMid' },
          { label: '中轨下方', value: 'belowMid' },
        ],
        width: 130,
      },
    ],
    make: () => ({ kind: 'boll', pos: 'belowLower' }),
  },
  drawdown: {
    label: '距高点回撤',
    fields: [
      { prop: 'days', label: 'N 根窗口', type: 'number', width: 110 },
      { prop: 'op', label: '比较', type: 'select', options: OPS, width: 80 },
      { prop: 'value', label: '回撤 %', type: 'number', width: 100 },
    ],
    make: () => ({ kind: 'drawdown', days: 20, op: 'gte', value: 10 }),
  },
  consecutive: {
    label: '连续阴阳',
    fields: [
      {
        prop: 'dir',
        label: '方向',
        type: 'select',
        options: [
          { label: '阳线', value: 'up' },
          { label: '阴线', value: 'down' },
        ],
        width: 100,
      },
      { prop: 'bars', label: '连续根数', type: 'number', width: 110 },
    ],
    make: () => ({ kind: 'consecutive', dir: 'down', bars: 3 }),
  },
  limit: {
    label: '涨停 / 跌停',
    fields: [
      {
        prop: 'dir',
        label: '方向',
        type: 'select',
        options: [
          { label: '涨停', value: 'up' },
          { label: '跌停', value: 'down' },
        ],
        width: 100,
      },
    ],
    make: () => ({ kind: 'limit', dir: 'up' }),
  },
  pnlPct: {
    label: '浮动盈亏（仅卖出）',
    fields: [
      { prop: 'op', label: '比较', type: 'select', options: OPS, width: 80 },
      { prop: 'value', label: '盈亏 %', type: 'number', width: 100 },
    ],
    make: () => ({ kind: 'pnlPct', op: 'lte', value: -5 }),
  },
  heldBars: {
    label: '已持有根数（仅卖出）',
    fields: [
      { prop: 'op', label: '比较', type: 'select', options: OPS, width: 80 },
      { prop: 'value', label: '根数', type: 'number', width: 100 },
    ],
    make: () => ({ kind: 'heldBars', op: 'gte', value: 5 }),
  },
};

/** 卖出专用条件不在买入侧提供，避免配出跑不了的规则 */
const EXIT_ONLY = ['pnlPct', 'heldBars'];
const kindOptions = computed(() =>
  Object.entries(META)
    .filter(([k]) => props.allowExitOnly || !EXIT_ONLY.includes(k))
    .map(([value, m]) => ({ value, label: m.label })),
);

/**
 * 单行下拉的选项：买入侧读到历史遗留的卖出专用条件时，把该 kind 补进选项，
 * 否则 el-select 找不到 option 会显示空白，用户既看不出是什么条件也无从修改。
 */
function kindOptionsFor(rule: PlaybookRule): Array<{ value: string; label: string }> {
  if (kindOptions.value.some((o) => o.value === rule.kind)) return kindOptions.value;
  return [...kindOptions.value, { value: rule.kind, label: META[rule.kind]?.label ?? rule.kind }];
}

// 规则行的稳定 key：规则对象本身不带 id，按对象身份分配自增号。
// 用下标当 key 时中间删除会让下标复用，Element Plus 输入组件会短暂显示上一条的值。
const ruleKeys = new WeakMap<object, number>();
let ruleKeySeq = 0;
function ruleKey(rule: PlaybookRule): number {
  let k = ruleKeys.get(rule);
  if (k == null) {
    ruleKeySeq += 1;
    k = ruleKeySeq;
    ruleKeys.set(rule, k);
  }
  return k;
}

function patch(next: Partial<PlaybookRuleGroup>): void {
  emit('update:modelValue', { ...props.modelValue, ...next });
}

function addRule(kind: string): void {
  patch({ rules: [...props.modelValue.rules, META[kind].make()] });
}

function removeRule(i: number): void {
  patch({ rules: props.modelValue.rules.filter((_, k) => k !== i) });
}

/** 切换条件类型时整条重建，避免残留上一类型的字段 */
function changeKind(i: number, kind: string): void {
  const rules = [...props.modelValue.rules];
  rules[i] = META[kind].make();
  patch({ rules });
}

function setField(i: number, prop: string, value: unknown): void {
  const rules = [...props.modelValue.rules];
  rules[i] = { ...rules[i], [prop]: value } as PlaybookRule;
  patch({ rules });
}

/** periods 字段在 UI 上是「5,10,20」文本，落回数组 */
function periodsText(rule: PlaybookRule): string {
  return 'periods' in rule && Array.isArray(rule.periods) ? rule.periods.join(',') : '';
}
function setPeriods(i: number, text: string): void {
  const periods = text
    .split(/[,，\s]+/)
    .map((t) => Number(t))
    .filter((n) => Number.isFinite(n) && n > 0);
  setField(i, 'periods', periods);
}

/** ma 条件仅在左侧选「另一条均线」时才需要左侧周期 */
function visibleFields(rule: PlaybookRule): Field[] {
  const fields = META[rule.kind]?.fields ?? [];
  if (rule.kind === 'ma' && rule.left !== 'ma') {
    return fields.filter((f) => f.prop !== 'leftPeriod');
  }
  if (rule.kind === 'kdj' && rule.signal !== 'kAbove' && rule.signal !== 'kBelow') {
    return fields.filter((f) => f.prop !== 'value');
  }
  return fields;
}
</script>

<template>
  <div class="rule-editor">
    <div class="re-head">
      <span class="re-title">{{ title }}</span>
      <el-radio-group
        :model-value="modelValue.mode"
        size="small"
        @change="(v: string | number | boolean) => patch({ mode: v as 'all' | 'any' })"
      >
        <el-radio-button value="all">全部满足</el-radio-button>
        <el-radio-button value="any">任一满足</el-radio-button>
      </el-radio-group>
      <el-dropdown trigger="click" @command="addRule">
        <el-button size="small" type="primary" plain>+ 加条件</el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item v-for="o in kindOptions" :key="o.value" :command="o.value">
              {{ o.label }}
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>

    <p v-if="hint" class="re-hint">{{ hint }}</p>

    <div v-if="!modelValue.rules.length" class="re-empty">暂无条件</div>
    <div v-for="(rule, i) in modelValue.rules" :key="ruleKey(rule)" class="re-row">
      <el-select
        :model-value="rule.kind"
        size="small"
        class="w150"
        @change="(v: string) => changeKind(i, v)"
      >
        <el-option
          v-for="o in kindOptionsFor(rule)"
          :key="o.value"
          :label="o.label"
          :value="o.value"
        />
      </el-select>

      <template v-for="f in visibleFields(rule)" :key="f.prop">
        <span class="re-lbl">{{ f.label }}</span>
        <el-input
          v-if="f.type === 'periods'"
          :model-value="periodsText(rule)"
          size="small"
          :style="{ width: `${f.width ?? 120}px` }"
          placeholder="5,10,20"
          @update:model-value="(v: string) => setPeriods(i, v)"
        />
        <el-select
          v-else-if="f.type === 'select'"
          :model-value="(rule as Record<string, unknown>)[f.prop]"
          size="small"
          :style="{ width: `${f.width ?? 110}px` }"
          @change="(v: unknown) => setField(i, f.prop, v)"
        >
          <el-option v-for="o in f.options" :key="String(o.value)" :label="o.label" :value="o.value" />
        </el-select>
        <el-input-number
          v-else
          :model-value="(rule as Record<string, unknown>)[f.prop] as number"
          size="small"
          :controls="false"
          :style="{ width: `${f.width ?? 100}px` }"
          @change="(v: number | undefined) => setField(i, f.prop, v ?? 0)"
        />
      </template>

      <el-button size="small" text type="danger" class="re-del" @click="removeRule(i)">删除</el-button>
    </div>
  </div>
</template>

<style scoped>
.rule-editor {
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  padding: 12px 14px;
  background: var(--bg-1);
}
.re-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.re-title {
  font-size: 13px;
  font-weight: 650;
  color: var(--brand-2);
  margin-right: auto;
}
.re-hint {
  margin: 8px 0 0;
  font-size: 11.5px;
  color: var(--text-2);
  line-height: 1.6;
}
.re-empty {
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-2);
}
.re-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--grid-line);
}
.re-lbl {
  font-size: 11.5px;
  color: var(--text-2);
}
.re-del { margin-left: auto; }
.w150 { width: 150px; }
</style>
