<script setup lang="ts">
import { onMounted } from 'vue';
import dayjs from 'dayjs';
import { ElMessage } from 'element-plus';
import { api } from '@/api';
import { useCachedResource } from '@/composables/useCachedResource';
import type { MacroOverview } from '@stock-agent/shared';

// 宏观·资金面底稿：低频/EOD 全局指标，10 分钟 TTL（与实时盘面分离）。
const { data: m, loading, refreshing, load, reload } = useCachedResource<MacroOverview>(
  'market:macro',
  () => api.getMacroOverview(),
  { ttlMs: 600_000 },
);

const dir = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const signed = (v: number, d = 2) => (v >= 0 ? '+' : '') + v.toFixed(d);
const signedInt = (v: number) => (v >= 0 ? '+' : '') + Math.round(v).toLocaleString('en-US');

async function refresh() {
  try {
    await reload();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

onMounted(() => void load());
</script>

<template>
  <div class="macro">
    <div class="macro-head">
      <span class="macro-tip">宏观·资金面底稿 · 日频/收盘级低频数据 · 定性为环境背景与护栏，非择时信号</span>
      <el-button size="small" text :loading="loading || refreshing" @click="refresh">刷新</el-button>
    </div>

    <div v-if="m" class="cards">
      <!-- 股指期货基差 -->
      <div class="card">
        <div class="card-title">股指期货基差<span v-if="m.basis" class="card-date">{{ m.basis.asOf }}</span></div>
        <template v-if="m.basis">
          <div class="basis-grid">
            <div v-for="it in m.basis.items" :key="it.name" class="basis-row">
              <span class="basis-name">{{ it.name }}</span>
              <span class="num" :class="dir(it.basis)">{{ signed(it.basis) }}</span>
              <span class="num basis-pct" :class="dir(it.basis)">{{ signed(it.basisPct) }}%</span>
            </div>
          </div>
          <div class="card-note">{{ m.basis.note }}</div>
        </template>
        <div v-else class="card-empty">暂不可用</div>
      </div>

      <!-- 股指期货持仓·中信 / 前20 -->
      <div class="card card-wide">
        <div class="card-title">
          股指期货持仓·中信 / 前20
          <span v-if="m.cffexRank" class="card-date">{{ m.cffexRank.date }} · 收盘 T-1</span>
        </div>
        <template v-if="m.cffexRank && m.cffexRank.items.length">
          <div class="cffex-grid">
            <div class="cffex-row cffex-head">
              <span class="cffex-name">品种</span>
              <span>中信净持仓</span>
              <span>日增减</span>
              <span>前20净持仓</span>
              <span>日增减</span>
            </div>
            <div v-for="it in m.cffexRank.items" :key="it.variety" class="cffex-row">
              <span class="cffex-name">{{ it.name }}</span>
              <span class="num" :class="dir(it.citicNet)">{{ signedInt(it.citicNet) }}</span>
              <span class="num cffex-chg" :class="dir(it.citicNetChg)">{{ signedInt(it.citicNetChg) }}</span>
              <span class="num" :class="dir(it.top20Net)">{{ signedInt(it.top20Net) }}</span>
              <span class="num cffex-chg" :class="dir(it.top20NetChg)">{{ signedInt(it.top20NetChg) }}</span>
            </div>
          </div>
          <div class="card-note">{{ m.cffexRank.note }}</div>
        </template>
        <div v-else class="card-empty">暂不可用</div>
      </div>

      <!-- 资金面 SHIBOR -->
      <div class="card">
        <div class="card-title">资金面 SHIBOR<span v-if="m.shibor" class="card-date">{{ m.shibor.date }}</span></div>
        <template v-if="m.shibor">
          <div class="kv-row">
            <div class="kv"><span class="kv-label">隔夜 O/N</span><span class="kv-val num">{{ m.shibor.overnight ?? '—' }}<small>%</small></span></div>
            <div class="kv"><span class="kv-label">1 周</span><span class="kv-val num">{{ m.shibor.week1 ?? '—' }}<small>%</small></span></div>
          </div>
          <div class="card-note">{{ m.shibor.note }}</div>
        </template>
        <div v-else class="card-empty">暂不可用</div>
      </div>

      <!-- 两融余额 -->
      <div class="card">
        <div class="card-title">两融·融资余额<span v-if="m.margin" class="card-date">{{ m.margin.date }} · {{ m.margin.scope }}</span></div>
        <template v-if="m.margin">
          <div class="kv-row">
            <div class="kv">
              <span class="kv-label">融资余额</span>
              <span class="kv-val num">{{ m.margin.financeBalance.toFixed(0) }}<small>亿</small></span>
            </div>
            <div class="kv">
              <span class="kv-label">较上日</span>
              <span class="kv-val num" :class="dir(m.margin.changeAmount ?? 0)">
                {{ m.margin.changeAmount != null ? signed(m.margin.changeAmount, 1) + '亿' : '—' }}
              </span>
            </div>
            <div class="kv">
              <span class="kv-label">近5日</span>
              <span class="kv-val num" :class="m.margin.trend === '上升' ? 'up' : m.margin.trend === '下降' ? 'down' : ''">{{ m.margin.trend }}</span>
            </div>
          </div>
          <div class="card-note">{{ m.margin.note }}</div>
        </template>
        <div v-else class="card-empty">暂不可用</div>
      </div>

      <!-- 南向资金 -->
      <div class="card">
        <div class="card-title">南向资金<span v-if="m.southbound" class="card-date">{{ m.southbound.date }}</span></div>
        <template v-if="m.southbound">
          <div class="kv-row">
            <div class="kv">
              <span class="kv-label">港股通净{{ m.southbound.netInflow >= 0 ? '流入' : '流出' }}</span>
              <span class="kv-val num" :class="dir(m.southbound.netInflow)">{{ signed(m.southbound.netInflow, 1) }}<small>亿</small></span>
            </div>
          </div>
          <div class="card-note">{{ m.southbound.note }}</div>
        </template>
        <div v-else class="card-empty">暂不可用</div>
      </div>

      <!-- 沪深300 估值分位 -->
      <div class="card">
        <div class="card-title">沪深300 估值分位<span v-if="m.valuation" class="card-date">{{ m.valuation.date }}</span></div>
        <template v-if="m.valuation">
          <div class="kv-row">
            <div class="kv"><span class="kv-label">滚动PE</span><span class="kv-val num">{{ m.valuation.pe }}</span></div>
            <div class="kv">
              <span class="kv-label">历史分位</span>
              <span class="kv-val num" :class="m.valuation.percentile < 30 ? 'up' : m.valuation.percentile > 70 ? 'down' : ''">{{ m.valuation.percentile }}<small>%</small></span>
            </div>
          </div>
          <div class="card-note">{{ m.valuation.note }}</div>
        </template>
        <div v-else class="card-empty">暂不可用</div>
      </div>

      <!-- 最近降准 -->
      <div class="card">
        <div class="card-title">最近降准 RRR</div>
        <template v-if="m.rrr">
          <div class="kv-row">
            <div class="kv"><span class="kv-label">大型机构(调整后)</span><span class="kv-val num">{{ m.rrr.bigBankAfter ?? '—' }}<small>%</small></span></div>
            <div class="kv">
              <span class="kv-label">幅度</span>
              <span class="kv-val num" :class="dir(m.rrr.bigBankDelta ?? 0)">{{ m.rrr.bigBankDelta != null ? signed(m.rrr.bigBankDelta) : '—' }}<small>%</small></span>
            </div>
          </div>
          <div class="rrr-date">{{ m.rrr.announceDate }} 公布 · {{ m.rrr.effectiveDate }} 生效</div>
          <div class="card-note">{{ m.rrr.note }}</div>
        </template>
        <div v-else class="card-empty">暂不可用</div>
      </div>
    </div>

    <el-empty v-else-if="!loading" :image-size="60" description="暂无宏观数据（数据源未连通）" />
  </div>
</template>

<style scoped>
.macro {
  margin-top: 4px;
}
.macro-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.macro-tip {
  font-size: 12px;
  color: var(--text-2);
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 14px;
}
.card {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
}
.card-title {
  font-weight: 600;
  margin-bottom: 10px;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.card-date {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-2);
}
.card-empty {
  font-size: 13px;
  color: var(--text-2);
  padding: 8px 0;
}
.card-note {
  margin-top: 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
  border-top: 1px dashed var(--border);
  padding-top: 8px;
}
.basis-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.basis-row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 10px;
  align-items: baseline;
  font-size: 13px;
}
.basis-name {
  color: var(--text-1);
}
.basis-pct {
  font-size: 12px;
  min-width: 56px;
  text-align: right;
}
.card-wide {
  grid-column: 1 / -1;
}
.cffex-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cffex-row {
  display: grid;
  grid-template-columns: 1.2fr 1fr 1fr 1fr 1fr;
  gap: 10px;
  align-items: baseline;
  font-size: 13px;
}
.cffex-row .num {
  text-align: right;
}
.cffex-head {
  font-size: 11px;
  color: var(--text-2);
  border-bottom: 1px solid var(--border);
  padding-bottom: 4px;
}
.cffex-head span:not(.cffex-name) {
  text-align: right;
}
.cffex-name {
  color: var(--text-1);
}
.cffex-chg {
  font-size: 12px;
}
.kv-row {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}
.kv {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.kv-label {
  font-size: 11px;
  color: var(--text-2);
}
.kv-val {
  font-size: 18px;
  font-weight: 600;
}
.kv-val small {
  font-size: 11px;
  font-weight: 400;
  margin-left: 1px;
}
.rrr-date {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-2);
}
</style>
