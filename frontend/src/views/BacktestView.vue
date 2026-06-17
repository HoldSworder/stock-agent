<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Refresh, VideoPlay, Close } from '@element-plus/icons-vue';
import type { EChartsCoreOption } from 'echarts';
import { api } from '@/api';
import EChart from '@/components/EChart.vue';
import type {
  BacktestPreset,
  BacktestRun,
  BacktestRunInput,
  BacktestRunListItem,
  BacktestScope,
  KlinePeriod,
} from '@stock-agent/shared';

// 回测页：单标的信号级（阶段一）+ 组合级（阶段二）。
// 数据走后端 getKline 历史日/周线，引擎为 tradelab（隔离在后端 backtest/engine.ts）。

const msg = (e: unknown) => (e instanceof Error ? e.message : '请求失败');

const PRESETS: { value: BacktestPreset; label: string; desc: string }[] = [
  { value: 'maTrend', label: '均线趋势', desc: '快线上穿慢线（金叉）建仓，跌破近 N 日低点止损' },
  { value: 'momentum', label: '动能突破', desc: '创近 N 日新高且区间涨幅达阈值建仓' },
];

// ===== 表单 =====
const scope = ref<BacktestScope>('signal');
const period = ref<KlinePeriod>('day');
const limit = ref(500);
const preset = ref<BacktestPreset>('maTrend');
const equity = ref(100000);
const riskPct = ref(1);

const params = reactive({
  fastPeriod: 10,
  slowPeriod: 30,
  lookback: 20,
  breakoutPct: 0,
  stopLookback: 10,
  rr: 2,
  atrTrailMult: 0,
});

const showCosts = ref(false);
const costs = reactive({
  commissionBps: 2.5,
  minCommission: 5,
  stampDutyBps: 5,
  transferFeeBps: 0.1,
  slippageBps: 2,
});

// 单标的
const code = ref('');
// 组合标的
const portfolio = ref<{ code: string; name: string }[]>([]);

// 股票搜索（远程）
const searchOptions = ref<{ code: string; name: string }[]>([]);
const searching = ref(false);
async function remoteSearch(q: string) {
  if (!q || q.trim().length < 1) {
    searchOptions.value = [];
    return;
  }
  searching.value = true;
  try {
    const list = await api.searchStocks(q.trim());
    searchOptions.value = list.map((s) => ({ code: s.code, name: s.name }));
  } catch {
    searchOptions.value = [];
  } finally {
    searching.value = false;
  }
}

function addPortfolio(c: string) {
  const opt = searchOptions.value.find((o) => o.code === c);
  if (!opt) return;
  if (portfolio.value.some((p) => p.code === opt.code)) return;
  if (portfolio.value.length >= 20) {
    ElMessage.warning('组合标的最多 20 个');
    return;
  }
  portfolio.value.push({ ...opt });
}
function removePortfolio(c: string) {
  portfolio.value = portfolio.value.filter((p) => p.code !== c);
}

// ===== 运行 / 结果 / 历史 =====
const running = ref(false);
const result = ref<BacktestRun | null>(null);
const history = ref<BacktestRunListItem[]>([]);
const historyLoading = ref(false);

async function loadHistory() {
  historyLoading.value = true;
  try {
    history.value = await api.listBacktestRuns(50);
  } catch (e) {
    ElMessage.error(msg(e));
  } finally {
    historyLoading.value = false;
  }
}

function buildInput(): BacktestRunInput | null {
  const base: BacktestRunInput = {
    scope: scope.value,
    period: period.value,
    limit: limit.value,
    preset: preset.value,
    params: { ...params },
    equity: equity.value,
    riskPct: riskPct.value,
    costs: { ...costs },
  };
  if (scope.value === 'signal') {
    if (!/^\d{6}$/.test(code.value)) {
      ElMessage.warning('请选择单只 6 位代码标的');
      return null;
    }
    base.code = code.value;
  } else {
    if (portfolio.value.length === 0) {
      ElMessage.warning('请至少添加 1 个组合标的');
      return null;
    }
    base.codes = portfolio.value.map((p) => p.code);
  }
  return base;
}

