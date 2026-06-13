<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import dayjs from 'dayjs';
import { ElMessage } from 'element-plus';
import { Compass, MagicStick, Refresh, TrendCharts } from '@element-plus/icons-vue';
import { api } from '@/api';
import ModuleScheduleDialog from '@/components/ModuleScheduleDialog.vue';
import { useKlineStore } from '@/stores/kline';
import { SCREEN_FACTOR_LABELS } from '@stock-agent/shared';
import type {
  ScreenEngineInfo,
  ScreenFactorKey,
  ScreenPick,
  ScreenRun,
  ScreenRunDetail,
  ScreenStrategy,
} from '@stock-agent/shared';

const kline = useKlineStore();
const msg = (e: unknown) => (e instanceof Error ? e.message : '请求失败');

// 发现枢纽：链向后续流程（自选/决策/战法/计划）
const hubLinks = [
  { to: '/watchlist', label: '加入自选', icon: 'Star' },
  { to: '/decision', label: '多智能体决策', icon: 'Opportunity' },
  { to: '/strategy', label: '战法验证', icon: 'DataAnalysis' },
  { to: '/plan', label: '今日计划', icon: 'Files' },
];

// ===== 选股链路（engine） =====
const engines = ref<ScreenEngineInfo[]>([]);
const engineId = ref('');

// ===== 选股配置 =====
const strategies = ref<ScreenStrategy[]>([]);
const strategyId = ref('');
const context = ref('');
const topN = ref(10);
const useLlm = ref(true);
const running = ref(false);
const savingDefault = ref(false);
// 仅首次加载用页内默认值初始化策略/数量，避免运行后刷新覆盖用户当前选择
const touchedTopN = ref(false);

const currentStrategy = computed(() =>
  strategies.value.find((s) => s.id === strategyId.value) ?? null,
);

function selectEngine(e: ScreenEngineInfo) {
  if (e.enabled) engineId.value = e.id;
}

// ===== 结果 / 历史 =====
const detail = ref<ScreenRunDetail | null>(null);
const recentRuns = ref<ScreenRun[]>([]);
const evaluating = ref(false);

