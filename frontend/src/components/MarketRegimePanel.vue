<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Refresh } from '@element-plus/icons-vue';
import { api } from '@/api';
import type {
  MarketRegimeBias,
  MarketRegimeHistoryItem,
  MarketRegimeOverview,
  MarketRegimePhase,
} from '@stock-agent/shared';

// 大盘阶段·完整面板（大盘页常驻）：阶段 + 强度分 + 明日展望 + 驱动/风险 + 6维度打分 + 权重指数表 +
// 全A等权vs权重背离 + 近30日走势。确定性只读，仅供参考不构成投资建议。

const overview = ref<MarketRegimeOverview | null>(null);
const history = ref<MarketRegimeHistoryItem[]>([]);
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    const [ov, his] = await Promise.all([api.regime.overview(), api.regime.history(30).catch(() => [])]);
    overview.value = ov;
    history.value = his;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}
onMounted(load);

// A股红涨绿跌语义：主升红、反弹橙、退潮绿、震荡灰
const PHASE_META: Record<MarketRegimePhase, { cls: string; icon: string }> = {
  主升: { cls: 'up', icon: '▲' },
  反弹: { cls: 'warn', icon: '↗' },
  退潮: { cls: 'down', icon: '▼' },
  震荡: { cls: 'flat', icon: '↔' },
};
const BIAS_CLS: Record<MarketRegimeBias, string> = { 偏强: 'up', 偏弱: 'down', 中性: 'flat' };
const phaseCls = (p: MarketRegimePhase) => PHASE_META[p].cls;

const ov = computed(() => overview.value);
const phaseMeta = computed(() => (ov.value ? PHASE_META[ov.value.phase] : PHASE_META['震荡']));
const barColor = (v: number) => (v >= 65 ? 'up' : v >= 45 ? 'warn' : 'down');

// ===== HMM 影子信号（概率视角，与规则四态相互印证）=====
const hmm = computed(() => ov.value?.hmm ?? null);
/** 隐状态配色：强势红 / 震荡灰 / 弱势绿（A股红涨绿跌语义） */
const hmmStateCls = (s: string) => (s === '强势' ? 'up' : s === '弱势' ? 'down' : 'flat');
/** 规则四态 × HMM 三态的印证/分歧判定（分歧即预警） */
const hmmCheck = computed<{ cls: 'ok' | 'warn' | 'flat'; text: string } | null>(() => {
  const o = ov.value;
  const h = o?.hmm;
  if (!o || !h) return null;
  const ruleStrong = o.phase === '主升' || (o.phase === '反弹' && o.tomorrowBias === '偏强');
  const ruleWeak = o.phase === '退潮';
  if ((ruleStrong && h.state === '强势') || (ruleWeak && h.state === '弱势')) {
    return { cls: 'ok', text: `规则判「${o.phase}」，HMM 同判「${h.state}」（强势概率 ${h.probs.强势}%），方向一致、相互印证。` };
  }
  if ((ruleStrong && h.state === '弱势') || (ruleWeak && h.state === '强势')) {
    return { cls: 'warn', text: `规则判「${o.phase}」但 HMM 判「${h.state}」（弱势概率 ${h.probs.弱势}%），两者背离，警惕伪信号，等共振再动手。` };
  }
  return { cls: 'flat', text: `规则判「${o.phase}」，HMM 判「${h.state}」（强弱读数 ${h.strength}/100），无强共振，方向偏中性、观望为宜。` };
});

// ===== 近30日走势 SVG sparkline（分数折线 + 按阶段着色圆点）=====
const W = 520;
const H = 68;
const PAD = 6;
const chart = computed(() => {
  const items = [...history.value].reverse(); // 接口倒序 → 转为时间升序
  if (items.length < 2) return null;
  const n = items.length;
  const xs = (i: number) => PAD + (i * (W - 2 * PAD)) / (n - 1);
  const ys = (s: number) => H - PAD - (Math.max(0, Math.min(100, s)) / 100) * (H - 2 * PAD);
  const pts = items.map((it, i) => ({ x: xs(i), y: ys(it.score), phase: it.phase, score: it.score, date: it.tradeDate }));
  const line = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  return { pts, line, mid: ys(50) };
});
</script>

