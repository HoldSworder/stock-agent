<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import dayjs from 'dayjs';
import { ElMessage } from 'element-plus';
import { api } from '@/api';
import StockLink from '@/components/StockLink.vue';
import {
  TURNING_DIRECTION_BEATS_BASELINE,
  TURNING_DIRECTION_HIT,
  TURNING_MIN_STREAK,
  TURNING_STREAK_STATS,
  turningActionText,
  type TurningCalendar,
  type TurningExpect,
  type TurningPointItem,
  type TurningSection,
} from '@stock-agent/shared';

// 转折日历页：把「哪几天可能出现转折」摊开给人看。
//
// 这一页的存在理由是一次实测复盘：系统在 2026-08-20 就算出了「159516 会在 08-25 转折」，
// 8/25 实际最低 0.682 正是那波的低点。日期算对了，却没有任何页面展示过。
//
// 本页只读已经记录下来的内容，不做任何技术计算。

const cal = ref<TurningCalendar | null>(null);
const loading = ref(false);
const days = ref(30);
/** 回看某个历史日期，看看那天系统给出的判断 */
const replay = ref('');

/**
 * 请求序号，防乱序。快速切日期会并发发出多个请求，慢的那个后到就会覆盖新结果，
 * 出现「控件写着 8-20、表格却是今天的数据」——回看页最不能出这种自相矛盾。
 */
let reqSeq = 0;

async function load(): Promise<void> {
  const seq = (reqSeq += 1);
  loading.value = true;
  try {
    const r = await api.assertions.calendar({
      days: days.value,
      asOf: replay.value || undefined,
    });
    if (seq !== reqSeq) return;
    cal.value = r;
  } catch (e) {
    if (seq === reqSeq) ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    if (seq === reqSeq) loading.value = false;
  }
}

/**
 * 用 watch 而不是控件的 @change 触发重载。
 * el-date-picker 清空或程序化改值时 v-model 已经变了、change 却不派发，
 * 结果横幅写着「正在回看 8-20」、下面列的还是今天的数据。
 */
watch([days, replay], () => void load());

const EXPECT_LABEL: Record<TurningExpect, string> = {
  high: '可能见高点',
  low: '可能见低点',
  unknown: '方向说不准',
};

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function dateText(iso: string): string {
  const d = dayjs(iso);
  return `${d.month() + 1}月${d.date()}日 ${WEEKDAY[d.day()]}`;
}

function whenText(inDays: number): string {
  if (inDays === 0) return '就是今天';
  if (inDays === 1) return '下一个交易日';
  return `${inDays} 个交易日后`;
}

/** 只出现过一天的预测，历史上说准的比例只有两成，整条降调 */
function isWeak(streak: number): boolean {
  return streak < TURNING_MIN_STREAK;
}

const pct = (v: number | null): string => (v == null ? '—' : `${(v * 100).toFixed(0)}%`);
const fmt = (n: number): string => (n < 10 ? n.toFixed(3) : n.toFixed(2));

/** 方向对应的那一侧排前面，另一侧仍然完整给出 */
function orderedSides(item: TurningPointItem): Array<{ tag: string; list: TurningPointItem['above'] }> {
  const above = { tag: '上方', list: item.above };
  const below = { tag: '下方', list: item.below };
  return item.expect === 'low' ? [below, above] : [above, below];
}

const sections = computed<TurningSection[]>(() =>
  cal.value ? [cal.value.daily, cal.value.weekly] : [],
);
const hasAny = computed(() =>
  sections.value.some((s) => s.entries.length > 0),
);

onMounted(load);
</script>

