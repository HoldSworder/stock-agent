<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import dayjs from 'dayjs';
import { useRouter } from 'vue-router';
import { Refresh } from '@element-plus/icons-vue';
import { api } from '@/api';
import EChart from '@/components/EChart.vue';
import StockLink from '@/components/StockLink.vue';
import { STAGE_ACTION_LABEL, STAGE_LABEL } from '@/constants/boardTags';
import type {
  CockpitPanorama,
  CockpitPanoramaLive,
  PanoramaBlock,
  PlanItemStatus,
} from '@stock-agent/shared';

// 今日全景：驾驶舱的结论层，按「能不能做 → 做什么 → 该动谁 → 系统状态」四层排布，
// 目标是把散在十几个页面的结论收到一屏，其余页面只作下钻。
//
// 两段加载：秒开层纯本地读取先出首屏，实时层（账户/纪律/ETF轮动/涨停梯队）需外部取数，
// 并行请求、到达后补位。结论带的持仓与仓位口径由实时层填充，未到达时显示「加载中」而非空白。

const router = useRouter();
const data = ref<CockpitPanorama | null>(null);
const live = ref<CockpitPanoramaLive | null>(null);
const loading = ref(false);
const liveLoading = ref(false);
const liveError = ref('');
/** 秒开层取数失败原因（空串=正常）；显式呈现，避免整块面板静默消失让人误以为功能下线 */
const loadError = ref('');

/** 第4层默认折叠；展开态记 localStorage，避免每次进来都要重新展开 */
const SYS_KEY = 'panorama:sysOpen';
const sysOpen = ref(localStorage.getItem(SYS_KEY) === '1');
function toggleSys(): void {
  sysOpen.value = !sysOpen.value;
  localStorage.setItem(SYS_KEY, sysOpen.value ? '1' : '0');
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    data.value = await api.cockpit.panorama();
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
  // 实时层独立于秒开层：秒开层失败也要照常发起，两层互不阻塞
  void loadLive();
}

async function loadLive(): Promise<void> {
  liveLoading.value = true;
  liveError.value = '';
  try {
    live.value = await api.cockpit.panoramaLive();
  } catch (e) {
    liveError.value = e instanceof Error ? e.message : String(e);
  } finally {
    liveLoading.value = false;
  }
}

onMounted(load);

const hasData = <T,>(b: PanoramaBlock<T> | undefined): boolean => !!b && b.status === 'ok' && !!b.data;

const trend = computed(() => data.value?.sentimentTrend.data ?? []);
const equity = computed(() => data.value?.equity.data ?? []);

const PLAN_STATUS_LABEL: Record<PlanItemStatus, string> = {
  pending: '待触发',
  triggered: '已触发',
  done: '已完成',
  invalid: '已失效',
};
const DIRECTION_LABEL: Record<string, string> = {
  buy: '买入',
  add: '加仓',
  hold: '持有',
  reduce: '减仓',
  sell: '卖出',
};
const DISC_LABEL: Record<string, string> = {
  stop_loss: '破止损',
  near_stop: '近止损',
  take_profit: '达止盈',
  over_hold: '超期',
  overweight: '超配',
  stop_not_executed: '止损未执行',
  healthy: '健康',
};

function go(path: string, query?: Record<string, string>): void {
  void router.push({ path, query });
}

// 图一：情绪与大盘强度逐日曲线，hover 读当日涨跌停 / 炸板 / 红绿家数
const trendOption = computed(() => ({
  grid: { left: 40, right: 16, top: 28, bottom: 24 },
  legend: { data: ['情绪指数', '大盘强度'], top: 0, textStyle: { fontSize: 11 } },
  tooltip: {
    trigger: 'axis',
    formatter: (params: Array<{ dataIndex: number }>) => {
      const p = trend.value[params[0]?.dataIndex ?? 0];
      if (!p) return '';
      const line = (k: string, v: number | null, unit = '') =>
        v == null ? '' : `<div>${k}：<b>${v}${unit}</b></div>`;
      return (
        `<div style="font-weight:600">${p.date}${p.phase ? ` · ${p.phase}` : ''}</div>` +
        line('情绪指数', p.sentiment) +
        line('大盘强度', p.regimeScore) +
        line('涨停', p.limitUp, ' 家') +
        line('跌停', p.limitDown, ' 家') +
        line('炸板率', p.brokenRate, '%') +
        line('上涨', p.advancers, ' 家') +
        line('下跌', p.decliners, ' 家')
      );
    },
  },
  xAxis: {
    type: 'category',
    data: trend.value.map((p) => p.date.slice(5)),
    axisLabel: { fontSize: 10 },
  },
  yAxis: { type: 'value', min: 0, max: 100, axisLabel: { fontSize: 10 } },
  series: [
    {
      name: '情绪指数',
      type: 'line',
      smooth: true,
      showSymbol: false,
      data: trend.value.map((p) => p.sentiment),
      lineStyle: { width: 2 },
      areaStyle: { opacity: 0.12 },
    },
    {
      name: '大盘强度',
      type: 'line',
      smooth: true,
      showSymbol: false,
      data: trend.value.map((p) => p.regimeScore),
      lineStyle: { width: 2, type: 'dashed' },
    },
  ],
}));

