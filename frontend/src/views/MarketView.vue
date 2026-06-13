<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import dayjs from 'dayjs';
import { ElMessage } from 'element-plus';
import { Refresh, MagicStick, Setting } from '@element-plus/icons-vue';
import { api } from '@/api';
import ModuleScheduleDialog from '@/components/ModuleScheduleDialog.vue';
import MarkdownView from '@/components/MarkdownView.vue';
import StockLink from '@/components/StockLink.vue';
import { useKlineStore } from '@/stores/kline';
import type {
  FuturesItem,
  GlobalIndex,
  HomeModule,
  MarketIndex,
  MarketOverview,
  RealPortfolio,
  WatchlistEntry,
} from '@stock-agent/shared';

const kline = useKlineStore();
const openIndexKline = (ix: MarketIndex) => kline.open(ix.code, ix.name, ix.secid);

const ov = ref<MarketOverview | null>(null);
const loading = ref(false);
const sectorTab = ref<'industry' | 'concept'>('industry');
// 顶层分块 Tab：A股大盘 / 期货价格 / 外盘
const tab = ref<'astock' | 'futures' | 'overseas'>('astock');

const reviewing = ref(false);
const review = ref('');

// 期货 + 外盘复盘（盘前），与大盘复盘分离
const reviewingFO = ref(false);
const reviewFO = ref('');

// 模块显隐
const modules = ref<HomeModule[]>([]);
const drawer = ref(false);
const draft = ref<Record<string, boolean>>({});
const savingModules = ref(false);
const enabled = (id: string) => modules.value.find((m) => m.id === id)?.enabled ?? false;

// mine 模块数据（自选股 + 真实持仓），按需懒加载
const watch = ref<WatchlistEntry[] | null>(null);
const portfolio = ref<RealPortfolio | null>(null);
const mineLoading = ref(false);

async function load(silent = false) {
  if (!silent) loading.value = true;
  try {
    ov.value = await api.getMarketOverview();
  } catch (e) {
    if (!silent) ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    if (!silent) loading.value = false;
  }
  if (enabled('mine')) void loadMine(silent);
}

async function loadModules() {
  try {
    modules.value = await api.getMarketModules();
  } catch {
    /* 配置拉取失败时全部按默认显示，不阻塞盘面 */
  }
}

async function loadMine(silent = false) {
  if (mineLoading.value) return;
  mineLoading.value = true;
  try {
    // 自选股走东财（轻量，可随 3s 轮询刷新）；真实持仓走同花顺，仅在非静默时刷新，避免高频打接口
    const w = await api.listWatchlist().catch(() => null);
    if (w) watch.value = w;
    if (!silent) {
      const p = await api.getRealPositions().catch(() => null);
      if (p) portfolio.value = p;
    }
  } finally {
    mineLoading.value = false;
  }
}

function openDrawer() {
  draft.value = Object.fromEntries(modules.value.map((m) => [m.id, m.enabled]));
  drawer.value = true;
}

async function saveModules() {
  savingModules.value = true;
  try {
    modules.value = await api.updateMarketModules({ ...draft.value });
    drawer.value = false;
    ElMessage.success('模块配置已保存');
    if (enabled('mine') && !watch.value && !portfolio.value) void loadMine();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    savingModules.value = false;
  }
}

async function runReview() {
  reviewing.value = true;
  review.value = '';
  try {
    const r = await api.marketReview();
    review.value = r.text || '（无输出）';
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    reviewing.value = false;
  }
}

async function runReviewFO() {
  reviewingFO.value = true;
  reviewFO.value = '';
  try {
    const r = await api.marketReviewFuturesOverseas();
    reviewFO.value = r.text || '（无输出）';
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    reviewingFO.value = false;
  }
}

// A股 红涨绿跌
const dir = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const pct = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
const fixed = (v: number, d = 2) => v.toFixed(d);
// 成交额（亿）→ 友好显示，过万亿换算
const amt = (yi: number) => (yi >= 10000 ? (yi / 10000).toFixed(2) + '万亿' : yi.toFixed(0) + '亿');

