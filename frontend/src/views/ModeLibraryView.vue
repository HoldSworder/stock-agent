<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { EChartsCoreOption } from 'echarts';
import type {
  ModeStatus,
  ResearchModeDetail,
  ResearchModeListItem,
  ResearchUniverseItem,
} from '@stock-agent/shared';
import { api } from '@/api';
import EChart from '@/components/EChart.vue';
import MarkdownView from '@/components/MarkdownView.vue';

// 量化研究模式库：codex/cursor 经写 API 登记的策略模式 + 回测 + 声明式站内自跟踪。
// 三 Tab — 模式库（买卖逻辑/回测/分析）/ 关注跟踪（关注以来每日持仓与累计收益）/ 研究标的库（独立于 ETF 关注列表）。
// 沿用项目暗色量化终端 token：单一琥珀强调色、红涨绿跌、数字等宽、完整 loading/empty/error 态。

const activeTab = ref('library');
const loading = ref(true);
const error = ref('');

const modes = ref<ResearchModeListItem[]>([]);
const universe = ref<ResearchUniverseItem[]>([]);

// 详情缓存（模式库与关注跟踪共用）
const detailCache = ref<Record<string, ResearchModeDetail>>({});
const selectedId = ref('');
const detailLoading = ref(false);
const selectedBtId = ref('');

const followedModes = computed(() => modes.value.filter((m) => m.followed));
const trackingId = ref('');

