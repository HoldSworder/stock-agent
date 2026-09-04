<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import dayjs from 'dayjs';
import { ElMessage } from 'element-plus';
import { Refresh } from '@element-plus/icons-vue';
import { api } from '@/api';
import { useCachedResource } from '@/composables/useCachedResource';
import { useKlineStore } from '@/stores/kline';
import type { IndexFlowLevel, IndexFundFlow, IndexFundFlowResult } from '@stock-agent/shared';

// 宽基指数主力资金流面板（大盘页常驻 / 驾驶舱精简）。
// 数据是收盘后落的日快照，历史逐日累积；不足 20 个交易日只显示数值、不给方向。
// 按规则计算，只读，仅供参考。红涨绿跌。

const props = defineProps<{
  /** 精简模式（驾驶舱）：只常驻一行结论，明细默认收起 */
  compact?: boolean;
}>();

const kline = useKlineStore();

const { data, loading, refreshing, load, reload } = useCachedResource<IndexFundFlowResult>(
  'market:indexFundFlow',
  () => api.getIndexFundFlow(),
  { ttlMs: 300_000 },
);

const items = computed(() => data.value?.items ?? []);
const summary = computed(() => data.value?.summary ?? null);
/** 有记录的指数才进表：一条都没有的指数画出来是一行空白，只会让人以为坏了 */
const rows = computed(() => items.value.filter((it) => it.days.length > 0));

const detailOpen = ref(!props.compact);

