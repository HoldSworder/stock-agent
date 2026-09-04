<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { EChartsCoreOption } from 'echarts';
import type {
  Playbook,
  PlaybookBacktest,
  PlaybookBacktestImport,
  PlaybookBacktestListItem,
  PlaybookBacktestMetrics,
  PlaybookHorizon,
  PlaybookSpec,
  PlaybookStatus,
  PlaybookUpsert,
} from '@stock-agent/shared';
import { api } from '@/api';
import EChart from '@/components/EChart.vue';
import MarkdownView from '@/components/MarkdownView.vue';
import PlaybookRuleEditor from '@/components/PlaybookRuleEditor.vue';

// 战法库：手工收录外部收集的战法（书 / 公众号 / 大V / 视频），并按战法自身规则严格回测。
// 两块内容——知识留档（markdown 五段）与回测（站内引擎跑 / 外部结果导入）。
// 筛选全在本地做，接口只拉全量。

const loading = ref(true);
const error = ref('');
const items = ref<Playbook[]>([]);
const selectedId = ref('');

// ---- 展示辅助 ----
const statusMeta: Record<PlaybookStatus, { label: string; type: '' | 'info' | 'warning' | 'success' | 'danger' }> = {
  collected: { label: '已收集', type: 'info' },
  testing: { label: '验证中', type: 'warning' },
  adopted: { label: '已采用', type: 'success' },
  retired: { label: '已弃用', type: 'danger' },
};
const horizonMeta: Record<PlaybookHorizon, string> = { short: '短线', mid: '中线', long: '长线' };
const MARKET_ENVS = ['主升', '反弹', '退潮', '震荡'];

function splitCsv(v?: string | null): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

// ---- 加载 ----
async function loadAll(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    items.value = await api.playbooks.list();
    if (items.value.length && !items.value.some((p) => p.id === selectedId.value)) {
      selectedId.value = items.value[0].id;
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
onMounted(loadAll);

// ---- 本地筛选 ----
const keyword = ref('');
const filterCategory = ref('');
const filterStatus = ref<PlaybookStatus | ''>('');
const filterRating = ref(0);

const categories = computed(() =>
  [...new Set(items.value.map((p) => p.category).filter((c): c is string => !!c))].sort(),
);

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return items.value.filter((p) => {
    if (filterCategory.value && p.category !== filterCategory.value) return false;
    if (filterStatus.value && p.status !== filterStatus.value) return false;
    if (filterRating.value && p.rating < filterRating.value) return false;
    if (!kw) return true;
    return [p.name, p.summary, p.tags, p.source, p.category, p.marketEnv]
      .filter(Boolean)
      .some((f) => String(f).toLowerCase().includes(kw));
  });
});

const selected = computed(() => items.value.find((p) => p.id === selectedId.value) ?? null);

// ---- 新建 / 编辑 ----
const drawerOpen = ref(false);
const editingId = ref<string | null>(null);
const saving = ref(false);

const emptyForm = (): PlaybookUpsert => ({
  name: '',
  summary: '',
  category: '',
  tags: '',
  horizon: null,
  marketEnv: '',
  source: '',
  sourceUrl: '',
  pickMd: '',
  buyMd: '',
  sellMd: '',
  riskMd: '',
  notesMd: '',
  rating: 0,
  status: 'collected',
});
const form = reactive<PlaybookUpsert>(emptyForm());
// 适用环境在表单里用多选，落库前拼成逗号串
const envList = ref<string[]>([]);

function openCreate(): void {
  editingId.value = null;
  Object.assign(form, emptyForm());
  envList.value = [];
  drawerOpen.value = true;
}

function openEdit(p: Playbook): void {
  editingId.value = p.id;
  Object.assign(form, emptyForm(), {
    name: p.name,
    summary: p.summary ?? '',
    category: p.category ?? '',
    tags: p.tags ?? '',
    horizon: p.horizon ?? null,
    source: p.source ?? '',
    sourceUrl: p.sourceUrl ?? '',
    pickMd: p.pickMd ?? '',
    buyMd: p.buyMd ?? '',
    sellMd: p.sellMd ?? '',
    riskMd: p.riskMd ?? '',
    notesMd: p.notesMd ?? '',
    rating: p.rating,
    status: p.status,
  });
  envList.value = splitCsv(p.marketEnv);
  drawerOpen.value = true;
}

async function save(): Promise<void> {
  if (!form.name.trim()) {
    ElMessage.warning('请填写战法名称');
    return;
  }
  saving.value = true;
  try {
    const body: PlaybookUpsert = { ...form, marketEnv: envList.value.join(',') };
    const saved = editingId.value
      ? await api.playbooks.update(editingId.value, body)
      : await api.playbooks.create(body);
    drawerOpen.value = false;
    // 先刷 items 再改选中 id：切换 watcher 依赖 items 里已有该条，否则读不到新战法的 spec
    await loadAll();
    selectedId.value = saved.id;
    ElMessage.success(editingId.value ? '已保存' : '已新建');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    saving.value = false;
  }
}