<template>
  <div class="page" v-loading="loading">
    <div class="page-head">
      <div>
        <h2 class="page-title">转折日历</h2>
        <p class="page-sub">
          系统认为哪几天可能出现转折。判断谁更靠得住，只看「连续几天没改口」——
          波浪的编号常变，日期反而稳
        </p>
      </div>
      <div class="head-ops">
        <el-select v-model="days" size="small" style="width: 130px">
          <el-option :value="10" label="未来 10 天" />
          <el-option :value="30" label="未来 30 天" />
          <el-option :value="90" label="未来 90 天" />
        </el-select>
        <el-date-picker
          v-model="replay"
          type="date"
          size="small"
          value-format="YYYY-MM-DD"
          placeholder="回看某天"
          style="width: 150px"
          clearable
        />
        <el-button size="small" @click="load">刷新</el-button>
      </div>
    </div>

    <!--
      成绩必须和日历摆在同一屏。一张排得整整齐齐的表格天然让人觉得可信，
      不把这两个数说清楚就是拿排版冒充胜率。
    -->
    <div v-if="cal" class="reliability">
      <div>
        <b>往哪边转</b>说得准吗：<b v-if="!TURNING_DIRECTION_BEATS_BASELINE">还没验出准头</b>
        <b v-else>已跑赢基线</b>——系统说对
        {{ TURNING_DIRECTION_HIT.hit }}/{{ TURNING_DIRECTION_HIT.events }} 次，
        而「不动脑筋永远猜{{ TURNING_DIRECTION_HIT.baselineSide === 'high' ? '见高' : '见低' }}」
        能对 {{ TURNING_DIRECTION_HIT.baseline }}/{{ TURNING_DIRECTION_HIT.events }} 次。
        所以下面的高低是<b>实验性判断</b>，不作买卖依据。
      </div>
      <div class="reliability__foot">
        方向这组数为截至 {{ TURNING_DIRECTION_HIT.asOf }} 的存档，非实时。
        同一个预测连着记多天只算一次，避免把证据量算重。
      </div>
    </div>

    <div v-if="replay" class="page-note">
      正在回看 {{ replay }}：只统计那天收盘前已经记下的内容，看到的就是当天系统给出的判断
    </div>

    <el-empty
      v-if="!loading && !hasAny"
      description="这段时间内系统没有给出转折日。波浪走势不清晰、或预测的日子都已经过去时属正常"
      :image-size="80"
    />

    <template v-else-if="cal">
      <section v-for="sec in sections" :key="sec.title" class="sec">
        <div class="sec__head">
          <span class="sec__title">{{ sec.title }}</span>
          <span class="sec__scope">{{ sec.scope }}</span>
        </div>
        <!--
          每一档只报自己的成绩。共用一份的话，刚开始记录的周线会顶着日线
          两个多月攒下的分显示，等于蹭分。
        -->
        <div class="sec__score" :class="{ 'is-none': sec.tooFewSamples }">
          <template v-if="sec.tooFewSamples">
            这一档只攒了 {{ sec.reliability.events.settled }} 次可判对错的预测，太少，先不给说准率
          </template>
          <template v-else>
            这一档的日子说准 {{ pct(sec.reliability.events.rate) }}（{{
              sec.reliability.events.hit
            }}/{{ sec.reliability.events.settled }} 次独立预测；考虑样本误差，真实水平可能低到
            {{ pct(sec.reliability.events.lowerBound) }}）。 其中连续
            {{ TURNING_MIN_STREAK }} 天以上没改口的那批 {{ TURNING_STREAK_STATS.strong }}%，
            只出现一天的只有 {{ TURNING_STREAK_STATS.weak }}%
          </template>
        </div>

        <el-empty
          v-if="sec.entries.length === 0"
          :description="`这段时间内没有${sec.title.slice(0, 4)}的转折日`"
          :image-size="60"
        />

        <div
          v-for="e in sec.entries"
          :key="e.date"
          class="panel entry"
          :class="{ 'is-weak': isWeak(e.maxStreak) || e.superseded }"
        >
          <div class="entry__head">
            <span class="entry__date">{{ dateText(e.date) }}</span>
            <span class="tag is-exp" :class="`is-${e.expect}`">
              实验判断 · {{ EXPECT_LABEL[e.expect] }}
            </span>
            <span v-if="!TURNING_DIRECTION_BEATS_BASELINE" class="tag is-warn">方向未验出准头</span>
            <span v-if="e.superseded" class="tag is-warn">最新分析没再提它</span>
            <span v-else class="tag" :class="isWeak(e.maxStreak) ? 'is-warn' : 'is-strong'">
              {{ isWeak(e.maxStreak) ? '今天才第一次给出' : `已连续 ${e.maxStreak} 天给出同一天` }}
            </span>
            <span class="entry__when">{{ whenText(e.inDays) }}</span>
          </div>

          <div class="entry__action">{{ turningActionText(e.maxStreak, e.superseded) }}</div>

          <div v-for="i in e.items" :key="`${i.code}-${i.period}`" class="item">
            <div class="item__head">
              <StockLink :code="i.code" :name="i.label" :secid="i.secid ?? undefined" />
              <span class="tag is-plain">{{ EXPECT_LABEL[i.expect] }}</span>
              <span v-if="i.superseded" class="item__meta is-warn">没被重申</span>
              <span v-else class="item__meta">连续 {{ i.streak }} 天没改口</span>
              <span class="item__meta">最后更新 {{ i.asOf }}</span>
              <span class="item__basis" :title="i.statement">{{ i.statement }}</span>
            </div>
            <!--
              两侧都给。方向对应的一侧排前面，但绝不隐藏另一侧——
              方向本身还没跑赢基线，只给一边等于把没把握的判断放大成唯一信息。
            -->
            <div v-if="i.above.length || i.below.length" class="item__levels">
              <span v-for="s in orderedSides(i)" :key="s.tag" class="side">
                <em>{{ s.tag }}</em>
                <template v-if="s.list.length">
                  <span v-for="l in s.list" :key="l.price" class="lv">
                    <b class="num">{{ fmt(l.price) }}</b>
                    {{ l.source }}<i v-if="l.rate != null">（这类位子历史上拦住过 {{ pct(l.rate) }}）</i>
                  </span>
                </template>
                <span v-else class="lv is-none">无</span>
              </span>
            </div>
          </div>

          <!--
            容差放在末行小字。早先它作为区间顶在日期下面，看着像「模型说这几天里某天会转」——
            那是评分时的宽容度，不是预测精度。
          -->
          <div class="entry__tol">
            打分时前后各放宽到 {{ e.from }} ~ {{ e.to }}，这中间出现转折都算说准。
            这是评分的宽容度，不是预测精度
          </div>
        </div>
      </section>

      <div class="page-note">{{ cal.note }}</div>
    </template>
  </div>
