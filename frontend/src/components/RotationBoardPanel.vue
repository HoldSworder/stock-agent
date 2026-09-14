<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import dayjs from 'dayjs';
import { Refresh } from '@element-plus/icons-vue';
import { api } from '@/api';
import StockLink from '@/components/StockLink.vue';
import type {
  RotationBoard,
  RotationBoardHolding,
  SwingOpportunity,
} from '@stock-agent/shared';
import {
  CORE_HOLDING_ACTION_LABELS,
  SWING_GRADE_LABELS,
  SWING_OPPORTUNITY_BASIS_LABELS,
  SWING_OPPORTUNITY_ORIGIN_LABELS,
} from '@stock-agent/shared';

/**
 * 驾驶舱主体：一页答完「今天做什么」。
 *
 * 四段，顺序就是决策顺序，不是按模块排的：
 *   1. 大盘能不能做——阶段建议几成，我实际几成
 *   2. 手上这几只——该走的排最前，其余继续拿着
 *   3. 最近有什么机会——每条带买哪只/什么价位/买多少/什么时候走
 *   4. 换仓怎么排——先卖哪只、钱够不够
 *
 * 四条界面纪律，都是「弄错了会让人亏钱」那类：
 *
 *  1. **「继续拿着」必须明确写出来，而且占最大面积。** 这套打法一年只有几次动作，
 *     绝大多数天数正确答案就是什么都不做。显示成空白会让人以为系统没算，
 *     然后跑去别处找一个动作出来做。
 *  2. **没查完 ≠ 没风险。** 风险列表为空不等于持仓安全，所以没查完的单独排前面。
 *  3. **快照日期常显，不可折叠。** 少了它就会把上一个交易日的结论当成今天的。
 *  4. **给不出数量时说清是哪一种原因，绝不显示成「买 0 份」。**
 */

const board = ref<RotationBoard | null>(null);
const loading = ref(false);
const error = ref('');

