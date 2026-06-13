<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import dayjs from 'dayjs';
import { ElMessage } from 'element-plus';
import { Refresh, MagicStick } from '@element-plus/icons-vue';
import { api } from '@/api';
import AiAnalysisDialog from '@/components/AiAnalysisDialog.vue';
import StockLink from '@/components/StockLink.vue';
import type { RealPortfolio } from '@stock-agent/shared';

const pf = ref<RealPortfolio | null>(null);
const loading = ref(false);
const error = ref('');
// 实时持仓 AI 分析弹窗（公共组件，流式轨迹 + 历史）
const analysisOpen = ref(false);
// 当日清仓折叠面板：默认收起（v-model 为空数组）
const closedExpand = ref<string[]>([]);
// 持仓分组 Tab：默认股票
const activeTab = ref<'stock' | 'fund'>('stock');

const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);

// 股票分组统计：现金/总资产归入股票账户口径
const stockStats = computed(() => {
  const p = pf.value;
  if (!p) return { marketValue: 0, todayProfit: 0, holdProfit: 0, asset: 0 };
  const marketValue = p.totalMarketValue - p.fundMarketValue;
  return {
    marketValue,
    todayProfit: sum(p.positions.map((x) => x.todayProfit)),
    holdProfit: sum(p.positions.map((x) => x.holdProfit)),
    asset: marketValue + p.cash,
  };
});