</template>

<style scoped>
.sec {
  margin-bottom: 18px;
}
.sec__head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px 12px;
  margin-bottom: 8px;
}
.sec__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-0, #cfd3dc);
}
.sec__scope {
  color: var(--text-2);
  font-size: 12px;
}
/* 每档自己的成绩，紧跟标题，不与另一档共用 */
.sec__score {
  margin-bottom: 8px;
  font-size: 12px;
  color: #e6a23c;
  line-height: 1.6;
}
.sec__score.is-none {
  color: var(--text-2);
}
.entry {
  margin-bottom: 10px;
}
/* 只出现一天、或已被新预测取代的，压暗不让它抢注意力 */
.entry.is-weak {
  opacity: 0.7;
}
.entry__head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px 10px;
  margin-bottom: 6px;
}
.entry__date {
  font-size: 17px;
  font-weight: 600;
  color: var(--text-0, #cfd3dc);
}
.entry__when {
  margin-left: auto;
  color: var(--text-2);
  font-size: 12px;
}
.entry__action {
  margin-bottom: 8px;
  padding: 5px 10px;
  border-left: 2px solid rgba(255, 208, 75, 0.45);
  background: rgba(255, 255, 255, 0.03);
  font-size: 13px;
  color: var(--text-1);
}
.entry__tol {
  margin-top: 6px;
  color: var(--text-2);
  font-size: 11px;
  opacity: 0.8;
}
.item {
  padding: 6px 0;
  border-top: 1px dashed var(--border);
}
.item__head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 12.5px;
}
.item__meta {
  color: var(--text-2);
  font-size: 11.5px;
}
.item__meta.is-warn {
  color: #e6a23c;
}
.item__basis {
  margin-left: auto;
  color: var(--text-2);
  font-size: 11px;
  opacity: 0.75;
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item__levels {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 18px;
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--text-2);
}
.side em {
  font-style: normal;
  margin-right: 6px;
  opacity: 0.8;
}
.lv {
  margin-right: 10px;
}
.lv b {
  color: var(--text-1);
  margin-right: 3px;
}
.lv i {
  font-style: normal;
  opacity: 0.7;
}
.lv.is-none {
  opacity: 0.6;
}
/* 成绩条：还没验出准头，措辞与配色都不能显得乐观 */
.reliability {
  margin-bottom: 12px;
  padding: 8px 12px;
  border: 1px solid rgba(230, 162, 60, 0.35);
  border-radius: 6px;
  background: rgba(230, 162, 60, 0.08);
  color: #e6a23c;
  font-size: 12.5px;
  line-height: 1.7;
}
.reliability > div + div {
  margin-top: 4px;
}
.reliability__foot {
  opacity: 0.8;
  font-size: 11.5px;
}
.tag {
  padding: 1px 7px;
  border-radius: 3px;
  font-size: 12px;
  border: 1px solid transparent;
}
/* 实验判断统一用中性描边，不用红绿——红绿会被读成「涨/跌」这种确定性结论 */
.tag.is-exp {
  border-color: rgba(255, 255, 255, 0.2);
  color: var(--text-1);
}
.tag.is-plain {
  border-color: rgba(255, 255, 255, 0.12);
  color: var(--text-2);
}
.tag.is-strong {
  border-color: rgba(255, 208, 75, 0.5);
  background: rgba(255, 208, 75, 0.14);
  color: #ffd04b;
}
.tag.is-warn {
  border-color: rgba(230, 162, 60, 0.35);
  color: #e6a23c;
}
</style>
