<script setup lang="ts">
import { onMounted, ref } from 'vue';
import dayjs from 'dayjs';
import { ElMessage } from 'element-plus';
import { Refresh } from '@element-plus/icons-vue';
import { api } from '@/api';
import type { RealPortfolio } from '@stock-agent/shared';

const pf = ref<RealPortfolio | null>(null);
const loading = ref(false);
const error = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    pf.value = await api.getRealPositions();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    ElMessage.error(error.value);
  } finally {
    loading.value = false;
  }
}

const money = (v: number) =>
  v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (v: number) => (v >= 0 ? '+' : '') + money(v);
const pct = (v: number) => (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
// A股 红涨绿跌：盈利为正 -> up(红)，亏损 -> down(绿)
const dir = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-title">真实持仓</div>
      <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
    </div>
    <div class="page-sub">
      来源：同花顺投资账本 → portfolio-sync → OpenViking 快照（当日盈亏已校正，红涨绿跌）
    </div>

    <template v-if="pf">
      <div class="meta">
        快照时间 {{ dayjs(pf.asOf).format('YYYY-MM-DD HH:mm') }} · 共 {{ pf.positionCount }} 只
      </div>

      <div class="cards">
        <div class="card">
          <div class="card-label">总资产</div>
          <div class="card-value num">{{ money(pf.totalAsset) }}</div>
        </div>
        <div class="card">
          <div class="card-label">持仓市值</div>
          <div class="card-value num">{{ money(pf.totalMarketValue) }}</div>
        </div>
        <div class="card">
          <div class="card-label">可用现金</div>
          <div class="card-value num">{{ money(pf.cash) }}</div>
        </div>
        <div class="card">
          <div class="card-label">当日盈亏</div>
          <div class="card-value num" :class="dir(pf.totalTodayProfit)">
            {{ signed(pf.totalTodayProfit) }}
          </div>
        </div>
        <div class="card">
          <div class="card-label">累计持有盈亏</div>
          <div class="card-value num" :class="dir(pf.totalHoldProfit)">
            {{ signed(pf.totalHoldProfit) }}
          </div>
        </div>
      </div>

      <el-table :data="pf.positions" v-loading="loading" stripe style="width: 100%">
        <el-table-column label="代码" width="92">
          <template #default="{ row }"><span class="num">{{ row.code }}</span></template>
        </el-table-column>
        <el-table-column prop="name" label="名称" min-width="110" />
        <el-table-column label="现价" min-width="92" align="right">
          <template #default="{ row }"><span class="num">{{ row.price }}</span></template>
        </el-table-column>
        <el-table-column label="成本" min-width="92" align="right">
          <template #default="{ row }"><span class="num">{{ row.avgCost }}</span></template>
        </el-table-column>
        <el-table-column label="持仓" min-width="100" align="right">
          <template #default="{ row }"><span class="num">{{ money(row.qty).replace('.00', '') }}</span></template>
        </el-table-column>
        <el-table-column label="市值" min-width="120" align="right">
          <template #default="{ row }"><span class="num">{{ money(row.marketValue) }}</span></template>
        </el-table-column>
        <el-table-column label="当日盈亏" min-width="140" align="right">
          <template #default="{ row }">
            <span class="num" :class="dir(row.todayProfit)">{{ signed(row.todayProfit) }}</span>
            <span class="num sub" :class="dir(row.todayRate)"> {{ pct(row.todayRate) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="持有盈亏" min-width="150" align="right">
          <template #default="{ row }">
            <span class="num" :class="dir(row.holdProfit)">{{ signed(row.holdProfit) }}</span>
            <span class="num sub" :class="dir(row.holdRate)"> {{ pct(row.holdRate) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="仓位" min-width="84" align="right">
          <template #default="{ row }"><span class="num">{{ (row.positionRate * 100).toFixed(1) }}%</span></template>
        </el-table-column>
      </el-table>
    </template>

    <el-empty v-else-if="!loading" :description="error || '暂无持仓快照'" />
  </div>
</template>

<style scoped>
.meta {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 14px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin-bottom: 18px;
}
.card {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
}
.card-label {
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 6px;
}
.card-value {
  font-size: 20px;
  font-weight: 600;
}
.sub {
  font-size: 11.5px;
  opacity: 0.85;
}
</style>
