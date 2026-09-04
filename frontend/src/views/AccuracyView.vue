<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '@/api';
import StockLink from '@/components/StockLink.vue';
import type {
  AssertionAccuracy,
  AssertionAccuracyReport,
  AssertionSliceDim,
  PlanOutcomeStat,
  SymbolAssertion,
} from '@stock-agent/shared';

// 技术断言战绩页。
//
// 它回答的是一个此前完全无从回答的问题：每天算出来的那些点位和时间窗，
// 后续走势到底认不认。之前系统只会不停地算，从不记录算得准不准。

const report = ref<AssertionAccuracyReport | null>(null);
const outcomeStats = ref<PlanOutcomeStat[]>([]);
const loading = ref(false);
const days = ref(180);

/** 下钻列表 */
const detail = ref<SymbolAssertion[]>([]);
const detailTitle = ref('');
const detailOpen = ref(false);
const detailLoading = ref(false);

const DIMS: Array<{ key: AssertionSliceDim; label: string }> = [
  { key: 'source', label: '按依据来源' },
  { key: 'kind', label: '按判断类型' },
  { key: 'code', label: '按标的' },
  { key: 'period', label: '按周期' },
];

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [r, o] = await Promise.all([
      api.assertions.report(days.value),
      api.planOutcomes.stats().catch(() => [] as PlanOutcomeStat[]),
    ]);
    report.value = r;
    outcomeStats.value = o;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function drill(dim: AssertionSliceDim, row: AssertionAccuracy): Promise<void> {
  detailOpen.value = true;
  detailLoading.value = true;
  detailTitle.value = `${row.label} · 判断明细`;
  detail.value = [];
  try {
    // 四个切片维度与后端过滤字段同名，直接按维度装参；不要用类型断言绕过，
    // 早先那个 as 掩盖了「按周期下钻时后端根本不认 period、返回的是全量」这个 bug
    detail.value = await api.assertions.list({ [dim]: row.key, limit: 200 });
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    detailLoading.value = false;
  }
}