async function load(): Promise<void> {
  loading.value = true;
  try {
    board.value = await api.cockpit.rotation();
    error.value = '';
  } catch (e) {
    board.value = null;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const today = () => dayjs().format('YYYY-MM-DD');

/** 没查完的排最前：既不是「安全」也不是「该走」，必须单独可见 */
const unchecked = computed<RotationBoardHolding[]>(() =>
  (board.value?.holdings ?? []).filter((h) => h.blockedReason != null),
);

/** 继续拿着的（已查过的）。这是默认状态，占最大面积 */
const holding = computed<RotationBoardHolding[]>(() =>
  (board.value?.holdings ?? []).filter((h) => h.blockedReason == null && h.action === 'hold'),
);

const exits = computed<RotationBoardHolding[]>(() => board.value?.exits ?? []);

/** 可以按的机会（日线信号 + 给得出数量） */
const actionable = computed<SwingOpportunity[]>(() =>
  (board.value?.opportunities ?? []).filter((o) => o.sizing != null),
);
/** 看着但先别动的（只有 60 分钟出信号、涨过了不追线、算不出数量） */
const watchOnly = computed<SwingOpportunity[]>(() =>
  (board.value?.opportunities ?? []).filter((o) => o.sizing == null),
);

/**
 * 空态要分清四种原因。
 * 「今天没机会」和「今天没跑成」长得一样但意思完全相反。
 */
const emptyReason = computed(() => {
  const b = board.value;
  if (!b) return '';
  if (b.scanning) return '正在扫，等一会再看';
  if (!b.run) return '今天还没扫过，点右上角「重新算」跑一轮';
  if (b.run.status === 'partial') {
    return `扫过了，但有 ${b.run.failures.length} 只没成功；已扫到的里面没有符合条件的机会`;
  }
  return '扫过了，今天没有符合条件的机会——这是正常状态，不用找事做';
});

/** 快照是不是今天的。不是就要明说 */
const snapshotNote = computed(() => {
  const run = board.value?.run;
  if (!run) return '还没有扫描结果';
  const partial = run.status === 'partial' ? `，有 ${run.failures.length} 只没扫成功` : '';
  return run.tradeDate === today()
    ? `用的是今天（${run.tradeDate}）收盘算好的结果${partial}`
    : `用的是 ${run.tradeDate} 的结果，不是今天的${partial}`;
});

const STANCE_TYPE = {
  over: 'warning',
  inside: 'success',
  under: 'primary',
  unknown: 'info',
} as const;

const pct = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
const money = (v: number): string => `${v.toLocaleString('zh-CN')} 元`;
</script>

<template>
  <el-card class="rotation" shadow="never">
    <template #header>
      <div class="hd">
        <div class="hd-main">
          <span class="title">今天做什么</span>
          <!-- 快照日期常显：不可折叠，见组件注释第 3 条 -->
          <el-tag
            size="small"
            :type="board?.run?.tradeDate === today() ? 'success' : 'warning'"
            effect="plain"
          >
            {{ snapshotNote }}
          </el-tag>
          <el-tag v-if="board?.scanning" size="small" type="info" effect="plain">
            正在扫，等一会
          </el-tag>
        </div>
        <el-button :icon="Refresh" size="small" :loading="loading" text @click="load">
          重新算
        </el-button>
      </div>
    </template>

    <el-alert v-if="error" type="error" :closable="false" :title="`看板没算出来：${error}`" />

    <el-alert
      v-for="f in board?.failures ?? []"
      :key="f.source"
      class="mb8"
      type="warning"
      :closable="false"
      show-icon
      :title="`${f.source}：${f.reason}`"
    />

    <!-- ===== 第 1 段 · 大盘能不能做 ===== -->
    <section v-if="board" class="blk market" :class="board.market.stance">
      <h4>大盘</h4>
      <el-alert
        v-if="board.market.unavailableReason"
        type="info"
        :closable="false"
        :title="board.market.unavailableReason"
      />
      <template v-else>
        <div class="row-hd">
          <el-tag size="large" :type="STANCE_TYPE[board.market.stance]" effect="dark">
            {{ board.market.phase }}
          </el-tag>
          <span class="mk-main">建议仓位 {{ board.market.positionRange }}</span>
          <span class="dim">
            后续{{ board.market.tomorrowBias }}｜出手{{ board.market.suggestedFrequency }}
            <template v-if="board.market.tradeDate">｜{{ board.market.tradeDate }} 收盘算的</template>
          </span>
        </div>
        <!-- 这一句才是每天真正要的答案 -->
        <div class="gap">{{ board.market.gapNote }}</div>
        <div class="why">{{ board.market.advice }}</div>
      </template>
    </section>

    <!-- ===== 第 2 段 · 手上这几只 ===== -->
    <section v-if="exits.length" class="blk urgent">
      <h4>该走的（{{ exits.length }} 只）</h4>
      <div v-for="h in exits" :key="h.code" class="row">
        <div class="row-hd">
          <StockLink :code="h.code" :name="h.name" />
          <el-tag size="small" type="danger" effect="dark">
            {{ CORE_HOLDING_ACTION_LABELS[h.action] }}
          </el-tag>
          <span class="dim">
            {{ h.track || '未归到赛道' }}｜仓位 {{ h.realPct }}%｜浮动 {{ pct(h.holdRatePct) }}
          </span>
        </div>
        <div class="why">{{ h.reason }}</div>
      </div>
    </section>

    <section v-if="unchecked.length" class="blk warn">
      <h4>这几只今天没查完（{{ unchecked.length }} 只）</h4>
      <div v-for="h in unchecked" :key="h.code" class="row">
        <div class="row-hd">
          <StockLink :code="h.code" :name="h.name" />
          <span class="dim">仓位 {{ h.realPct }}%｜浮动 {{ pct(h.holdRatePct) }}</span>
        </div>
        <div class="why">{{ h.blockedReason }}</div>
      </div>
    </section>

    <section v-if="board" class="blk">
      <h4>
        继续拿着（{{ holding.length }} 只）
        <span v-if="board.cash" class="dim">｜现金 {{ board.cash.cashPct }}%</span>
      </h4>
      <el-empty
        v-if="!holding.length && !unchecked.length && !exits.length"
        :description="board.run ? '账户里没有赛道 ETF 持仓' : emptyReason"
      />
      <div v-for="h in holding" :key="h.code" class="row hold">
        <div class="row-hd">
          <StockLink :code="h.code" :name="h.name" />
          <el-tag size="small" type="success" effect="plain">继续拿着</el-tag>
          <span class="dim">
            {{ h.track || '未归到赛道' }}｜仓位 {{ h.realPct }}%｜浮动 {{ pct(h.holdRatePct) }}
          </span>
          <el-tag v-if="h.grade !== 'none'" size="small" type="warning" effect="plain">
            {{ SWING_GRADE_LABELS[h.grade] }}
          </el-tag>
        </div>
        <div class="trigger">{{ h.nextTrigger }}</div>
        <div class="why">{{ h.reason }}</div>
        <div v-if="h.structureLine != null" class="line">
          保护价 {{ h.structureLine }}（{{ h.structureBasis }}），现价还有
          {{ h.distanceToLinePct?.toFixed(1) }}% 的距离
        </div>
      </div>
    </section>

    <!-- ===== 第 3 段 · 最近有什么机会 ===== -->
    <section v-if="board" class="blk">
      <h4>
        最近的机会（{{ actionable.length }} 个可以按）
        <span v-if="board.opportunitiesOmitted > 0" class="dim">
          ｜还有 {{ board.opportunitiesOmitted }} 个没列出来，先看最强的这几个
        </span>
      </h4>
      <el-empty v-if="!actionable.length && !watchOnly.length" :description="emptyReason" />

      <div v-for="o in actionable" :key="`a-${o.code}`" class="row opp">
        <!-- 买哪只 -->
        <div class="row-hd">
          <StockLink :code="o.code" :name="o.name" />
          <el-tag size="small" type="primary" effect="dark">{{ SWING_GRADE_LABELS[o.grade] }}</el-tag>
          <span class="dim">
            {{ o.track }}
            <template v-if="o.isTrackProxy && o.peerCount > 1">
              （这个赛道有 {{ o.peerCount }} 只，取最活跃的这只）
            </template>
            ｜{{ SWING_OPPORTUNITY_ORIGIN_LABELS[o.origin] }}
          </span>
        </div>

        <!-- 买多少：第一眼要看到的就是这一行 -->
        <div v-if="o.sizing" class="buy">
          买 {{ o.sizing.shares }} 份，约 {{ money(o.sizing.amount) }}（占总资产
          {{ o.sizing.allowedPct }}%）
        </div>
        <div v-if="o.sizing" class="why">{{ o.sizing.note }}</div>

        <!-- 什么价位 -->
        <div class="line">
          <template v-if="o.zone">
            买入区间 {{ o.zone.low }}~{{ o.zone.high }}（下单不用纠结精确价位的容差，不是说它会走到这里）
          </template>
          <template v-if="o.chaseGuard != null">
            ｜涨过 {{ o.chaseGuard }} 就别追了
          </template>
        </div>

        <!-- 什么时候走 -->
        <div class="line">
          跌破 {{ o.initialStop }} 走人
          <template v-if="o.firstRTarget != null">
            ｜涨到 {{ o.firstRTarget }} 先减一半（赚的等于当初打算亏的）
          </template>
          ｜{{ o.timeStopTradeDays }} 个交易日没走出预期就撤
        </div>

        <div v-if="o.intradayHint" class="line dim">
          60 分钟线也出了信号（{{ SWING_GRADE_LABELS[o.intradayHint.grade] }}），两个周期同向
        </div>

        <!-- 凭什么：依据和反证一起给 -->
        <ul class="pts">
          <li v-for="(r, i) in o.rationale.slice(0, 3)" :key="`r${i}`">{{ r }}</li>
          <li v-for="(r, i) in o.counterEvidence.slice(0, 2)" :key="`c${i}`" class="counter">
            反过来看：{{ r }}
          </li>
        </ul>
      </div>

      <!-- 看着但先别动手：不给数量，并说清是哪一种原因 -->
      <div v-if="watchOnly.length" class="sub">
        <h5>先看着，这几个还不到动手的时候（{{ watchOnly.length }} 个）</h5>
        <div v-for="o in watchOnly" :key="`w-${o.code}`" class="row">
          <div class="row-hd">
            <StockLink :code="o.code" :name="o.name" />
            <el-tag size="small" type="info" effect="plain">
              {{ SWING_OPPORTUNITY_BASIS_LABELS[o.basis] }}
            </el-tag>
            <span class="dim">{{ o.track }}</span>
          </div>
          <div class="why">{{ o.sizingUnavailable }}</div>
        </div>
      </div>
    </section>

    <!-- ===== 第 4 段 · 换仓怎么排 ===== -->
    <section v-if="board?.swaps.length" class="blk">
      <h4>换仓怎么做</h4>
      <div v-for="s in board.swaps" :key="`${s.out.code}-${s.into.code}`" class="row">
        <div class="row-hd">
          <span class="swap">{{ s.out.name }} → {{ s.into.name }}</span>
          <el-tag size="small" :type="s.needsSaleFirst ? 'warning' : 'info'" effect="plain">
            {{ s.needsSaleFirst ? '要先卖再买' : '现金够，可直接买' }}
          </el-tag>
          <span v-if="s.freedAmount > 0" class="dim">卖出大约释放 {{ money(s.freedAmount) }}</span>
        </div>
        <div class="why">{{ s.note }}</div>
      </div>
    </section>
  </el-card>
</template>

<style scoped>
.rotation {
  margin-bottom: 12px;
}
.hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.hd-main {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.title {
  font-size: 16px;
  font-weight: 600;
}
.blk + .blk {
  margin-top: 16px;
}
.blk h4 {
  margin: 0 0 8px;
  font-size: 14px;
}
.sub {
  margin-top: 10px;
}
.sub h5 {
  margin: 0 0 6px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.row {
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
}
.row + .row {
  margin-top: 6px;
}
.row-hd {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.market {
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
}
.market.over {
  background: var(--el-color-warning-light-9);
}
.mk-main {
  font-size: 15px;
  font-weight: 600;
}
.gap {
  margin-top: 6px;
  font-size: 14px;
  font-weight: 600;
}
.urgent .row {
  background: var(--el-color-danger-light-9);
}
.warn .row {
  background: var(--el-color-warning-light-9);
}
.opp {
  background: var(--el-color-primary-light-9);
}
.buy {
  margin-top: 6px;
  font-size: 15px;
  font-weight: 600;
}
.trigger {
  margin-top: 4px;
  font-size: 13px;
  font-weight: 600;
}
.why,
.line {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-regular);
}
.dim {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.swap {
  font-weight: 600;
}
.pts {
  margin: 4px 0 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--el-text-color-regular);
}
.counter {
  color: var(--el-text-color-secondary);
}
.mb8 {
  margin-bottom: 8px;
}
</style>