async function loadAll(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [ms, us] = await Promise.all([api.modes.list(), api.researchUniverse.list()]);
    modes.value = ms;
    universe.value = us;
    if (ms.length && !selectedId.value) void openMode(ms[0].id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
onMounted(loadAll);

const reseeding = ref(false);
async function reseed(): Promise<void> {
  reseeding.value = true;
  try {
    const r = await api.modes.reseed();
    detailCache.value = {};
    selectedId.value = '';
    await loadAll();
    ElMessage.success(`已从种子刷新 ${r.modes} 个模式 / ${r.backtests} 条回测`);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    reseeding.value = false;
  }
}

async function fetchDetail(id: string, force = false): Promise<ResearchModeDetail | null> {
  if (!force && detailCache.value[id]) return detailCache.value[id];
  try {
    const d = await api.modes.detail(id);
    detailCache.value = { ...detailCache.value, [id]: d };
    return d;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
    return null;
  }
}

async function openMode(id: string): Promise<void> {
  selectedId.value = id;
  detailLoading.value = true;
  const d = await fetchDetail(id);
  detailLoading.value = false;
  selectedBtId.value = d?.backtests.find((b) => b.isRecommended)?.id ?? d?.backtests[0]?.id ?? '';
}

const selectedDetail = computed(() => detailCache.value[selectedId.value] ?? null);
const selectedBt = computed(
  () => selectedDetail.value?.backtests.find((b) => b.id === selectedBtId.value) ?? null,
);

// ---- 关注 / 站内自跟踪动作 ----
async function toggleFollow(m: ResearchModeListItem, next: boolean): Promise<void> {
  try {
    await api.modes.follow(m.id, next);
    m.followed = next;
    ElMessage.success(next ? '已关注，纳入每日跟踪' : '已取消关注');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

const acting = ref(false);
async function trackNow(id: string): Promise<void> {
  acting.value = true;
  try {
    const r = await api.modes.trackNow(id);
    ElMessage.success(`已跟踪 ${r.date}：持仓 ${r.holdings.length} 只，当日 ${(r.dayReturn * 100).toFixed(2)}%`);
    await fetchDetail(id, true);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    acting.value = false;
  }
}
async function rebacktest(id: string): Promise<void> {
  acting.value = true;
  try {
    const bt = await api.modes.rebacktest(id);
    ElMessage.success(`已重跑回测：${bt.label}`);
    const d = await fetchDetail(id, true);
    if (d) selectedBtId.value = bt.id;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    acting.value = false;
  }
}

// ---- 回测买卖明细（逐笔交易记录，按所选回测惰性拉取 + 通用 markdown 表解析）----
interface TradeTable {
  headers: string[];
  rows: string[][];
}
const tradesCache = ref<Record<string, TradeTable | null>>({});
const tradesLoading = ref(false);

function parseMdTable(md: string | null): TradeTable | null {
  if (!md) return null;
  const lines = md
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|'));
  if (lines.length < 2) return null;
  const cells = (l: string) =>
    l
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim());
  const headers = cells(lines[0]);
  const rows: string[][] = [];
  for (const l of lines.slice(1)) {
    const c = cells(l);
    if (c.every((x) => x === '' || /^:?-{2,}:?$/.test(x))) continue; // 跳过 |---| 分隔行
    rows.push(c);
  }
  return rows.length ? { headers, rows } : null;
}

async function loadTrades(modeId: string, bid: string): Promise<void> {
  if (bid in tradesCache.value) return;
  tradesLoading.value = true;
  try {
    const r = await api.modes.trades(modeId, bid);
    tradesCache.value = { ...tradesCache.value, [bid]: parseMdTable(r.tradesMd) };
  } catch {
    tradesCache.value = { ...tradesCache.value, [bid]: null };
  } finally {
    tradesLoading.value = false;
  }
}

// 所选回测变化即惰性拉取其逐笔明细
watch(
  () => [selectedId.value, selectedBtId.value] as const,
  ([, bid]) => {
    if (bid && selectedDetail.value) void loadTrades(selectedDetail.value.mode.id, bid);
  },
  { immediate: true },
);

const tradesTable = computed<TradeTable | null>(() =>
  selectedBtId.value ? tradesCache.value[selectedBtId.value] ?? null : null,
);

// 列定位（各模式列不一，按表头语义匹配，不写死索引）
const retCol = computed(() => tradesTable.value?.headers.findIndex((h) => h === '收益') ?? -1);
const contribCol = computed(
  () => tradesTable.value?.headers.findIndex((h) => h.includes('贡献')) ?? -1,
);
const reasonCol = computed(() => tradesTable.value?.headers.findIndex((h) => h.includes('原因')) ?? -1);

function parseNum(s: string | undefined): number | null {
  if (s == null) return null;
  const v = parseFloat(String(s).replace(/[,%\s+]/g, ''));
  return Number.isFinite(v) ? v : null;
}

const tradeStats = computed(() => {
  const t = tradesTable.value;
  const ri = retCol.value;
  if (!t || ri < 0) return null;
  const vals = t.rows
    .map((r) => parseNum(r[ri]))
    .filter((v): v is number => v !== null);
  if (!vals.length) return null;
  const n = vals.length;
  const win = vals.filter((v) => v > 0).length;
  const avg = vals.reduce((a, b) => a + b, 0) / n;
  return { n, winRate: (win / n) * 100, avg, best: Math.max(...vals), worst: Math.min(...vals) };
});

function cellClass(colIdx: number, val: string): string {
  if (colIdx === retCol.value || colIdx === contribCol.value) {
    const v = parseNum(val);
    return v == null ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : 'mut';
  }
  return '';
}

// ---- 关注跟踪 Tab ----
async function openTracking(id: string): Promise<void> {
  trackingId.value = id;
  await fetchDetail(id);
}
const trackingDetail = computed(() => detailCache.value[trackingId.value] ?? null);
const latestDaily = computed(() => {
  const d = trackingDetail.value?.recentDaily;
  return d && d.length ? d[d.length - 1] : null;
});

const cumChartOption = computed<EChartsCoreOption>(() => {
  const daily = trackingDetail.value?.recentDaily ?? [];
  return {
    grid: { left: 8, right: 16, top: 16, bottom: 24, containLabel: true },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#11151c',
      borderColor: '#283140',
      textStyle: { color: '#e8edf4' },
      valueFormatter: (v: unknown) => `${(Number(v) * 100).toFixed(2)}%`,
    },
    xAxis: {
      type: 'category',
      data: daily.map((d) => d.date),
      axisLine: { lineStyle: { color: '#283140' } },
      axisLabel: { color: '#788694', fontSize: 10 },
    },
    yAxis: {
      type: 'value',
      axisLabel: {
        color: '#788694',
        fontFamily: 'JetBrains Mono, monospace',
        formatter: (v: number) => `${(v * 100).toFixed(0)}%`,
      },
      splitLine: { lineStyle: { color: '#161b22' } },
    },
    series: [
      {
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: daily.map((d) => d.cumReturn ?? 0),
        lineStyle: { color: '#f0b429', width: 2 },
        areaStyle: { color: 'rgba(240,180,41,0.10)' },
      },
    ],
  };
});

// ---- 研究标的库 CRUD ----
const uniForm = ref({ code: '', name: '', tags: '', note: '' });
const uniSaving = ref(false);
async function addUniverse(): Promise<void> {
  const code = uniForm.value.code.trim();
  const name = uniForm.value.name.trim();
  if (!/^\d{6}$/.test(code) || !name) {
    ElMessage.warning('请填写 6 位代码与名称');
    return;
  }
  uniSaving.value = true;
  try {
    await api.researchUniverse.add({
      code,
      name,
      tags: uniForm.value.tags.trim() || null,
      note: uniForm.value.note.trim() || null,
    });
    uniForm.value = { code: '', name: '', tags: '', note: '' };
    universe.value = await api.researchUniverse.list();
    ElMessage.success('已加入研究标的库');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    uniSaving.value = false;
  }
}
async function removeUniverse(code: string): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认从研究标的库移除 ${code}？`, '提示', { type: 'warning' });
  } catch {
    return;
  }
  await api.researchUniverse.remove(code);
  universe.value = universe.value.filter((u) => u.code !== code);
}

// ---- 展示辅助 ----
const statusMeta: Record<ModeStatus, { label: string; type: string }> = {
  recommended: { label: '推荐', type: 'warning' },
  baseline: { label: '基准', type: 'info' },
  experiment: { label: '实验', type: '' },
  retired: { label: '退役', type: 'danger' },
};
function pctRaw(v: number | null | undefined): string {
  return v === null || v === undefined ? '-' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}
function pctFrac(v: number | null | undefined): string {
  return v === null || v === undefined ? '-' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;
}
function retClass(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'mut';
  return v > 0 ? 'pos' : v < 0 ? 'neg' : 'mut';
}
function tagsArr(tags?: string | null): string[] {
  return (tags ?? '').split(',').map((t) => t.trim()).filter(Boolean);
}
</script>

<template>
  <div class="mode-view">
    <header class="page-head">
      <div>
        <h1>量化研究模式库</h1>
        <p class="sub">codex/cursor 发掘的策略模式 · 买卖逻辑与回测留档 · 关注后站内每日跟踪</p>
      </div>
      <div class="meta-strip">
        <span><b>{{ modes.length }}</b> 模式</span>
        <span><b>{{ followedModes.length }}</b> 关注中</span>
        <span><b>{{ universe.length }}</b> 研究标的</span>
        <el-button
          size="small"
          :loading="reseeding"
          title="从最新种子刷新各模式回测指标（含复利/非复利收益），保留关注与每日跟踪"
          @click="reseed"
        >从种子刷新</el-button>
      </div>
    </header>

    <el-alert v-if="error" :title="`加载失败：${error}`" type="error" :closable="false" show-icon class="mb" />
    <el-skeleton v-if="loading" :rows="8" animated class="mb" />

    <el-tabs v-else v-model="activeTab" class="tabs">
      <!-- ============ Tab1 模式库 ============ -->
      <el-tab-pane label="模式库" name="library">
        <div v-if="!modes.length" class="empty">
          研究模式库为空。codex/cursor 可经写 API <span class="mono">PUT /api/modes/:id</span>
          登记模式与回测后，在此查看与关注。
        </div>
        <div v-else class="lib">
          <!-- 左：模式列表 -->
          <aside class="mode-list">
            <button
              v-for="m in modes"
              :key="m.id"
              class="mode-card"
              :class="{ active: m.id === selectedId }"
              @click="openMode(m.id)"
            >
              <div class="mc-top">
                <span class="mc-name">{{ m.name }}</span>
                <el-tag size="small" :type="statusMeta[m.status].type" effect="dark">
                  {{ statusMeta[m.status].label }}
                </el-tag>
              </div>
              <div class="mc-metrics">
                <span
                  class="mono"
                  :class="retClass(m.headlineFlatReturn ?? m.headlineReturn)"
                  :title="m.headlineFlatReturn != null ? '非复利(等权)收益' : '复利收益（暂无非复利口径）'"
                >{{ pctRaw(m.headlineFlatReturn ?? m.headlineReturn) }}</span>
                <span v-if="m.headlineFlatReturn != null" class="mut sm">等权</span>
                <span class="mono mut">回撤 {{ pctRaw(m.headlineDrawdown) }}</span>
                <span class="mut">· {{ m.backtestCount }} 版回测</span>
              </div>
              <div class="mc-foot">
                <span class="track-pill" :class="m.trackingMode">
                  {{ m.trackingMode === 'system' ? '站内自跟踪' : '外部推送' }}
                </span>
                <span v-if="m.followed" class="follow-dot">● 关注中</span>
              </div>
            </button>
          </aside>

          <!-- 右：详情 -->
          <section class="mode-detail">
            <el-skeleton v-if="detailLoading" :rows="6" animated />
            <template v-else-if="selectedDetail">
              <div class="md-head">
                <div>
                  <h2>{{ selectedDetail.mode.name }}</h2>
                  <div class="md-tags">
                    <span v-if="selectedDetail.mode.category" class="cat">{{ selectedDetail.mode.category }}</span>
                    <el-tag
                      v-for="t in tagsArr(selectedDetail.mode.tags)"
                      :key="t"
                      size="small"
                      effect="plain"
                    >{{ t }}</el-tag>
                    <span v-if="selectedDetail.mode.source" class="src mono">via {{ selectedDetail.mode.source }}</span>
                  </div>
                </div>
                <div class="md-actions">
                  <el-switch
                    :model-value="modes.find((x) => x.id === selectedId)?.followed ?? false"
                    active-text="关注"
                    inline-prompt
                    @change="(v: string | number | boolean) => toggleFollow(modes.find((x) => x.id === selectedId)!, !!v)"
                  />
                  <template v-if="selectedDetail.mode.trackingMode === 'system'">
                    <el-button size="small" :loading="acting" @click="trackNow(selectedId)">立即跟踪</el-button>
                    <el-button size="small" :loading="acting" @click="rebacktest(selectedId)">重跑回测</el-button>
                  </template>
                </div>
              </div>

              <p v-if="selectedDetail.mode.summary" class="md-summary">{{ selectedDetail.mode.summary }}</p>

              <div v-if="selectedDetail.mode.recommendedConfig" class="md-config">
                <span class="lbl">推荐配置</span>
                <code class="mono">{{ selectedDetail.mode.recommendedConfig }}</code>
              </div>

              <!-- 回测版本 -->
              <div class="md-block">
                <div class="block-h">
                  <span>回测结果</span>
                  <el-select
                    v-if="selectedDetail.backtests.length"
                    v-model="selectedBtId"
                    size="small"
                    class="w260"
                  >
                    <el-option
                      v-for="b in selectedDetail.backtests"
                      :key="b.id"
                      :label="`${b.label}${b.isRecommended ? ' ★推荐' : ''}`"
                      :value="b.id"
                    />
                  </el-select>
                </div>
                <div v-if="!selectedBt" class="empty sm">暂无回测数据。</div>
                <template v-else>
                  <div class="kpis">
                    <div class="kpi">
                      <span class="k">非复利收益<span class="mut sm">等权</span></span>
                      <span
                        v-if="selectedBt.metrics.flatReturn != null"
                        class="v mono"
                        :class="retClass(selectedBt.metrics.flatReturn)"
                      >{{ pctRaw(selectedBt.metrics.flatReturn) }}</span>
                      <span v-else class="v mono mut" title="该旧模式暂无非复利口径">—</span>
                    </div>
                    <div class="kpi">
                      <span class="k">复利收益</span>
                      <span class="v mono" :class="retClass(selectedBt.metrics.return)">{{ pctRaw(selectedBt.metrics.return) }}</span>
                    </div>
                    <div class="kpi">
                      <span class="k">最大回撤</span>
                      <span class="v mono neg">{{ pctRaw(selectedBt.metrics.maxDrawdown) }}</span>
                    </div>
                    <div class="kpi">
                      <span class="k">年化</span>
                      <span class="v mono" :class="retClass(selectedBt.metrics.annualized)">{{ pctRaw(selectedBt.metrics.annualized) }}</span>
                    </div>
                    <div class="kpi">
                      <span class="k">交易次数</span>
                      <span class="v mono">{{ selectedBt.metrics.trades ?? '-' }}</span>
                    </div>
                    <div class="kpi">
                      <span class="k">胜率</span>
                      <span class="v mono">{{ selectedBt.metrics.winRate != null ? `${selectedBt.metrics.winRate.toFixed(0)}%` : '-' }}</span>
                    </div>
                    <div class="kpi">
                      <span class="k">区间</span>
                      <span class="v mono mut">{{ selectedBt.range ?? '-' }}</span>
                    </div>
                  </div>

                  <div v-if="selectedBt.costSensitivity.length" class="sub-tbl">
                    <div class="sub-h">成本敏感性</div>
                    <table class="mini">
                      <thead><tr><th>口径</th><th>收益</th><th>回撤</th><th>次数</th></tr></thead>
                      <tbody>
                        <tr v-for="(c, i) in selectedBt.costSensitivity" :key="i">
                          <td>{{ c.caliber }}</td>
                          <td class="mono" :class="retClass(c.return)">{{ pctRaw(c.return) }}</td>
                          <td class="mono neg">{{ pctRaw(c.maxDrawdown) }}</td>
                          <td class="mono mut">{{ c.trades ?? '-' }}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  <div v-if="selectedBt.segments.length" class="sub-tbl">
                    <div class="sub-h">分段复核</div>
                    <table class="mini">
                      <thead><tr><th>区间</th><th>收益</th><th>回撤</th><th>次数</th></tr></thead>
                      <tbody>
                        <tr v-for="(s, i) in selectedBt.segments" :key="i">
                          <td>{{ s.label }}</td>
                          <td class="mono" :class="retClass(s.return)">{{ pctRaw(s.return) }}</td>
                          <td class="mono neg">{{ pctRaw(s.maxDrawdown) }}</td>
                          <td class="mono mut">{{ s.trades ?? '-' }}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  <MarkdownView
                    v-if="selectedBt.concentrationMd"
                    :source="selectedBt.concentrationMd"
                    class="prose"
                  />

                  <!-- 买卖明细（逐笔交易记录）-->
                  <div class="sub-tbl trades">
                    <div class="sub-h">买卖明细</div>
                    <el-skeleton v-if="tradesLoading && !tradesTable" :rows="4" animated />
                    <template v-else-if="tradesTable">
                      <div v-if="tradeStats" class="trade-stats">
                        <span>笔数<b class="mono">{{ tradeStats.n }}</b></span>
                        <span>胜率<b class="mono" :class="tradeStats.winRate >= 50 ? 'pos' : 'neg'">{{ tradeStats.winRate.toFixed(0) }}%</b></span>
                        <span>平均收益<b class="mono" :class="retClass(tradeStats.avg)">{{ tradeStats.avg > 0 ? '+' : '' }}{{ tradeStats.avg.toFixed(1) }}%</b></span>
                        <span>最佳<b class="mono pos">+{{ tradeStats.best.toFixed(1) }}%</b></span>
                        <span>最差<b class="mono neg">{{ tradeStats.worst.toFixed(1) }}%</b></span>
                      </div>
                      <div class="t-scroll">
                        <table class="t-table">
                          <thead>
                            <tr><th v-for="(h, i) in tradesTable.headers" :key="i">{{ h }}</th></tr>
                          </thead>
                          <tbody>
                            <tr v-for="(row, ri) in tradesTable.rows" :key="ri">
                              <td
                                v-for="(cell, ci) in row"
                                :key="ci"
                                class="mono"
                                :class="[cellClass(ci, cell), ci === reasonCol ? 'reason' : '']"
                              >{{ cell }}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </template>
                    <div v-else class="empty sm">该版本无独立买卖流水（仅推荐候选附完整明细）。</div>
                  </div>
                </template>
              </div>

              <!-- 买卖逻辑 -->
              <div v-if="selectedDetail.mode.buySellMd" class="md-block">
                <div class="block-h"><span>买卖逻辑</span></div>
                <MarkdownView :source="selectedDetail.mode.buySellMd" class="prose" />
              </div>

              <!-- 相关分析 -->
              <div v-if="selectedDetail.mode.analysisMd" class="md-block">
                <div class="block-h"><span>相关分析</span></div>
                <MarkdownView :source="selectedDetail.mode.analysisMd" class="prose" />
              </div>

              <!-- 风险 -->
              <div v-if="selectedDetail.mode.risksMd" class="md-block risk">
                <div class="block-h"><span>风险提示</span></div>
                <MarkdownView :source="selectedDetail.mode.risksMd" class="prose" />
              </div>
            </template>
          </section>
        </div>
      </el-tab-pane>

      <!-- ============ Tab2 关注跟踪 ============ -->
      <el-tab-pane label="关注跟踪" name="tracking">
        <div v-if="!followedModes.length" class="empty">
          还没有关注的模式。到「模式库」里打开关注开关，关注后会按收盘自动跟踪（system 模式由站内引擎计算，
          external 模式由 codex/cursor 推送）。
        </div>
        <div v-else class="track-wrap">
          <aside class="track-list">
            <button
              v-for="m in followedModes"
              :key="m.id"
              class="track-item"
              :class="{ active: m.id === trackingId }"
              @click="openTracking(m.id)"
            >
              <span class="ti-name">{{ m.name }}</span>
              <span class="track-pill" :class="m.trackingMode">
                {{ m.trackingMode === 'system' ? '站内' : '外部' }}
              </span>
            </button>
          </aside>
          <section class="track-detail">
            <div v-if="!trackingDetail" class="empty sm">选择左侧一个关注模式查看跟踪。</div>
            <template v-else>
              <div class="td-kpis">
                <div class="kpi">
                  <span class="k">累计收益（关注以来）</span>
                  <span class="v mono" :class="retClass(latestDaily?.cumReturn)">
                    {{ pctFrac(latestDaily?.cumReturn) }}
                  </span>
                </div>
                <div class="kpi">
                  <span class="k">当前回撤</span>
                  <span class="v mono neg">{{ pctFrac(latestDaily?.drawdown) }}</span>
                </div>
                <div class="kpi">
                  <span class="k">最新跟踪日</span>
                  <span class="v mono mut">{{ latestDaily?.date ?? '-' }}</span>
                </div>
              </div>

              <div v-if="trackingDetail.recentDaily.length" class="track-chart-wrap">
                <div class="sub-h">累计收益曲线</div>
                <EChart :option="cumChartOption" height="240px" />
              </div>

              <div class="track-cols">
                <div class="tc">
                  <div class="sub-h">当前应持仓</div>
                  <div v-if="!latestDaily?.holdings.length" class="empty sm">暂无持仓快照。</div>
                  <ul v-else class="holdings">
                    <li v-for="h in latestDaily?.holdings" :key="h.code">
                      <span class="h-name">{{ h.name }}</span>
                      <span class="mono mut">{{ h.code }}</span>
                      <span class="mono brand">{{ (h.weight * 100).toFixed(0) }}%</span>
                    </li>
                  </ul>
                </div>
                <div class="tc">
                  <div class="sub-h">信号事件</div>
                  <div v-if="!trackingDetail.events.length" class="empty sm">暂无买卖事件。</div>
                  <ul v-else class="events">
                    <li v-for="e in trackingDetail.events" :key="e.id">
                      <span class="ev-date mono">{{ e.date }}</span>
                      <span class="ev-kind" :class="e.kind">{{ e.kind === 'exit' ? '卖出' : e.kind === 'enter' ? '买入' : '换仓' }}</span>
                      <span class="ev-detail">{{ e.detail }}</span>
                    </li>
                  </ul>
                </div>
              </div>
            </template>
          </section>
        </div>
      </el-tab-pane>

      <!-- ============ Tab3 研究标的库 ============ -->
      <el-tab-pane label="研究标的库" name="universe">
        <el-alert type="info" :closable="false" class="mb" show-icon>
          <template #title>
            独立于「ETF 关注列表」的量化研究标的池，供 codex/cursor 回测与站内跟踪引擎取用
            （读取 <span class="mono">GET /api/research-universe</span>）。
          </template>
        </el-alert>

        <div class="uni-add">
          <el-input v-model="uniForm.code" placeholder="6位代码" class="w120" />
          <el-input v-model="uniForm.name" placeholder="名称" class="w160" />
          <el-input v-model="uniForm.tags" placeholder="标签（逗号分隔，首个作主题去重键）" class="w260" />
          <el-input v-model="uniForm.note" placeholder="备注" class="w220" />
          <el-button type="primary" :loading="uniSaving" @click="addUniverse">加入</el-button>
        </div>

        <el-table :data="universe" size="small" class="tbl" height="540">
          <el-table-column label="代码" width="100">
            <template #default="{ row }"><span class="mono">{{ row.code }}</span></template>
          </el-table-column>
          <el-table-column label="名称" min-width="160" prop="name" />
          <el-table-column label="标签" min-width="200">
            <template #default="{ row }">
              <el-tag v-for="t in tagsArr(row.tags)" :key="t" size="small" effect="plain" class="utag">{{ t }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="备注" min-width="180">
            <template #default="{ row }"><span class="mut">{{ row.note || '-' }}</span></template>
          </el-table-column>
          <el-table-column label="" width="80" align="right">
            <template #default="{ row }">
              <el-button text size="small" class="del" @click="removeUniverse(row.code)">移除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.mode-view {
  padding: 20px 24px 40px;
  max-width: 1480px;
  margin: 0 auto;
}
.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}
.page-head h1 {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 650;
  color: var(--text-0);
  margin: 0;
}
.page-head .sub {
  margin: 4px 0 0;
  color: var(--text-2);
  font-size: 13px;
}
.meta-strip {
  display: flex;
  gap: 16px;
  align-items: baseline;
  color: var(--text-2);
  font-size: 12px;
}
.meta-strip b {
  color: var(--text-0);
  font-family: var(--font-mono);
  font-size: 14px;
}
.mb { margin-bottom: 14px; }
.mono { font-family: var(--font-mono); }
.pos { color: var(--up); }
.neg { color: var(--down); }
.mut { color: var(--text-2); }
.brand { color: var(--brand-2); }
.cat { font-size: 12px; color: var(--text-1); }

.empty {
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  padding: 32px;
  text-align: center;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.7;
}
.empty.sm { padding: 18px; font-size: 12.5px; }

/* ===== 模式库 ===== */
.lib {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 16px;
}
@media (max-width: 980px) {
  .lib { grid-template-columns: 1fr; }
}
.mode-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 720px;
  overflow-y: auto;
}
.mode-card {
  text-align: left;
  background: var(--bg-2);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  padding: 12px 14px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.mode-card:hover { border-color: var(--border); }
.mode-card.active {
  border-color: var(--brand-glow);
  background: var(--brand-soft);
}
.mc-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.mc-name {
  color: var(--text-0);
  font-size: 13.5px;
  font-weight: 600;
}
.mc-metrics {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 12px;
  margin-bottom: 6px;
}
.mc-metrics .pos, .mc-metrics .neg { font-size: 15px; font-weight: 600; }
.mc-metrics .sm { font-size: 10px; margin-left: -6px; }
.mc-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
}
.track-pill {
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-2);
  font-size: 11px;
}
.track-pill.system {
  border-color: var(--brand-glow);
  color: var(--brand-2);
}
.follow-dot { color: var(--brand-2); font-size: 11px; }

.mode-detail {
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  background: var(--bg-2);
  padding: 18px 20px;
  min-height: 400px;
}
.md-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.md-head h2 {
  margin: 0;
  font-size: 18px;
  color: var(--text-0);
  font-weight: 650;
}
.md-tags {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  flex-wrap: wrap;
}
.md-tags .src { color: var(--text-2); font-size: 11px; }
.md-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.md-summary {
  color: var(--text-1);
  font-size: 13.5px;
  line-height: 1.75;
  margin: 14px 0 0;
}
.md-config {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
  font-size: 12px;
}
.md-config .lbl { color: var(--text-2); }
.md-config code {
  background: var(--bg-1);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  padding: 3px 8px;
  color: var(--brand-2);
  font-size: 12px;
}
.md-block {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--grid-line);
}
.md-block.risk .block-h span { color: var(--down); }
.block-h {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.block-h span {
  font-size: 13px;
  font-weight: 650;
  color: var(--brand-2);
}
.w260 { width: 260px; }
.w220 { width: 220px; }
.w160 { width: 160px; }
.w120 { width: 120px; }

.kpis {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 10px;
}
@media (max-width: 1100px) {
  .kpis { grid-template-columns: repeat(3, 1fr); }
}
.kpi {
  background: var(--bg-1);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.kpi .k { font-size: 11px; color: var(--text-2); }
.kpi .k .sm { font-size: 9px; margin-left: 3px; opacity: 0.7; }
.kpi .v { font-size: 16px; font-weight: 600; color: var(--text-0); }

.sub-tbl { margin-top: 16px; }
.sub-h {
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 8px;
}
table.mini {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
table.mini th, table.mini td {
  text-align: right;
  padding: 6px 8px;
  border-bottom: 1px solid var(--grid-line);
}
table.mini th:first-child, table.mini td:first-child {
  text-align: left;
  color: var(--text-1);
}
table.mini th { color: var(--text-2); font-weight: 500; }
.prose {
  margin-top: 12px;
  font-size: 13px;
  line-height: 1.75;
  color: var(--text-1);
}
/* ===== 回测买卖明细 ===== */
.trade-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  font-size: 12.5px;
  color: var(--text-2);
  padding: 2px 0 10px;
}
.trade-stats b {
  margin-left: 5px;
  font-size: 14px;
  color: var(--text-0);
}
.t-scroll {
  max-height: 420px;
  overflow: auto;
  border: 1px solid var(--border-soft, var(--grid-line));
  border-radius: var(--radius-sm, 6px);
}
.t-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.t-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--bg-1);
  color: var(--text-2);
  font-weight: 500;
  text-align: right;
  white-space: nowrap;
  padding: 7px 10px;
  border-bottom: 1px solid var(--grid-line);
}
.t-table td {
  text-align: right;
  white-space: nowrap;
  padding: 6px 10px;
  border-bottom: 1px solid var(--grid-line);
  color: var(--text-1);
}
.t-table th:first-child,
.t-table td:first-child {
  text-align: left;
}
.t-table tbody tr:hover { background: var(--bg-1); }
.t-table td.reason {
  text-align: left;
  font-family: var(--font-display);
  color: var(--text-2);
}

/* ===== 关注跟踪 ===== */
.track-wrap {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: 16px;
}
@media (max-width: 980px) {
  .track-wrap { grid-template-columns: 1fr; }
}
.track-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.track-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  text-align: left;
  background: var(--bg-2);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  padding: 10px 12px;
  cursor: pointer;
}
.track-item.active { border-color: var(--brand-glow); background: var(--brand-soft); }
.ti-name { color: var(--text-0); font-size: 13px; }
.track-detail {
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  background: var(--bg-2);
  padding: 18px 20px;
}
.td-kpis {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-bottom: 18px;
}
.track-chart-wrap { margin-bottom: 18px; }
.track-cols {
  display: grid;
  grid-template-columns: 1fr 1.2fr;
  gap: 18px;
}
@media (max-width: 900px) {
  .track-cols { grid-template-columns: 1fr; }
}
.holdings, .events {
  list-style: none;
  margin: 0;
  padding: 0;
}
.holdings li {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 7px 0;
  border-bottom: 1px solid var(--grid-line);
  font-size: 13px;
}
.holdings .h-name { color: var(--text-0); flex: 1; }
.events li {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 7px 0;
  border-bottom: 1px solid var(--grid-line);
  font-size: 12.5px;
}
.ev-date { color: var(--text-2); font-size: 11px; }
.ev-kind {
  padding: 0 7px;
  border-radius: 999px;
  font-size: 11px;
  border: 1px solid var(--border);
}
.ev-kind.enter { color: var(--up); border-color: var(--up); }
.ev-kind.exit { color: var(--down); border-color: var(--down); }
.ev-detail { color: var(--text-1); }

/* ===== 研究标的库 ===== */
.uni-add {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.utag { margin-right: 4px; }
.del:hover { color: var(--down); }
</style>