const ladderSorted = computed(() => ov.value?.ladder ?? []);

// 期货按 group 分组（保持后端 secid 清单顺序），供期货 Tab 分组渲染
const futuresGroups = computed<{ group: string; items: FuturesItem[] }[]>(() => {
  const list = ov.value?.futures ?? [];
  const groups: { group: string; items: FuturesItem[] }[] = [];
  for (const f of list) {
    let g = groups.find((x) => x.group === f.group);
    if (!g) {
      g = { group: f.group, items: [] };
      groups.push(g);
    }
    g.items.push(f);
  }
  return groups;
});

// 外围指数按 group 分组（美股/中概/欧洲/亚太/汇率/债券/加密），保持后端清单顺序，供外盘 Tab 分组渲染
const overseasGroups = computed<{ group: string; items: GlobalIndex[] }[]>(() => {
  const list = ov.value?.globalIndices ?? [];
  const groups: { group: string; items: GlobalIndex[] }[] = [];
  for (const g of list) {
    let cur = groups.find((x) => x.group === g.group);
    if (!cur) {
      cur = { group: g.group, items: [] };
      groups.push(cur);
    }
    cur.items.push(g);
  }
  return groups;
});

let timer: ReturnType<typeof setInterval> | undefined;
onMounted(async () => {
  await loadModules();
  await load();
  timer = setInterval(() => load(true), 3000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-title">大盘</div>
      <div class="head-actions">
        <el-button :icon="Setting" @click="openDrawer">模块管理</el-button>
        <ModuleScheduleDialog module="market" />
        <el-button :icon="Refresh" :loading="loading" @click="load()">刷新</el-button>
      </div>
    </div>
    <div class="page-sub">
      实时盘面（东方财富行情，红涨绿跌）
      <span v-if="ov"> · 更新 {{ dayjs(ov.asOf).format('HH:mm:ss') }}</span>
      <span v-if="ov?.stale" class="stale-hint">
        · 部分数据为最近缓存（{{ dayjs(ov.dataAsOf).format('HH:mm:ss') }}），上游行情暂不可用
      </span>
    </div>

    <el-tabs v-if="ov" v-model="tab" class="market-tabs">
      <!-- ===== A股大盘 ===== -->
      <el-tab-pane label="A股大盘" name="astock">
        <div class="tab-actions">
          <el-button :icon="MagicStick" type="primary" :loading="reviewing" @click="runReview">
            一键 AI 大盘复盘点评
          </el-button>
        </div>

        <!-- 指数条 -->
        <div v-if="enabled('indices')" class="idx-strip">
          <div
            v-for="ix in ov.indices"
            :key="ix.code"
            class="idx idx-clickable"
            role="button"
            tabindex="0"
            @click="openIndexKline(ix)"
            @keydown.enter="openIndexKline(ix)"
          >
            <div class="idx-name">{{ ix.name }}</div>
            <div class="idx-point num" :class="dir(ix.pct)">{{ fixed(ix.point) }}</div>
            <div class="idx-pct num" :class="dir(ix.pct)">{{ pct(ix.pct) }}</div>
          </div>
        </div>

        <!-- 两市成交额 + 情绪温度（并排关键指标条） -->
      <div
        v-if="(enabled('turnoverTotal') && ov.turnoverTotal) || (enabled('emotion') && ov.emotion)"
        class="stat-strip"
      >
        <template v-if="enabled('turnoverTotal') && ov.turnoverTotal">
          <div class="stat">
            <div class="stat-label">两市成交额</div>
            <div class="stat-val num">{{ amt(ov.turnoverTotal.total) }}</div>
            <div
              v-if="ov.turnoverTotal.chgPct != null"
              class="stat-sub num"
              :class="dir(ov.turnoverTotal.chgPct)"
            >
              较昨 {{ pct(ov.turnoverTotal.chgPct) }}
            </div>
          </div>
        </template>
        <template v-if="enabled('emotion') && ov.emotion">
          <div class="stat">
            <div class="stat-label">涨停</div>
            <div class="stat-val num up">{{ ov.emotion.limitUp }}</div>
          </div>
          <div class="stat">
            <div class="stat-label">跌停</div>
            <div class="stat-val num down">{{ ov.emotion.limitDown }}</div>
          </div>
          <div class="stat">
            <div class="stat-label">炸板 / 炸板率</div>
            <div class="stat-val num">{{ ov.emotion.brokenBoard }}</div>
            <div class="stat-sub num">{{ fixed(ov.emotion.brokenRate, 1) }}%</div>
          </div>
          <div class="stat">
            <div class="stat-label">最高连板</div>
            <div class="stat-val num up">{{ ov.emotion.maxStreak }}<small>板</small></div>
          </div>
        </template>
      </div>

      <!-- AI 复盘点评 -->
      <div v-if="reviewing || review" class="review">
        <div class="review-head">
          <el-icon><MagicStick /></el-icon> AI 复盘点评
        </div>
        <div v-if="reviewing" class="review-loading">正在结合盘面生成点评…</div>
        <MarkdownView v-else :source="review" />
      </div>

      <!-- 涨停板梯队 -->
      <div v-if="enabled('ladder')" class="panel block">
        <div class="panel-head"><span class="panel-title">涨停板梯队</span></div>
        <div v-if="ladderSorted.length" class="ladder">
          <div v-for="t in ladderSorted" :key="t.streak" class="ladder-row">
            <div class="ladder-tag" :class="{ hot: t.streak >= 3 }">
              {{ t.streak === 1 ? '首板' : t.streak + '连板' }}
              <span class="ladder-count">{{ t.count }}</span>
            </div>
            <div class="ladder-stocks">
              <el-tag
                v-for="s in t.stocks"
                :key="s.code"
                size="small"
                effect="plain"
                class="ladder-chip"
              >
                <StockLink :code="s.code" :name="s.name" /><span
                  v-if="s.sector"
                  class="chip-sector"
                  >{{ s.sector }}</span
                >
              </el-tag>
            </div>
          </div>
        </div>
        <el-empty v-else :image-size="60" description="暂无涨停（盘前/非交易日）" />
      </div>

      <div class="grid">
        <!-- 板块主力资金流 -->
        <div v-if="enabled('moneyflow')" class="panel">
          <div class="panel-head"><span class="panel-title">板块主力资金流</span></div>
          <div class="two-col">
            <div class="col">
              <div class="col-cap up">净流入 TOP</div>
              <div v-for="s in ov.moneyInflow ?? []" :key="s.code" class="flow-row">
                <StockLink class="flow-name" :code="s.code" :name="s.name" />
                <span class="num up">+{{ fixed(s.netInflow) }}亿</span>
              </div>
              <el-empty v-if="!ov.moneyInflow?.length" :image-size="44" description="暂无" />
            </div>
            <div class="col">
              <div class="col-cap down">净流出 TOP</div>
              <div v-for="s in ov.moneyOutflow ?? []" :key="s.code" class="flow-row">
                <StockLink class="flow-name" :code="s.code" :name="s.name" />
                <span class="num down">{{ fixed(s.netInflow) }}亿</span>
              </div>
              <el-empty v-if="!ov.moneyOutflow?.length" :image-size="44" description="暂无" />
            </div>
          </div>
        </div>

        <!-- 热门板块 -->
        <div v-if="enabled('hotSectors')" class="panel">
          <div class="panel-head">
            <span class="panel-title">热门板块</span>
            <el-radio-group v-model="sectorTab" size="small">
              <el-radio-button value="industry">行业</el-radio-button>
              <el-radio-button value="concept">概念</el-radio-button>
            </el-radio-group>
          </div>
          <el-table
            :data="sectorTab === 'industry' ? ov.hotIndustries : ov.hotConcepts"
            size="small"
            style="width: 100%"
          >
            <el-table-column type="index" label="#" width="44" />
            <el-table-column label="板块" min-width="110">
              <template #default="{ row }">
                <StockLink :code="row.code" :name="row.name" />
              </template>
            </el-table-column>
            <el-table-column label="涨幅" min-width="84" align="right">
              <template #default="{ row }">
                <span class="num" :class="dir(row.pct)">{{ pct(row.pct) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="领涨股" min-width="100">
              <template #default="{ row }">
                <StockLink
                  v-if="row.leadStock"
                  :code="row.leadStockCode"
                  :name="row.leadStock"
                />
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <!-- 领跌板块 + 跌幅榜 -->
        <div v-if="enabled('losers')" class="panel">
          <div class="panel-head"><span class="panel-title">领跌板块 / 跌幅榜</span></div>
          <div class="two-col">
            <div class="col">
              <div class="col-cap">领跌板块</div>
              <div v-for="s in ov.loserSectors ?? []" :key="s.code" class="flow-row">
                <StockLink class="flow-name" :code="s.code" :name="s.name" />
                <span class="num down">{{ pct(s.pct) }}</span>
              </div>
              <el-empty v-if="!ov.loserSectors?.length" :image-size="44" description="暂无" />
            </div>
            <div class="col">
              <div class="col-cap">个股跌幅榜</div>
              <div v-for="s in ov.topLosers ?? []" :key="s.code" class="flow-row">
                <StockLink class="flow-name" :code="s.code" :name="s.name" />
                <span class="num down">{{ pct(s.pct) }}</span>
              </div>
              <el-empty v-if="!ov.topLosers?.length" :image-size="44" description="暂无" />
            </div>
          </div>
        </div>

        <!-- 成交额榜 -->
        <div v-if="enabled('turnoverRank')" class="panel">
          <div class="panel-head"><span class="panel-title">成交额榜</span></div>
          <el-table :data="ov.topTurnover" size="small" style="width: 100%">
            <el-table-column type="index" label="#" width="44" />
            <el-table-column label="名称" min-width="92">
              <template #default="{ row }">
                <StockLink :code="row.code" :name="row.name" />
              </template>
            </el-table-column>
            <el-table-column label="现价" min-width="80" align="right">
              <template #default="{ row }"><span class="num">{{ fixed(row.price) }}</span></template>
            </el-table-column>
            <el-table-column label="涨幅" min-width="84" align="right">
              <template #default="{ row }">
                <span class="num" :class="dir(row.pct)">{{ pct(row.pct) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="成交额" min-width="92" align="right">
              <template #default="{ row }"><span class="num">{{ fixed(row.amount) }}亿</span></template>
            </el-table-column>
          </el-table>
        </div>

        <!-- mine：自选股 / 真实持仓今日表现 -->
        <div v-if="enabled('mine')" class="panel">
          <div class="panel-head">
            <span class="panel-title">我的标的 · 今日表现</span>
            <el-button text size="small" :loading="mineLoading" @click="loadMine">刷新</el-button>
          </div>
          <div v-if="portfolio" class="mine-port">
            <span>持仓市值 <b class="num">{{ fixed(portfolio.totalMarketValue) }}</b></span>
            <span
              >今日盈亏
              <b class="num" :class="dir(portfolio.totalTodayProfit)">{{
                fixed(portfolio.totalTodayProfit)
              }}</b></span
            >
          </div>
          <div class="mine-cap">自选股</div>
          <div v-for="w in watch ?? []" :key="w.code" class="flow-row">
            <StockLink class="flow-name" :code="w.code" :name="w.name" />
            <span v-if="w.quote" class="num" :class="dir(w.quote.pct)">{{ pct(w.quote.pct) }}</span>
            <span v-else class="num muted">—</span>
          </div>
          <el-empty v-if="!watch?.length && !portfolio" :image-size="44" description="暂无自选/持仓" />
        </div>
      </div>
      </el-tab-pane>

      <!-- ===== 期货价格 ===== -->
      <el-tab-pane label="期货价格" name="futures">
        <div class="tab-actions">
          <el-button :icon="MagicStick" type="primary" :loading="reviewingFO" @click="runReviewFO">
            一键 AI 期货+外盘复盘点评
          </el-button>
          <span class="tab-tip">盘前定调：商品价格传导 + 隔夜外盘</span>
        </div>

        <div v-if="reviewingFO || reviewFO" class="review">
          <div class="review-head"><el-icon><MagicStick /></el-icon> 期货 + 外盘复盘点评</div>
          <div v-if="reviewingFO" class="review-loading">正在结合期货与外盘生成点评…</div>
          <MarkdownView v-else :source="reviewFO" />
        </div>

        <template v-if="enabled('futures')">
          <div v-for="g in futuresGroups" :key="g.group" class="fut-group">
            <div class="fut-group-cap">{{ g.group }}</div>
            <div class="idx-strip global">
              <div v-for="f in g.items" :key="f.code" class="idx">
                <div class="idx-name">{{ f.name }}</div>
                <div class="idx-point num" :class="dir(f.pct)">{{ fixed(f.price) }}</div>
                <div class="idx-pct num" :class="dir(f.pct)">{{ pct(f.pct) }}</div>
              </div>
            </div>
          </div>
          <el-empty
            v-if="!futuresGroups.length"
            :image-size="60"
            description="暂无期货行情（非交易时段/数据源不可用）"
          />
        </template>
        <el-empty v-else :image-size="60" description="期货价格模块已在模块管理中关闭" />
      </el-tab-pane>

      <!-- ===== 外盘 ===== -->
      <el-tab-pane label="外盘" name="overseas">
        <div class="tab-actions">
          <el-button :icon="MagicStick" type="primary" :loading="reviewingFO" @click="runReviewFO">
            一键 AI 期货+外盘复盘点评
          </el-button>
          <span class="tab-tip">盘前定调：商品价格传导 + 隔夜外盘</span>
        </div>

        <div v-if="reviewingFO || reviewFO" class="review">
          <div class="review-head"><el-icon><MagicStick /></el-icon> 期货 + 外盘复盘点评</div>
          <div v-if="reviewingFO" class="review-loading">正在结合期货与外盘生成点评…</div>
          <MarkdownView v-else :source="reviewFO" />
        </div>

        <template v-if="enabled('globalIndices')">
          <template v-if="overseasGroups.length">
            <div v-for="g in overseasGroups" :key="g.group" class="fut-group">
              <div class="fut-group-cap">{{ g.group }}</div>
              <div class="idx-strip global">
                <div
                  v-for="ix in g.items"
                  :key="ix.secid"
                  class="idx idx-clickable"
                  role="button"
                  tabindex="0"
                  @click="kline.open(ix.code, ix.name, ix.secid)"
                  @keydown.enter="kline.open(ix.code, ix.name, ix.secid)"
                >
                  <div class="idx-name">{{ ix.name }}</div>
                  <div class="idx-point num" :class="dir(ix.pct)">{{ fixed(ix.point) }}</div>
                  <div class="idx-quote-line num" :class="dir(ix.pct)">
                    <span v-if="ix.change != null">{{ ix.change >= 0 ? '+' : '' }}{{ fixed(ix.change) }}</span>
                    <span>{{ pct(ix.pct) }}</span>
                  </div>
                  <div
                    v-if="ix.high != null || ix.low != null || ix.amplitude != null"
                    class="idx-detail"
                  >
                    <span v-if="ix.high != null">高 {{ fixed(ix.high) }}</span>
                    <span v-if="ix.low != null">低 {{ fixed(ix.low) }}</span>
                    <span v-if="ix.amplitude != null">振 {{ fixed(ix.amplitude, 1) }}%</span>
                  </div>
                </div>
              </div>
            </div>
          </template>
          <el-empty
            v-else
            :image-size="60"
            description="暂无外围指数（数据源不可用）"
          />
        </template>
        <el-empty v-else :image-size="60" description="外围关键指数模块已在模块管理中关闭" />
      </el-tab-pane>
    </el-tabs>

    <el-empty v-else-if="!loading" description="暂无盘面数据" />

    <!-- 模块管理抽屉 -->
    <el-drawer v-model="drawer" title="模块管理" size="320px">
      <div class="mod-list">
        <div v-for="m in modules" :key="m.id" class="mod-row">
          <span>{{ m.label }}</span>
          <el-switch v-model="draft[m.id]" />
        </div>
      </div>
      <template #footer>
        <el-button @click="drawer = false">取消</el-button>
        <el-button type="primary" :loading="savingModules" @click="saveModules">保存</el-button>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 8px;
}
.market-tabs {
  margin-top: 4px;
}
.stale-hint {
  color: var(--warning, #e6a23c);
}
.tab-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}
.tab-tip {
  font-size: 12px;
  color: var(--text-2);
}
.fut-group {
  margin-bottom: 14px;
}
.fut-group-cap {
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 6px;
}
.idx-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin-bottom: 14px;
}
/* 外围指数条：略紧凑，与 A 股指数条做轻量区分 */
.idx-strip.global {
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
}
.idx-strip.global .idx {
  padding: 8px 12px;
  background: var(--bg-1);
}
.idx-strip.global .idx-point {
  font-size: 16px;
}
.idx {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 16px;
}
.idx-clickable {
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.idx-clickable:hover {
  border-color: var(--brand);
  background: var(--bg-hover);
}
.idx-name {
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 6px;
}
.idx-point {
  font-size: 20px;
  font-weight: 600;
}
.idx-pct {
  font-size: 13px;
  margin-top: 2px;
}
/* 外围指数：涨跌额 + 涨跌幅 同行展示 */
.idx-quote-line {
  display: flex;
  gap: 8px;
  font-size: 13px;
  margin-top: 2px;
}
/* 外围指数：最高/最低/振幅 明细行 */
.idx-detail {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-2);
}
.stat-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 12px;
  margin-bottom: 18px;
}
.stat {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 14px;
}
.stat-label {
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 4px;
}
.stat-val {
  font-size: 22px;
  font-weight: 600;
}
.stat-val small {
  font-size: 12px;
  font-weight: 400;
}
.stat-sub {
  font-size: 12px;
  margin-top: 2px;
  color: var(--text-2);
}
.review {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
  margin-bottom: 18px;
}
.review-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: var(--brand);
  margin-bottom: 10px;
}
.review-loading {
  color: var(--text-2);
  font-size: 13px;
}
.review-body {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--text-0);
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.panel {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
}
.panel.block {
  margin-bottom: 16px;
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.panel-title {
  font-weight: 600;
}
/* 涨停梯队 */
.ladder-row {
  display: flex;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}
.ladder-row:last-child {
  border-bottom: none;
}
.ladder-tag {
  flex: 0 0 76px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}
.ladder-tag.hot {
  color: var(--up, #f56c6c);
}
.ladder-count {
  display: inline-block;
  margin-left: 4px;
  font-size: 11px;
  color: var(--text-2);
}
.ladder-stocks {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ladder-chip .chip-sector {
  margin-left: 4px;
  opacity: 0.6;
  font-size: 11px;
}
/* 双列榜 */
.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.col-cap,
.mine-cap {
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 6px;
}
.flow-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;
}
.flow-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.muted {
  color: var(--text-2);
}
.mine-port {
  display: flex;
  gap: 18px;
  font-size: 13px;
  color: var(--text-2);
  margin-bottom: 10px;
}
.mine-cap {
  margin-top: 4px;
}
.mod-list {
  display: flex;
  flex-direction: column;
}
.mod-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 4px;
  border-bottom: 1px solid var(--border);
}
@media (max-width: 900px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