// 图三：账户净值曲线
const equityOption = computed(() => ({
  grid: { left: 46, right: 16, top: 16, bottom: 24 },
  tooltip: { trigger: 'axis', valueFormatter: (v: number) => v.toFixed(4) },
  xAxis: {
    type: 'category',
    data: equity.value.map((p) => p.date.slice(5)),
    axisLabel: { fontSize: 10 },
  },
  yAxis: { type: 'value', scale: true, axisLabel: { fontSize: 10 } },
  series: [
    {
      name: '净值',
      type: 'line',
      smooth: true,
      showSymbol: false,
      data: equity.value.map((p) => p.nav),
      lineStyle: { width: 2 },
      areaStyle: { opacity: 0.12 },
    },
  ],
}));

/** 日历热力：按周分列，最近 10 周 */
const calendar = computed(() => {
  const pts = equity.value.slice(-70);
  const weeks: Array<Array<{ date: string; dayPct: number } | null>> = [];
  let cur: Array<{ date: string; dayPct: number } | null> = [];
  for (const p of pts) {
    const dow = dayjs(p.date).day();
    if (cur.length === 0 && dow > 1) for (let i = 1; i < dow; i += 1) cur.push(null);
    cur.push({ date: p.date, dayPct: p.dayPct });
    if (dow === 5 || cur.length === 5) {
      weeks.push(cur);
      cur = [];
    }
  }
  if (cur.length) weeks.push(cur);
  return weeks;
});

function heatClass(v: number): string {
  const a = Math.abs(v);
  const lvl = a >= 2 ? 3 : a >= 0.8 ? 2 : a > 0 ? 1 : 0;
  if (lvl === 0) return 'h0';
  return `${v > 0 ? 'up' : 'down'}${lvl}`;
}

const dir = (v: number): string => (v > 0 ? 'up' : v < 0 ? 'down' : '');

defineExpose({ reload: load });
</script>

