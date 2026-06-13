<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import dayjs from 'dayjs';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Refresh, MagicStick, Clock, Back } from '@element-plus/icons-vue';
import { api } from '@/api';
import StockLink from '@/components/StockLink.vue';
import ModuleScheduleDialog from '@/components/ModuleScheduleDialog.vue';
import type {
  DailyPlanDetail,
  DailyPlanEvent,
  DailyPlanItem,
  DailyPlanSummary,
  EtfAction,
  EtfSignal,
  PlanDirection,
  PlanEventKind,
  PlanItemStatus,
  PlanItemSource,
  PlanTrigger,
  StockQuote,
} from '@stock-agent/shared';

const detail = ref<DailyPlanDetail | null>(null);
const loading = ref(false);
const generating = ref(false);
const error = ref('');

// 历史回看：viewingDate 非空表示当前查看的是历史计划（只读）
const viewingDate = ref<string | null>(null);
const historyDrawer = ref(false);
const historyList = ref<DailyPlanSummary[]>([]);
const historyLoading = ref(false);

// 实时合并数据（仅查看当日时拉取，历史回看不拉以免把当下行情误当历史）
const quoteMap = ref<Map<string, StockQuote>>(new Map());
const etfSignalMap = ref<Map<string, EtfSignal>>(new Map());

/** 拉取实时行情（个股 quotes + ETF 信号），失败静默降级为只读落库字段 */
async function loadLive() {
  quoteMap.value = new Map();
  etfSignalMap.value = new Map();
  const list = detail.value?.items ?? [];
  const stockCodes = list.filter((i) => i.assetType !== 'etf').map((i) => i.code);
  const hasEtf = list.some((i) => i.assetType === 'etf');
  const tasks: Promise<void>[] = [];
  if (stockCodes.length) {
    tasks.push(
      api
        .quotes(stockCodes)
        .then((qs) => {
          quoteMap.value = new Map(qs.map((q) => [q.code, q]));
        })
        .catch(() => {}),
    );
  }
  if (hasEtf) {
    tasks.push(
      api.etf
        .signals()
        .then((r) => {
          etfSignalMap.value = new Map(r.signals.map((s) => [s.code, s]));
        })
        .catch(() => {}),
    );
  }
  await Promise.all(tasks);
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    detail.value = await api.plan.today();
    viewingDate.value = null;
    if (detail.value) await loadLive();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    ElMessage.error(error.value);
  } finally {
    loading.value = false;
  }
}

async function openHistory() {
  historyDrawer.value = true;
  historyLoading.value = true;
  try {
    historyList.value = await api.plan.history(60);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    historyLoading.value = false;
  }
}

