<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import dayjs from 'dayjs';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Refresh, MagicStick, Plus, Delete, Setting } from '@element-plus/icons-vue';
import { api } from '@/api';
import { useCachedResource } from '@/composables/useCachedResource';
import ModuleScheduleDialog from '@/components/ModuleScheduleDialog.vue';
import AiAnalysisDialog from '@/components/AiAnalysisDialog.vue';
import BoardReviewConclusion from '@/components/BoardReviewConclusion.vue';
import ScoreBreakdownPopover from '@/components/ScoreBreakdownPopover.vue';
import StrengthMethodologyDrawer from '@/components/StrengthMethodologyDrawer.vue';
import { QuestionFilled } from '@element-plus/icons-vue';
import { useKlineStore } from '@/stores/kline';
import type {
  EtfAction,
  EtfListItem,
  EtfOverview,
  EtfPoolItem,
  EtfRotationItem,
  EtfRotationOverview,
  EtfRotationState,
  EtfSignal,
  EtfStatus,
  EtfTrigger,
  HomeModule,
  MidDrilldownResult,
} from '@stock-agent/shared';

const msg = (e: unknown) => (e instanceof Error ? e.message : '请求失败');
const kline = useKlineStore();
const openKline = (it: EtfListItem) => kline.open(it.code, it.name, it.secid);

const tab = ref<'overview' | 'pool' | 'rotation'>('overview');
const status = ref<EtfStatus | null>(null);

// ===== Tab1 市场总览 =====
// SWR 缓存：重进/切 Tab 瞬显，3s 轮询变为按 TTL 的廉价新鲜度检查
const {
  data: ov,
  loading: ovLoading,
  refreshing: ovRefreshing,
  load: loadOverviewRes,
  reload: reloadOverview,
} = useCachedResource<EtfOverview>('etf:overview', () => api.etf.overview(), { ttlMs: 60_000 });
// 统一 AI 分析弹窗开关（ETF 综合研判，原市场点评 + 综合研判已合并为单一 kind）
const analyzeOpen = ref(false);
// 面板显隐
const modules = ref<HomeModule[]>([]);
const drawer = ref(false);
const draft = ref<Record<string, boolean>>({});
const savingModules = ref(false);
const enabled = (id: string) => modules.value.find((m) => m.id === id)?.enabled ?? false;

// ===== Tab2 跟踪池 =====
const pool = ref<EtfPoolItem[]>([]);
const signals = ref<EtfSignal[]>([]);
const asOf = ref('');
const loading = ref(false);
const newCode = ref('');
const newTags = ref('');
const adding = ref(false);

// ===== Tab3 行业轮动（中线赛道层）=====
// SWR 缓存（120s，中线慢变）：切到轮动 Tab 命中即瞬显，不再每次重拉
const {
  data: rot,
  loading: rotLoading,
  load: loadRotationRes,
  reload: reloadRotation,
} = useCachedResource<EtfRotationOverview>('rotation:overview', () => api.rotation.overview(), {
  ttlMs: 120_000,
});
const methodology = ref<InstanceType<typeof StrengthMethodologyDrawer>>();