<template>
  <section class="panorama" v-loading="loading">
    <div class="pa-head">
      <span class="pa-title">今日全景</span>
      <span class="pa-sub">
        各页结论都汇总在这里，明细点「查看 →」展开
        <template v-if="liveLoading">· 实时数据加载中…</template>
        <template v-else-if="liveError">· 实时层失败：{{ liveError }}</template>
      </span>
      <span v-if="data" class="pa-asof">{{ dayjs(data.asOf).format('MM-DD HH:mm:ss') }}</span>
      <el-button :icon="Refresh" size="small" :loading="loading || liveLoading" @click="load">
        刷新
      </el-button>
    </div>

    <div v-if="loadError" class="pa-fail">
      ⚠ 今日全景取数失败：{{ loadError }}（数据未到，不是功能下线）
    </div>

    <!-- ===== 第 0 层 结论带 ===== -->
    <div v-if="data" class="verdict-bar">
      <div class="vb-cell">
        <div class="vb-cap">能不能做</div>
        <template v-if="hasData(data.canTrade)">
          <div class="vb-main">
            {{ data.canTrade.data!.phase ?? '阶段未知' }}
            <span class="vb-num">{{ data.canTrade.data!.score ?? '—' }}</span>
            <span v-if="live && hasData(live.account)" class="vb-sub num">
              仓位 {{ live.account.data!.positionPct }}% / 上限
              {{ data.canTrade.data!.totalMaxPositionPct }}%
            </span>
            <span v-else class="vb-sub muted">仓位加载中…</span>
          </div>
          <div class="vb-note">{{ data.canTrade.data!.conclusion }}</div>
        </template>
        <div v-else class="vb-fail">{{ data.canTrade.note }}</div>
      </div>
      <div class="vb-cell">
        <div class="vb-cap">做什么</div>
        <template v-if="hasData(data.focus)">
          <div class="vb-main">
            {{ data.focus.data!.board }}
            <span v-if="data.focus.data!.action" class="vb-act">
              {{ STAGE_ACTION_LABEL[data.focus.data!.action] }}
            </span>
          </div>
          <div class="vb-note">{{ data.focus.data!.conclusion }}</div>
        </template>
        <div v-else class="vb-fail">{{ data.focus.note }}</div>
      </div>
      <div class="vb-cell">
        <div class="vb-cap">该动谁</div>
        <div class="vb-main">
          <template v-if="live && hasData(live.discipline)">
            <span class="vb-num" :class="{ alert: live.discipline.data!.items.length > 0 }">
              {{ live.discipline.data!.items.length }}
            </span>
            笔持仓 ·
          </template>
          <span v-else class="vb-sub muted">持仓加载中 ·</span>
          <span class="vb-num">{{ data.todo.data?.planPending ?? 0 }}</span> 个计划待触发
        </div>
        <div class="vb-note">
          <template v-if="live && hasData(live.discipline)">
            止损 {{ live.discipline.data!.stopLoss }} · 止盈 {{ live.discipline.data!.takeProfit }} ·
            超配 {{ live.discipline.data!.overweight }} · 止损未执行
            {{ live.discipline.data!.stopNotExecuted }}
          </template>
          <template v-else-if="live && live.discipline.status !== 'ok'">
            {{ live.discipline.note }}
          </template>
          <template v-else>{{ data.todo.note || data.todo.data?.conclusion }}</template>
        </div>
      </div>
    </div>

    <template v-if="data">
      <!-- ===== 第 1 层 今天能不能做 ===== -->
      <div class="layer-h"><span class="lh-tag">1</span>今天能不能做</div>
      <div class="market-bar">
        <div class="mb-cell">
          <span class="mb-cap">情绪</span>
          <template v-if="hasData(data.sentimentNow)">
            <span class="mb-v num">{{ data.sentimentNow.data!.index }}</span>
            <span class="mb-x">{{ data.sentimentNow.data!.level }} · {{ data.sentimentNow.data!.phase }}</span>
            <span
              v-if="data.sentimentNow.data!.delta != null"
              class="mb-d num"
              :class="dir(data.sentimentNow.data!.delta!)"
            >
              {{ data.sentimentNow.data!.delta! > 0 ? '+' : '' }}{{ data.sentimentNow.data!.delta }}
            </span>
            <span class="mb-advice">{{ data.sentimentNow.data!.advice }}</span>
          </template>
          <span v-else class="mb-fail">{{ data.sentimentNow.note }}</span>
        </div>
        <div class="mb-cell">
          <span class="mb-cap">涨停梯队</span>
          <template v-if="live && hasData(live.dragon)">
            <span class="mb-v num">{{ live.dragon.data!.maxStreak }}</span>
            <span class="mb-x">板高</span>
            <span class="mb-v num">{{ live.dragon.data!.limitUpCount }}</span>
            <span class="mb-x">涨停</span>
            <span class="mb-v num">{{ live.dragon.data!.brokenRate }}%</span>
            <span class="mb-x">炸板</span>
            <span v-if="live.dragon.data!.topDragon" class="mb-advice">
              总龙头 {{ live.dragon.data!.topDragon }}
            </span>
          </template>
          <span v-else-if="live" class="mb-fail">{{ live.dragon.note }}</span>
          <span v-else class="mb-x muted">加载中…</span>
        </div>
      </div>

      <!-- ===== 第 2 层 做什么 ===== -->
      <div class="layer-h"><span class="lh-tag">2</span>做什么</div>
      <div class="pa-grid">
        <!-- ETF 轮动榜（核心打法的赛道层） -->
        <div class="pa-card">
          <div class="pc-h">
            ETF 轮动榜
            <el-button link type="primary" class="pc-more" @click="go('/etf')">查看 →</el-button>
          </div>
          <div v-if="live && hasData(live.rotation)" class="rot-list">
            <div v-if="!live.rotation.data!.length" class="pc-loading">暂无在榜 ETF</div>
            <div v-for="r in live.rotation.data!" :key="r.code" class="rot-row">
              <StockLink :code="r.code" :name="r.name" class="rot-name" />
              <span class="rot-state">{{ r.state }}</span>
              <span v-if="r.track" class="rot-track">{{ r.track }}</span>
              <span class="rot-num num">强度 {{ r.score }}</span>
              <span v-if="r.rs != null" class="rot-num num" :class="dir(r.rs)">RS {{ r.rs }}</span>
            </div>
          </div>
          <div v-else-if="live" class="pc-fail">{{ live.rotation.note }}</div>
          <div v-else class="pc-loading">加载中…</div>
        </div>

        <!-- 今日计划操作清单 -->
        <div class="pa-card">
          <div class="pc-h">
            今日计划操作
            <el-button link type="primary" class="pc-more" @click="go('/plan')">查看 →</el-button>
          </div>
          <div v-if="hasData(data.planActions)" class="plan-list">
            <div v-for="p in data.planActions.data!" :key="p.code" class="plan-row">
              <span class="pl-dir" :class="p.direction">{{ DIRECTION_LABEL[p.direction] ?? p.direction }}</span>
              <StockLink :code="p.code" :name="p.name" class="pl-name" />
              <span class="pl-trigger num">{{ p.trigger }}</span>
              <span class="pl-status" :class="p.status">{{ PLAN_STATUS_LABEL[p.status] }}</span>
              <span v-if="p.confidence != null" class="pl-conf num">信心{{ p.confidence }}</span>
            </div>
          </div>
          <div v-else class="pc-fail">{{ data.planActions.note }}</div>
        </div>

        <!-- 主线生命周期泳道 -->
        <div class="pa-card span2">
          <div class="pc-h">
            主线生命周期（阶段决定可做动作，只收紧不放大）
            <el-button link type="primary" class="pc-more" @click="go('/market', { tab: 'board' })">
              查看 →
            </el-button>
          </div>
          <div v-if="hasData(data.lanes)" class="lanes">
            <div v-for="l in data.lanes.data!" :key="l.stage" class="lane" :class="`st-${l.stage}`">
              <div class="lane-h">
                <span class="lane-stage">{{ STAGE_LABEL[l.stage] }}</span>
                <span class="lane-act">{{ STAGE_ACTION_LABEL[l.action] }}</span>
              </div>
              <div v-if="!l.items.length" class="lane-empty">—</div>
              <div v-for="it in l.items.slice(0, 5)" :key="it.boardCode" class="lane-item">
                <span class="li-board">{{ it.board }}</span>
                <span class="li-num">{{ it.newHighCount }}</span>
              </div>
            </div>
          </div>
          <div v-else class="pc-fail">{{ data.lanes.note }}</div>
        </div>
      </div>

      <!-- ===== 第 3 层 该动谁 ===== -->
      <div class="layer-h"><span class="lh-tag">3</span>该动谁</div>
      <div class="pa-grid">
        <!-- 账户 + 纪律 -->
        <div class="pa-card">
          <div class="pc-h">
            账户与纪律
            <el-button link type="primary" class="pc-more" @click="go('/positions')">查看 →</el-button>
          </div>
          <div v-if="live && hasData(live.account)" class="acct">
            <div class="ac-item">
              <span class="ac-v num">{{ (live.account.data!.totalAsset / 10000).toFixed(1) }}万</span>
              <span class="ac-k">总资产</span>
            </div>
            <div class="ac-item">
              <span class="ac-v num">{{ (live.account.data!.cash / 10000).toFixed(1) }}万</span>
              <span class="ac-k">现金</span>
            </div>
            <div class="ac-item">
              <span class="ac-v num">{{ live.account.data!.positionPct }}%</span>
              <span class="ac-k">仓位</span>
            </div>
            <div class="ac-item">
              <span class="ac-v num" :class="dir(live.account.data!.todayRate)">
                {{ live.account.data!.todayRate > 0 ? '+' : '' }}{{ live.account.data!.todayRate }}%
              </span>
              <span class="ac-k">今日</span>
            </div>
          </div>
          <div v-else-if="live" class="pc-fail">{{ live.account.note }}</div>
          <div v-else class="pc-loading">加载中…</div>

          <div v-if="live && hasData(live.discipline)" class="disc">
            <div v-if="live.discipline.data!.warnings.length" class="disc-warn">
              ⚠ {{ live.discipline.data!.warnings.join('；') }}
            </div>
            <div v-if="!live.discipline.data!.items.length" class="disc-ok">
              逐票纪律健康，无需处理
            </div>
            <div v-for="i in live.discipline.data!.items" :key="i.code" class="disc-row">
              <span class="dr-tag" :class="i.status">{{ DISC_LABEL[i.status] ?? i.status }}</span>
              <StockLink :code="i.code" :name="i.name" class="dr-name" />
              <span class="dr-action">{{ i.action }}</span>
            </div>
          </div>
        </div>

        <!-- ETF 多周期盯盘 -->
        <div class="pa-card">
          <div class="pc-h">
            ETF 多周期盯盘
            <el-button link type="primary" class="pc-more" @click="go('/etf-watch')">查看 →</el-button>
          </div>
          <template v-if="hasData(data.etfWatch)">
            <div class="ew-meta">
              <span :class="data.etfWatch.data!.running ? 'on' : 'off'">
                {{ data.etfWatch.data!.running ? '引擎运行中' : '引擎未运行' }}
              </span>
              <span class="num">今日告警 {{ data.etfWatch.data!.alertsToday }} 条</span>
            </div>
            <div v-if="!data.etfWatch.data!.items.length" class="pc-loading">暂无持层标的</div>
            <div v-for="e in data.etfWatch.data!.items" :key="e.code" class="ew-row">
              <StockLink :code="e.code" :name="e.name" class="ew-name" />
              <span class="ew-layers num">L{{ e.heldLayers.join('/') || '—' }}</span>
              <span v-if="e.trendStage" class="ew-stage">{{ e.trendStage }}</span>
              <span v-if="e.lastAction" class="ew-act">{{ e.lastAction }}</span>
            </div>
          </template>
          <div v-else class="pc-fail">{{ data.etfWatch.note }}</div>
        </div>

        <!-- 个股盯盘 -->
        <div class="pa-card span2">
          <div class="pc-h">
            个股盯盘告警
            <el-button link type="primary" class="pc-more" @click="go('/watch')">查看 →</el-button>
          </div>
          <template v-if="hasData(data.stockWatch)">
            <div class="ew-meta">
              <span :class="data.stockWatch.data!.running ? 'on' : 'off'">
                {{ data.stockWatch.data!.running ? '引擎运行中' : '引擎未运行' }}
              </span>
              <span class="num">今日告警 {{ data.stockWatch.data!.alertsToday }} 条</span>
              <span class="num">上轮命中 {{ data.stockWatch.data!.lastSignalCount }}</span>
            </div>
            <div v-if="!data.stockWatch.data!.alerts.length" class="pc-loading">今日无需提醒的告警</div>
            <div v-for="a in data.stockWatch.data!.alerts" :key="a.code + a.at" class="sw-row">
              <span class="sw-sev" :class="a.severity">{{ a.severity }}</span>
              <StockLink :code="a.code" :name="a.name" class="sw-name" />
              <span class="sw-advice">{{ a.advice }}</span>
              <span class="sw-time num">{{ dayjs(a.at).format('HH:mm') }}</span>
            </div>
          </template>
          <div v-else class="pc-fail">{{ data.stockWatch.note }}</div>
        </div>
      </div>

      <!-- ===== 第 4 层 系统与产出（默认折叠）===== -->
      <div class="layer-h clickable" @click="toggleSys">
        <span class="lh-tag">4</span>系统与产出
        <span class="lh-toggle">{{ sysOpen ? '收起 ▲' : '展开 ▼' }}</span>
      </div>
      <div v-if="sysOpen" class="pa-grid">
        <div class="pa-card">
          <div class="pc-h">账户净值与逐日盈亏</div>
          <template v-if="hasData(data.equity) && equity.length">
            <EChart :option="equityOption" height="160px" />
            <div class="cal">
              <div v-for="(w, wi) in calendar" :key="wi" class="cal-week">
                <span
                  v-for="(d, di) in w"
                  :key="di"
                  class="cal-cell"
                  :class="d ? heatClass(d.dayPct) : 'h0'"
                  :title="d ? `${d.date}  ${d.dayPct > 0 ? '+' : ''}${d.dayPct}%` : ''"
                />
              </div>
            </div>
          </template>
          <div v-else class="pc-fail">{{ data.equity.note || '暂无数据' }}</div>
        </div>

        <div class="pa-card">
          <div class="pc-h">情绪与大盘强度（近 {{ trend.length }} 个交易日）</div>
          <EChart v-if="hasData(data.sentimentTrend) && trend.length" :option="trendOption" height="200px" />
          <div v-else class="pc-fail">{{ data.sentimentTrend.note || '暂无数据' }}</div>
        </div>

        <div class="pa-card span2">
          <div class="pc-h">系统健康</div>
          <div v-if="hasData(data.health)" class="health">
            <div v-for="c in data.health.data!" :key="c.key" class="hc" :class="c.status">
              <span class="hc-dot" />
              <span class="hc-label">{{ c.label }}</span>
              <span class="hc-detail">{{ c.detail }}</span>
            </div>
          </div>
          <div v-else class="pc-fail">{{ data.health.note || '暂无数据' }}</div>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.panorama {
  margin-bottom: 16px;
}
.pa-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;
}
.pa-title {
  font-size: 15px;
  font-weight: 600;
}
.pa-sub {
  flex: 1;
  font-size: 12px;
  color: var(--text-2);
}
.pa-fail {
  font-size: 12.5px;
  color: #e6a23c;
  line-height: 1.6;
  margin-bottom: 10px;
}
.pa-asof {
  font-size: 11.5px;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.num {
  font-variant-numeric: tabular-nums;
}
.muted {
  color: var(--text-2);
}
.up {
  color: #f56c6c;
}
.down {
  color: #4eb61b;
}

/* 结论带 */
.verdict-bar {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-bottom: 14px;
}
.vb-cell {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
}
.vb-cap {
  font-size: 11px;
  letter-spacing: 0.1em;
  color: var(--text-2);
  margin-bottom: 6px;
}
.vb-main {
  font-size: 17px;
  font-weight: 600;
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
}
.vb-num.alert {
  color: #f56c6c;
}
.vb-sub {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-2);
}
.vb-act {
  font-size: 12px;
  font-weight: 600;
  color: #e6a23c;
  border: 1px solid currentColor;
  border-radius: 3px;
  padding: 0 5px;
}
.vb-note {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.5;
}
.vb-fail {
  font-size: 12.5px;
  color: #e6a23c;
  line-height: 1.5;
}