// A 股红涨绿跌
const dir = (v: number | null | undefined) => (v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');
const pct = (v: number | null | undefined) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
const fmtTime = (iso: string) => dayjs(iso).format('MM-DD HH:mm');

const confTag = (c: number | null): 'success' | 'warning' | 'info' =>
  c == null ? 'info' : c >= 70 ? 'success' : c >= 40 ? 'warning' : 'info';

function factorBar(p: ScreenPick, key: ScreenFactorKey): number {
  return p.factors.find((f) => f.key === key)?.score ?? 0;
}
function pickFactorKeys(p: ScreenPick): ScreenFactorKey[] {
  return p.factors.map((f) => f.key);
}

async function loadStatus() {
  try {
    const s = await api.screener.status();
    engines.value = s.engines;
    strategies.value = s.strategies;
    recentRuns.value = s.recentRuns;
    if (!engineId.value) engineId.value = s.defaultEngine || s.engines.find((e) => e.enabled)?.id || '';
    if (!strategyId.value) strategyId.value = s.defaultStrategyId || s.strategies[0]?.id || '';
    if (!touchedTopN.value) topN.value = s.defaultTopN || 10;
  } catch (e) {
    ElMessage.error(msg(e));
  }
}

async function run() {
  if (!strategyId.value) return;
  running.value = true;
  try {
    detail.value = await api.screener.screen({
      engine: engineId.value,
      strategyId: strategyId.value,
      context: context.value.trim() || undefined,
      topN: topN.value,
      useLlm: useLlm.value,
    });
    await loadStatus();
    ElMessage.success(`选出 ${detail.value.picks.length} 只候选`);
  } catch (e) {
    ElMessage.error(msg(e));
  } finally {
    running.value = false;
  }
}

async function saveDefault() {
  if (!strategyId.value) return;
  savingDefault.value = true;
  try {
    await api.screener.saveConfig({ strategyId: strategyId.value, topN: topN.value });
    ElMessage.success('已设为定时默认（收盘定时任务将使用此策略与数量）');
  } catch (e) {
    ElMessage.error(msg(e));
  } finally {
    savingDefault.value = false;
  }
}

async function openRun(id: string) {
  try {
    detail.value = await api.screener.run(id);
  } catch (e) {
    ElMessage.error(msg(e));
  }
}

async function evalCurrent() {
  if (!detail.value) return;
  evaluating.value = true;
  try {
    const r = await api.screener.evalRun(detail.value.id);
    if (r.detail) detail.value = r.detail;
    ElMessage.success(`已回填 ${r.updated} 只 T+N 收益`);
  } catch (e) {
    ElMessage.error(msg(e));
  } finally {
    evaluating.value = false;
  }
}

onMounted(loadStatus);
</script>

<template>
  <div class="screener">
    <header class="page-head">
      <div class="title">
        <el-icon><Compass /></el-icon>
        <div>
          <h2>选股</h2>
          <p class="sub">发现枢纽 · 全市场多因子三层漏斗（硬筛 → 多因子打分 → LLM 横向排序）</p>
        </div>
      </div>
      <div class="head-actions">
        <ModuleScheduleDialog module="screener" />
        <el-button :icon="Refresh" circle @click="loadStatus" />
      </div>
    </header>

    <!-- 发现枢纽快捷链路 -->
    <div class="hub">
      <span class="hub-label">选出后去：</span>
      <router-link v-for="l in hubLinks" :key="l.to" :to="l.to" class="hub-link">
        {{ l.label }}
      </router-link>
    </div>

    <!-- 选股配置：链路 Tab 由后端注册表驱动，可在此页扩展更多选股链路 -->
    <el-card shadow="never" class="config">
      <div class="engine-tabs">
        <span
          v-for="e in engines"
          :key="e.id"
          :class="['engine', { active: e.id === engineId, soon: !e.enabled }]"
          :title="e.description"
          @click="selectEngine(e)"
        >
          {{ e.name }}<span v-if="!e.enabled" class="soon-tag">规划中</span>
        </span>
      </div>
      <div class="config-row">
        <div class="field">
          <label>策略</label>
          <el-select v-model="strategyId" style="width: 180px">
            <el-option v-for="s in strategies" :key="s.id" :label="s.name" :value="s.id" />
          </el-select>
        </div>
        <div class="field grow">
          <label>题材上下文（可选）</label>
          <el-input
            v-model="context"
            placeholder="如：机器人 算力 固态电池（命中候选行业/名称加题材分）"
            clearable
          />
        </div>
        <div class="field">
          <label>数量</label>
          <el-input-number
            v-model="topN"
            :min="3"
            :max="30"
            controls-position="right"
            style="width: 110px"
            @change="touchedTopN = true"
          />
        </div>
        <div class="field">
          <label>LLM 横排</label>
          <el-switch v-model="useLlm" />
        </div>
        <el-button type="primary" :icon="MagicStick" :loading="running" @click="run">
          开始选股
        </el-button>
        <el-button :loading="savingDefault" @click="saveDefault">存为定时默认</el-button>
      </div>
      <p v-if="currentStrategy" class="strategy-desc">{{ currentStrategy.description }}</p>
    </el-card>

    <div class="body">
      <!-- 结果 -->
      <el-card shadow="never" class="result">
        <template v-if="detail">
          <div class="result-head">
            <div>
              <h3>{{ detail.strategyName }} · Top{{ detail.picks.length }}</h3>
              <p class="meta">
                全市场 {{ detail.marketCount }} → 硬筛 {{ detail.filteredCount }} ·
                {{ fmtTime(detail.createdAt) }}
                <span v-if="detail.context"> · 题材：{{ detail.context }}</span>
              </p>
            </div>
            <el-button :icon="TrendCharts" :loading="evaluating" @click="evalCurrent">
              T+N 复盘
            </el-button>
          </div>

          <div v-if="detail.marketView || detail.selectionLogic || detail.portfolioRisk" class="llm-notes">
            <p v-if="detail.marketView"><b>大盘</b>{{ detail.marketView }}</p>
            <p v-if="detail.selectionLogic"><b>选股逻辑</b>{{ detail.selectionLogic }}</p>
            <p v-if="detail.portfolioRisk" class="risk"><b>组合风险</b>{{ detail.portfolioRisk }}</p>
          </div>

          <el-table :data="detail.picks" size="small" stripe>
            <el-table-column label="#" width="44">
              <template #default="{ row }">{{ row.rank }}</template>
            </el-table-column>
            <el-table-column label="标的" min-width="150">
              <template #default="{ row }">
                <a class="code-link" @click="kline.open(row.code, row.name)">
                  {{ row.name }}<span class="code">{{ row.code }}</span>
                </a>
                <div class="industry">{{ row.industry || '—' }}</div>
              </template>
            </el-table-column>
            <el-table-column label="现价" width="80">
              <template #default="{ row }">{{ row.price }}</template>
            </el-table-column>
            <el-table-column label="涨跌" width="84">
              <template #default="{ row }">
                <span :class="['num', dir(row.pct)]">{{ pct(row.pct) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="综合分" width="78">
              <template #default="{ row }">
                <b>{{ row.screenScore }}</b>
              </template>
            </el-table-column>
            <el-table-column label="因子" min-width="170">
              <template #default="{ row }">
                <div class="factors">
                  <div v-for="k in pickFactorKeys(row)" :key="k" class="factor" :title="`${SCREEN_FACTOR_LABELS[k]} ${factorBar(row, k)}`">
                    <span class="fk">{{ SCREEN_FACTOR_LABELS[k] }}</span>
                    <span class="fbar"><i :style="{ width: factorBar(row, k) + '%' }" /></span>
                  </div>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="选股逻辑 / 风险" min-width="240">
              <template #default="{ row }">
                <div v-if="row.thesis" class="thesis">{{ row.thesis }}</div>
                <div class="tags">
                  <el-tag v-if="row.confidence != null" size="small" :type="confTag(row.confidence)">
                    信心 {{ row.confidence }}
                  </el-tag>
                  <el-tag v-for="t in row.riskTags" :key="t" size="small" type="danger" effect="plain">
                    {{ t }}
                  </el-tag>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="T+N" width="84">
              <template #default="{ row }">
                <span v-if="row.evalReturn != null" :class="['num', dir(row.evalReturn)]">
                  {{ pct(row.evalReturn) }}
                </span>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
          </el-table>
        </template>
        <el-empty v-else description="尚未选股，配置策略后点击「开始选股」" />
      </el-card>

      <!-- 历史 -->
      <el-card shadow="never" class="history">
        <h3>历史</h3>
        <ul class="run-list">
          <li
            v-for="r in recentRuns"
            :key="r.id"
            :class="{ active: detail?.id === r.id }"
            @click="openRun(r.id)"
          >
            <div class="run-top">
              <span class="run-name">{{ r.strategyName }}</span>
              <span class="run-n">Top{{ r.topN }}</span>
            </div>
            <div class="run-meta">{{ fmtTime(r.createdAt) }} · 候选 {{ r.filteredCount }}</div>
          </li>
        </ul>
        <el-empty v-if="!recentRuns.length" description="暂无记录" :image-size="60" />
      </el-card>
    </div>
  </div>
</template>

<style scoped>
.screener {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.page-head .title {
  display: flex;
  align-items: center;
  gap: 12px;
}
.page-head .title .el-icon {
  font-size: 26px;
}
.page-head h2 {
  margin: 0;
  font-size: 20px;
}
.page-head .sub {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.head-actions {
  display: flex;
  gap: 8px;
}
.hub {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.hub-label {
  color: var(--el-text-color-secondary);
}
.hub-link {
  color: var(--el-color-primary);
  text-decoration: none;
  padding: 2px 10px;
  border: 1px solid var(--el-border-color);
  border-radius: 14px;
}
.hub-link:hover {
  background: var(--el-color-primary-light-9);
}
.engine-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.engine {
  font-size: 13px;
  padding: 4px 12px;
  border-radius: 6px 6px 0 0;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  color: var(--el-text-color-regular);
}
.engine.active {
  color: var(--el-color-primary);
  border-bottom-color: var(--el-color-primary);
  font-weight: 600;
}
.engine.soon {
  color: var(--el-text-color-disabled);
  cursor: not-allowed;
}
.soon-tag {
  margin-left: 4px;
  font-size: 10px;
  padding: 0 4px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
}
.config-row {
  display: flex;
  gap: 14px;
  align-items: flex-end;
  flex-wrap: wrap;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field.grow {
  flex: 1;
  min-width: 200px;
}
.field label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.strategy-desc {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.body {
  display: grid;
  grid-template-columns: 1fr 260px;
  gap: 14px;
  align-items: start;
}
.result-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 10px;
}
.result-head h3 {
  margin: 0;
}
.result-head .meta {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.llm-notes {
  background: var(--el-fill-color-light);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
  font-size: 13px;
}
.llm-notes p {
  margin: 4px 0;
}
.llm-notes b {
  margin-right: 6px;
  color: var(--el-color-primary);
}
.llm-notes .risk b {
  color: var(--el-color-danger);
}
.code-link {
  cursor: pointer;
  color: var(--el-text-color-primary);
  font-weight: 600;
}
.code-link:hover {
  color: var(--el-color-primary);
}
.code-link .code {
  margin-left: 6px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  font-weight: 400;
}
.industry {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.num.up {
  color: var(--el-color-danger);
}
.num.down {
  color: var(--el-color-success);
}
.muted {
  color: var(--el-text-color-secondary);
}
.factors {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.factor {
  display: flex;
  align-items: center;
  gap: 6px;
}
.factor .fk {
  width: 42px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.factor .fbar {
  flex: 1;
  height: 6px;
  background: var(--el-fill-color);
  border-radius: 3px;
  overflow: hidden;
}
.factor .fbar i {
  display: block;
  height: 100%;
  background: var(--el-color-primary);
}
.thesis {
  font-size: 12px;
  line-height: 1.5;
  margin-bottom: 4px;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.history h3 {
  margin: 0 0 10px;
}
.run-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.run-list li {
  padding: 8px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  cursor: pointer;
}
.run-list li:hover,
.run-list li.active {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}
.run-top {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  font-weight: 600;
}
.run-n {
  color: var(--el-text-color-secondary);
  font-weight: 400;
}
.run-meta {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  margin-top: 2px;
}
</style>