async function runSettle(): Promise<void> {
  loading.value = true;
  try {
    const s = await api.assertions.settle();
    ElMessage.success(
      `核对 ${s.checked} 条：遵循 ${s.settled.respected ?? 0} / 未遵循 ${s.settled.violated ?? 0}`,
    );
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

const pct = (v: number | null): string => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);

/** 遵循率着色按**下界**而不是点估计：点估计在小样本下会把噪声染成绿色 */
function rateClass(a: AssertionAccuracy): string {
  if (a.lowerBound == null) return 'is-unknown';
  if (a.lowerBound >= 0.55) return 'is-good';
  if (a.lowerBound >= 0.45) return 'is-mid';
  return 'is-poor';
}

const OUTCOME_LABEL: Record<string, string> = {
  respected: '遵循',
  violated: '未遵循',
  untouched: '未触及',
  unjudgeable: '判不了',
};

/** 未触及占比高说明这类位子普遍够不着，是「记了也白记」的信号 */
function untouchedPct(a: AssertionAccuracy): string {
  if (a.recorded <= 0) return '—';
  return `${((a.untouched / a.recorded) * 100).toFixed(0)}%`;
}

const hasData = computed(() => (report.value?.overall.recorded ?? 0) > 0);

/**
 * 总览按「价位」「日子」分开报。
 *
 * 这两类衡量的是完全不同的事：价位类问「这条线管不管用」，时间类问「转折是不是落在预测的那几天」。
 * 合成一个总数会让好的那一类被差的那一类拖下去，看到 46% 也不知道该少信哪一半。
 * 数据直接取 slices.kind，后端已经按 kind 分组算好，不必新开接口。
 */
/** 该类还一条没记时的占位：比率为 null，界面显示「—」，着色走 is-unknown */
const EMPTY_ACC: AssertionAccuracy = {
  key: '',
  label: '',
  recorded: 0,
  settled: 0,
  respected: 0,
  violated: 0,
  untouched: 0,
  rate: null,
  lowerBound: null,
};
const kindOf = (key: 'level' | 'time'): AssertionAccuracy =>
  report.value?.slices.kind.find((k) => k.key === key) ?? EMPTY_ACC;
const levelAcc = computed(() => kindOf('level'));
const timeAcc = computed(() => kindOf('time'));

onMounted(load);
</script>

<template>
  <div class="page" v-loading="loading">
    <div class="page-head">
      <div>
        <h2 class="page-title">说准率</h2>
        <p class="page-sub">
          每天把各套方法给出的价位和日子记下来，等走势走出来后逐条核对，
          看哪套方法在你自己的标的上真的说得准
        </p>
      </div>
      <div class="head-ops">
        <el-select v-model="days" size="small" style="width: 120px" @change="load">
          <el-option :value="30" label="近 30 天" />
          <el-option :value="90" label="近 90 天" />
          <el-option :value="180" label="近 180 天" />
          <el-option :value="1000" label="全部" />
        </el-select>
        <el-button size="small" @click="load">刷新</el-button>
        <el-button size="small" type="primary" plain @click="runSettle">立即核对</el-button>
      </div>
    </div>

    <el-empty
      v-if="!loading && !hasData"
      description="还没有记录。每天收盘后会自动记一次，也可以在后端手动补跑历史"
      :image-size="80"
    />

    <template v-else-if="report">
      <!-- 总览 -->
      <section class="panel overall">
        <div class="ov-cell">
          <span class="ov-label">价位说得准</span>
          <span class="ov-main num" :class="rateClass(levelAcc)">{{ pct(levelAcc.rate) }}</span>
          <span class="ov-sub num">
            已判 {{ levelAcc.settled }}，保守估计不低于 {{ pct(levelAcc.lowerBound) }}
          </span>
        </div>
        <div class="ov-cell">
          <span class="ov-label">日子说得准</span>
          <span class="ov-main num" :class="rateClass(timeAcc)">{{ pct(timeAcc.rate) }}</span>
          <span class="ov-sub num">
            已判 {{ timeAcc.settled }}，保守估计不低于 {{ pct(timeAcc.lowerBound) }}
          </span>
        </div>
        <div class="ov-cell">
          <span class="ov-label">合计已判定</span>
          <span class="ov-main num">{{ report.overall.settled }}</span>
          <span class="ov-sub num">
            说准 {{ report.overall.respected }} / 没说准 {{ report.overall.violated }}
          </span>
        </div>
        <div class="ov-cell">
          <span class="ov-label">价格没走到</span>
          <span class="ov-main num">{{ report.overall.untouched }}</span>
          <span class="ov-sub">价格压根没走到那儿，说明不了对错，不算分</span>
        </div>
        <div class="ov-cell">
          <span class="ov-label">AI 计划情景</span>
          <span class="ov-main num">{{ pct(report.scenario.rate) }}</span>
          <span class="ov-sub num">
            已判 {{ report.scenario.settled }}，下界 {{ pct(report.scenario.lowerBound) }}
          </span>
        </div>
        <div class="ov-cell ov-cell--wide">
          <span class="ov-label">统计区间</span>
          <span class="ov-main num sm">{{ report.fromDate ?? '—' }} ~ {{ report.toDate ?? '—' }}</span>
        </div>
      </section>

      <div class="page-note">{{ report.note }}</div>

      <!-- 四维切片 -->
      <section v-for="d in DIMS" :key="d.key" class="panel">
        <div class="panel-head">
          <span class="section-title">{{ d.label }}</span>
          <span class="panel-meta">点某一行可以看到具体是哪些判断</span>
        </div>
        <el-table
          v-if="report.slices[d.key].length"
          :data="report.slices[d.key]"
          size="small"
          style="width: 100%"
          @row-click="(row: AssertionAccuracy) => drill(d.key, row)"
        >
          <el-table-column label="分组" min-width="130">
            <template #default="{ row }">
              <StockLink v-if="d.key === 'code'" :code="row.key" :name="row.label" />
              <span v-else>{{ row.label }}</span>
            </template>
          </el-table-column>
          <el-table-column label="说准率" min-width="150">
            <template #default="{ row }">
              <div class="rate-cell">
                <span class="num rate-main" :class="rateClass(row)">{{ pct(row.rate) }}</span>
                <el-progress
                  v-if="row.lowerBound != null"
                  :percentage="Math.round(row.lowerBound * 100)"
                  :show-text="false"
                  :stroke-width="4"
                  class="rate-bar"
                />
              </div>
            </template>
          </el-table-column>
          <el-table-column label="保守下界" min-width="90" align="right">
            <template #default="{ row }">
              <span class="num" :title="'考虑样本误差后的保守估计，样本越少压得越低'">
                {{ pct(row.lowerBound) }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="已判 / 遵循 / 未遵循" min-width="140" align="right">
            <template #default="{ row }">
              <span class="num muted">
                {{ row.settled }} / {{ row.respected }} / {{ row.violated }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="价格没走到" min-width="100" align="right">
            <template #default="{ row }">
              <span class="num muted" :title="'价格根本没走到这些位子的比例，太高说明记了也白记'">
                {{ untouchedPct(row) }}
              </span>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-else description="暂无数据" :image-size="50" />
      </section>

      <!-- 计划复盘归因 -->
      <section v-if="outcomeStats.length" class="panel">
        <div class="panel-head">
          <span class="section-title">计划复盘归因</span>
          <span class="panel-meta">来自交易计划的收盘复核，只统计选了归因枚举的那些</span>
        </div>
        <div class="outcome-grid">
          <div v-for="o in outcomeStats" :key="o.outcome" class="outcome-cell">
            <span class="outcome-count num">{{ o.count }}</span>
            <span class="outcome-label">{{ o.label }}</span>
          </div>
        </div>
      </section>
    </template>

    <!-- 下钻抽屉 -->
    <el-drawer v-model="detailOpen" :title="detailTitle" size="46%">
      <div v-loading="detailLoading" class="drill">
        <div v-for="a in detail" :key="a.id" class="drill-row">
          <div class="drill-top">
            <span class="drill-outcome" :class="`is-${a.outcome ?? 'pending'}`">
              {{ a.outcome ? OUTCOME_LABEL[a.outcome] ?? a.outcome : '待判' }}
            </span>
            <StockLink :code="a.code" class="num" show="code" />
            <span class="num muted">{{ a.asOf }}</span>
          </div>
          <div class="drill-stmt">{{ a.statement }}</div>
          <div class="drill-meta num">
            <span v-if="a.price != null">价位 {{ a.price }}</span>
            <span v-if="a.direction">
              期望{{ a.direction === 'up' ? '向上反弹' : '向下受阻' }}
            </span>
            <span v-if="a.windowFrom">窗口 {{ a.windowFrom }} ~ {{ a.windowTo }}</span>
            <span v-if="a.atrSnapshot">ATR {{ a.atrSnapshot }}</span>
            <span v-if="a.reactionBars">反应窗 {{ a.reactionBars }} 根</span>
            <span>到期 {{ a.dueDate }}</span>
          </div>
          <div v-if="a.settleNote" class="drill-note">{{ a.settleNote }}</div>
        </div>
        <el-empty v-if="!detailLoading && detail.length === 0" description="无记录" :image-size="60" />
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.page {
  padding: 16px 18px 28px;
}
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}
.page-title {
  margin: 0 0 4px;
  font-size: 18px;
  font-weight: 600;
}
.page-sub {
  margin: 0;
  max-width: 640px;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.7;
}
.head-ops {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.page-note {
  margin: 0 0 14px;
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.7;
}
.panel {
  margin-bottom: 14px;
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
}
.panel-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
}
.section-title {
  font-size: 13px;
  font-weight: 600;
}
.panel-meta {
  color: var(--text-2);
  font-size: 11px;
}
/* 总览 */
.overall {
  display: flex;
  flex-wrap: wrap;
  gap: 0;
  padding: 0;
  overflow: hidden;
}
.ov-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1 1 0;
  min-width: 150px;
  padding: 12px 14px;
  border-left: 1px solid rgba(255, 255, 255, 0.06);
}
.ov-cell:first-child {
  border-left: none;
}
.ov-cell--wide {
  flex: 2 1 0;
}
.ov-label {
  color: var(--text-2);
  font-size: 11px;
}
.ov-main {
  font-size: 22px;
  font-weight: 600;
  line-height: 1.2;
}
.ov-main.sm {
  font-size: 14px;
}
.ov-sub {
  color: var(--text-2);
  font-size: 11px;
}
/* 遵循率着色按下界，不按点估计 */
.is-good {
  color: #f0454a;
}
.is-mid {
  color: #e6a23c;
}
.is-poor {
  color: #12b886;
}
.is-unknown {
  color: var(--text-2);
}
.rate-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rate-main {
  min-width: 48px;
  font-weight: 600;
}
.rate-bar {
  flex: 1;
  min-width: 60px;
}
.muted {
  color: var(--text-2);
}
/* 归因 */
.outcome-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.outcome-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 92px;
  padding: 8px 12px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
}
.outcome-count {
  font-size: 18px;
  font-weight: 600;
}
.outcome-label {
  color: var(--text-2);
  font-size: 11px;
}
/* 下钻 */
.drill-row {
  padding: 8px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.drill-top {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 3px;
}
.drill-outcome {
  padding: 1px 6px;
  border: 1px solid;
  border-radius: 3px;
  font-size: 10px;
}
.drill-outcome.is-respected {
  color: #f0454a;
  border-color: rgba(240, 69, 74, 0.5);
}
.drill-outcome.is-violated {
  color: #12b886;
  border-color: rgba(18, 184, 134, 0.5);
}
.drill-outcome.is-untouched,
.drill-outcome.is-unjudgeable,
.drill-outcome.is-pending {
  color: var(--text-2);
  border-color: rgba(255, 255, 255, 0.14);
}
.drill-stmt {
  font-size: 13px;
  color: #cfd3dc;
}
.drill-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-top: 3px;
  color: var(--text-2);
  font-size: 11px;
}
.drill-note {
  margin-top: 3px;
  color: var(--el-color-warning);
  font-size: 11px;
}
</style>