/* 层标题 */
.layer-h {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
  margin: 14px 0 8px;
}
.layer-h.clickable {
  cursor: pointer;
  user-select: none;
}
.lh-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  background: var(--bg-3, #2a2a2a);
  font-size: 10px;
}
.lh-toggle {
  margin-left: auto;
  font-weight: 400;
  font-size: 11.5px;
}

/* 第1层 市场条 */
.market-bar {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.mb-cell {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12px;
}
.mb-cap {
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--text-2);
  margin-right: 2px;
}
.mb-v {
  font-size: 16px;
  font-weight: 600;
}
.mb-x {
  color: var(--text-2);
}
.mb-advice {
  flex: 1 1 100%;
  color: var(--text-2);
  line-height: 1.5;
}
.mb-fail {
  color: #e6a23c;
}

/* 卡片网格 */
.pa-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.pa-card {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
}
.pa-card.span2 {
  grid-column: span 2;
}
.pc-h {
  display: flex;
  align-items: baseline;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}
.pc-more {
  margin-left: auto;
  font-size: 12px;
  font-weight: 400;
}
.pc-fail {
  font-size: 12.5px;
  color: #e6a23c;
  padding: 12px 0;
  line-height: 1.6;
}
.pc-loading {
  font-size: 12.5px;
  color: var(--text-2);
  padding: 12px 0;
}