// 5 态彩色标签：进攻态偏暖、回避态偏冷
const STATE_TAG: Record<EtfRotationState, 'danger' | 'warning' | 'success' | 'info'> = {
  加速: 'danger',
  上升: 'success',
  回踩: 'warning',
  过热: 'info',
  破位: 'info',
};
const rsClass = (v: number | null) => (v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');

async function loadRotation(force = false) {
  try {
    await (force ? reloadRotation() : loadRotationRes());
  } catch (e) {
    ElMessage.error(msg(e));
  }
}

const openRotKline = (it: EtfRotationItem) => kline.open(it.code, it.name);

// ===== Tab3 中线下钻：强赛道 ETF → 成分股 universe → 中线龙头选股 =====
const drill = ref<MidDrilldownResult | null>(null);
const drillLoading = ref(false);
async function runDrilldown() {
  drillLoading.value = true;
  try {
    // 默认纯量化（不调 LLM），快且省成本；如需 LLM 横排可后续加开关
    drill.value = await api.rotation.drilldown({ useLlm: false });
  } catch (e) {
    ElMessage.error(msg(e));
  } finally {
    drillLoading.value = false;
  }
}

const ACTION_LABEL: Record<EtfAction, string> = {
  buy: '买入',
  add: '加仓',
  hold: '持有/观望',
  reduce: '减仓/止盈',
  avoid: '规避',
};
const actionTag = (a: EtfAction): 'danger' | 'warning' | 'success' | 'info' =>
  a === 'buy' ? 'danger' : a === 'add' ? 'warning' : a === 'reduce' ? 'success' : 'info';

// A 股红涨绿跌
const dir = (v: number | null | undefined) => (v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');
const pct = (v: number | null | undefined) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
const fixed = (v: number | null | undefined, d = 2) => (v == null ? '—' : v.toFixed(d));
const fmtNum = (v: number | null, digits = 3) => (v == null ? '—' : v.toFixed(digits));
const fmtTrig = (t: EtfTrigger | null) => (t ? `${t.value}` : '—');
// 成交额（亿）→ 过万亿换算
const amt = (yi: number) => (yi >= 10000 ? (yi / 10000).toFixed(2) + '万亿' : yi.toFixed(0) + '亿');

const statusText = () => {
  const s = status.value;
  if (!s) return '连接中…';
  if (!s.enabled) return '模块未启用';
  return `在线 · ${s.poolSize} 只`;
};

// ===== Tab1 加载 =====
// force=true 强制拉最新（刷新按钮）；否则按缓存/TTL（初次/轮询），后台静默刷新不打扰
async function loadOverview(force = false) {
  try {
    await (force ? reloadOverview() : loadOverviewRes());
  } catch (e) {
    ElMessage.error(msg(e));
  }
}

async function loadModules() {
  try {
    modules.value = await api.etf.modules();
  } catch {
    /* 配置拉取失败时全部按默认显示，不阻塞盘面 */
  }
}

function openDrawer() {
  draft.value = Object.fromEntries(modules.value.map((m) => [m.id, m.enabled]));
  drawer.value = true;
}

async function saveModules() {
  savingModules.value = true;
  try {
    modules.value = await api.etf.updateModules({ ...draft.value });
    drawer.value = false;
    ElMessage.success('模块配置已保存');
  } catch (e) {
    ElMessage.error(msg(e));
  } finally {
    savingModules.value = false;
  }
}

// ===== Tab2 加载 =====
async function loadStatus() {
  try {
    status.value = await api.etf.status();
  } catch {
    /* 状态失败不阻断主流程 */
  }
}

async function loadPool() {
  try {
    pool.value = await api.etf.pool();
  } catch (e) {
    ElMessage.error(msg(e));
  }
}

async function loadSignals() {
  loading.value = true;
  try {
    const r = await api.etf.signals();
    signals.value = r.signals;
    asOf.value = r.asOf;
  } catch (e) {
    ElMessage.error(msg(e));
  } finally {
    loading.value = false;
  }
}

async function refreshPool() {
  await Promise.all([loadStatus(), loadPool()]);
  await loadSignals();
}

async function addPool() {
  const code = newCode.value.trim();
  if (!/^\d{6}$/.test(code)) {
    ElMessage.warning('请输入 6 位 ETF 代码');
    return;
  }
  adding.value = true;
  try {
    pool.value = await api.etf.addPool({ code, tags: newTags.value.trim() || undefined });
    newCode.value = '';
    newTags.value = '';
    ElMessage.success('已加入跟踪池');
    await Promise.all([loadStatus(), loadSignals()]);
  } catch (e) {
    ElMessage.error(msg(e));
  } finally {
    adding.value = false;
  }
}

async function removePool(item: EtfPoolItem) {
  try {
    await ElMessageBox.confirm(`从跟踪池移除 ${item.name}(${item.code})？`, '确认', {
      type: 'warning',
    });
  } catch {
    return;
  }
  try {
    pool.value = await api.etf.removePool(item.code);
    signals.value = signals.value.filter((s) => s.code !== item.code);
    await loadStatus();
    ElMessage.success('已移除');
  } catch (e) {
    ElMessage.error(msg(e));
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
onMounted(async () => {
  await Promise.all([loadStatus(), loadModules()]);
  await Promise.all([loadOverview(), refreshPool()]);
  // 交易时段静默轮询市场总览（仅当前在总览 Tab 时刷新，省请求）
  // 轮询不强刷：仅按 TTL 检查，未过期为纯内存命中（不发请求），过期则后台静默刷新一次
  timer = setInterval(() => {
    if (tab.value === 'overview') void loadOverview();
  }, 3000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-title">ETF</div>
      <div class="head-actions">
        <span class="st-chip" :class="{ live: status?.enabled }">
          <span class="dot" />
          {{ statusText() }}
        </span>
        <template v-if="tab === 'overview'">
          <el-button :icon="MagicStick" type="primary" @click="analyzeOpen = true">
            AI 综合研判
          </el-button>
          <el-button :icon="Setting" @click="openDrawer">模块管理</el-button>
          <el-button :icon="Refresh" :loading="ovLoading || ovRefreshing" @click="loadOverview(true)">刷新</el-button>
        </template>
        <template v-else-if="tab === 'pool'">
          <el-button :icon="MagicStick" type="primary" @click="analyzeOpen = true">
            AI 综合研判
          </el-button>
          <ModuleScheduleDialog module="etf" />
          <el-button :icon="Refresh" :loading="loading" @click="refreshPool">刷新信号</el-button>
        </template>
        <template v-else>
          <el-button :icon="QuestionFilled" text @click="methodology?.open('rotation')">
            方法论
          </el-button>
          <ModuleScheduleDialog module="etf" />
          <el-button :icon="Refresh" :loading="rotLoading" @click="loadRotation(true)">
            刷新轮动榜
          </el-button>
        </template>
      </div>
    </div>

    <el-tabs v-model="tab" class="etf-tabs" @tab-change="tab === 'rotation' && loadRotation()">
      <!-- ===================== Tab1 市场总览 ===================== -->
      <el-tab-pane label="ETF 市场总览" name="overview">
        <div class="page-sub">
          全市场 ETF 实时盘面（东方财富行情，红涨绿跌）
          <span v-if="ov"> · 更新 {{ dayjs(ov.asOf).format('HH:mm:ss') }}</span>
        </div>

        <!-- 首屏加载骨架（仿最终布局：统计条 + 行情条 + 双列面板） -->
        <div v-if="!ov && ovLoading" class="ov-skeleton">
          <el-skeleton animated>
            <template #template>
              <div class="sk-strip">
                <el-skeleton-item v-for="i in 5" :key="i" variant="p" class="sk-stat" />
              </div>
              <div class="sk-strip">
                <el-skeleton-item v-for="i in 4" :key="i" variant="p" class="sk-idx" />
              </div>
              <div class="grid">
                <div v-for="i in 2" :key="i" class="panel">
                  <el-skeleton-item variant="h3" style="width: 40%" />
                  <el-skeleton-item v-for="r in 5" :key="r" variant="text" style="margin-top: 12px" />
                </div>
              </div>
            </template>
          </el-skeleton>
        </div>

        <template v-else-if="ov">
          <!-- 全市场概览统计 -->
          <div v-if="enabled('overviewStat') && ov.stat" class="stat-strip">
            <div class="stat">
              <div class="stat-label">ETF 总数</div>
              <div class="stat-val num">{{ ov.stat.total }}</div>
              <div class="stat-sub num" :class="dir(ov.stat.avgPct)">
                平均 {{ pct(ov.stat.avgPct) }}
              </div>
            </div>
            <div class="stat">
              <div class="stat-label">上涨</div>
              <div class="stat-val num up">{{ ov.stat.up }}</div>
            </div>
            <div class="stat">
              <div class="stat-label">下跌</div>
              <div class="stat-val num down">{{ ov.stat.down }}</div>
            </div>
            <div class="stat">
              <div class="stat-label">平盘</div>
              <div class="stat-val num">{{ ov.stat.flat }}</div>
            </div>
            <div class="stat">
              <div class="stat-label">总成交额</div>
              <div class="stat-val num">{{ amt(ov.stat.totalAmount) }}</div>
            </div>
          </div>

          <!-- 主流宽基行情条 -->
          <div v-if="enabled('broadStrip') && ov.broad.length" class="idx-strip">
            <div
              v-for="it in ov.broad"
              :key="it.code"
              class="idx idx-clickable"
              role="button"
              tabindex="0"
              @click="openKline(it)"
              @keydown.enter="openKline(it)"
            >
              <div class="idx-name">{{ it.name }}</div>
              <div class="idx-point num" :class="dir(it.pct)">{{ fixed(it.price, 3) }}</div>
              <div class="idx-pct num" :class="dir(it.pct)">{{ pct(it.pct) }}</div>
            </div>
          </div>

          <div class="grid">
            <!-- 涨跌幅双列榜 -->
            <div v-if="enabled('changeRank')" class="panel">
              <div class="panel-head"><span class="panel-title">涨跌幅榜</span></div>
              <div class="two-col">
                <div class="col">
                  <div class="col-cap up">涨幅 TOP</div>
                  <div v-for="it in ov.gainers" :key="it.code" class="flow-row">
                    <span class="flow-name link" role="button" @click="openKline(it)"
                      >{{ it.name }}</span
                    >
                    <span class="num up">{{ pct(it.pct) }}</span>
                  </div>
                  <el-empty v-if="!ov.gainers.length" :image-size="44" description="暂无" />
                </div>
                <div class="col">
                  <div class="col-cap down">跌幅 TOP</div>
                  <div v-for="it in ov.losers" :key="it.code" class="flow-row">
                    <span class="flow-name link" role="button" @click="openKline(it)"
                      >{{ it.name }}</span
                    >
                    <span class="num down">{{ pct(it.pct) }}</span>
                  </div>
                  <el-empty v-if="!ov.losers.length" :image-size="44" description="暂无" />
                </div>
              </div>
            </div>

            <!-- 主力资金流双列 -->
            <div v-if="enabled('moneyflow')" class="panel">
              <div class="panel-head"><span class="panel-title">主力资金流</span></div>
              <div class="two-col">
                <div class="col">
                  <div class="col-cap up">净流入 TOP</div>
                  <div v-for="it in ov.inflow" :key="it.code" class="flow-row">
                    <span class="flow-name link" role="button" @click="openKline(it)"
                      >{{ it.name }}</span
                    >
                    <span class="num up">+{{ fixed(it.netInflow) }}亿</span>
                  </div>
                  <el-empty v-if="!ov.inflow.length" :image-size="44" description="暂无" />
                </div>
                <div class="col">
                  <div class="col-cap down">净流出 TOP</div>
                  <div v-for="it in ov.outflow" :key="it.code" class="flow-row">
                    <span class="flow-name link" role="button" @click="openKline(it)"
                      >{{ it.name }}</span
                    >
                    <span class="num down">{{ fixed(it.netInflow) }}亿</span>
                  </div>
                  <el-empty v-if="!ov.outflow.length" :image-size="44" description="暂无" />
                </div>
              </div>
            </div>

            <!-- 成交额榜 -->
            <div v-if="enabled('turnoverRank')" class="panel">
              <div class="panel-head"><span class="panel-title">成交额榜（流动性 TOP）</span></div>
              <el-table :data="ov.turnover" size="small" style="width: 100%" @row-click="openKline">
                <el-table-column type="index" label="#" width="44" />
                <el-table-column label="名称" min-width="120">
                  <template #default="{ row }">{{ row.name }}<span class="muted">({{ row.code }})</span></template>
                </el-table-column>
                <el-table-column label="涨幅" min-width="84" align="right">
                  <template #default="{ row }"><span class="num" :class="dir(row.pct)">{{ pct(row.pct) }}</span></template>
                </el-table-column>
                <el-table-column label="成交额" min-width="92" align="right">
                  <template #default="{ row }"><span class="num">{{ fixed(row.amount) }}亿</span></template>
                </el-table-column>
              </el-table>
            </div>

            <!-- 规模榜 -->
            <div v-if="enabled('aumRank')" class="panel">
              <div class="panel-head"><span class="panel-title">规模榜（AUM TOP）</span></div>
              <el-table :data="ov.aum" size="small" style="width: 100%" @row-click="openKline">
                <el-table-column type="index" label="#" width="44" />
                <el-table-column label="名称" min-width="120">
                  <template #default="{ row }">{{ row.name }}<span class="muted">({{ row.code }})</span></template>
                </el-table-column>
                <el-table-column label="涨幅" min-width="84" align="right">
                  <template #default="{ row }"><span class="num" :class="dir(row.pct)">{{ pct(row.pct) }}</span></template>
                </el-table-column>
                <el-table-column label="规模" min-width="92" align="right">
                  <template #default="{ row }"><span class="num">{{ fixed(row.aum) }}亿</span></template>
                </el-table-column>
              </el-table>
            </div>

            <!-- 主题赛道分类 -->
            <div v-if="enabled('themeCat')" class="panel">
              <div class="panel-head"><span class="panel-title">主题赛道分类</span></div>
              <el-table :data="ov.themes" size="small" style="width: 100%">
                <el-table-column label="赛道" min-width="120">
                  <template #default="{ row }">{{ row.name }}</template>
                </el-table-column>
                <el-table-column label="平均涨幅" min-width="90" align="right">
                  <template #default="{ row }"><span class="num" :class="dir(row.avgPct)">{{ pct(row.avgPct) }}</span></template>
                </el-table-column>
                <el-table-column label="领涨代表" min-width="150">
                  <template #default="{ row }">
                    <span v-if="row.lead">
                      {{ row.lead.name }}
                      <span class="num" :class="dir(row.lead.pct)">{{ pct(row.lead.pct) }}</span>
                    </span>
                    <span v-else class="muted">—</span>
                  </template>
                </el-table-column>
              </el-table>
            </div>
          </div>
        </template>

        <el-empty v-else description="暂无 ETF 盘面数据，点右上角刷新重试" />
      </el-tab-pane>

      <!-- ===================== Tab2 我的跟踪池 ===================== -->
      <el-tab-pane label="我的跟踪池" name="pool">
        <div class="page-sub">
          独立跟踪池，叠加估值分位、年线偏离、折溢价、动量轮动、网格水位等确定性指标生成买卖信号，仅供研判，不自动下单
        </div>

        <div class="filters">
          <el-input
            v-model="newCode"
            placeholder="ETF 代码，如 510300"
            clearable
            class="f-input"
            @keyup.enter="addPool"
          />
          <el-input v-model="newTags" placeholder="标签（可空，逗号分隔）" clearable class="f-input" />
          <el-button type="primary" :icon="Plus" :loading="adding" @click="addPool">加入跟踪池</el-button>
          <span v-if="asOf" class="muted as-of">信号更新于 {{ dayjs(asOf).format('HH:mm:ss') }}</span>
        </div>

        <div v-loading="loading && signals.length > 0" class="panel pool-panel">
          <el-table v-if="signals.length" :data="signals" size="small" row-key="code">
            <el-table-column type="expand">
              <template #default="{ row }">
                <div class="expand-box">
                  <p v-if="row.warning" class="warn">⚠️ {{ row.warning }}</p>
                  <ul class="notes">
                    <li v-for="(n, i) in row.notes" :key="i">{{ n }}</li>
                  </ul>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="标的" min-width="150" fixed>
              <template #default="{ row }">
                <span class="link" role="button" @click="kline.open(row.code, row.name)"
                  >{{ row.name }}<span class="muted">({{ row.code }})</span></span
                >
              </template>
            </el-table-column>
            <el-table-column label="现价" width="90">
              <template #default="{ row }">{{ fmtNum(row.price) }}</template>
            </el-table-column>
            <el-table-column label="涨跌" width="80">
              <template #default="{ row }">
                <span :class="dir(row.pct)">{{ pct(row.pct) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="建议" width="100">
              <template #default="{ row }">
                <el-tag :type="actionTag(row.action)" effect="dark" size="small">
                  {{ ACTION_LABEL[row.action as EtfAction] }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="估值分位" width="90">
              <template #default="{ row }">
                {{ row.pricePercentile == null ? '—' : row.pricePercentile + '%' }}
              </template>
            </el-table-column>
            <el-table-column label="年线偏离" width="90">
              <template #default="{ row }">
                <span :class="dir(row.maDeviation)">{{ pct(row.maDeviation) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="折溢价" width="90">
              <template #default="{ row }">
                <span :class="dir(row.premiumPct)">{{ pct(row.premiumPct) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="动量(排名)" width="110">
              <template #default="{ row }">
                <span v-if="row.momentum == null" class="muted">—</span>
                <span v-else :class="dir(row.momentum)">
                  {{ pct(row.momentum) }}<span v-if="row.momentumRank" class="muted"> #{{ row.momentumRank }}</span>
                </span>
              </template>
            </el-table-column>
            <el-table-column label="波动" width="80">
              <template #default="{ row }">{{ row.volatility == null ? '—' : row.volatility + '%' }}</template>
            </el-table-column>
            <el-table-column label="触发价 买/卖/损/盈" min-width="190">
              <template #default="{ row }">
                <span class="trig">
                  <span class="up">{{ fmtTrig(row.buyTrigger) }}</span> /
                  <span class="down">{{ fmtTrig(row.sellTrigger) }}</span> /
                  <span>{{ fmtTrig(row.stopLoss) }}</span> /
                  <span>{{ fmtTrig(row.takeProfit) }}</span>
                </span>
              </template>
            </el-table-column>
            <el-table-column label="网格(档/下买/上卖)" min-width="160">
              <template #default="{ row }">
                <span v-if="row.grid" class="muted">
                  {{ row.grid.level }}/{{ row.grid.gridCount }}（{{ row.grid.stepPct }}%）
                  <span class="up">{{ row.grid.nextBuy ?? '—' }}</span> /
                  <span class="down">{{ row.grid.nextSell ?? '—' }}</span>
                </span>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="70" fixed="right">
              <template #default="{ row }">
                <el-button
                  :icon="Delete"
                  size="small"
                  text
                  type="danger"
                  @click="removePool({ code: row.code, name: row.name } as EtfPoolItem)"
                />
              </template>
            </el-table-column>
          </el-table>
          <div v-else-if="loading" class="pool-loading">
            <el-skeleton :rows="8" animated />
            <p class="pool-loading-tip">正在为 {{ status?.poolSize ?? '' }} 只 ETF 计算信号，标的较多时需要数秒…</p>
          </div>
          <el-empty v-else description="跟踪池为空，添加 ETF 后刷新信号" />
        </div>
      </el-tab-pane>

      <!-- ===================== Tab3 行业轮动 ===================== -->
      <el-tab-pane label="行业轮动" name="rotation" lazy>
        <div class="page-sub">
          中线赛道层：跟踪池 + 主题赛道代表 ETF 的相对强弱(RS)/趋势/资金流确定性轮动榜 + 5 态，仅供研判，不自动下单
          <span v-if="rot"> · 更新 {{ dayjs(rot.asOf).format('HH:mm:ss') }}</span>
        </div>

        <!-- agent 过滤结论（复用板块研判范式，指向 rotation API） -->
        <BoardReviewConclusion source="rotation" />

        <div v-loading="rotLoading" class="panel rot-panel">
          <el-table v-if="rot && rot.items.length" :data="rot.items" size="small" @row-click="openRotKline">
            <el-table-column type="index" label="#" width="44" />
            <el-table-column label="ETF" min-width="170">
              <template #default="{ row }">
                <span class="link">{{ row.name }}<span class="muted">({{ row.code }})</span></span>
                <span v-if="row.track" class="muted track">[{{ row.track }}]</span>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="80">
              <template #default="{ row }">
                <el-tag :type="STATE_TAG[row.state as EtfRotationState]" effect="dark" size="small">
                  {{ row.state }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="强度" width="120">
              <template #default="{ row }">
                <ScoreBreakdownPopover
                  :title="`${row.name} 轮动强度构成`"
                  :parts="row.breakdown.parts"
                  :total="row.breakdown.total"
                >
                  <span class="num strength">{{ row.score }}</span>
                </ScoreBreakdownPopover>
              </template>
            </el-table-column>
            <el-table-column label="RS(对300)" width="100" align="right">
              <template #default="{ row }">
                <span class="num" :class="rsClass(row.rs)">
                  {{ row.rs == null ? '—' : `${row.rs >= 0 ? '+' : ''}${row.rs}%` }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="20/60/120日" min-width="150" align="right">
              <template #default="{ row }">
                <span class="num small">
                  <span :class="dir(row.ret20)">{{ pct(row.ret20) }}</span> /
                  <span :class="dir(row.ret60)">{{ pct(row.ret60) }}</span> /
                  <span :class="dir(row.ret120)">{{ pct(row.ret120) }}</span>
                </span>
              </template>
            </el-table-column>
            <el-table-column label="年线偏离" width="92" align="right">
              <template #default="{ row }">
                <span class="num" :class="dir(row.maDeviation)">{{ pct(row.maDeviation) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="分位" width="72" align="right">
              <template #default="{ row }">
                {{ row.pricePercentile == null ? '—' : row.pricePercentile + '%' }}
              </template>
            </el-table-column>
            <el-table-column label="折溢价" width="84" align="right">
              <template #default="{ row }">
                <span class="num" :class="dir(row.premiumPct)">{{ pct(row.premiumPct) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="周线" width="80" align="center">
              <template #default="{ row }">
                <span v-if="row.weekMaTrend === true" class="up">多头</span>
                <span v-else-if="row.weekMaTrend === false" class="muted">未多头</span>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
            <el-table-column label="净流入" width="92" align="right">
              <template #default="{ row }">
                <span v-if="row.flowNetIn == null" class="muted">—</span>
                <span v-else class="num" :class="rsClass(row.flowNetIn)">{{ fixed(row.flowNetIn) }}亿</span>
              </template>
            </el-table-column>
            <el-table-column label="研判" min-width="240">
              <template #default="{ row }"><span class="muted note">{{ row.note }}</span></template>
            </el-table-column>
          </el-table>
          <el-empty v-else-if="!rotLoading" description="暂无轮动数据，点右上角刷新轮动榜重试" />
        </div>

        <!-- M2 中线下钻：强赛道 ETF → 成分股 universe → 中线龙头选股 -->
        <div class="panel drill-panel" v-loading="drillLoading">
          <div class="drill-head">
            <div>
              <span class="drill-title">中线下钻</span>
              <span class="drill-sub">
                取轮动榜「上升/加速 + RS 为正」的强赛道 ETF，合并其成分股为 universe，在其中跑中线龙头选股（纯量化）
              </span>
            </div>
            <el-button type="primary" :loading="drillLoading" @click="runDrilldown">
              {{ drill ? '重新下钻' : '开始下钻' }}
            </el-button>
          </div>

          <template v-if="drill">
            <div class="drill-flow">
              <span class="flow-step">
                强赛道 ETF <b>{{ drill.strongEtfs.length }}</b> 个
              </span>
              <span class="flow-arrow">→</span>
              <span class="flow-step">
                合并 universe <b>{{ drill.universeSize }}</b> 只
              </span>
              <span class="flow-arrow">→</span>
              <span class="flow-step">
                中线龙头 <b>{{ drill.run?.picks.length ?? 0 }}</b> 只
              </span>
              <span class="drill-asof muted">{{ dayjs(drill.asOf).format('MM-DD HH:mm') }}</span>
            </div>

            <div v-if="drill.strongEtfs.length" class="drill-etfs">
              <el-tag
                v-for="e in drill.strongEtfs"
                :key="e.code"
                :type="STATE_TAG[e.state]"
                effect="plain"
                class="drill-etf-tag"
                @click="kline.open(e.code, e.name)"
              >
                {{ e.name }}
                <span v-if="e.track" class="muted">[{{ e.track }}]</span>
                · 强度{{ e.score }} · 成分{{ e.constituentCount }}
              </el-tag>
            </div>

            <el-table
              v-if="drill.run && drill.run.picks.length"
              :data="drill.run.picks"
              size="small"
              class="drill-picks"
            >
              <el-table-column label="#" width="44">
                <template #default="{ row }">{{ row.rank }}</template>
              </el-table-column>
              <el-table-column label="个股" min-width="160">
                <template #default="{ row }">
                  <span class="link" @click="kline.open(row.code, row.name)">
                    {{ row.name }}<span class="muted">({{ row.code }})</span>
                  </span>
                  <span v-if="row.industry" class="muted track">[{{ row.industry }}]</span>
                </template>
              </el-table-column>
              <el-table-column label="选股分" width="84" align="right">
                <template #default="{ row }"><span class="num strength">{{ row.screenScore }}</span></template>
              </el-table-column>
              <el-table-column label="现价" width="84" align="right">
                <template #default="{ row }"><span class="num">{{ fixed(row.price) }}</span></template>
              </el-table-column>
              <el-table-column label="涨跌" width="84" align="right">
                <template #default="{ row }"><span class="num" :class="dir(row.pct)">{{ pct(row.pct) }}</span></template>
              </el-table-column>
              <el-table-column label="逻辑/风险" min-width="220">
                <template #default="{ row }">
                  <span v-if="row.thesis" class="muted note">{{ row.thesis }}</span>
                  <span v-for="t in row.riskTags" :key="t" class="risk-tag">{{ t }}</span>
                </template>
              </el-table-column>
            </el-table>

            <div class="drill-note muted">{{ drill.note }}</div>
          </template>
          <el-empty
            v-else-if="!drillLoading"
            description="点「开始下钻」从强赛道 ETF 钻取中线龙头个股"
            :image-size="60"
          />
        </div>
      </el-tab-pane>
    </el-tabs>

    <StrengthMethodologyDrawer ref="methodology" />

    <!-- 模块管理抽屉 -->
    <el-drawer v-model="drawer" title="模块管理" size="320px">
      <div class="mod-list">
        <div v-for="m in modules" :key="m.id" class="mod-row">
          <span>{{ m.label }}</span>
          <el-switch v-model="draft[m.id]" />
        </div>
      </div>
      <template #footer>
        <el-button @click="drawer = false">取消</el-button>
        <el-button type="primary" :loading="savingModules" @click="saveModules">保存</el-button>
      </template>
    </el-drawer>

    <!-- 统一 AI 分析弹窗（ETF 综合研判） -->
    <AiAnalysisDialog v-model="analyzeOpen" kind="etf-analyze" title="ETF 综合研判" />
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
/* 全局 .page-sub 默认 margin-top:-12px 是为贴在 page-head 下；本页在 el-tabs 内，
   负边距会把说明文案顶到 tab 栏下方被遮挡，这里覆盖为正常间距 */
.page-sub {
  margin-top: 4px;
}
/* 状态徽标（与研报/盯盘页一致，此前缺失导致裸文本显示） */
.st-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-1);
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  white-space: nowrap;
}
.st-chip .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-2);
}
.st-chip.live .dot {
  background: var(--down);
  box-shadow: 0 0 8px var(--down);
}
/* 首屏加载骨架 */
.ov-skeleton {
  margin-top: 4px;
}
.sk-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
  margin-bottom: 14px;
}
.sk-stat {
  height: 64px;
  border-radius: var(--radius);
}
.sk-idx {
  height: 72px;
  border-radius: var(--radius);
}
/* 跟踪池加载：保证容器有高度，避免 spinner 贴在塌陷的细条上 */
.pool-panel {
  min-height: 160px;
}
.pool-loading {
  padding: 4px 2px;
}
.pool-loading-tip {
  margin: 14px 0 2px;
  font-size: 12.5px;
  color: var(--text-2);
  text-align: center;
}
/* ===== 市场总览（复用大盘页样式） ===== */
.idx-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin-bottom: 14px;
}
.idx {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 16px;
}
.idx-clickable {
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.idx-clickable:hover {
  border-color: var(--brand);
  background: var(--bg-hover);
}
.idx-name {
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 6px;
}
.idx-point {
  font-size: 20px;
  font-weight: 600;
}
.idx-pct {
  font-size: 13px;
  margin-top: 2px;
}
.stat-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 12px;
  margin-bottom: 18px;
}
.stat {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 14px;
}
.stat-label {
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 4px;
}
.stat-val {
  font-size: 22px;
  font-weight: 600;
}
.stat-sub {
  font-size: 12px;
  margin-top: 2px;
  color: var(--text-2);
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.panel {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.panel-title {
  font-weight: 600;
}
.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.col-cap {
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 6px;
}
.flow-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;
}
.flow-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.link {
  cursor: pointer;
  color: var(--brand);
}
.link:hover {
  text-decoration: underline;
}
.mod-list {
  display: flex;
  flex-direction: column;
}
.mod-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 4px;
  border-bottom: 1px solid var(--border);
}
@media (max-width: 900px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
/* ===== 跟踪池 ===== */
.filters {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 12px 0;
  flex-wrap: wrap;
}
.f-input {
  width: 220px;
}
.as-of {
  margin-left: auto;
  font-size: 12px;
}
.muted {
  color: var(--text-2);
}
.up {
  color: #e54d42;
}
.down {
  color: #15a05a;
}
.trig {
  font-variant-numeric: tabular-nums;
}
.expand-box {
  padding: 6px 24px;
}
.expand-box .warn {
  color: var(--el-color-warning);
  margin: 0 0 6px;
}
.notes {
  margin: 0;
  padding-left: 18px;
  color: var(--el-text-color-regular);
}
.notes li {
  line-height: 1.7;
}
/* ===== 中线下钻 ===== */
.drill-panel {
  margin-top: 14px;
}
.drill-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.drill-title {
  font-weight: 600;
  margin-right: 8px;
}
.drill-sub {
  font-size: 12.5px;
  color: var(--text-2);
}
.drill-flow {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 12px;
  margin-bottom: 12px;
  font-size: 13px;
}
.flow-step b {
  color: var(--brand);
  font-size: 15px;
  padding: 0 2px;
}
.flow-arrow {
  color: var(--text-2);
}
.drill-asof {
  margin-left: auto;
  font-size: 12px;
}
.drill-etfs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}
.drill-etf-tag {
  cursor: pointer;
}
.drill-picks {
  margin-bottom: 10px;
}
.risk-tag {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  font-size: 11.5px;
  color: var(--el-color-warning);
  border: 1px solid var(--el-color-warning);
  border-radius: 4px;
}
.drill-note {
  font-size: 12.5px;
}
</style>