/** 查看某历史日期计划（只读回看） */
async function viewHistory(date: string) {
  loading.value = true;
  try {
    const d = await api.plan.get(date);
    if (!d) {
      ElMessage.warning('该日期暂无计划详情');
      return;
    }
    detail.value = d;
    viewingDate.value = date;
    historyDrawer.value = false;
    // 历史回看不拉实时数据，清空合并 Map
    quoteMap.value = new Map();
    etfSignalMap.value = new Map();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function generate() {
  if (detail.value) {
    try {
      await ElMessageBox.confirm(
        '今日已有计划，重新生成将覆盖当前计划标的（保留历史事件）。确认继续？',
        '重新生成今日计划',
        { type: 'warning', confirmButtonText: '重新生成', cancelButtonText: '取消' },
      );
    } catch {
      return;
    }
  }
  generating.value = true;
  try {
    const date = detail.value?.plan.planDate;
    await (date ? api.plan.regenerate(date) : api.plan.generate());
    ElMessage.success('计划生成完成');
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    generating.value = false;
  }
}

const plan = computed(() => detail.value?.plan ?? null);
const items = computed(() => detail.value?.items ?? []);
const isLive = computed(() => !viewingDate.value);

function itemPriority(a: DailyPlanItem, b: DailyPlanItem) {
  return b.priority - a.priority;
}

const stockItems = computed(() =>
  items.value.filter((i) => i.assetType !== 'etf').sort(itemPriority),
);
const etfItems = computed(() =>
  items.value.filter((i) => i.assetType === 'etf').sort(itemPriority),
);

const events = computed<DailyPlanEvent[]>(() =>
  [...(detail.value?.events ?? [])].sort((a, b) => (a.ts < b.ts ? 1 : -1)),
);

const STATUS_META: Record<DailyPlanDetail['plan']['status'], { label: string; type: string }> = {
  draft: { label: '草稿', type: 'info' },
  active: { label: '生效中', type: 'success' },
  closed: { label: '已复盘', type: 'warning' },
};

const DIR_META: Record<PlanDirection, { label: string; type: string }> = {
  buy: { label: '买入', type: 'danger' },
  hold: { label: '持有', type: 'warning' },
  reduce: { label: '减仓', type: 'success' },
  sell: { label: '卖出', type: 'success' },
  watch: { label: '观察', type: 'info' },
};

const ITEM_STATUS_META: Record<PlanItemStatus, { label: string; type: string }> = {
  pending: { label: '待触发', type: 'info' },
  triggered: { label: '已触发', type: 'danger' },
  done: { label: '已完成', type: 'success' },
  invalid: { label: '已失效', type: 'info' },
};

const SOURCE_LABEL: Record<PlanItemSource, string> = {
  research: '研报',
  hotspot: '热点',
  sector: '板块',
  position: '持仓',
  watchlist: '自选',
  other: '其他',
};

const BIAS_META: Record<'bull' | 'bear' | 'neutral', { label: string; cls: string }> = {
  bull: { label: '偏多', cls: 'up' },
  bear: { label: '偏空', cls: 'down' },
  neutral: { label: '中性', cls: '' },
};

const ACTION_META: Record<EtfAction, { label: string; type: string }> = {
  buy: { label: '买入', type: 'danger' },
  add: { label: '加仓', type: 'danger' },
  hold: { label: '持有', type: 'warning' },
  reduce: { label: '减仓', type: 'success' },
  avoid: { label: '回避', type: 'info' },
};

const EVENT_META: Record<PlanEventKind, { label: string; type: string }> = {
  created: { label: '生成', type: 'primary' },
  regenerated: { label: '重新生成', type: 'warning' },
  trigger_hit: { label: '触发', type: 'danger' },
  note: { label: '备注', type: 'info' },
  review: { label: '复盘', type: 'success' },
};

function trg(t: PlanTrigger | null): string {
  if (!t) return '—';
  const tag = t.type === 'breakout' ? '突破' : t.type === 'pullback' ? '回落' : '';
  return `${tag}${t.value}${t.note ? `（${t.note}）` : ''}`;
}

/** 多 agent 辩论结论标签色：清仓=危险 / 减仓=警告 / 持有=信息 */
function debateTagType(verdict: string | null): string {
  if (verdict === '清仓') return 'danger';
  if (verdict === '减仓') return 'warning';
  return 'info';
}

const liveQuote = (code: string): StockQuote | null => quoteMap.value.get(code) ?? null;
const etfSig = (code: string): EtfSignal | null => etfSignalMap.value.get(code) ?? null;

function pctCls(v: number | null | undefined): string {
  if (v == null) return '';
  return v > 0 ? 'up' : v < 0 ? 'down' : '';
}

function fmtNum(v: number | null | undefined, digits = 2): string {
  return v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits);
}

function fmtPct(v: number | null | undefined, digits = 2): string {
  return v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

/** 现价距买入触发价的百分比（正=尚在触发价之上，负=已跌破/接近买点） */
function distToTrigger(code: string, t: PlanTrigger | null): string {
  const q = liveQuote(code);
  if (!q || !t || !t.value) return '—';
  const d = ((q.price - t.value) / t.value) * 100;
  return `${d > 0 ? '+' : ''}${d.toFixed(2)}%`;
}

/** 解析事件 payload（note/trigger 文本） */
function eventText(ev: DailyPlanEvent): string {
  if (!ev.payload) return '';
  try {
    const p = JSON.parse(ev.payload) as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof p.code === 'string') parts.push(p.code);
    if (typeof p.name === 'string') parts.push(p.name);
    const msg = p.note ?? p.message ?? p.text ?? p.summary;
    if (typeof msg === 'string' && msg) parts.push(msg);
    return parts.join(' · ') || ev.payload;
  } catch {
    return ev.payload;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-title">今日计划</div>
      <div class="head-actions">
        <el-tag v-if="viewingDate" type="info" effect="plain" size="small">历史查看</el-tag>
        <el-tag v-if="plan" :type="STATUS_META[plan.status].type as any" effect="dark" size="small">
          {{ STATUS_META[plan.status].label }}
        </el-tag>
        <span v-if="plan" class="meta">{{ plan.planDate }}</span>
        <el-button :icon="Clock" @click="openHistory">历史</el-button>
        <el-button v-if="viewingDate" :icon="Back" :loading="loading" @click="load">返回今日</el-button>
        <template v-else>
          <ModuleScheduleDialog module="plan" />
          <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
          <el-button type="primary" :icon="MagicStick" :loading="generating" @click="generate">
            {{ plan ? '重新生成' : '生成今日计划' }}
          </el-button>
        </template>
      </div>
    </div>
    <div class="page-sub">
      盘前作战室：研报 / 热点 / 板块 / 持仓 / 大盘 / 外围串联，盘中盯盘程序化对照，盘后收盘复盘闭环（仅研判不下单）
    </div>

    <el-empty
      v-if="!loading && !plan"
      description="今日尚无作战计划，点击右上角「生成今日计划」由 Agent 综合各模块生成"
    />

    <template v-if="plan">
      <!-- 大盘研判 -->
      <div class="section">
        <div class="section-title">大盘研判</div>
        <div v-if="plan.marketStance" class="stance">
          <div class="cards">
            <div class="card">
              <div class="card-label">方向</div>
              <div class="card-value" :class="BIAS_META[plan.marketStance.bias].cls">
                {{ BIAS_META[plan.marketStance.bias].label }}
              </div>
            </div>
            <div class="card">
              <div class="card-label">建议仓位</div>
              <div class="card-value num">{{ plan.marketStance.positionPct }}%</div>
            </div>
            <div class="card">
              <div class="card-label">关键支撑</div>
              <div class="card-value">{{ plan.marketStance.support || '—' }}</div>
            </div>
            <div class="card">
              <div class="card-label">关键压力</div>
              <div class="card-value">{{ plan.marketStance.resistance || '—' }}</div>
            </div>
          </div>
          <div class="stance-summary">{{ plan.marketStance.summary }}</div>
        </div>
        <div v-else class="muted">未提供大盘研判</div>
      </div>

      <!-- 外围 / 重点板块 -->
      <div class="section two-col">
        <div class="col">
          <div class="section-title">隔夜外围 / 政策</div>
          <div class="ext">{{ plan.externalContext || '—' }}</div>
        </div>
        <div class="col">
          <div class="section-title">重点板块</div>
          <div v-if="plan.focusSectors.length" class="sectors">
            <div v-for="s in plan.focusSectors" :key="s.name" class="sector">
              <span class="sector-name">{{ s.name }}</span>
              <el-tag size="small" effect="plain">{{ s.strength }}</el-tag>
              <span class="sector-reason">{{ s.reason }}</span>
            </div>
          </div>
          <div v-else class="muted">—</div>
        </div>
      </div>

      <!-- 个股计划 -->
      <div v-if="stockItems.length" class="section">
        <div class="section-title">
          个股计划（{{ stockItems.length }}）
          <span v-if="!isLive" class="tag-hist">历史回看·不含实时行情</span>
        </div>
        <el-table :data="stockItems" stripe style="width: 100%">
          <el-table-column label="名称" min-width="120">
            <template #default="{ row }">
              <StockLink :code="row.code" :name="row.name" />
              <span class="code-sub num">{{ row.code }}</span>
            </template>
          </el-table-column>
          <el-table-column label="方向" width="74" align="center">
            <template #default="{ row }">
              <el-tag size="small" :type="DIR_META[row.direction as PlanDirection].type as any" effect="dark">
                {{ DIR_META[row.direction as PlanDirection].label }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column v-if="isLive" label="现价" width="84" align="right">
            <template #default="{ row }">
              <span class="num">{{ fmtNum(liveQuote(row.code)?.price) }}</span>
            </template>
          </el-table-column>
          <el-table-column v-if="isLive" label="涨跌幅" width="84" align="right">
            <template #default="{ row }">
              <span class="num" :class="pctCls(liveQuote(row.code)?.pct)">{{ fmtPct(liveQuote(row.code)?.pct) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="逻辑" min-width="180">
            <template #default="{ row }"><span class="thesis">{{ row.thesis || '—' }}</span></template>
          </el-table-column>
          <el-table-column label="买入触发" min-width="118" align="right">
            <template #default="{ row }"><span class="num up">{{ trg(row.buyTrigger) }}</span></template>
          </el-table-column>
          <el-table-column v-if="isLive" label="距买点" width="84" align="right">
            <template #default="{ row }">
              <span class="num sub">{{ distToTrigger(row.code, row.buyTrigger) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="止损" min-width="104" align="right">
            <template #default="{ row }"><span class="num down">{{ trg(row.stopLoss) }}</span></template>
          </el-table-column>
          <el-table-column label="止盈 / 卖点" min-width="118" align="right">
            <template #default="{ row }">
              <span class="num">{{ trg(row.takeProfit) }}</span>
              <span v-if="row.sellTrigger" class="num sub"> / {{ trg(row.sellTrigger) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="仓位" width="74" align="right">
            <template #default="{ row }"><span class="num">{{ row.positionHint || '—' }}</span></template>
          </el-table-column>
          <el-table-column label="来源" width="68" align="center">
            <template #default="{ row }">
              <el-tag size="small" effect="plain">{{ SOURCE_LABEL[row.source as PlanItemSource] }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="辩论" width="96" align="center">
            <template #default="{ row }">
              <el-tooltip
                v-if="row.debateVerdict"
                :content="row.debateNote || '多 agent 辩论结论'"
                placement="top"
              >
                <el-tag size="small" :type="debateTagType(row.debateVerdict) as any" effect="dark">
                  {{ row.debateVerdict }}<span v-if="row.debateConfidence != null"> {{ row.debateConfidence }}</span>
                </el-tag>
              </el-tooltip>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="80" align="center">
            <template #default="{ row }">
              <el-tag size="small" :type="ITEM_STATUS_META[row.status as PlanItemStatus].type as any">
                {{ ITEM_STATUS_META[row.status as PlanItemStatus].label }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="盘中备注" min-width="150">
            <template #default="{ row }"><span class="muted">{{ row.lastNote || '—' }}</span></template>
          </el-table-column>
        </el-table>
      </div>

      <!-- ETF 计划 -->
      <div v-if="etfItems.length" class="section">
        <div class="section-title">
          ETF 计划（{{ etfItems.length }}）
          <span v-if="!isLive" class="tag-hist">历史回看·不含实时量化信号</span>
        </div>
        <el-table :data="etfItems" stripe style="width: 100%">
          <el-table-column label="名称" min-width="120">
            <template #default="{ row }">
              <StockLink :code="row.code" :name="row.name" />
              <span class="code-sub num">{{ row.code }}</span>
            </template>
          </el-table-column>
          <el-table-column label="方向" width="74" align="center">
            <template #default="{ row }">
              <el-tag size="small" :type="DIR_META[row.direction as PlanDirection].type as any" effect="dark">
                {{ DIR_META[row.direction as PlanDirection].label }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column v-if="isLive" label="现价" width="80" align="right">
            <template #default="{ row }"><span class="num">{{ fmtNum(etfSig(row.code)?.price) }}</span></template>
          </el-table-column>
          <el-table-column v-if="isLive" label="涨跌幅" width="80" align="right">
            <template #default="{ row }">
              <span class="num" :class="pctCls(etfSig(row.code)?.pct)">{{ fmtPct(etfSig(row.code)?.pct) }}</span>
            </template>
          </el-table-column>
          <el-table-column v-if="isLive" label="折溢价" width="76" align="right">
            <template #default="{ row }">
              <span class="num" :class="pctCls(etfSig(row.code)?.premiumPct)">{{ fmtPct(etfSig(row.code)?.premiumPct) }}</span>
            </template>
          </el-table-column>
          <el-table-column v-if="isLive" label="估值分位" width="84" align="right">
            <template #default="{ row }">
              <span class="num">{{ etfSig(row.code)?.pricePercentile != null ? fmtNum(etfSig(row.code)?.pricePercentile, 0) + '%' : '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column v-if="isLive" label="年线偏离" width="84" align="right">
            <template #default="{ row }">
              <span class="num" :class="pctCls(etfSig(row.code)?.maDeviation)">{{ fmtPct(etfSig(row.code)?.maDeviation) }}</span>
            </template>
          </el-table-column>
          <el-table-column v-if="isLive" label="动量排名" width="80" align="right">
            <template #default="{ row }">
              <span class="num">{{ etfSig(row.code)?.momentumRank != null ? '#' + etfSig(row.code)?.momentumRank : '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column v-if="isLive" label="网格水位" width="84" align="center">
            <template #default="{ row }">
              <span v-if="etfSig(row.code)?.grid" class="num">
                {{ etfSig(row.code)?.grid?.level }}/{{ etfSig(row.code)?.grid?.gridCount }}
              </span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column v-if="isLive" label="信号建议" width="82" align="center">
            <template #default="{ row }">
              <el-tag
                v-if="etfSig(row.code)"
                size="small"
                :type="ACTION_META[etfSig(row.code)!.action].type as any"
                effect="dark"
              >
                {{ ACTION_META[etfSig(row.code)!.action].label }}
              </el-tag>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="买入触发" min-width="112" align="right">
            <template #default="{ row }"><span class="num up">{{ trg(row.buyTrigger) }}</span></template>
          </el-table-column>
          <el-table-column label="止损" min-width="100" align="right">
            <template #default="{ row }"><span class="num down">{{ trg(row.stopLoss) }}</span></template>
          </el-table-column>
          <el-table-column label="止盈 / 卖点" min-width="116" align="right">
            <template #default="{ row }">
              <span class="num">{{ trg(row.takeProfit) }}</span>
              <span v-if="row.sellTrigger" class="num sub"> / {{ trg(row.sellTrigger) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="仓位" width="72" align="right">
            <template #default="{ row }"><span class="num">{{ row.positionHint || '—' }}</span></template>
          </el-table-column>
          <el-table-column v-if="isLive" label="信号要点" min-width="180">
            <template #default="{ row }">
              <el-tooltip
                v-if="etfSig(row.code)?.notes?.length"
                placement="top"
                :content="etfSig(row.code)!.notes.join('；')"
              >
                <span class="thesis clamp">{{ etfSig(row.code)!.notes.join('；') }}</span>
              </el-tooltip>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="80" align="center">
            <template #default="{ row }">
              <el-tag size="small" :type="ITEM_STATUS_META[row.status as PlanItemStatus].type as any">
                {{ ITEM_STATUS_META[row.status as PlanItemStatus].label }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="盘中备注" min-width="150">
            <template #default="{ row }"><span class="muted">{{ row.lastNote || '—' }}</span></template>
          </el-table-column>
        </el-table>
      </div>

      <el-empty v-if="!stockItems.length && !etfItems.length" :image-size="60" description="本计划暂无标的" />

      <!-- 完整作战图（默认展开） -->
      <el-collapse v-if="plan.narrative" class="narr" :model-value="['narr']">
        <el-collapse-item name="narr" title="完整作战图（narrative）">
          <pre class="narrative">{{ plan.narrative }}</pre>
        </el-collapse-item>
      </el-collapse>

      <!-- 计划动态 -->
      <div v-if="events.length" class="section">
        <div class="section-title">计划动态</div>
        <el-timeline>
          <el-timeline-item
            v-for="ev in events"
            :key="ev.id"
            :timestamp="dayjs(ev.ts).format('MM-DD HH:mm')"
            placement="top"
            :type="EVENT_META[ev.kind].type as any"
          >
            <el-tag size="small" :type="EVENT_META[ev.kind].type as any" effect="plain">
              {{ EVENT_META[ev.kind].label }}
            </el-tag>
            <span v-if="eventText(ev)" class="event-text">{{ eventText(ev) }}</span>
          </el-timeline-item>
        </el-timeline>
      </div>

      <!-- 盘后复盘 -->
      <div v-if="plan.status === 'closed' && plan.reviewSummary" class="section review">
        <div class="section-title">盘后复盘</div>
        <pre class="narrative">{{ plan.reviewSummary }}</pre>
        <div class="meta">更新于 {{ dayjs(plan.updatedAt).format('YYYY-MM-DD HH:mm') }}</div>
      </div>
    </template>

    <!-- 计划历史抽屉 -->
    <el-drawer v-model="historyDrawer" title="计划历史" size="360px">
      <div v-loading="historyLoading" class="hist-list">
        <div
          v-for="item in historyList"
          :key="item.planDate"
          class="hist-item"
          :class="{ active: item.planDate === viewingDate }"
          @click="viewHistory(item.planDate)"
        >
          <div class="hist-row">
            <span class="hist-date num">{{ item.planDate }}</span>
            <el-tag :type="STATUS_META[item.status].type as any" effect="plain" size="small">
              {{ STATUS_META[item.status].label }}
            </el-tag>
            <span v-if="item.bias" class="hist-bias" :class="BIAS_META[item.bias].cls">
              {{ BIAS_META[item.bias].label }}
            </span>
            <span class="hist-count">{{ item.itemCount }} 只</span>
          </div>
          <div v-if="item.summary" class="hist-summary">{{ item.summary }}</div>
        </div>
        <el-empty
          v-if="!historyLoading && !historyList.length"
          :image-size="60"
          description="暂无计划记录"
        />
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.meta {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.muted {
  color: var(--el-text-color-secondary);
}
.section {
  margin-top: 18px;
}
.section-title {
  font-weight: 600;
  margin-bottom: 10px;
  font-size: 15px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
}
.card {
  background: var(--el-fill-color-light);
  border-radius: 8px;
  padding: 12px 14px;
}
.card-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 6px;
}
.card-value {
  font-size: 20px;
  font-weight: 600;
}
.stance-summary {
  margin-top: 12px;
  padding: 10px 14px;
  background: var(--el-fill-color-lighter);
  border-radius: 8px;
  line-height: 1.6;
}
.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
}
.ext {
  line-height: 1.7;
  white-space: pre-wrap;
}
.sectors {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sector {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.sector-name {
  font-weight: 600;
}
.sector-reason {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.thesis {
  font-size: 13px;
  line-height: 1.5;
}
.thesis.clamp {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.code-sub {
  margin-left: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.tag-hist {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}
.event-text {
  margin-left: 8px;
  font-size: 13px;
}
.sub {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.narr {
  margin-top: 18px;
}
.narrative {
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  line-height: 1.7;
  margin: 0;
}
.review {
  background: var(--el-fill-color-lighter);
  border-radius: 8px;
  padding: 14px 16px;
}
.hist-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.hist-item {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--el-fill-color-light);
  cursor: pointer;
  transition: background 0.15s;
}
.hist-item:hover {
  background: var(--el-fill-color);
}
.hist-item.active {
  outline: 1px solid var(--el-color-primary);
}
.hist-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.hist-date {
  font-weight: 600;
}
.hist-bias.up {
  color: var(--el-color-danger);
}
.hist-bias.down {
  color: var(--el-color-success);
}
.hist-count {
  margin-left: auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.hist-summary {
  margin-top: 6px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  line-height: 1.5;
}
@media (max-width: 760px) {
  .two-col {
    grid-template-columns: 1fr;
  }
}
</style>