/* ETF 轮动 */
.rot-list,
.plan-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rot-row,
.plan-row,
.disc-row,
.ew-row,
.sw-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
}
.rot-name,
.pl-name,
.dr-name,
.ew-name,
.sw-name {
  font-weight: 600;
}
.rot-state {
  color: #e6a23c;
}
.rot-track,
.rot-num,
.li-num {
  color: var(--text-2);
}

/* 计划清单 */
.pl-dir {
  font-weight: 600;
  padding: 0 5px;
  border-radius: 3px;
  border: 1px solid currentColor;
  font-size: 11px;
}
.pl-dir.buy,
.pl-dir.add {
  color: #f56c6c;
}
.pl-dir.reduce,
.pl-dir.sell {
  color: #4eb61b;
}
.pl-dir.hold {
  color: #909399;
}
.pl-trigger,
.pl-conf {
  color: var(--text-2);
}
.pl-status {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--text-2);
}
.pl-status.triggered {
  color: #e6a23c;
}
.pl-status.invalid {
  color: #909399;
  text-decoration: line-through;
}

/* 账户与纪律 */
.acct {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-bottom: 10px;
}
.ac-item {
  display: flex;
  flex-direction: column;
}
.ac-v {
  font-size: 16px;
  font-weight: 600;
}
.ac-k {
  font-size: 11px;
  color: var(--text-2);
}
.disc {
  display: flex;
  flex-direction: column;
  gap: 5px;
  border-top: 1px dashed var(--border);
  padding-top: 8px;
}
.disc-warn {
  font-size: 12px;
  color: #e6a23c;
  line-height: 1.5;
}
.disc-ok {
  font-size: 12px;
  color: #67c23a;
}
.dr-tag {
  font-size: 11px;
  font-weight: 600;
  padding: 0 4px;
  border-radius: 3px;
  border: 1px solid currentColor;
  color: #909399;
}
.dr-tag.stop_loss,
.dr-tag.stop_not_executed {
  color: #f56c6c;
}
.dr-tag.take_profit {
  color: #e6a23c;
}
.dr-action {
  color: var(--text-2);
}

