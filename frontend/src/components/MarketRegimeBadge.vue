<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { QuestionFilled } from '@element-plus/icons-vue';
import { api } from '@/api';
import type { MarketRegimeOverview, MarketRegimePhase, MarketRegimeBias } from '@stock-agent/shared';

// 大盘阶段徽标：一行展示当前阶段（主升/反弹/退潮/震荡）+ 强度分 + 明日倾向 + 建议交易频率/仓位，
// hover/点击展开各维度证据、权重vs等权背离与白话建议。确定性只读，仅供参考不构成投资建议。
// 用法：<MarketRegimeBadge :regime="data.regime" />（外部已有数据）或 <MarketRegimeBadge auto-load />（自取实时）。

const props = withDefaults(
  defineProps<{
    /** 外部传入的大盘阶段数据（驾驶舱等已聚合场景） */
    regime?: MarketRegimeOverview | null;
    /** 无外部数据时自动拉取实时接口（大盘页用） */
    autoLoad?: boolean;
  }>(),
  { regime: null, autoLoad: false },
);

const loaded = ref<MarketRegimeOverview | null>(null);
const loading = ref(false);
const rg = computed<MarketRegimeOverview | null>(() => props.regime ?? loaded.value);

async function load() {
  loading.value = true;
  try {
    loaded.value = await api.regime.overview();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}
defineExpose({ reload: load });

onMounted(() => {
  if (props.autoLoad && !props.regime) void load();
});

// A股红涨绿跌语义：主升红、反弹橙、退潮绿、震荡灰
const PHASE_META: Record<MarketRegimePhase, { cls: string; icon: string; label: string }> = {
  主升: { cls: 'up', icon: '▲', label: '主升' },
  反弹: { cls: 'warn', icon: '↗', label: '反弹' },
  退潮: { cls: 'down', icon: '▼', label: '退潮' },
  震荡: { cls: 'flat', icon: '↔', label: '震荡' },
};
const BIAS_CLS: Record<MarketRegimeBias, string> = { 偏强: 'up', 偏弱: 'down', 中性: 'flat' };

const phaseMeta = computed(() => (rg.value ? PHASE_META[rg.value.phase] : PHASE_META['震荡']));
const deltaText = computed(() => {
  const d = rg.value?.delta;
  if (d == null) return '';
  return `${d >= 0 ? '+' : ''}${d}`;
});
</script>

<template>
  <div v-if="rg" class="regime-badge" :class="phaseMeta.cls">
    <div class="rb-main">
      <span class="rb-phase">
        <span class="rb-icon">{{ phaseMeta.icon }}</span>
        大盘阶段 · {{ phaseMeta.label }}
      </span>
      <span class="rb-score num">{{ rg.score }}<span class="rb-unit">/100</span></span>
      <span v-if="deltaText" class="rb-delta num" :class="rg.delta! >= 0 ? 'up' : 'down'">{{ deltaText }}</span>
      <span class="rb-sep">·</span>
      <span class="rb-bias" :class="BIAS_CLS[rg.tomorrowBias]">明日倾向 {{ rg.tomorrowBias }}</span>
      <span class="rb-sep">·</span>
      <span class="rb-advice-line">交易 {{ rg.suggestedFrequency }} · 仓位 {{ rg.positionRange }}</span>
      <span class="rb-cont">已持续 {{ rg.consecutiveDays }} 日</span>

      <el-popover placement="bottom-start" :width="380" trigger="hover">
        <template #reference>
          <el-icon class="rb-help"><QuestionFilled /></el-icon>
        </template>
        <div class="rb-detail">
          <div class="rb-detail-title">大盘阶段研判 · {{ rg.tradeDate }}</div>
          <p class="rb-adv">{{ rg.advice }}</p>

          <div class="rb-block-title">维度贡献（合计 {{ rg.breakdown.total }}）</div>
          <div class="rb-parts">
            <div v-for="p in rg.breakdown.parts" :key="p.label" class="rb-part">
              <span class="rb-part-l">{{ p.label }}</span>
              <span class="rb-part-v num">{{ p.value }}</span>
            </div>
          </div>

          <div v-if="rg.indices.length" class="rb-block-title">权重指数</div>
          <div v-for="ix in rg.indices" :key="ix.secid" class="rb-idx">
            <span class="rb-idx-n">{{ ix.name }}</span>
            <span class="rb-idx-tag" :class="ix.alignment === '多头排列' ? 'up' : ix.alignment === '空头排列' ? 'down' : 'flat'">{{ ix.alignment }}</span>
            <span class="rb-idx-ma" :class="ix.aboveMa60 ? 'up' : 'down'">{{ ix.aboveMa60 ? '站上MA60' : '失守MA60' }}</span>
            <span class="rb-idx-pct num" :class="ix.trendPct20 >= 0 ? 'up' : 'down'">20日{{ ix.trendPct20 >= 0 ? '+' : '' }}{{ ix.trendPct20 }}%</span>
          </div>

          <div v-if="rg.equalWeight" class="rb-eqw">
            <span class="rb-block-title">等权口径 · {{ rg.equalWeight.name }}</span>
            <span :class="rg.equalWeight.aboveMa60 ? 'up' : 'down'">{{ rg.equalWeight.aboveMa60 ? '站上MA60' : '失守MA60' }}</span>
            <span class="num" :class="rg.equalWeight.trendPct20 >= 0 ? 'up' : 'down'">20日{{ rg.equalWeight.trendPct20 >= 0 ? '+' : '' }}{{ rg.equalWeight.trendPct20 }}%</span>
            <span v-if="rg.equalWeight.upRatio != null" class="num">涨占比{{ rg.equalWeight.upRatio }}%</span>
          </div>

          <div class="rb-diverge" :class="rg.divergence.active ? 'warn' : ''">
            <b>权重vs等权：</b>{{ rg.divergence.note }}
          </div>

          <p class="rb-note">{{ rg.note }}</p>
        </div>
      </el-popover>
    </div>
  </div>
  <div v-else-if="loading" class="regime-badge flat"><span class="rb-phase">大盘阶段研判中…</span></div>
</template>

<style scoped>
.regime-badge {
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 12px;
  border: 1px solid var(--el-border-color-light);
  background: var(--el-fill-color-lighter);
  border-left-width: 4px;
}
.regime-badge.up { border-left-color: var(--el-color-danger); }
.regime-badge.warn { border-left-color: var(--el-color-warning); }
.regime-badge.down { border-left-color: var(--el-color-success); }
.regime-badge.flat { border-left-color: var(--el-color-info); }
.rb-main { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 13px; }
.rb-phase { font-weight: 700; font-size: 14px; }
.rb-icon { margin-right: 2px; }
.regime-badge.up .rb-phase { color: var(--el-color-danger); }
.regime-badge.warn .rb-phase { color: var(--el-color-warning); }
.regime-badge.down .rb-phase { color: var(--el-color-success); }
.regime-badge.flat .rb-phase { color: var(--el-color-info); }
.rb-score { font-weight: 700; font-size: 15px; }
.rb-unit { font-size: 11px; color: var(--el-text-color-secondary); font-weight: 400; }
.rb-sep { color: var(--el-text-color-placeholder); }
.rb-cont { color: var(--el-text-color-secondary); font-size: 12px; margin-left: auto; }
.rb-help { cursor: pointer; color: var(--el-text-color-secondary); }
.num { font-variant-numeric: tabular-nums; }
.up { color: var(--el-color-danger); }
.down { color: var(--el-color-success); }
.warn { color: var(--el-color-warning); }
.flat { color: var(--el-text-color-secondary); }
.rb-detail { font-size: 12px; line-height: 1.6; }
.rb-detail-title { font-weight: 700; margin-bottom: 4px; }
.rb-adv { margin: 4px 0 8px; color: var(--el-text-color-regular); }
.rb-block-title { font-weight: 600; margin: 8px 0 4px; color: var(--el-text-color-primary); }
.rb-parts { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.rb-part { display: flex; gap: 6px; min-width: 46%; justify-content: space-between; }
.rb-part-l { color: var(--el-text-color-secondary); }
.rb-idx { display: flex; gap: 8px; align-items: center; margin: 2px 0; }
.rb-idx-n { min-width: 64px; }
.rb-eqw { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; margin-top: 6px; }
.rb-diverge { margin-top: 6px; padding: 4px 6px; border-radius: 4px; background: var(--el-fill-color-light); }
.rb-diverge.warn { background: var(--el-color-warning-light-9); color: var(--el-color-warning); }
.rb-note { margin: 8px 0 0; color: var(--el-text-color-placeholder); font-size: 11px; }
</style>