// A股 红涨绿跌
const flowDir = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const flowText = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}亿`;

const LEVEL_TEXT: Record<IndexFlowLevel, string> = {
  strong: '偏强',
  neutral: '不强不弱',
  weak: '偏弱',
  unknown: '记录还不够',
};

/** 20-39 日只能说「暂时」，这是样本决定的，不是措辞好听 */
function levelText(it: IndexFundFlow): string {
  const s = it.stats;
  if (!s || s.level === 'unknown') return LEVEL_TEXT.unknown;
  return (s.tier === 'tentative' ? '暂时' : '') + LEVEL_TEXT[s.level];
}

/**
 * 强弱只表示「跟自己近期比」，与金额正负无关——
 * 所以它旁边必须一直摆着原始金额，否则「偏强」会被读成「在净流入」。
 */
function levelClass(it: IndexFundFlow): string {
  const lv = it.stats?.level ?? 'unknown';
  return lv === 'strong' ? 'lv-strong' : lv === 'weak' ? 'lv-weak' : 'lv-flat';
}

// ===== 近 20 日主力净流入迷你柱状图（SVG，正红负绿，按组内最大绝对值缩放）=====
const BAR_W = 108;
const BAR_H = 30;
const GAP = 2;
/** 图里最多画 20 根：108px 里塞 60 根会糊成一片，看不出任何东西 */
const BAR_DAYS = 20;

interface Bar {
  x: number;
  y: number;
  w: number;
  h: number;
  cls: string;
}

/** 生成柱状图几何：零轴居中，正向上（红）、负向下（绿） */
function bars(it: IndexFundFlow): { bars: Bar[]; mid: number } {
  const vals = it.days.slice(-BAR_DAYS).map((d) => d.main);
  const maxAbs = Math.max(...vals.map((v) => Math.abs(v)), 1e-6);
  const n = vals.length;
  const bw = Math.max(1, (BAR_W - GAP * (n - 1)) / n);
  const mid = BAR_H / 2;
  const half = BAR_H / 2 - 1;
  const out: Bar[] = vals.map((v, i) => {
    const h = (Math.abs(v) / maxAbs) * half;
    const x = i * (bw + GAP);
    return {
      x,
      w: bw,
      h: Math.max(0.5, h),
      y: v >= 0 ? mid - h : mid,
      cls: v > 0 ? 'up' : v < 0 ? 'down' : 'flat',
    };
  });
  return { bars: out, mid };
}

/** 预派生行数据：柱状图几何只算一次，避免模板里同行多次调用 bars() 重复遍历 */
const view = computed(() =>
  rows.value.map((it) => ({
    item: it,
    ...bars(it),
  })),
);

const dataTimeText = computed(() => {
  const d = data.value;
  if (!d?.dataDate) return '还没有记录';
  const at = d.fetchedAt ? dayjs(d.fetchedAt).format('MM-DD HH:mm') : '';
  return `数据为 ${d.dataDate} 收盘${at ? `，${at} 存下` : ''}`;
});

async function refresh() {
  try {
    await reload();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

/**
 * 什么时候值得重新拉。
 *
 * 这份数据一天只变一次——收盘后 15:23 落快照。盘中每隔几分钟拉一遍，
 * 拿回来的永远是同一份昨天的数，纯属白跑。所以只在快照可能落地的那段窗口里轮询，
 * 拿到当天的就停。原先这个面板只在挂载时取一次，页面开着不动的话
 * 早上打开看到的数会一直挂到收盘，那才是真正会误事的。
 */
const POLL_MS = 300_000;
let timer: number | null = null;

function inSnapshotWindow(): boolean {
  const sh = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const day = sh.getDay();
  if (day === 0 || day === 6) return false;
  const hm = sh.getHours() * 60 + sh.getMinutes();
  return hm >= 920 && hm <= 990; // 15:20 - 16:30
}

function shanghaiToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function tick(): void {
  // 已经拿到今天的快照，今天不会再变，不必再问
  if (data.value?.dataDate === shanghaiToday()) return;
  if (!inSnapshotWindow()) return;
  if (document.visibilityState !== 'visible') return;
  void reload().catch(() => {
    /* 轮询失败保持旧数据，下一轮自愈 */
  });
}

function onVisible(): void {
  if (document.visibilityState === 'visible') tick();
}

onMounted(() => {
  void load().catch((e) => ElMessage.error(e instanceof Error ? e.message : String(e)));
  timer = window.setInterval(tick, POLL_MS);
  document.addEventListener('visibilitychange', onVisible);
});

onBeforeUnmount(() => {
  if (timer != null) window.clearInterval(timer);
  document.removeEventListener('visibilitychange', onVisible);
});
</script>

<template>
  <div v-loading="loading" class="idx-flow" :class="{ compact }">
    <div v-if="!compact" class="block-head">
      <div class="block-title">
        宽基指数主力资金流
        <el-popover placement="bottom-start" :width="420" trigger="click">
          <template #reference>
            <span class="how" role="button" tabindex="0" @keydown.enter.space.prevent>怎么看 ⓘ</span>
          </template>
          <div class="how-body">
            <p>
              这里的「主力」只是按订单大小分类，并不能识别真实买家。大单可能被拆成小单，所以负值很常见；它不等于所有资金都在撤退，也不能单独作为买卖依据。
            </p>
            <p>
              正确的读法是跟这个指数<b>自己过去的记录</b>比：最近 5
              天的合计，在过去所有可比较的 5 天里排得靠前还是靠后。所以「偏强」时金额仍可能是负数——
              它说的是比自己近期好转，不是在净流入。
            </p>
            <p>
              历史从系统开始记录那天起逐日累积。满 20 个交易日才给方向，满 40
              个才给正常结论；不够就只显示数值。
            </p>
          </div>
        </el-popover>
        <span class="sub">{{ dataTimeText }}</span>
      </div>
      <el-button :icon="Refresh" :loading="refreshing" circle size="small" @click="refresh" />
    </div>

    <!-- 结论行：驾驶舱只常驻这一行 -->
    <div v-if="summary" class="verdict" :class="{ muted: !summary.actionable }">
      <span class="verdict-tag">资金面</span>
      <span class="verdict-text">{{ summary.text }}</span>
      <button v-if="compact" class="verdict-more" type="button" @click="detailOpen = !detailOpen">
        {{ detailOpen ? '收起明细' : '看明细' }}
      </button>
    </div>

    <div v-show="detailOpen">
      <div v-if="view.length" class="flow-grid">
        <div
          v-for="r in view"
          :key="r.item.secid"
          class="flow-row"
          role="button"
          tabindex="0"
          @click="kline.open(r.item.code, r.item.name, r.item.secid)"
          @keydown.enter="kline.open(r.item.code, r.item.name, r.item.secid)"
        >
          <div class="flow-name">{{ r.item.name }}</div>
          <div class="flow-today num" :class="flowDir(r.item.stats!.latest)">
            {{ flowText(r.item.stats!.latest) }}
          </div>
          <svg class="flow-bars" :viewBox="`0 0 ${BAR_W} ${BAR_H}`" :width="BAR_W" :height="BAR_H">
            <line class="axis" :x1="0" :y1="r.mid" :x2="BAR_W" :y2="r.mid" />
            <rect
              v-for="(b, i) in r.bars"
              :key="i"
              :x="b.x"
              :y="b.y"
              :width="b.w"
              :height="b.h"
              class="bar"
              :class="b.cls"
            />
          </svg>
          <div class="flow-tail">
            <span v-if="r.item.stats!.sum5 != null" class="flow-sum num" :class="flowDir(r.item.stats!.sum5!)">
              5日 {{ flowText(r.item.stats!.sum5!) }}
            </span>
            <span class="flow-level" :class="levelClass(r.item)">{{ levelText(r.item) }}</span>
            <span class="flow-days">{{ r.item.stats!.days }}天</span>
          </div>
        </div>
      </div>
      <el-empty
        v-else-if="!loading"
        :image-size="50"
        description="还没有记录，今天收盘后开始逐日累积"
      />
    </div>
  </div>
</template>

<style scoped>
.idx-flow {
  min-height: 80px;
  margin-bottom: 12px;
}
.idx-flow.compact {
  min-height: 0;
}
.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.block-title {
  font-weight: 600;
  font-size: 14px;
}
.block-title .sub {
  font-weight: 400;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-left: 8px;
}
.how {
  margin-left: 6px;
  font-weight: 400;
  font-size: 12px;
  color: var(--el-color-primary);
  cursor: pointer;
  border-bottom: 1px dashed currentColor;
}
.how:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}
.how-body {
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--el-text-color-regular);
}
.how-body p {
  margin: 0 0 8px;
}
.how-body p:last-child {
  margin-bottom: 0;
}

/* 结论行 */
.verdict {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 12px;
  margin-bottom: 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-left: 3px solid var(--el-color-primary);
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.6;
}
.verdict.muted {
  border-left-color: var(--el-border-color);
  color: var(--el-text-color-secondary);
}
.verdict-tag {
  flex: 0 0 auto;
  font-weight: 600;
}
.verdict-text {
  flex: 1;
  min-width: 0;
}
.verdict-more {
  flex: 0 0 auto;
  border: none;
  background: transparent;
  color: var(--el-color-primary);
  font-size: 12px;
  cursor: pointer;
}

.flow-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 8px;
}
.flow-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.15s;
}
.flow-row:hover {
  background-color: var(--el-fill-color-light);
}
.flow-name {
  flex: 0 0 auto;
  width: 62px;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.flow-today {
  flex: 0 0 auto;
  width: 66px;
  text-align: right;
  font-size: 13px;
  font-weight: 600;
}
.flow-bars {
  flex: 0 0 auto;
}
.flow-tail {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
  margin-left: auto;
  font-size: 11px;
  line-height: 1.4;
}
.flow-sum {
  font-size: 11.5px;
}
.flow-level {
  font-weight: 600;
}
.lv-strong {
  color: var(--el-color-danger);
}
.lv-weak {
  color: var(--el-color-success);
}
.lv-flat {
  color: var(--el-text-color-secondary);
}
.flow-days {
  color: var(--el-text-color-secondary);
}
.num.up,
.bar.up {
  color: var(--el-color-danger);
}
.num.down,
.bar.down {
  color: var(--el-color-success);
}
.num.flat {
  color: var(--el-text-color-secondary);
}
.bar {
  fill: currentColor;
}
.bar.up {
  fill: var(--el-color-danger);
}
.bar.down {
  fill: var(--el-color-success);
}
.bar.flat {
  fill: var(--el-text-color-secondary);
}
.axis {
  stroke: var(--el-border-color);
  stroke-width: 0.5;
}
</style>
