<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Refresh, WarningFilled, InfoFilled } from '@element-plus/icons-vue';
import { api } from '@/api';
import {
  SWING_GRADE_LABELS,
  SWING_TRACK_CATEGORY_LABELS,
  type SwingAdvice,
  type SwingOverview,
  type SwingReading,
  type SwingTrackCategory,
} from '@stock-agent/shared';

// 波段观察页。
//
// 三条界面约束是刻意的，改动前请先读明白为什么：
//
// 1) **不按买卖吸引力排序**。按「最值得买」排出来的名单，无论文案怎么写，
//    都会被读成推荐。这里按赛道类别与代码固定排序，看谁有信号靠自己扫一眼。
// 2) **相反证据与支持证据并列展示**，不折叠、不弱化。
//    只看到支持的一面是最容易亏钱的读法。
// 3) **未经检验的提示常显**，不是免责声明而是当前事实：
//    这套判断还没证明比随便挑日子更准，仓位因此被锁在试探规模。
//
// 另外不显示「强度 85%」这类数字给到卡片主位——它会被当成成功概率。
// 力道衰减程度只在展开的依据里以文字出现。

const loading = ref(true);
const scanning = ref(false);
const data = ref<SwingOverview | null>(null);
/** 展开了依据的行 */
const expanded = ref<Set<string>>(new Set());

const rowKey = (r: SwingReading): string => `${r.code}:${r.period ?? ''}`;