/* 盯盘 */
.ew-meta {
  display: flex;
  gap: 12px;
  font-size: 11.5px;
  color: var(--text-2);
  margin-bottom: 8px;
}
.ew-meta .on {
  color: #67c23a;
}
.ew-meta .off {
  color: #909399;
}
.ew-layers,
.ew-stage,
.ew-act,
.sw-advice,
.sw-time {
  color: var(--text-2);
}
/*
 * 告警正文来自模型产出，长度不可控。flex 子项默认 min-width:auto 不会收缩，
 * 一条超长告警会把整个内容区撑出横向滚动条（页面底部因此多出一条滚动条）。
 * 这里让它占满剩余宽度并允许在任意字符处断行，长度约束由后端 parseVerdict 负责。
 */
.sw-advice {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.ew-act {
  color: #e6a23c;
}
.sw-sev {
  font-size: 11px;
  font-weight: 600;
  color: #909399;
}
.sw-sev.high {
  color: #f56c6c;
}
.sw-sev.medium {
  color: #e6a23c;
}
.sw-time {
  flex-shrink: 0;
}

/* 泳道 */
.lanes {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.lane {
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px 8px;
  min-height: 110px;
}
.lane-h {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 6px;
}
.lane-stage {
  font-size: 12.5px;
  font-weight: 600;
}
.lane-act {
  font-size: 11px;
  color: var(--text-2);
}
.lane.st-advancing {
  border-color: #f56c6c66;
}
.lane.st-advancing .lane-stage {
  color: #f56c6c;
}
.lane.st-brewing .lane-stage {
  color: #e6a23c;
}
.lane.st-diverging .lane-stage {
  color: #909399;
}
.lane.st-fading .lane-stage {
  color: #4eb61b;
}
.lane-item {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  font-size: 12px;
  padding: 2px 0;
}
.li-board {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lane-empty {
  font-size: 12px;
  color: var(--text-2);
}

/* 日历热力 */
.cal {
  display: flex;
  gap: 3px;
  margin-top: 10px;
}
.cal-week {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.cal-cell {
  width: 11px;
  height: 11px;
  border-radius: 2px;
  background: var(--bg-3, #2a2a2a);
}
.cal-cell.h0 {
  opacity: 0.35;
}
.cal-cell.up1 {
  background: #f56c6c44;
}
.cal-cell.up2 {
  background: #f56c6c99;
}
.cal-cell.up3 {
  background: #f56c6c;
}
.cal-cell.down1 {
  background: #4eb61b44;
}
.cal-cell.down2 {
  background: #4eb61b99;
}
.cal-cell.down3 {
  background: #4eb61b;
}

/* 系统健康 */
.health {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 16px;
}
.hc {
  display: grid;
  grid-template-columns: 10px 72px 1fr;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.hc-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #67c23a;
}
.hc.warn .hc-dot {
  background: #e6a23c;
}
.hc.down .hc-dot {
  background: #f56c6c;
}
.hc-detail {
  color: var(--text-2);
}

@media (max-width: 1100px) {
  .verdict-bar,
  .market-bar,
  .pa-grid,
  .health {
    grid-template-columns: 1fr;
  }
  .pa-card.span2 {
    grid-column: span 1;
  }
}
</style>
