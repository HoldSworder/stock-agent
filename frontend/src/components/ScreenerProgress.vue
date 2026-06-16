<script setup lang="ts">
import { computed } from 'vue';
import { Check, Loading } from '@element-plus/icons-vue';
import type { ScreenProgressEvent, ScreenProgressStage } from '@stock-agent/shared';

// 选股链路实时进度：阶段步进（已完成打勾 + 实时只数，当前阶段高亮脉冲，未到阶段灰显）
// + 骨架表格复刻最终结果表形态。纯展示组件，进度数据由父级经 WebSocket 累积后传入。
const props = defineProps<{ events: ScreenProgressEvent[]; engine: string; useLlm: boolean }>();

// 各链路「必经阶段」模板：保证未到阶段也灰显（可预期的管线）。
// 可选阶段（enrich/rank）不放模板，待其在事件中出现再按规范顺序插入，避免永久灰显。
const TEMPLATES: Record<string, Array<{ stage: ScreenProgressStage; label: string }>> = {
  multifactor: [
    { stage: 'snapshot', label: '全市场快照' },
    { stage: 'filter', label: '规则硬筛' },
    { stage: 'score', label: '多因子打分' },
  ],
  nl: [
    { stage: 'snapshot', label: '妙想自然语言筛选' },
    { stage: 'filter', label: 'A 股可交易性过滤' },
  ],
};

const CANON_ORDER: ScreenProgressStage[] = ['snapshot', 'filter', 'score', 'enrich', 'rank'];

interface Step {
  stage: ScreenProgressStage;
  label: string;
  status: 'pending' | 'running' | 'done';
  marketCount?: number;
  filteredCount?: number;
  poolCount?: number;
  note?: string;
}

const steps = computed<Step[]>(() => {
  const byStage = new Map<ScreenProgressStage, Step>();
  const template = TEMPLATES[props.engine] ?? TEMPLATES.multifactor;
  for (const t of template) byStage.set(t.stage, { ...t, status: 'pending' });
  // multifactor 开了 LLM 横排时，预置 rank 占位以便灰显「即将进行」
  if (props.engine === 'multifactor' && props.useLlm) {
    byStage.set('rank', { stage: 'rank', label: 'LLM 横向排序', status: 'pending' });
  }
  for (const e of props.events) {
    const prev = byStage.get(e.stage) ?? { stage: e.stage, label: e.label, status: 'pending' };
    byStage.set(e.stage, {
      stage: e.stage,
      label: e.label || prev.label,
      status: e.status,
      marketCount: e.marketCount ?? prev.marketCount,
      filteredCount: e.filteredCount ?? prev.filteredCount,
      poolCount: e.poolCount ?? prev.poolCount,
      note: e.note ?? prev.note,
    });
  }
  return CANON_ORDER.filter((s) => byStage.has(s)).map((s) => byStage.get(s)!);
});

function countText(s: Step): string {
  if (s.status === 'pending') return '';
  if (s.stage === 'snapshot') return s.marketCount != null ? `全市场 ${s.marketCount}` : '';
  if (s.stage === 'filter') return s.filteredCount != null ? `候选 ${s.filteredCount}` : '';
  return s.poolCount != null ? `池 ${s.poolCount}` : '';
}
</script>

<template>
  <div class="screener-progress">
    <div class="bar"><i /></div>

    <ol class="steps">
      <li v-for="s in steps" :key="s.stage" :class="['step', s.status]">
        <span class="dot">
          <el-icon v-if="s.status === 'done'"><Check /></el-icon>
          <el-icon v-else-if="s.status === 'running'" class="spin"><Loading /></el-icon>
          <i v-else class="pending-dot" />
        </span>
        <div class="info">
          <span class="label">{{ s.label }}</span>
          <span v-if="countText(s)" class="count">{{ countText(s) }}</span>
          <span v-if="s.note" class="note">{{ s.note }}</span>
        </div>
      </li>
    </ol>

    <!-- 骨架表格：复刻最终结果表行形态（#/标的/现价/涨跌/综合分/因子），替代裸 spinner -->
    <div class="skeleton">
      <div v-for="n in 6" :key="n" class="srow">
        <el-skeleton animated>
          <template #template>
            <div class="cells">
              <el-skeleton-item variant="text" class="c-rank" />
              <el-skeleton-item variant="text" class="c-name" />
              <el-skeleton-item variant="text" class="c-price" />
              <el-skeleton-item variant="text" class="c-pct" />
              <el-skeleton-item variant="text" class="c-score" />
              <el-skeleton-item variant="text" class="c-factor" />
            </div>
          </template>
        </el-skeleton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.screener-progress {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.bar {
  height: 3px;
  border-radius: 3px;
  background: var(--el-color-primary-light-8);
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  width: 40%;
  border-radius: 3px;
  background: var(--el-color-primary);
  animation: indeterminate 1.3s ease-in-out infinite;
}
@keyframes indeterminate {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(300%);
  }
}
.steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 10px 18px;
}
.step {
  display: flex;
  align-items: center;
  gap: 8px;
  position: relative;
}
.step:not(:last-child)::after {
  content: '';
  width: 18px;
  height: 1px;
  background: var(--el-border-color);
  margin-left: 4px;
}
.dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
}
.step.done .dot {
  background: var(--el-color-primary);
  color: #fff;
}
.step.running .dot {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}
.pending-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--el-text-color-disabled);
}
.spin {
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.info {
  display: flex;
  flex-direction: column;
  line-height: 1.3;
}
.label {
  font-size: 13px;
  color: var(--el-text-color-regular);
}
.step.running .label {
  color: var(--el-color-primary);
  font-weight: 600;
}
.step.pending .label {
  color: var(--el-text-color-disabled);
}
.count {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}
.note {
  font-size: 11px;
  color: var(--el-color-warning);
}
.skeleton {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 4px;
}
.cells {
  display: flex;
  align-items: center;
  gap: 12px;
}
.c-rank {
  width: 24px;
}
.c-name {
  width: 130px;
}
.c-price {
  width: 56px;
}
.c-pct {
  width: 56px;
}
.c-score {
  width: 48px;
}
.c-factor {
  flex: 1;
}
@media (max-width: 768px) {
  .steps {
    flex-direction: column;
    align-items: flex-start;
  }
  .step:not(:last-child)::after {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .bar i {
    animation: none;
    width: 100%;
  }
  .spin {
    animation: none;
  }
}
</style>