async function load() {
  loading.value = true;
  try {
    data.value = await api.swing.overview();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function rescan() {
  scanning.value = true;
  ElMessage.info('开始重新扫描，几百个标的要几分钟，可以先去做别的');
  try {
    const r = await api.swing.scan();
    ElMessage.success(`扫完了：${r.okCount}/${r.targetCount} 个标的成功`);
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    scanning.value = false;
  }
}

function toggle(r: SwingReading) {
  const k = rowKey(r);
  const s = new Set(expanded.value);
  if (s.has(k)) s.delete(k);
  else s.add(k);
  expanded.value = s;
}

/** 快照是不是今天的。不是今天就要显眼提示，否则会把旧建议当成新的 */
const snapshotStale = computed(() => {
  const run = data.value?.run;
  if (!run) return false;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  return run.tradeDate !== today;
});

/** 有信号的行。固定排序：先按赛道类别，再按代码，不按吸引力 */
function signaled(rows: SwingReading[]): SwingReading[] {
  const order: SwingTrackCategory[] = ['industry', 'broad', 'overseas', 'commodity', 'own'];
  return rows
    .filter((r) => r.grade !== 'none')
    .sort(
      (a, b) =>
        order.indexOf(a.category) - order.indexOf(b.category) || a.code.localeCompare(b.code),
    );
}

/** 无信号但有关注价位的行，同样固定排序 */
function quiet(rows: SwingReading[]): SwingReading[] {
  return rows.filter((r) => r.grade === 'none').sort((a, b) => a.code.localeCompare(b.code));
}

const trackSignals = computed(() => signaled(data.value?.tracks ?? []));
const mineSignals = computed(() => signaled(data.value?.mine ?? []));
const trackQuiet = computed(() => quiet(data.value?.tracks ?? []));
const mineQuiet = computed(() => quiet(data.value?.mine ?? []));

/** 周期显示名 */
const periodLabel = (p?: string): string => (p === '60m' ? '60分钟' : p === 'day' ? '日线' : (p ?? ''));

/**
 * 建议仓位与你实际持仓的对照。
 *
 * 不能只看「偏离几个百分点」：建议 0.8% 而实际 0% 只差 0.8 个百分点，
 * 按绝对差值会被判成一致并显示成绿色，可 0% 意味着压根没买。
 * 「没买」和「买得差不多」是两种完全不同的状态，必须分开说。
 */
function realVsAdvice(a: SwingAdvice): { label: string; type: 'success' | 'warning' | 'info' } {
  const real = a.realPositionPct ?? 0;
  if (real <= 0) return { label: '你还没买', type: 'info' };
  const gap = Math.abs(real - a.targetPct);
  if (gap > 1) return { label: `你实际有 ${real}%，和建议差得多`, type: 'warning' };
  return { label: `你实际有 ${real}%`, type: 'success' };
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="swing" v-loading="loading">
    <!-- 未经检验提示：常显，不可关闭 -->
    <el-alert
      v-if="!data?.validation.passed"
      type="warning"
      :closable="false"
      show-icon
      class="mb"
    >
      <template #title>这些提示还没经过检验，只能当参考</template>
      <div class="alert-body">
        <p v-for="(s, i) in data?.validation.shortfalls ?? []" :key="i">{{ s }}</p>
        <p class="hard-truth">
          仓位上限只能限制你亏多少，不能让一个没有优势的判断变成赚钱的判断。
          如果这套规则本身是无效的，每次小亏叠起来仍然是稳定亏损。
        </p>
      </div>
    </el-alert>

    <!-- 快照状态：日期、成功数、失败清单 -->
    <div class="bar">
      <div class="bar-left">
        <template v-if="data?.run">
          <el-tag :type="snapshotStale ? 'warning' : 'success'" size="small">
            {{ data.run.tradeDate }} 收盘后算的
          </el-tag>
          <span class="muted">
            数据到 {{ data.run.dataAsOf ?? '—' }}，扫了
            {{ data.run.okCount }}/{{ data.run.targetCount }} 个标的
          </span>
          <el-tag v-if="snapshotStale" type="warning" size="small" effect="plain">
            不是今天的，今天还没扫过
          </el-tag>
          <el-tag v-if="data.run.status === 'partial'" type="warning" size="small" effect="plain">
            有 {{ data.run.failures.length }} 个标的没取到数据
          </el-tag>
        </template>
        <span v-else class="muted">还没有扫描记录</span>
      </div>
      <el-button :icon="Refresh" :loading="scanning" size="small" @click="rescan">
        重新扫一遍
      </el-button>
    </div>

    <!-- 没取到数据的标的：如实列出，避免被当成「这些没信号」 -->
    <el-collapse v-if="(data?.run?.failures.length ?? 0) > 0" class="mb">
      <el-collapse-item :title="`${data?.run?.failures.length} 个标的今天没取到数据（不等于没信号）`">
        <p v-for="f in data?.run?.failures ?? []" :key="f.code" class="muted small">
          {{ f.code }}：{{ f.reason }}
        </p>
      </el-collapse-item>
    </el-collapse>

    <!-- 系统建议持仓：必须与真实持仓分开显示，不能混成一个数 -->
    <section v-if="(data?.advices.length ?? 0) > 0" class="block">
      <h3>系统建议的持仓（跟踪中）</h3>
      <p class="muted small">
        这是系统按规则算出来的建议，不是你的真实持仓。没照着做也会一直跟，直到止盈或止损。
      </p>
      <div v-for="a in data?.advices ?? []" :key="a.id" class="card advice">
        <div class="card-head">
          <span class="code">{{ a.code }}</span>
          <span class="name">{{ a.name }}</span>
          <el-tag size="small" effect="plain">建议 {{ a.targetPct }}%</el-tag>
          <el-tag
            v-if="a.realPositionPct != null"
            size="small"
            effect="plain"
            :type="realVsAdvice(a).type"
          >
            {{ realVsAdvice(a).label }}
          </el-tag>
          <el-tag v-if="a.firstRHit" size="small" type="success" effect="plain">已减过一半</el-tag>
        </div>
        <div class="zone">
          <span>建议区间 <b>{{ a.zone.low }} ~ {{ a.zone.high }}</b></span>
          <span>建议成本 <b>{{ a.avgCost }}</b></span>
          <span>当初定的止损 <b>{{ a.initialStop }}</b></span>
          <span v-if="a.currentStop !== a.initialStop">
            现在的保护线 <b>{{ a.currentStop }}</b>（只会往上抬，不会往下让）
          </span>
        </div>
        <div class="layers">
          <span v-for="l in a.layers" :key="l.layer" class="muted small">
            第 {{ l.layer }} 层 {{ l.pct }}%，{{ l.at }} 在 {{ l.price }}
          </span>
          <span v-if="a.layers.length === 1" class="muted small">
            第 2 层要等走势确认转向才加，不会因为又跌了就补
          </span>
        </div>
        <div
          v-if="a.realPositionPct != null && a.realPositionPct > 0 && Math.abs(a.realPositionPct - a.targetPct) > 1"
          class="muted small warn-text"
        >
          建议和你实际持有的对不上。后面的减仓提示是按建议算的，实际操作请自己换算。
        </div>
      </div>
    </section>

    <!-- 「正在扫」与「还没扫过」必须分开说：显示成同一句会让人以为坏了，然后重复触发 -->
    <el-alert v-if="data?.scanning" type="info" :closable="false" show-icon class="mb">
      <template #title>正在扫描，几分钟后刷新页面就能看到</template>
      <div class="alert-body">
        <p>几百个标的要逐个取行情，慢的时候要十几分钟。不用重复点。</p>
      </div>
    </el-alert>

    <el-empty
      v-if="!data?.run && !data?.scanning"
      description="还没扫过。点右上角「重新扫一遍」开始"
    />

    <template v-else>
      <!-- 我的持仓与自选 -->
      <section class="block">
        <h3>我的持仓与自选</h3>
        <p v-if="mineSignals.length === 0" class="muted">今天没有出现力道衰减的迹象</p>
        <div v-for="r in mineSignals" :key="rowKey(r)" class="card" @click="toggle(r)">
          <div class="card-head">
            <span class="code">{{ r.code }}</span>
            <span class="name">{{ r.name }}</span>
            <el-tag size="small" effect="plain">{{ periodLabel(r.period) }}</el-tag>
            <el-tag size="small" :type="r.grade.includes('bottom') ? 'info' : 'warning'">
              {{ SWING_GRADE_LABELS[r.grade] }}
            </el-tag>
            <span class="muted small">现价 {{ r.close }}</span>
          </div>
          <div v-if="r.zone" class="zone">
            <span>可以分批的区间 <b>{{ r.zone.low }} ~ {{ r.zone.high }}</b></span>
            <span class="muted small">
              （这个区间是给你下单留的余地，不是预测它会走到哪）
            </span>
            <span v-if="r.initialStop">跌破 <b>{{ r.initialStop }}</b> 就不要了</span>
          </div>
          <div v-if="r.watchLevels.length > 0" class="levels">
            <span
              v-for="l in r.watchLevels"
              :key="`${l.side}:${l.price}`"
              class="level"
              :class="l.side"
            >
              {{ l.side === 'below' ? '下方' : '上方' }} {{ l.price }}
              （差 {{ l.distancePct }}%，{{ l.basis }}）
            </span>
          </div>
          <div v-if="expanded.has(rowKey(r))" class="detail">
            <div class="detail-col">
              <div class="detail-title"><el-icon><InfoFilled /></el-icon> 看到了这些</div>
              <p v-for="(x, i) in r.rationale" :key="i">{{ x }}</p>
            </div>
            <div class="detail-col counter">
              <div class="detail-title"><el-icon><WarningFilled /></el-icon> 但也有相反的情况</div>
              <p v-if="r.counterEvidence.length === 0" class="muted">没有明显相反的证据</p>
              <p v-for="(x, i) in r.counterEvidence" :key="i">{{ x }}</p>
            </div>
          </div>
          <div v-else class="expand-hint muted small">点一下看依据</div>
        </div>
      </section>

      <!-- 赛道 -->
      <section class="block">
        <h3>各赛道（用一只 ETF 代看）</h3>
        <p v-if="trackSignals.length === 0" class="muted">今天各赛道都没有出现力道衰减的迹象</p>
        <div v-for="r in trackSignals" :key="rowKey(r)" class="card" @click="toggle(r)">
          <div class="card-head">
            <el-tag size="small" effect="plain">
              {{ SWING_TRACK_CATEGORY_LABELS[r.category] }}
            </el-tag>
            <span class="track">{{ r.track }}</span>
            <span class="muted small">用 {{ r.name }}（{{ r.code }}）代看</span>
            <el-tag size="small" effect="plain">{{ periodLabel(r.period) }}</el-tag>
            <el-tag size="small" :type="r.grade.includes('bottom') ? 'info' : 'warning'">
              {{ SWING_GRADE_LABELS[r.grade] }}
            </el-tag>
          </div>
          <div v-if="r.peerCount > 1" class="muted small">
            这个赛道有 {{ r.peerCount }} 只 ETF，取的是成交最活跃的这只
          </div>
          <div v-if="r.zone" class="zone">
            <span>可以分批的区间 <b>{{ r.zone.low }} ~ {{ r.zone.high }}</b></span>
            <span v-if="r.initialStop">跌破 <b>{{ r.initialStop }}</b> 就不要了</span>
          </div>
          <div v-if="expanded.has(rowKey(r))" class="detail">
            <div class="detail-col">
              <div class="detail-title"><el-icon><InfoFilled /></el-icon> 看到了这些</div>
              <p v-for="(x, i) in r.rationale" :key="i">{{ x }}</p>
            </div>
            <div class="detail-col counter">
              <div class="detail-title"><el-icon><WarningFilled /></el-icon> 但也有相反的情况</div>
              <p v-if="r.counterEvidence.length === 0" class="muted">没有明显相反的证据</p>
              <p v-for="(x, i) in r.counterEvidence" :key="i">{{ x }}</p>
            </div>
          </div>
          <div v-else class="expand-hint muted small">点一下看依据</div>
        </div>
      </section>

      <!-- 暂时安静的标的：折叠，但要能查到，否则会以为系统没算 -->
      <el-collapse class="mb">
        <el-collapse-item
          :title="`暂时没有信号的 ${trackQuiet.length + mineQuiet.length} 个（系统都算过了）`"
        >
          <div class="quiet-grid">
            <div v-for="r in [...mineQuiet, ...trackQuiet]" :key="rowKey(r)" class="quiet-item">
              <span class="code">{{ r.code }}</span>
              <span class="name">{{ r.name }}</span>
              <span class="muted small">{{ periodLabel(r.period) }}</span>
              <span v-if="r.unavailableReason" class="muted small">
                {{ r.unavailableReason }}
              </span>
              <span v-else-if="r.watchLevels.length > 0" class="muted small">
                下方最近 {{ r.watchLevels.find((l) => l.side === 'below')?.price ?? '—' }}
              </span>
            </div>
          </div>
        </el-collapse-item>
      </el-collapse>
    </template>
  </div>
</template>

<style scoped>
.swing {
  padding: 16px;
}
.mb {
  margin-bottom: 12px;
}
.alert-body p {
  margin: 4px 0;
  line-height: 1.6;
}
.hard-truth {
  margin-top: 8px;
  font-weight: 600;
}
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.bar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.block {
  margin-bottom: 20px;
}
.block h3 {
  margin: 0 0 10px;
  font-size: 15px;
}
/* 卡片不用红绿：交易色会把「观察」读成「买卖」 */
.card {
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
  cursor: pointer;
  background: var(--el-fill-color-blank);
}
.card:hover {
  border-color: var(--el-border-color);
}
.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.code {
  font-family: ui-monospace, monospace;
}
.name,
.track {
  font-weight: 600;
}
.zone {
  margin-top: 6px;
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  align-items: baseline;
}
/* 建议持仓卡片用左边框区分，不用底色——底色容易被读成「买/卖」的红绿 */
.advice {
  border-left: 3px solid var(--el-color-info);
  cursor: default;
}
.layers {
  margin-top: 6px;
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.warn-text {
  margin-top: 6px;
  color: var(--el-color-warning);
}
.levels {
  margin-top: 6px;
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.level {
  font-size: 12px;
  color: var(--el-text-color-regular);
}
.detail {
  margin-top: 10px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
@media (max-width: 720px) {
  .detail {
    grid-template-columns: 1fr;
  }
}
.detail-col p {
  margin: 4px 0;
  font-size: 13px;
  line-height: 1.6;
}
.detail-title {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 4px;
  color: var(--el-text-color-secondary);
}
.expand-hint {
  margin-top: 6px;
}
.muted {
  color: var(--el-text-color-secondary);
}
.small {
  font-size: 12px;
}
.quiet-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 6px;
}
.quiet-item {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: 13px;
}
</style>