// 场外基金分组统计：基金无独立现金
const fundStats = computed(() => {
  const p = pf.value;
  if (!p) return { marketValue: 0, todayProfit: 0, holdProfit: 0 };
  return {
    marketValue: p.fundMarketValue,
    todayProfit: sum(p.funds.map((x) => x.todayProfit)),
    holdProfit: sum(p.funds.map((x) => x.holdProfit)),
  };
});

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
      <div class="head-actions">
        <el-button :icon="MagicStick" type="primary" @click="analysisOpen = true">
          实时持仓分析
        </el-button>
        <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
      </div>
    </div>
    <div class="page-sub">
      来源：同花顺投资账本接口（股票实时报价 + 场外基金账本净值，红涨绿跌）
    </div>

    <template v-if="pf">
      <div class="meta">
        快照时间 {{ dayjs(pf.asOf).format('YYYY-MM-DD HH:mm') }} · 共 {{ pf.positionCount }} 只
      </div>

      <el-tabs v-model="activeTab" class="pos-tabs">
        <el-tab-pane :label="`股票 (${pf.positions.length})`" name="stock">
          <div class="cards">
            <div class="card">
              <div class="card-label">股票总资产</div>
              <div class="card-value num">{{ money(stockStats.asset) }}</div>
            </div>
            <div class="card">
              <div class="card-label">股票市值</div>
              <div class="card-value num">{{ money(stockStats.marketValue) }}</div>
            </div>
            <div class="card">
              <div class="card-label">可用现金</div>
              <div class="card-value num">{{ money(pf.cash) }}</div>
            </div>
            <div class="card">
              <div class="card-label">当日盈亏</div>
              <div class="card-value num" :class="dir(stockStats.todayProfit)">
                {{ signed(stockStats.todayProfit) }}
              </div>
            </div>
            <div class="card">
              <div class="card-label">累计持有盈亏</div>
              <div class="card-value num" :class="dir(stockStats.holdProfit)">
                {{ signed(stockStats.holdProfit) }}
              </div>
            </div>
          </div>

          <el-table :data="pf.positions" v-loading="loading" stripe style="width: 100%">
            <el-table-column label="代码" width="92">
              <template #default="{ row }">
                <StockLink :code="row.code" :name="row.name" show="code" class="num" />
              </template>
            </el-table-column>
            <el-table-column label="名称" min-width="110">
              <template #default="{ row }">
                <StockLink :code="row.code" :name="row.name" />
              </template>
            </el-table-column>
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

          <el-collapse v-if="pf.closedToday.length" v-model="closedExpand" class="closed">
            <el-collapse-item name="closed" :title="`当日清仓 (${pf.closedToday.length})`">
              <el-table :data="pf.closedToday" stripe style="width: 100%">
                <el-table-column label="代码" width="92">
                  <template #default="{ row }">
                    <StockLink :code="row.code" :name="row.name" show="code" class="num" />
                  </template>
                </el-table-column>
                <el-table-column label="名称" min-width="110">
                  <template #default="{ row }">
                    <StockLink :code="row.code" :name="row.name" />
                  </template>
                </el-table-column>
                <el-table-column label="成本" min-width="92" align="right">
                  <template #default="{ row }"><span class="num">{{ row.avgCost }}</span></template>
                </el-table-column>
                <el-table-column label="清仓盈亏" min-width="150" align="right">
                  <template #default="{ row }">
                    <span class="num" :class="dir(row.holdProfit)">{{ signed(row.holdProfit) }}</span>
                    <span class="num sub" :class="dir(row.holdRate)"> {{ pct(row.holdRate) }}</span>
                  </template>
                </el-table-column>
                <el-table-column label="持仓天数" min-width="92" align="right">
                  <template #default="{ row }"><span class="num">{{ row.holdDays }}</span></template>
                </el-table-column>
              </el-table>
            </el-collapse-item>
          </el-collapse>
        </el-tab-pane>

        <el-tab-pane v-if="pf.funds.length" :label="`场外基金 (${pf.funds.length})`" name="fund">
          <div class="cards">
            <div class="card">
              <div class="card-label">基金市值</div>
              <div class="card-value num">{{ money(fundStats.marketValue) }}</div>
            </div>
            <div class="card">
              <div class="card-label">当日盈亏</div>
              <div class="card-value num" :class="dir(fundStats.todayProfit)">
                {{ signed(fundStats.todayProfit) }}
              </div>
            </div>
            <div class="card">
              <div class="card-label">累计持有盈亏</div>
              <div class="card-value num" :class="dir(fundStats.holdProfit)">
                {{ signed(fundStats.holdProfit) }}
              </div>
            </div>
          </div>

          <div class="section-sub">蚂蚁财富等 · 同花顺账本净值</div>
          <el-table :data="pf.funds" stripe style="width: 100%">
            <el-table-column label="代码" width="92">
              <template #default="{ row }"><span class="num">{{ row.code }}</span></template>
            </el-table-column>
            <el-table-column label="名称" min-width="160">
              <template #default="{ row }">{{ row.name }}</template>
            </el-table-column>
            <el-table-column label="净值" min-width="110" align="right">
              <template #default="{ row }">
                <span v-if="row.estAvailable" class="num">{{ row.nav }}</span>
                <span v-else class="num sub">净值缺失</span>
              </template>
            </el-table-column>
            <el-table-column label="成本净值" min-width="100" align="right">
              <template #default="{ row }"><span class="num">{{ row.costNav }}</span></template>
            </el-table-column>
            <el-table-column label="份额" min-width="110" align="right">
              <template #default="{ row }"><span class="num">{{ money(row.shares) }}</span></template>
            </el-table-column>
            <el-table-column label="市值" min-width="120" align="right">
              <template #default="{ row }"><span class="num">{{ money(row.marketValue) }}</span></template>
            </el-table-column>
            <el-table-column label="当日盈亏(估)" min-width="140" align="right">
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
        </el-tab-pane>
      </el-tabs>
    </template>

    <el-empty v-else-if="!loading" :description="error || '暂无持仓快照'" />

    <AiAnalysisDialog v-model="analysisOpen" kind="real-positions" title="实时持仓分析" />
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 8px;
}
.meta {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 14px;
}
.pos-tabs {
  margin-top: 4px;
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
.section-sub {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--text-2);
}
.closed {
  margin-top: 16px;
}
</style>