async function remove(p: Playbook): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除战法「${p.name}」？`, '提示', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await api.playbooks.remove(p.id);
    if (selectedId.value === p.id) selectedId.value = '';
    await loadAll();
    ElMessage.success('已删除');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

// ================= 回测 =================

const detailTab = ref('doc');

/** 新战法的默认规则骨架：留空条件，由用户按战法原文逐条填 */
const emptySpec = (): PlaybookSpec => ({
  universe: { kind: 'codes', codes: [] },
  period: 'day',
  barLimit: 500,
  entry: { mode: 'all', rules: [] },
  exit: { mode: 'any', rules: [] },
  stopLossPct: null,
  takeProfitPct: null,
  maxHoldBars: null,
  fill: 'nextOpen',
});

const spec = ref<PlaybookSpec>(emptySpec());
/** 标的池代码在 UI 上是一行文本，保存时切成数组 */
const codesText = ref('');
const specDirty = ref(false);

const backtests = ref<PlaybookBacktestListItem[]>([]);
const selectedBtId = ref('');
const selectedBt = ref<PlaybookBacktest | null>(null);
const btLoading = ref(false);
const running = ref(false);

/** 覆盖度不足时的警示文案；覆盖度缺失（外部导入的旧记录）或接近全覆盖时不提示 */
const COVERAGE_WARN_RATIO = 0.9;
const coverageWarn = computed<{ title: string; detail: string } | null>(() => {
  const c = selectedBt.value?.metrics.coverage;
  if (!c || c.requested <= 0 || c.ratio >= COVERAGE_WARN_RATIO) return null;
  const parts: string[] = [];
  if (c.failed.length) parts.push(`取数失败或样本不足 ${c.failed.length} 只：${c.failed.slice(0, 8).join('、')}`);
  if (c.skipped.length) parts.push(`超出取数预算未纳入 ${c.skipped.length} 只：${c.skipped.slice(0, 8).join('、')}`);
  return {
    title: `标的覆盖度偏低：仅纳入 ${c.included}/${c.requested}（${Math.round(c.ratio * 100)}%）`,
    detail:
      `${parts.join('；')}。被剔除的标的多为退市、长期停牌或流动性差的品种，` +
      `剔除方向偏乐观，下面这组指标不代表整个池子的真实表现。`,
  };
});

// 只监听 selectedId：selected 是由 items 派生的 computed，loadAll() 整体替换 items 后
// 即使选中的还是同一条，对象引用也变了，监听 selected 会把用户未保存的规则编辑静默重置掉。
watch(selectedId, (id) => {
  const p = selected.value;
  spec.value = p?.spec ? { ...emptySpec(), ...p.spec } : emptySpec();
  codesText.value = (spec.value.universe.codes ?? []).join(',');
  specDirty.value = false;
  selectedBtId.value = '';
  selectedBt.value = null;
  backtests.value = [];
  if (id && p) void loadBacktests(p.id);
});

function markDirty(): void {
  specDirty.value = true;
}

/** 把 UI 上的标的文本并回 spec */
function currentSpec(): PlaybookSpec {
  const codes = codesText.value
    .split(/[,，\s]+/)
    .map((c) => c.trim())
    .filter(Boolean);
  return { ...spec.value, universe: { ...spec.value.universe, codes } };
}

/** 标的池上限，与后端 MAX_CODES 一致 */
const MAX_CODES = 30;

/**
 * 跑回测前的缺项校验，口径对齐后端 assertRunnableSpec / resolveUniverse，
 * 让用户在点按钮前就知道缺什么，而不是靠一个 400 才发现。
 */
const specIssues = computed<string[]>(() => {
  const s = currentSpec();
  const issues: string[] = [];
  if (!s.entry.rules.length) issues.push('缺少买入条件');
  const hasExit =
    s.exit.rules.length > 0 ||
    s.stopLossPct != null ||
    s.takeProfitPct != null ||
    s.maxHoldBars != null;
  if (!hasExit) issues.push('缺少离场手段（卖出条件 / 止损 / 止盈 / 持有上限 至少一项）');
  if (s.universe.kind === 'codes') {
    const n = (s.universe.codes ?? []).length;
    if (!n) issues.push('标的池为空，请填写代码');
    else if (n > MAX_CODES) issues.push(`标的池最多 ${MAX_CODES} 只，当前 ${n} 只`);
  }
  return issues;
});

/** @param autoOpen 拉完后自动打开最新一条；调用方要打开指定回测时传 false，免得两次请求打架 */
async function loadBacktests(id: string, autoOpen = true): Promise<void> {
  try {
    backtests.value = await api.playbooks.listBacktests(id);
    if (autoOpen && backtests.value.length) await openBacktest(backtests.value[0].id);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

async function openBacktest(bid: string): Promise<void> {
  if (!selected.value) return;
  selectedBtId.value = bid;
  btLoading.value = true;
  try {
    selectedBt.value = await api.playbooks.backtest(selected.value.id, bid);
  } catch (e) {
    selectedBt.value = null;
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    btLoading.value = false;
  }
}

async function saveSpec(): Promise<void> {
  if (!selected.value) return;
  try {
    const saved = await api.playbooks.saveSpec(selected.value.id, currentSpec());
    const i = items.value.findIndex((p) => p.id === saved.id);
    if (i >= 0) items.value[i] = saved;
    specDirty.value = false;
    ElMessage.success('回测规则已保存');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

async function runBacktest(): Promise<void> {
  if (!selected.value) return;
  running.value = true;
  try {
    // 带上当前编辑中的规则跑，后端会顺带存为战法规则，免得再点一次保存
    const bt = await api.playbooks.runBacktest(selected.value.id, currentSpec());
    specDirty.value = false;
    await loadAll();
    await loadBacktests(selected.value.id, false);
    await openBacktest(bt.id);
    ElMessage.success(`回测完成：${bt.metrics.trades ?? 0} 笔成交`);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    running.value = false;
  }
}

async function removeBacktest(bid: string): Promise<void> {
  if (!selected.value) return;
  try {
    await ElMessageBox.confirm('确认删除这条回测记录？', '提示', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await api.playbooks.removeBacktest(selected.value.id, bid);
    if (selectedBtId.value === bid) selectedBt.value = null;
    await loadBacktests(selected.value.id);
    ElMessage.success('已删除该回测记录');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

// ---- 外部导入 ----
const importOpen = ref(false);
const importText = ref('');
const importing = ref(false);

const IMPORT_SAMPLE = `{
  "label": "python 复算 2020-2025",
  "range": "2020-01-02 ~ 2025-12-31",
  "poolSize": 12,
  "metrics": { "returnPct": 86.4, "maxDrawdownPct": -18.2, "trades": 63, "winRatePct": 57.1 },
  "notes": ["外部 python 回测，成本按万 2.5 + 印花税千 0.5"]
}`;

/** metrics 里允许出现的数值字段，逐个校验类型，避免 "86.4" 这类字符串直接入库 */
const METRIC_NUM_KEYS = [
  'returnPct',
  'annualizedPct',
  'maxDrawdownPct',
  'trades',
  'winRatePct',
  'profitFactor',
  'avgReturnPct',
  'avgHoldBars',
  'maxConsecutiveLosses',
] as const;

/** 把手填 JSON 收敛成 PlaybookBacktestImport；类型不对就直接报错，别让脏数据落库 */
function parseImport(raw: string): PlaybookBacktestImport {
  const body: unknown = JSON.parse(raw);
  if (!body || typeof body !== 'object') throw new Error('JSON 顶层需为对象');
  const o = body as Record<string, unknown>;
  if (typeof o.label !== 'string' || !o.label.trim()) throw new Error('label 需为非空字符串');
  if (!o.metrics || typeof o.metrics !== 'object') throw new Error('JSON 需含 metrics 对象');
  const m = o.metrics as Record<string, unknown>;
  const metrics: PlaybookBacktestMetrics = {};
  for (const k of METRIC_NUM_KEYS) {
    const v = m[k];
    if (v == null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`metrics.${k} 需为数字，当前为 ${JSON.stringify(v)}`);
    }
    metrics[k] = v;
  }
  if (o.poolSize != null && (typeof o.poolSize !== 'number' || !Number.isFinite(o.poolSize))) {
    throw new Error('poolSize 需为数字');
  }
  if (o.range != null && typeof o.range !== 'string') throw new Error('range 需为字符串');
  if (o.notes != null && (!Array.isArray(o.notes) || o.notes.some((n) => typeof n !== 'string'))) {
    throw new Error('notes 需为字符串数组');
  }
  return {
    label: o.label.trim(),
    range: o.range as string | undefined,
    poolSize: o.poolSize as number | undefined,
    metrics,
    trades: o.trades as PlaybookBacktestImport['trades'],
    equity: o.equity as PlaybookBacktestImport['equity'],
    notes: o.notes as string[] | undefined,
  };
}

async function doImport(): Promise<void> {
  if (!selected.value) return;
  importing.value = true;
  try {
    const body = parseImport(importText.value);
    const bt = await api.playbooks.importBacktest(selected.value.id, body);
    importOpen.value = false;
    importText.value = '';
    await loadBacktests(selected.value.id, false);
    await openBacktest(bt.id);
    ElMessage.success('已导入');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    importing.value = false;
  }
}

// ---- 回测展示辅助 ----
function pct(v: number | null | undefined): string {
  return v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
}
function retClass(v: number | null | undefined): string {
  if (v == null) return 'mut';
  return v > 0 ? 'pos' : v < 0 ? 'neg' : 'mut';
}
/** 成交价统一两位小数，避免不同数据源小数位不一致导致列参差 */
function price(v: number | null | undefined): string {
  return v == null ? '—' : v.toFixed(2);
}

/** 逐笔胜负数（口径同后端 summarize：收益 > 0 记胜） */
const tradeWinLoss = computed(() => {
  const trades = selectedBt.value?.trades ?? [];
  const win = trades.filter((t) => t.returnPct > 0).length;
  return { win, loss: trades.length - win };
});

/** 回测记录下拉的摘要标签：来源 · 名称 · 收益 · 笔数 */
function btOptionLabel(b: PlaybookBacktestListItem): string {
  const parts = [b.source === 'system' ? '站内' : '外部', b.label];
  if (b.metrics?.returnPct != null) parts.push(pct(b.metrics.returnPct));
  if (b.metrics?.trades != null) parts.push(`${b.metrics.trades} 笔`);
  return parts.join(' · ');
}

const equityOption = computed<EChartsCoreOption>(() => {
  const pts = selectedBt.value?.equity ?? [];
  return {
    grid: { left: 48, right: 16, top: 16, bottom: 28 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: pts.map((p) => p.date), axisLabel: { fontSize: 10 } },
    yAxis: {
      type: 'value',
      scale: true,
      axisLabel: { fontSize: 10, formatter: (v: number) => v.toFixed(2) },
    },
    series: [
      {
        type: 'line',
        data: pts.map((p) => p.equity),
        showSymbol: false,
        lineStyle: { width: 1.5 },
        areaStyle: { opacity: 0.08 },
      },
    ],
  };
});
</script>

<template>
  <div class="playbook-view">
    <header class="page-head">
      <div>
        <h1>战法库</h1>
        <p class="sub">收集的各项战法留档 · 来源 / 适用环境 / 选股·买点·卖点·风控</p>
      </div>
      <div class="meta-strip">
        <span><b>{{ items.length }}</b> 条</span>
        <span><b>{{ items.filter((p) => p.status === 'adopted').length }}</b> 已采用</span>
        <el-button size="small" type="primary" @click="openCreate">新建战法</el-button>
      </div>
    </header>

    <el-alert v-if="error" :title="`加载失败：${error}`" type="error" :closable="false" show-icon class="mb" />
    <el-skeleton v-if="loading" :rows="8" animated class="mb" />

    <template v-else>
      <div v-if="!items.length" class="empty">
        战法库为空。点右上「新建战法」把你收集到的打法记录进来。
      </div>

      <div v-else class="lib">
        <!-- 左：筛选 + 列表 -->
        <aside class="side">
          <div class="filters">
            <el-input v-model="keyword" size="small" placeholder="搜索名称 / 标签 / 来源" clearable />
            <div class="filter-row">
              <el-select v-model="filterCategory" size="small" placeholder="类型" clearable>
                <el-option v-for="c in categories" :key="c" :label="c" :value="c" />
              </el-select>
              <el-select v-model="filterStatus" size="small" placeholder="状态" clearable>
                <el-option
                  v-for="(m, k) in statusMeta"
                  :key="k"
                  :label="m.label"
                  :value="k"
                />
              </el-select>
              <el-select v-model="filterRating" size="small" placeholder="星级">
                <el-option label="不限星级" :value="0" />
                <el-option v-for="n in 5" :key="n" :label="`${n} 星以上`" :value="n" />
              </el-select>
            </div>
          </div>

          <div class="pb-list">
            <div v-if="!filtered.length" class="empty sm">没有符合条件的战法。</div>
            <button
              v-for="p in filtered"
              :key="p.id"
              class="pb-card"
              :class="{ active: p.id === selectedId }"
              @click="selectedId = p.id"
            >
              <div class="pc-top">
                <span class="pc-name">{{ p.name }}</span>
                <el-tag size="small" :type="statusMeta[p.status].type" effect="dark">
                  {{ statusMeta[p.status].label }}
                </el-tag>
              </div>
              <p v-if="p.summary" class="pc-sum">{{ p.summary }}</p>
              <div class="pc-foot">
                <span v-if="p.category" class="pill">{{ p.category }}</span>
                <span v-if="p.horizon" class="pill">{{ horizonMeta[p.horizon] }}</span>
                <span class="stars">{{ '★'.repeat(p.rating) }}</span>
              </div>
            </button>
          </div>
        </aside>

        <!-- 右：详情 -->
        <section class="pb-detail">
          <div v-if="!selected" class="empty">从左侧选择一个战法查看详情。</div>
          <template v-else>
            <div class="pd-head">
              <div>
                <h2>{{ selected.name }}</h2>
                <div class="pd-tags">
                  <el-tag size="small" :type="statusMeta[selected.status].type" effect="dark">
                    {{ statusMeta[selected.status].label }}
                  </el-tag>
                  <span v-if="selected.category" class="cat">{{ selected.category }}</span>
                  <span v-if="selected.horizon" class="cat">{{ horizonMeta[selected.horizon] }}</span>
                  <el-tag v-for="t in splitCsv(selected.tags)" :key="t" size="small" effect="plain">
                    {{ t }}
                  </el-tag>
                  <span class="stars">{{ '★'.repeat(selected.rating) }}</span>
                </div>
              </div>
              <div class="pd-actions">
                <el-button size="small" @click="openEdit(selected)">编辑</el-button>
                <el-button size="small" type="danger" plain @click="remove(selected)">删除</el-button>
              </div>
            </div>

            <p v-if="selected.summary" class="pd-summary">{{ selected.summary }}</p>

            <div class="pd-meta">
              <span v-if="splitCsv(selected.marketEnv).length">
                适用环境
                <b>{{ splitCsv(selected.marketEnv).join(' / ') }}</b>
              </span>
              <span v-if="selected.source">
                来源
                <a v-if="selected.sourceUrl" :href="selected.sourceUrl" target="_blank" rel="noopener">
                  {{ selected.source }}
                </a>
                <b v-else>{{ selected.source }}</b>
              </span>
              <span class="mut mono">更新于 {{ selected.updatedAt.slice(0, 10) }}</span>
            </div>

            <el-tabs v-model="detailTab" class="pd-tabs">
              <el-tab-pane label="战法留档" name="doc" />
              <el-tab-pane :label="`回测（${backtests.length}）`" name="backtest" />
            </el-tabs>

            <template v-if="detailTab === 'doc'">
            <div v-if="selected.pickMd" class="pd-block">
              <div class="block-h"><span>选股规则</span></div>
              <MarkdownView :source="selected.pickMd" class="prose" />
            </div>
            <div v-if="selected.buyMd" class="pd-block">
              <div class="block-h"><span>买点</span></div>
              <MarkdownView :source="selected.buyMd" class="prose" />
            </div>
            <div v-if="selected.sellMd" class="pd-block">
              <div class="block-h"><span>卖点</span></div>
              <MarkdownView :source="selected.sellMd" class="prose" />
            </div>
            <div v-if="selected.riskMd" class="pd-block risk">
              <div class="block-h"><span>风控</span></div>
              <MarkdownView :source="selected.riskMd" class="prose" />
            </div>
            <div v-if="selected.notesMd" class="pd-block">
              <div class="block-h"><span>个人心得</span></div>
              <MarkdownView :source="selected.notesMd" class="prose" />
            </div>
            </template>

            <!-- ============ 回测 ============ -->
            <template v-else>
              <div class="pd-block">
                <div class="block-h">
                  <span>回测规则</span>
                  <div class="bt-actions">
                    <el-button size="small" :disabled="!specDirty" @click="saveSpec">保存规则</el-button>
                    <el-button size="small" @click="importOpen = true">导入外部结果</el-button>
                    <el-button
                      size="small"
                      type="primary"
                      :loading="running"
                      :disabled="specIssues.length > 0"
                      @click="runBacktest"
                    >
                      跑回测
                    </el-button>
                  </div>
                </div>

                <p v-if="specIssues.length" class="bt-issues">
                  规则未配齐，无法回测：{{ specIssues.join('；') }}
                </p>

                <p class="bt-tip">
                  规则按战法自身指标严格逐 bar 执行，不做预设近似：信号收盘确认、次一根 bar 成交（天然 T+1），
                  成本按佣金双边 + 过户费双边 + 印花税卖出单边 + 滑点分别计。指标样本不足的 bar 一律不成立。
                  站内引擎只支持日线 / 周线可算出的条件；集合竞价、龙虎榜、盘口这类条件表达不了，
                  请用「导入外部结果」提交 python / codex 的回测产出。
                </p>

                <div class="bt-cfg" @change="markDirty">
                  <label>
                    <span>标的池</span>
                    <el-select v-model="spec.universe.kind" size="small" @change="markDirty">
                      <el-option label="指定代码" value="codes" />
                      <el-option label="自选股" value="watchlist" />
                      <el-option label="ETF 跟踪池" value="etfPool" />
                      <el-option label="研究标的库" value="researchUniverse" />
                    </el-select>
                  </label>
                  <label v-if="spec.universe.kind === 'codes'" class="wide">
                    <span>代码（逗号分隔，最多 30 只）</span>
                    <el-input v-model="codesText" size="small" placeholder="600519,000001" @input="markDirty" />
                  </label>
                  <label>
                    <span>周期</span>
                    <el-select v-model="spec.period" size="small" @change="markDirty">
                      <el-option label="日线" value="day" />
                      <el-option label="周线" value="week" />
                    </el-select>
                  </label>
                  <label>
                    <span>K 线根数</span>
                    <el-input-number v-model="spec.barLimit" size="small" :min="60" :max="2000" :controls="false" @change="markDirty" />
                  </label>
                  <label>
                    <span>成交价怎么算</span>
                    <el-select v-model="spec.fill" size="small" @change="markDirty">
                      <el-option label="次根开盘" value="nextOpen" />
                      <el-option label="次根收盘" value="nextClose" />
                    </el-select>
                  </label>
                  <label>
                    <span>止损 %（留空不启用）</span>
                    <el-input-number v-model="spec.stopLossPct" size="small" :min="0" :max="100" :controls="false" @change="markDirty" />
                  </label>
                  <label>
                    <span>止盈 %</span>
                    <el-input-number v-model="spec.takeProfitPct" size="small" :min="0" :max="1000" :controls="false" @change="markDirty" />
                  </label>
                  <label>
                    <span>最长持有（根）</span>
                    <el-input-number v-model="spec.maxHoldBars" size="small" :min="1" :max="500" :controls="false" @change="markDirty" />
                  </label>
                </div>

                <PlaybookRuleEditor
                  v-model="spec.entry"
                  title="买入条件"
                  hint="按战法原文逐条填；条件之间的关系用「全部满足 / 任一满足」表达。"
                  class="mt12"
                  @update:model-value="markDirty"
                />
                <PlaybookRuleEditor
                  v-model="spec.exit"
                  title="卖出条件"
                  allow-exit-only
                  hint="任一卖出条件成立即卖；与上方止损 / 止盈 / 持有上限取先触发者。"
                  class="mt12"
                  @update:model-value="markDirty"
                />
              </div>

              <!-- 回测记录 -->
              <div class="pd-block">
                <div class="block-h">
                  <span>回测记录</span>
                  <el-select
                    v-if="backtests.length"
                    :model-value="selectedBtId"
                    size="small"
                    class="w360"
                    @change="openBacktest"
                  >
                    <el-option
                      v-for="b in backtests"
                      :key="b.id"
                      :label="btOptionLabel(b)"
                      :value="b.id"
                    />
                  </el-select>
                </div>

                <div v-if="!backtests.length" class="empty sm">
                  还没有回测记录。配好规则点「跑回测」，或从 python / codex 导入外部结果。
                </div>
                <el-skeleton v-else-if="btLoading" :rows="4" animated />
                <template v-else-if="selectedBt">
                  <div class="kpis">
                    <div class="kpi">
                      <span class="k">累计收益</span>
                      <span class="v mono" :class="retClass(selectedBt.metrics.returnPct)">
                        {{ pct(selectedBt.metrics.returnPct) }}
                      </span>
                    </div>
                    <div class="kpi">
                      <span class="k">年化</span>
                      <span class="v mono" :class="retClass(selectedBt.metrics.annualizedPct)">
                        {{ pct(selectedBt.metrics.annualizedPct) }}
                      </span>
                    </div>
                    <div class="kpi">
                      <span class="k">最大回撤</span>
                      <span class="v mono neg">{{ pct(selectedBt.metrics.maxDrawdownPct) }}</span>
                    </div>
                    <div class="kpi">
                      <span class="k">交易笔数</span>
                      <span class="v mono">{{ selectedBt.metrics.trades ?? '—' }}</span>
                    </div>
                    <div class="kpi">
                      <span class="k">胜率</span>
                      <span class="v mono">
                        {{ selectedBt.metrics.winRatePct == null ? '—' : `${selectedBt.metrics.winRatePct}%` }}
                      </span>
                    </div>
                    <div class="kpi">
                      <span class="k">盈亏比</span>
                      <span class="v mono">{{ selectedBt.metrics.profitFactor ?? '—' }}</span>
                    </div>
                    <div class="kpi">
                      <span class="k">单笔均收益</span>
                      <span class="v mono" :class="retClass(selectedBt.metrics.avgReturnPct)">
                        {{ pct(selectedBt.metrics.avgReturnPct) }}
                      </span>
                    </div>
                    <div class="kpi">
                      <span class="k">平均持有</span>
                      <span class="v mono">
                        {{ selectedBt.metrics.avgHoldBars == null ? '—' : `${selectedBt.metrics.avgHoldBars} 根` }}
                      </span>
                    </div>
                    <div class="kpi">
                      <span class="k">最大连亏</span>
                      <span class="v mono">{{ selectedBt.metrics.maxConsecutiveLosses ?? '—' }}</span>
                    </div>
                    <div class="kpi">
                      <span class="k">区间</span>
                      <span class="v mono mut">{{ selectedBt.range || '—' }}</span>
                    </div>
                  </div>

                  <!-- 覆盖度警示：取数失败/超预算的标的被剔除后仍会出组合指标，而这类失败集中在
                       退市、长期停牌、流动性差的标的上，剔除方向系统性偏乐观。低覆盖必须说出来，
                       否则用户会把一份只跑了半个池子的曲线当成完整回测结果。 -->
                  <el-alert
                    v-if="coverageWarn"
                    type="warning"
                    show-icon
                    :closable="false"
                    class="bt-coverage"
                    :title="coverageWarn.title"
                    :description="coverageWarn.detail"
                  />

                  <div class="bt-bar">
                    <span class="mut">
                      {{ selectedBt.source === 'system' ? '站内引擎' : '外部导入' }} ·
                      {{ selectedBt.poolSize ?? 0 }} 只标的 ·
                      <template v-if="selectedBt.metrics.coverage">
                        实际纳入 {{ selectedBt.metrics.coverage.included }}/{{
                          selectedBt.metrics.coverage.requested
                        }}
                        ·
                      </template>
                      {{ selectedBt.createdAt.slice(0, 16).replace('T', ' ') }}
                    </span>
                    <el-button size="small" text type="danger" @click="removeBacktest(selectedBt.id)">
                      删除该记录
                    </el-button>
                  </div>

                  <EChart v-if="selectedBt.equity.length" :option="equityOption" height="240px" />

                  <div v-if="selectedBt.trades.length" class="sub-tbl">
                    <div class="sub-h">
                      逐笔成交（{{ selectedBt.trades.length }} 笔，收益已扣成本）·
                      胜 {{ tradeWinLoss.win }} / 负 {{ tradeWinLoss.loss }}
                    </div>
                    <div class="t-scroll">
                      <table class="t-table">
                        <thead>
                          <tr>
                            <th>标的</th><th>买入日</th><th>买价</th><th>卖出日</th><th>卖价</th>
                            <th>收益</th><th>持有</th><th>离场原因</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr
                            v-for="(t, i) in selectedBt.trades"
                            :key="`${t.code}:${t.entryDate}:${t.exitDate}:${i}`"
                          >
                            <td>
                              <div class="cell-name">{{ t.name || t.code }}</div>
                              <div v-if="t.name" class="mono mut cell-code">{{ t.code }}</div>
                            </td>
                            <td class="mono mut">{{ t.entryDate }}</td>
                            <td class="mono">{{ price(t.entryPrice) }}</td>
                            <td class="mono mut">{{ t.exitDate }}</td>
                            <td class="mono">{{ price(t.exitPrice) }}</td>
                            <td class="mono" :class="retClass(t.returnPct)">{{ pct(t.returnPct) }}</td>
                            <td class="mono mut">{{ t.holdBars }}</td>
                            <td class="mut">{{ t.exitReason }}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <ul v-if="selectedBt.notes.length" class="bt-notes">
                    <li v-for="(n, i) in selectedBt.notes" :key="i">{{ n }}</li>
                  </ul>
                </template>
              </div>
            </template>
          </template>
        </section>
      </div>
    </template>

    <!-- 外部回测结果导入 -->
    <el-dialog v-model="importOpen" title="导入外部回测结果" width="640px">
      <p class="imp-tip">
        粘贴 python / codex 产出的回测 JSON。至少需要 <code class="mono">label</code> 与
        <code class="mono">metrics</code>，可选 <code class="mono">range / poolSize / trades / equity / notes</code>，
        字段名与站内回测记录一致。
      </p>
      <el-input v-model="importText" type="textarea" :rows="12" :placeholder="IMPORT_SAMPLE" />
      <template #footer>
        <el-button @click="importOpen = false">取消</el-button>
        <el-button type="primary" :loading="importing" @click="doImport">导入</el-button>
      </template>
    </el-dialog>

    <!-- 新建 / 编辑 -->
    <el-drawer
      v-model="drawerOpen"
      :title="editingId ? '编辑战法' : '新建战法'"
      size="620px"
      destroy-on-close
    >
      <el-form label-position="top" class="pb-form">
        <el-form-item label="名称" required>
          <el-input v-model="form.name" placeholder="如：缩量回踩 5 日线低吸" />
        </el-form-item>
        <el-form-item label="一句话核心">
          <el-input v-model="form.summary" placeholder="这套战法最本质的一句话" />
        </el-form-item>
        <div class="form-row">
          <el-form-item label="类型">
            <el-select v-model="form.category" placeholder="打板 / 低吸 / 趋势…" filterable allow-create clearable>
              <el-option v-for="c in categories" :key="c" :label="c" :value="c" />
            </el-select>
          </el-form-item>
          <el-form-item label="周期">
            <el-select v-model="form.horizon" placeholder="不限" clearable>
              <el-option v-for="(label, k) in horizonMeta" :key="k" :label="label" :value="k" />
            </el-select>
          </el-form-item>
          <el-form-item label="状态">
            <el-select v-model="form.status">
              <el-option v-for="(m, k) in statusMeta" :key="k" :label="m.label" :value="k" />
            </el-select>
          </el-form-item>
        </div>
        <div class="form-row">
          <el-form-item label="适用环境">
            <el-select v-model="envList" multiple placeholder="大盘阶段" >
              <el-option v-for="e in MARKET_ENVS" :key="e" :label="e" :value="e" />
            </el-select>
          </el-form-item>
          <el-form-item label="星级">
            <el-rate v-model="form.rating" clearable />
          </el-form-item>
        </div>
        <el-form-item label="标签（逗号分隔）">
          <el-input v-model="form.tags" placeholder="情绪周期,首板,龙头" />
        </el-form-item>
        <div class="form-row">
          <el-form-item label="来源">
            <el-input v-model="form.source" placeholder="书名 / 公众号 / 大V" />
          </el-form-item>
          <el-form-item label="原文链接">
            <el-input v-model="form.sourceUrl" placeholder="https://" />
          </el-form-item>
        </div>
        <el-form-item label="选股规则（markdown）">
          <el-input v-model="form.pickMd" type="textarea" :rows="5" />
        </el-form-item>
        <el-form-item label="买点（markdown）">
          <el-input v-model="form.buyMd" type="textarea" :rows="5" />
        </el-form-item>
        <el-form-item label="卖点（markdown）">
          <el-input v-model="form.sellMd" type="textarea" :rows="5" />
        </el-form-item>
        <el-form-item label="风控（markdown）">
          <el-input v-model="form.riskMd" type="textarea" :rows="4" />
        </el-form-item>
        <el-form-item label="个人心得（markdown）">
          <el-input v-model="form.notesMd" type="textarea" :rows="4" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="drawerOpen = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.playbook-view {
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
  font-size: 12px;
  color: var(--text-2);
}
.meta-strip b {
  font-family: var(--font-mono);
  color: var(--text-0);
  font-size: 14px;
  margin-right: 3px;
}
.mb { margin-bottom: 16px; }
.mono { font-family: var(--font-mono); }
.mut { color: var(--text-2); }
.cat { font-size: 12px; color: var(--text-1); }
.stars { color: var(--brand-2); font-size: 12px; letter-spacing: 1px; }

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

.lib {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 16px;
}
@media (max-width: 980px) {
  .lib { grid-template-columns: 1fr; }
}
.side {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.filters {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.filter-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}
.pb-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 680px;
  overflow-y: auto;
}
.pb-card {
  text-align: left;
  background: var(--bg-2);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  padding: 12px 14px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.pb-card:hover { border-color: var(--border); }
.pb-card.active {
  border-color: var(--brand-glow);
  background: var(--brand-soft);
}
.pc-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.pc-name {
  color: var(--text-0);
  font-size: 13.5px;
  font-weight: 600;
}
.pc-sum {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.pc-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}
.pill {
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-2);
  font-size: 11px;
}
.pc-foot .stars { margin-left: auto; }

.pb-detail {
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  background: var(--bg-2);
  padding: 18px 20px;
  min-height: 400px;
}
.pd-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.pd-head h2 {
  margin: 0;
  font-size: 18px;
  color: var(--text-0);
  font-weight: 650;
}
.pd-tags {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  flex-wrap: wrap;
}
.pd-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.pd-summary {
  color: var(--text-1);
  font-size: 13.5px;
  line-height: 1.75;
  margin: 14px 0 0;
}
.pd-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 12px;
  font-size: 12px;
  color: var(--text-2);
}
.pd-meta b { color: var(--text-1); margin-left: 4px; font-weight: 600; }
.pd-meta a { color: var(--brand-2); margin-left: 4px; }

.pd-block {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--grid-line);
}
.pd-block.risk .block-h span { color: var(--down); }
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
.prose {
  margin-top: 12px;
  font-size: 13px;
  line-height: 1.75;
  color: var(--text-1);
}

/* ===== 回测 ===== */
.pd-tabs {
  margin-top: 12px;
  --el-tabs-header-height: 34px;
}
.pd-tabs :deep(.el-tabs__header) { margin-bottom: 0; }
.bt-actions {
  display: flex;
  gap: 8px;
}
.bt-tip {
  margin: 0 0 12px;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--text-2);
}
.bt-cfg {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}
.bt-cfg label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11.5px;
  color: var(--text-2);
}
.bt-cfg label.wide { grid-column: span 2; }
.bt-cfg :deep(.el-select),
.bt-cfg :deep(.el-input-number) { width: 100%; }
.bt-issues {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--down);
}
.mt12 { margin-top: 12px; }
.w360 { width: 360px; }

.kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 10px;
}
.kpi {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-1);
}
.kpi .k { font-size: 11px; color: var(--text-2); }
.kpi .v { font-size: 15px; font-weight: 600; color: var(--text-0); }
.pos { color: var(--up); }
.neg { color: var(--down); }

.bt-coverage {
  margin-top: 12px;
}
.bt-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 12px;
  font-size: 11.5px;
}
.bt-notes {
  margin: 12px 0 0;
  padding-left: 18px;
  font-size: 11.5px;
  color: var(--text-2);
  line-height: 1.8;
}

.sub-tbl { margin-top: 16px; }
.sub-h {
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 8px;
}
.t-scroll {
  max-height: 320px;
  overflow: auto;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
}
.t-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.t-table th,
.t-table td {
  padding: 6px 10px;
  text-align: left;
  border-bottom: 1px solid var(--grid-line);
  white-space: nowrap;
}
.t-table th {
  position: sticky;
  top: 0;
  background: var(--bg-2);
  color: var(--text-2);
  font-weight: 500;
}
.t-table td { color: var(--text-1); }
.cell-name { color: var(--text-0); }
.cell-code { font-size: 11px; }

.imp-tip {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-2);
}
.imp-tip code {
  background: var(--bg-1);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  padding: 1px 5px;
  color: var(--brand-2);
}

.pb-form .form-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
}
.pb-form :deep(.el-select) { width: 100%; }
</style>