async function run() {
  const input = buildInput();
  if (!input) return;
  running.value = true;
  try {
    result.value = await api.runBacktest(input);
    await loadHistory();
  } catch (e) {
    ElMessage.error(msg(e));
  } finally {
    running.value = false;
  }
}

async function openRun(id: string) {
  try {
    result.value = await api.getBacktestRun(id);
  } catch (e) {
    ElMessage.error(msg(e));
  }
}

onMounted(loadHistory);

// ===== 展示辅助（A股 红涨绿跌）=====
const dir = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const pct1 = (v: number | null | undefined) =>
  v == null ? '-' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
const ratePct = (v: number | null | undefined) => (v == null ? '-' : (v * 100).toFixed(1) + '%');
const num = (v: number | null | undefined, d = 2) => (v == null ? '-' : v.toFixed(d));
const money = (v: number | null | undefined) =>
  v == null ? '-' : Math.round(v).toLocaleString('en-US');

const presetLabel = (p: BacktestPreset) => PRESETS.find((x) => x.value === p)?.label ?? p;

// 净值曲线
const equityOption = computed<EChartsCoreOption>(() => {
  const eq = result.value?.equity ?? [];
  return {
    grid: { left: 56, right: 16, top: 16, bottom: 28 },
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'category',
      data: eq.map((p) => p.time),
      axisLine: { lineStyle: { color: '#788694' } },
      axisLabel: { color: '#788694', fontSize: 10 },
      boundaryGap: false,
    },
    yAxis: {
      type: 'value',
      scale: true,
      axisLabel: { color: '#788694', fontSize: 10 },
      splitLine: { lineStyle: { color: 'rgba(120,134,148,0.15)' } },
    },
    series: [
      {
        type: 'line',
        data: eq.map((p) => Math.round(p.equity)),
        smooth: true,
        showSymbol: false,
        lineStyle: { color: '#f0b429', width: 1.5 },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(240,180,41,0.25)' },
              { offset: 1, color: 'rgba(240,180,41,0.02)' },
            ],
          },
        },
      },
    ],
  };
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-title">回测</div>
      <div class="head-actions">
        <el-button :icon="Refresh" :loading="historyLoading" @click="loadHistory">刷新历史</el-button>
      </div>
    </div>
    <div class="page-sub">
      基于历史日/周线回放预设策略，验证收益曲线、胜率与回撤。建仓近似 T+1、涨停板当根不建仓，已计入 A 股佣金/印花税/滑点成本。
    </div>

    <div class="bt-layout">
      <!-- 左：参数表单 -->
      <div class="panel form-panel">
        <div class="panel-title">参数</div>

        <el-form label-position="top" size="small">
          <el-form-item label="回测范围">
            <el-radio-group v-model="scope">
              <el-radio-button value="signal">单标的</el-radio-button>
              <el-radio-button value="portfolio">组合</el-radio-button>
            </el-radio-group>
          </el-form-item>

          <!-- 单标的 -->
          <el-form-item v-if="scope === 'signal'" label="标的">
            <el-select
              v-model="code"
              filterable
              remote
              clearable
              :remote-method="remoteSearch"
              :loading="searching"
              placeholder="搜索代码/名称"
              style="width: 100%"
            >
              <el-option
                v-for="o in searchOptions"
                :key="o.code"
                :label="`${o.name} (${o.code})`"
                :value="o.code"
              />
            </el-select>
          </el-form-item>

          <!-- 组合标的 -->
          <template v-else>
            <el-form-item label="添加标的">
              <el-select
                filterable
                remote
                :remote-method="remoteSearch"
                :loading="searching"
                placeholder="搜索后选择加入"
                style="width: 100%"
                :model-value="''"
                @change="addPortfolio"
              >
                <el-option
                  v-for="o in searchOptions"
                  :key="o.code"
                  :label="`${o.name} (${o.code})`"
                  :value="o.code"
                />
              </el-select>
            </el-form-item>
            <div v-if="portfolio.length" class="chips">
              <el-tag
                v-for="p in portfolio"
                :key="p.code"
                closable
                :icon="Close"
                @close="removePortfolio(p.code)"
              >
                {{ p.name }} ({{ p.code }})
              </el-tag>
            </div>
          </template>

          <el-form-item label="预设策略">
            <el-select v-model="preset" style="width: 100%">
              <el-option v-for="p in PRESETS" :key="p.value" :label="p.label" :value="p.value" />
            </el-select>
            <div class="hint">{{ PRESETS.find((p) => p.value === preset)?.desc }}</div>
          </el-form-item>

          <div class="row2">
            <el-form-item label="周期">
              <el-select v-model="period" style="width: 100%">
                <el-option label="日线" value="day" />
                <el-option label="周线" value="week" />
              </el-select>
            </el-form-item>
            <el-form-item label="K 线根数">
              <el-input-number v-model="limit" :min="60" :max="2000" :step="50" controls-position="right" style="width: 100%" />
            </el-form-item>
          </div>

          <!-- 预设参数 -->
          <div v-if="preset === 'maTrend'" class="row2">
            <el-form-item label="快线周期">
              <el-input-number v-model="params.fastPeriod" :min="2" :max="120" controls-position="right" style="width: 100%" />
            </el-form-item>
            <el-form-item label="慢线周期">
              <el-input-number v-model="params.slowPeriod" :min="3" :max="250" controls-position="right" style="width: 100%" />
            </el-form-item>
          </div>
          <div v-else class="row2">
            <el-form-item label="动能回看(日)">
              <el-input-number v-model="params.lookback" :min="2" :max="250" controls-position="right" style="width: 100%" />
            </el-form-item>
            <el-form-item label="涨幅阈值(%)">
              <el-input-number v-model="params.breakoutPct" :min="0" :max="100" controls-position="right" style="width: 100%" />
            </el-form-item>
          </div>

          <div class="row2">
            <el-form-item label="止损回看(日)">
              <el-input-number v-model="params.stopLookback" :min="2" :max="120" controls-position="right" style="width: 100%" />
            </el-form-item>
            <el-form-item label="盈亏比目标">
              <el-input-number v-model="params.rr" :min="0.5" :max="10" :step="0.5" controls-position="right" style="width: 100%" />
            </el-form-item>
          </div>

          <div class="row2">
            <el-form-item label="ATR跟踪止盈(倍, 0关)">
              <el-input-number v-model="params.atrTrailMult" :min="0" :max="10" :step="0.5" controls-position="right" style="width: 100%" />
            </el-form-item>
            <el-form-item label="单笔风险(%)">
              <el-input-number v-model="riskPct" :min="0.1" :max="100" :step="0.5" controls-position="right" style="width: 100%" />
            </el-form-item>
          </div>

          <el-form-item label="初始资金(元)">
            <el-input-number v-model="equity" :min="10000" :step="10000" controls-position="right" style="width: 100%" />
          </el-form-item>

          <el-form-item>
            <div class="costs-toggle" @click="showCosts = !showCosts">
              成本设置（A股默认）{{ showCosts ? '收起' : '展开' }}
            </div>
          </el-form-item>
          <template v-if="showCosts">
            <div class="row2">
              <el-form-item label="佣金(bps,双边)">
                <el-input-number v-model="costs.commissionBps" :min="0" :step="0.5" controls-position="right" style="width: 100%" />
              </el-form-item>
              <el-form-item label="最低佣金(元)">
                <el-input-number v-model="costs.minCommission" :min="0" controls-position="right" style="width: 100%" />
              </el-form-item>
            </div>
            <div class="row2">
              <el-form-item label="印花税(bps,卖出)">
                <el-input-number v-model="costs.stampDutyBps" :min="0" controls-position="right" style="width: 100%" />
              </el-form-item>
              <el-form-item label="滑点(bps)">
                <el-input-number v-model="costs.slippageBps" :min="0" controls-position="right" style="width: 100%" />
              </el-form-item>
            </div>
          </template>

          <el-button type="primary" :icon="VideoPlay" :loading="running" class="run-btn" @click="run">
            运行回测
          </el-button>
        </el-form>
      </div>

      <!-- 右：结果 -->
      <div class="result-col">
        <div v-if="!result" class="panel empty-panel">
          <el-empty description="设置参数后点击「运行回测」" />
        </div>

        <template v-else>
          <div class="panel">
            <div class="panel-title-row">
              <span class="panel-title">{{ result.label }}</span>
              <span class="meta">{{ presetLabel(result.preset) }} · {{ result.period === 'week' ? '周线' : '日线' }} · {{ result.range }}</span>
            </div>

            <!-- 指标卡 -->
            <div class="metrics">
              <div class="metric">
                <div class="m-label">区间收益</div>
                <div class="m-val num" :class="dir(result.metrics.returnPct)">{{ pct1(result.metrics.returnPct) }}</div>
              </div>
              <div class="metric">
                <div class="m-label">胜率</div>
                <div class="m-val num">{{ ratePct(result.metrics.winRate) }}</div>
              </div>
              <div class="metric">
                <div class="m-label">最大回撤</div>
                <div class="m-val num down">-{{ num(result.metrics.maxDrawdown) }}%</div>
              </div>
              <div class="metric">
                <div class="m-label">盈亏比</div>
                <div class="m-val num">{{ num(result.metrics.profitFactor) }}</div>
              </div>
              <div class="metric">
                <div class="m-label">夏普</div>
                <div class="m-val num">{{ num(result.metrics.sharpe) }}</div>
              </div>
              <div class="metric">
                <div class="m-label">交易笔数</div>
                <div class="m-val num">{{ result.metrics.trades }}</div>
              </div>
              <div class="metric">
                <div class="m-label">期末权益</div>
                <div class="m-val num">{{ money(result.metrics.finalEquity) }}</div>
              </div>
            </div>

            <!-- 净值曲线 -->
            <EChart v-if="result.equity.length" :option="equityOption" height="280px" />
            <div v-else class="hint" style="padding: 16px 0">无成交，净值无变化</div>
          </div>

          <!-- 组合分系统绩效 -->
          <div v-if="result.systems.length" class="panel">
            <div class="panel-title">分系统绩效</div>
            <el-table :data="result.systems" size="small" style="width: 100%">
              <el-table-column prop="code" label="代码" min-width="80" />
              <el-table-column label="权重" align="right" min-width="64">
                <template #default="{ row }">{{ num(row.weight) }}</template>
              </el-table-column>
              <el-table-column label="区间收益" align="right" min-width="90">
                <template #default="{ row }"><span class="num" :class="dir(row.metrics.returnPct)">{{ pct1(row.metrics.returnPct) }}</span></template>
              </el-table-column>
              <el-table-column label="胜率" align="right" min-width="72">
                <template #default="{ row }">{{ ratePct(row.metrics.winRate) }}</template>
              </el-table-column>
              <el-table-column label="最大回撤" align="right" min-width="84">
                <template #default="{ row }"><span class="num down">-{{ num(row.metrics.maxDrawdown) }}%</span></template>
              </el-table-column>
              <el-table-column label="笔数" align="right" min-width="60">
                <template #default="{ row }">{{ row.metrics.trades }}</template>
              </el-table-column>
            </el-table>
          </div>

          <!-- 成交流水 -->
          <div v-if="result.trades.length" class="panel">
            <div class="panel-title">成交流水（{{ result.trades.length }}）</div>
            <el-table :data="result.trades" size="small" height="320" style="width: 100%">
              <el-table-column prop="symbol" label="代码" min-width="76" />
              <el-table-column prop="entryTime" label="建仓日" min-width="100" />
              <el-table-column label="建仓价" align="right" min-width="76">
                <template #default="{ row }">{{ num(row.entry) }}</template>
              </el-table-column>
              <el-table-column prop="exitTime" label="平仓日" min-width="100" />
              <el-table-column label="平仓价" align="right" min-width="76">
                <template #default="{ row }">{{ num(row.exit) }}</template>
              </el-table-column>
              <el-table-column label="盈亏" align="right" min-width="90">
                <template #default="{ row }"><span class="num" :class="dir(row.pnl)">{{ money(row.pnl) }}</span></template>
              </el-table-column>
              <el-table-column prop="reason" label="离场" min-width="80" />
            </el-table>
          </div>

          <!-- 口径说明 -->
          <div class="panel notes">
            <div class="panel-title">口径说明</div>
            <ul>
              <li v-for="(n, i) in result.notes" :key="i">{{ n }}</li>
            </ul>
          </div>
        </template>
      </div>
    </div>

    <!-- 历史回测 -->
    <div class="panel history">
      <div class="panel-title">历史回测</div>
      <el-table v-loading="historyLoading" :data="history" size="small" style="width: 100%" @row-click="(r: BacktestRunListItem) => openRun(r.id)">
        <el-table-column prop="label" label="名称" min-width="160" />
        <el-table-column label="范围" min-width="80">
          <template #default="{ row }">{{ row.scope === 'portfolio' ? '组合' : '单标的' }}</template>
        </el-table-column>
        <el-table-column label="策略" min-width="90">
          <template #default="{ row }">{{ presetLabel(row.preset) }}</template>
        </el-table-column>
        <el-table-column prop="range" label="区间" min-width="180" />
        <el-table-column label="区间收益" align="right" min-width="90">
          <template #default="{ row }"><span class="num" :class="dir(row.metrics.returnPct)">{{ pct1(row.metrics.returnPct) }}</span></template>
        </el-table-column>
        <el-table-column label="胜率" align="right" min-width="72">
          <template #default="{ row }">{{ ratePct(row.metrics.winRate) }}</template>
        </el-table-column>
        <el-table-column label="最大回撤" align="right" min-width="84">
          <template #default="{ row }"><span class="num down">-{{ num(row.metrics.maxDrawdown) }}%</span></template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.bt-layout {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 12px;
  align-items: start;
  margin-top: 12px;
}
.panel {
  background: var(--panel, #131722);
  border: 1px solid rgba(120, 134, 148, 0.18);
  border-radius: 8px;
  padding: 14px;
  margin-bottom: 12px;
}
.form-panel {
  position: sticky;
  top: 12px;
}
.panel-title {
  font-weight: 600;
  margin-bottom: 10px;
}
.panel-title-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 12px;
  gap: 8px;
}
.panel-title-row .meta {
  font-size: 12px;
  color: #788694;
}
.row2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.hint {
  font-size: 11px;
  color: #788694;
  margin-top: 4px;
  line-height: 1.4;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}
.costs-toggle {
  font-size: 12px;
  color: #f0b429;
  cursor: pointer;
}
.run-btn {
  width: 100%;
  margin-top: 8px;
}
.result-col {
  min-width: 0;
}
.empty-panel {
  display: flex;
  justify-content: center;
  padding: 40px 0;
}
.metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}
.metric {
  background: rgba(120, 134, 148, 0.06);
  border-radius: 6px;
  padding: 8px 10px;
}
.m-label {
  font-size: 11px;
  color: #788694;
}
.m-val {
  font-size: 17px;
  font-weight: 600;
  margin-top: 2px;
}
.num {
  font-variant-numeric: tabular-nums;
}
.up {
  color: #f6465d;
}
.down {
  color: #1fc77f;
}
.notes ul {
  margin: 0;
  padding-left: 18px;
}
.notes li {
  font-size: 12px;
  color: #788694;
  line-height: 1.7;
}
.history :deep(.el-table__row) {
  cursor: pointer;
}
@media (max-width: 980px) {
  .bt-layout {
    grid-template-columns: 1fr;
  }
  .form-panel {
    position: static;
  }
}
</style>