<template>
  <section v-loading="loading" class="regime-panel">
    <div v-if="ov">
      <!-- 头部 -->
      <div class="rp-head" :class="phaseMeta.cls">
        <div class="rp-phase-box">
          <div class="rp-phase-lbl">大盘阶段</div>
          <div class="rp-phase">{{ phaseMeta.icon }} {{ ov.phase }}</div>
          <div class="rp-cont">已持续 {{ ov.consecutiveDays }} 个交易日</div>
        </div>
        <div class="rp-score-box">
          <div class="rp-score num">{{ ov.score }}<span class="rp-unit">/100</span></div>
          <div v-if="ov.delta != null" class="rp-delta num" :class="ov.delta >= 0 ? 'up' : 'down'">
            较昨 {{ ov.delta >= 0 ? '+' : '' }}{{ ov.delta }}
          </div>
        </div>
        <div class="rp-kv-box">
          <div class="rp-kv">
            <span class="rp-kv-l">明日倾向</span>
            <span class="rp-kv-v" :class="BIAS_CLS[ov.tomorrowBias]">{{ ov.tomorrowBias }}</span>
          </div>
          <div class="rp-kv">
            <span class="rp-kv-l">建议交易</span>
            <span class="rp-kv-v">{{ ov.suggestedFrequency }}</span>
          </div>
          <div class="rp-kv">
            <span class="rp-kv-l">建议仓位</span>
            <span class="rp-kv-v">{{ ov.positionRange }}</span>
          </div>
        </div>
        <el-button class="rp-refresh" :icon="Refresh" text size="small" :loading="loading" @click="load">刷新</el-button>
      </div>

      <!-- 明日及后续展望 -->
      <div class="rp-outlook">
        <span class="rp-tag">明日及后续展望</span>
        <span class="rp-outlook-text">{{ ov.outlook }}</span>
      </div>

      <!-- 驱动 / 风险 -->
      <div class="rp-dr">
        <div class="rp-dr-col">
          <div class="rp-dr-title up">驱动因素</div>
          <div class="rp-chips">
            <el-tag v-for="d in ov.drivers" :key="d" size="small" type="danger" effect="light">{{ d }}</el-tag>
            <span v-if="!ov.drivers.length" class="rp-empty">暂无明显正向驱动</span>
          </div>
        </div>
        <div class="rp-dr-col">
          <div class="rp-dr-title warn">风险提示</div>
          <div class="rp-chips">
            <el-tag v-for="r in ov.risks" :key="r" size="small" type="warning" effect="light">{{ r }}</el-tag>
            <span v-if="!ov.risks.length" class="rp-empty">暂无显著风险</span>
          </div>
        </div>
      </div>

      <div class="rp-grid">
        <!-- 六维度打分 -->
        <div class="rp-block">
          <div class="rp-block-title">维度打分（综合 {{ ov.score }}/100）</div>
          <div v-for="d in ov.dimensions" :key="d.key" class="rp-dim">
            <div class="rp-dim-row">
              <span class="rp-dim-lbl">{{ d.label }}</span>
              <span class="rp-dim-w">权重{{ d.weight }}%</span>
              <span class="rp-dim-score num" :class="barColor(d.rawScore)">{{ d.rawScore }}</span>
            </div>
            <div class="rp-bar"><div class="rp-bar-fill" :class="barColor(d.rawScore)" :style="{ width: d.rawScore + '%' }" /></div>
            <div class="rp-dim-read">{{ d.reading }}<span class="rp-dim-ev">· {{ d.evidence }}</span></div>
          </div>
        </div>

        <div class="rp-block">
          <!-- 权重指数表 -->
          <div class="rp-block-title">权重指数结构</div>
          <el-table :data="ov.indices" size="small" stripe>
            <el-table-column label="指数" min-width="82">
              <template #default="{ row }"><span class="rp-idx-n">{{ row.name }}</span></template>
            </el-table-column>
            <el-table-column label="排列" width="76" align="center">
              <template #default="{ row }">
                <span :class="row.alignment === '多头排列' ? 'up' : row.alignment === '空头排列' ? 'down' : 'flat'">{{ row.alignment }}</span>
              </template>
            </el-table-column>
            <el-table-column label="MA20/60" width="86" align="center">
              <template #default="{ row }">
                <span :class="row.aboveMa20 ? 'up' : 'down'">{{ row.aboveMa20 ? '上' : '下' }}</span>
                <span class="rp-slash">/</span>
                <span :class="row.aboveMa60 ? 'up' : 'down'">{{ row.aboveMa60 ? '上' : '下' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="近20日" width="76" align="right">
              <template #default="{ row }">
                <span class="num" :class="row.trendPct20 >= 0 ? 'up' : 'down'">{{ row.trendPct20 >= 0 ? '+' : '' }}{{ row.trendPct20 }}%</span>
              </template>
            </el-table-column>
          </el-table>

          <!-- 全A等权 vs 权重 背离 -->
          <div v-if="ov.equalWeight" class="rp-eqw">
            <span class="rp-tag">等权口径 · {{ ov.equalWeight.name }}</span>
            <span :class="ov.equalWeight.aboveMa60 ? 'up' : 'down'">{{ ov.equalWeight.aboveMa60 ? '站上MA60' : '失守MA60' }}</span>
            <span class="num" :class="ov.equalWeight.trendPct20 >= 0 ? 'up' : 'down'">20日{{ ov.equalWeight.trendPct20 >= 0 ? '+' : '' }}{{ ov.equalWeight.trendPct20 }}%</span>
            <span v-if="ov.equalWeight.upRatio != null" class="num">涨占比{{ ov.equalWeight.upRatio }}%</span>
          </div>
          <div class="rp-diverge" :class="ov.divergence.active ? 'warn' : ''">
            <b>权重vs等权：</b>{{ ov.divergence.note }}
          </div>
        </div>
      </div>

      <!-- HMM 概率视角（隐马尔可夫，与规则四态并列印证；取不到不渲染） -->
      <div v-if="hmm" class="rp-block rp-hmm">
        <div class="rp-block-title">
          HMM 概率视角
          <span class="rp-hmm-sub">隐马尔可夫 · 全A等权{{ hmm.symbol }} · {{ hmm.window }}日现训 · 与规则四态相互印证</span>
        </div>
        <div class="rp-hmm-top">
          <div class="rp-hmm-state" :class="hmmStateCls(hmm.state)">当前隐状态 <b>{{ hmm.state }}</b></div>
          <div class="rp-hmm-strength">
            强弱读数 <span class="num" :class="barColor(hmm.strength)">{{ hmm.strength }}</span><span class="rp-unit">/100</span>
          </div>
        </div>
        <div class="rp-hmm-probs">
          <div class="rp-hmm-prob">
            <div class="rp-hmm-prob-row"><span>强势</span><span class="num up">{{ hmm.probs.强势 }}%</span></div>
            <div class="rp-bar"><div class="rp-bar-fill up" :style="{ width: hmm.probs.强势 + '%' }" /></div>
          </div>
          <div class="rp-hmm-prob">
            <div class="rp-hmm-prob-row"><span>震荡</span><span class="num flat">{{ hmm.probs.震荡 }}%</span></div>
            <div class="rp-bar"><div class="rp-bar-fill flat" :style="{ width: hmm.probs.震荡 + '%' }" /></div>
          </div>
          <div class="rp-hmm-prob">
            <div class="rp-hmm-prob-row"><span>弱势</span><span class="num down">{{ hmm.probs.弱势 }}%</span></div>
            <div class="rp-bar"><div class="rp-bar-fill down" :style="{ width: hmm.probs.弱势 + '%' }" /></div>
          </div>
        </div>
        <div v-if="hmmCheck" class="rp-diverge" :class="hmmCheck.cls === 'warn' ? 'warn' : ''">
          <b>规则 × HMM：</b>{{ hmmCheck.text }}
        </div>
      </div>

      <!-- 近30日走势 -->
      <div class="rp-block">
        <div class="rp-block-title">近 {{ history.length }} 个交易日强度分走势</div>
        <svg v-if="chart" class="rp-spark" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none">
          <line :x1="0" :y1="chart.mid" :x2="W" :y2="chart.mid" class="rp-spark-mid" />
          <polyline :points="chart.line" class="rp-spark-line" />
          <circle v-for="(p, i) in chart.pts" :key="i" :cx="p.x" :cy="p.y" r="2.6" :class="'dot-' + phaseCls(p.phase)">
            <title>{{ p.date }} · {{ p.phase }} · {{ p.score }}</title>
          </circle>
        </svg>
        <div v-else class="rp-empty">历史数据不足（每日打开或收盘快照后逐步积累）</div>
        <div class="rp-legend">
          <span class="lg"><i class="dot-up" />主升</span>
          <span class="lg"><i class="dot-warn" />反弹</span>
          <span class="lg"><i class="dot-down" />退潮</span>
          <span class="lg"><i class="dot-flat" />震荡</span>
          <span class="lg-mid">中线=50 分</span>
        </div>
      </div>

      <p class="rp-note">{{ ov.advice }}</p>
      <p class="rp-foot">{{ ov.note }}</p>
    </div>
    <el-empty v-else-if="!loading" :image-size="60" description="大盘阶段数据暂不可用" />
  </section>
</template>

<style scoped>
.regime-panel {
  border: 1px solid var(--el-border-color-light);
  border-radius: 10px;
  padding: 14px 16px;
  margin-bottom: 14px;
  background: var(--el-bg-color);
}
/* 头部 */
.rp-head {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
  padding: 10px 14px;
  border-radius: 8px;
  border-left: 5px solid var(--el-color-info);
  background: var(--el-fill-color-lighter);
}
.rp-head.up { border-left-color: var(--el-color-danger); }
.rp-head.warn { border-left-color: var(--el-color-warning); }
.rp-head.down { border-left-color: var(--el-color-success); }
.rp-head.flat { border-left-color: var(--el-color-info); }
.rp-phase-lbl { font-size: 12px; color: var(--el-text-color-secondary); }
.rp-phase { font-size: 26px; font-weight: 800; line-height: 1.15; }
.rp-head.up .rp-phase { color: var(--el-color-danger); }
.rp-head.warn .rp-phase { color: var(--el-color-warning); }
.rp-head.down .rp-phase { color: var(--el-color-success); }
.rp-head.flat .rp-phase { color: var(--el-color-info); }
.rp-cont { font-size: 12px; color: var(--el-text-color-secondary); }
.rp-score-box { text-align: center; }
.rp-score { font-size: 30px; font-weight: 800; }
.rp-unit { font-size: 13px; font-weight: 400; color: var(--el-text-color-secondary); }
.rp-delta { font-size: 12px; }
.rp-kv-box { display: flex; gap: 18px; }
.rp-kv { display: flex; flex-direction: column; gap: 2px; }
.rp-kv-l { font-size: 12px; color: var(--el-text-color-secondary); }
.rp-kv-v { font-size: 16px; font-weight: 700; }
.rp-refresh { margin-left: auto; align-self: flex-start; }
/* 展望 */
.rp-outlook { margin: 12px 0 8px; font-size: 13px; line-height: 1.7; }
.rp-tag {
  display: inline-block;
  font-size: 12px;
  font-weight: 700;
  color: var(--el-color-primary);
  margin-right: 8px;
}
.rp-outlook-text { color: var(--el-text-color-regular); }
/* 驱动/风险 */
.rp-dr { display: flex; gap: 24px; flex-wrap: wrap; margin: 8px 0 12px; }
.rp-dr-col { flex: 1; min-width: 240px; }
.rp-dr-title { font-size: 12px; font-weight: 700; margin-bottom: 6px; }
.rp-dr-title.up { color: var(--el-color-danger); }
.rp-dr-title.warn { color: var(--el-color-warning); }
.rp-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.rp-empty { color: var(--el-text-color-secondary); font-size: 12px; }
/* 两栏 */
.rp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 12px; }
@media (max-width: 900px) { .rp-grid { grid-template-columns: 1fr; } }
.rp-block-title { font-size: 13px; font-weight: 700; margin: 6px 0 8px; }
/* 维度条 */
.rp-dim { margin-bottom: 9px; }
.rp-dim-row { display: flex; align-items: baseline; gap: 8px; }
.rp-dim-lbl { font-size: 13px; font-weight: 600; }
.rp-dim-w { font-size: 11px; color: var(--el-text-color-secondary); }
.rp-dim-score { margin-left: auto; font-weight: 700; }
.rp-bar { height: 6px; border-radius: 3px; background: var(--el-fill-color); margin: 4px 0 3px; overflow: hidden; }
.rp-bar-fill { height: 100%; border-radius: 3px; }
.rp-bar-fill.up { background: var(--el-color-danger); }
.rp-bar-fill.warn { background: var(--el-color-warning); }
.rp-bar-fill.down { background: var(--el-color-success); }
.rp-bar-fill.flat { background: var(--el-color-info); }
/* HMM 概率视角 */
.rp-hmm-sub { font-size: 11px; font-weight: 400; color: var(--el-text-color-secondary); margin-left: 8px; }
.rp-hmm-top { display: flex; align-items: baseline; gap: 20px; margin-bottom: 8px; }
.rp-hmm-state { font-size: 14px; color: var(--el-text-color-regular); }
.rp-hmm-state b { font-size: 18px; font-weight: 800; margin-left: 4px; }
.rp-hmm-state.up b { color: var(--el-color-danger); }
.rp-hmm-state.down b { color: var(--el-color-success); }
.rp-hmm-state.flat b { color: var(--el-text-color-secondary); }
.rp-hmm-strength { font-size: 13px; color: var(--el-text-color-secondary); }
.rp-hmm-strength .num { font-size: 18px; font-weight: 800; }
.rp-hmm-probs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 8px; }
@media (max-width: 640px) { .rp-hmm-probs { grid-template-columns: 1fr; } }
.rp-hmm-prob-row { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 3px; }
.rp-dim-read { font-size: 12px; color: var(--el-text-color-regular); }
.rp-dim-ev { color: var(--el-text-color-secondary); margin-left: 4px; }
.rp-idx-n { font-weight: 600; }
.rp-slash { color: var(--el-text-color-placeholder); margin: 0 2px; }
/* 等权 / 背离 */
.rp-eqw { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; margin: 10px 0 6px; font-size: 13px; }
.rp-diverge { font-size: 12px; padding: 6px 8px; border-radius: 5px; background: var(--el-fill-color-light); line-height: 1.6; }
.rp-diverge.warn { background: var(--el-color-warning-light-9); color: var(--el-color-warning); }
/* sparkline */
.rp-spark { width: 100%; height: 72px; display: block; }
.rp-spark-line { fill: none; stroke: var(--el-color-primary); stroke-width: 1.6; }
.rp-spark-mid { stroke: var(--el-border-color); stroke-width: 1; stroke-dasharray: 3 3; }
.dot-up { fill: var(--el-color-danger); }
.dot-warn { fill: var(--el-color-warning); }
.dot-down { fill: var(--el-color-success); }
.dot-flat { fill: var(--el-color-info); }
.rp-legend { display: flex; gap: 14px; align-items: center; margin-top: 4px; font-size: 12px; color: var(--el-text-color-secondary); }
.rp-legend .lg { display: inline-flex; align-items: center; gap: 4px; }
.rp-legend i { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.rp-legend i.dot-up { background: var(--el-color-danger); }
.rp-legend i.dot-warn { background: var(--el-color-warning); }
.rp-legend i.dot-down { background: var(--el-color-success); }
.rp-legend i.dot-flat { background: var(--el-color-info); }
.rp-legend .lg-mid { margin-left: auto; }
/* 底部 */
.rp-note { margin: 10px 0 2px; font-size: 13px; color: var(--el-text-color-regular); line-height: 1.7; }
.rp-foot { margin: 0; font-size: 11px; color: var(--el-text-color-placeholder); }
/* 通用色 */
.num { font-variant-numeric: tabular-nums; }
.up { color: var(--el-color-danger); }
.down { color: var(--el-color-success); }
.warn { color: var(--el-color-warning); }
.flat { color: var(--el-text-color-secondary); }
</style>
