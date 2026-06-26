<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import dayjs from 'dayjs';
import { ElMessage } from 'element-plus';
import { Refresh, MagicStick, Setting, TopRight } from '@element-plus/icons-vue';
import { api } from '@/api';
import { useCachedResource } from '@/composables/useCachedResource';
import AiAnalysisDialog from '@/components/AiAnalysisDialog.vue';
import ModuleScheduleDialog from '@/components/ModuleScheduleDialog.vue';
import MarkdownView from '@/components/MarkdownView.vue';
import StockLink from '@/components/StockLink.vue';
import BoardReviewConclusion from '@/components/BoardReviewConclusion.vue';
import BoardStrengthPanel from '@/components/BoardStrengthPanel.vue';
import BoardBreadthPanel from '@/components/BoardBreadthPanel.vue';
import MarketThemesPanel from '@/components/MarketThemesPanel.vue';
import MainlineConsensusPanel from '@/components/MainlineConsensusPanel.vue';
import HotConceptsPanel from '@/components/HotConceptsPanel.vue';
import SentimentPanel from '@/components/SentimentPanel.vue';
import MacroPanel from '@/components/MacroPanel.vue';
import UsMappingPanel from '@/components/UsMappingPanel.vue';
import LadderPanel from '@/components/LadderPanel.vue';
import { useKlineStore } from '@/stores/kline';
import type {
  FuturesItem,
  GlobalIndex,
  HomeModule,
  MarketIndex,
  MarketOverview,
} from '@stock-agent/shared';

const kline = useKlineStore();
const router = useRouter();
const openIndexKline = (ix: MarketIndex) => kline.open(ix.code, ix.name, ix.secid);

// 大盘快照走 SWR 缓存：重进页面瞬显上次结果，3s 轮询变为「按 TTL 的廉价新鲜度检查」（未过期不发请求）
const {
  data: ov,
  loading,
  refreshing,
  load,
  reload,
} = useCachedResource<MarketOverview>('market:overview', () => api.getMarketOverview(), {
  ttlMs: 60_000,
});
const sectorTab = ref<'industry' | 'concept'>('industry');
// 顶层分块 Tab：A股大盘 / 行业中线·市场主线 / 期货价格 / 外盘
// （中线雷达、市场主线已合并为单一 Tab：共用「板块主线研判」agent 结论 + 主线卡片 + 中线强弱表双明细下钻）
const tab = ref<'astock' | 'macro' | 'usmap' | 'sentiment' | 'board' | 'futures' | 'overseas'>('astock');
// 「行业中线 / 市场主线」明细折叠状态：默认全收起（仅顶部主线共识决策区常驻），按需下钻
const boardDetail = ref<string[]>([]);

// 大盘与板块研判（合并大盘复盘 + 板块主线）发起统一走 AiAnalysisDialog（kind=market-board），内嵌展示最新一条
const reviewOpen = ref(false);
const review = ref('');

// 模块显隐
const modules = ref<HomeModule[]>([]);
const drawer = ref(false);
const draft = ref<Record<string, boolean>>({});
const savingModules = ref(false);
const enabled = (id: string) => modules.value.find((m) => m.id === id)?.enabled ?? false;

// 「我的标的」已迁移至「持仓与自选」页，此处去重，仅保留模块开关与入口提示
function goAccount() {
  void router.push('/positions');
}

// 刷新按钮：强制拉最新（无视 TTL）；失败弹提示。初次/轮询走缓存与静默刷新，不打扰。
async function refresh() {
  try {
    await reload();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

async function loadModules() {
  try {
    modules.value = await api.getMarketModules();
  } catch {
    /* 配置拉取失败时全部按默认显示，不阻塞盘面 */
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
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    savingModules.value = false;
  }
}

// 弹窗关闭后刷新内嵌最新复盘点评
function onReviewDialog(open: boolean) {
  reviewOpen.value = open;
  if (!open) void loadLatestReview();
}

async function loadLatestReview() {
  try {
    const list = await api.listAnalyses('market-board', undefined, 1, true);
    if (list.length > 0) review.value = list[0].content;
  } catch {
    /* 静默 */
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
  try {
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
  void loadLatestReview();
  // 轮询不强刷：仅按 TTL 检查新鲜度，未过期是纯内存命中（不发请求），过期则后台静默刷新一次
  timer = setInterval(() => void load(), 3000);
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
        <ModuleScheduleDialog module="themes" />
        <el-button :icon="Refresh" :loading="loading || refreshing" @click="refresh">刷新</el-button>
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
          <el-button :icon="MagicStick" type="primary" @click="reviewOpen = true">
            一键 AI 大盘与板块研判
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

      <!-- AI 大盘与板块研判（最新一条；发起 / 历史走统一弹窗） -->
      <div v-if="review" class="review">
        <div class="review-head">
          <el-icon><MagicStick /></el-icon> AI 大盘与板块研判
        </div>
        <MarkdownView :source="review" />
      </div>
      <AiAnalysisDialog
        :model-value="reviewOpen"
        kind="market-board"
        title="大盘与板块研判"
        @update:model-value="onReviewDialog"
      />

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

        <!-- mine：已迁移至「持仓与自选」页，去重后仅保留入口提示（模块开关仍可在模块管理中关闭） -->
        <div v-if="enabled('mine')" class="panel mine-moved" @click="goAccount">
          <div class="panel-head">
            <span class="panel-title">我的标的</span>
          </div>
          <div class="mine-moved-body">
            <span>持仓与自选已统一迁移至「持仓与自选」页，点此查看实时持仓 / 场外基金 / 自选分组</span>
            <el-button type="primary" link :icon="TopRight" @click.stop="goAccount">去账户页</el-button>
          </div>
        </div>
      </div>
      </el-tab-pane>

      <!-- ===== 宏观·资金面（低频/EOD 全局指标：基差/SHIBOR/降准/两融/南向/估值分位）===== -->
      <el-tab-pane v-if="enabled('macro')" label="宏观·资金面" name="macro" lazy>
        <MacroPanel />
      </el-tab-pane>

      <!-- ===== 情绪周期（S1 短线择时总开关）===== -->
      <el-tab-pane label="情绪周期" name="sentiment" lazy>
        <SentimentPanel />
      </el-tab-pane>

      <!-- ===== 连板梯队 / 龙头辨识（S6 龙头战法）===== -->
      <el-tab-pane label="连板梯队" name="ladder" lazy>
        <LadderPanel />
      </el-tab-pane>

      <!-- ===== 板块（主线共识 + 热门细分概念 + 中线/主线明细下钻）===== -->
      <!-- 信息架构：顶部「主线共识」决策区先给结论，再「热门细分概念」常驻供赛道内下钻，其余明细按需折叠下钻（省请求） -->
      <el-tab-pane label="板块" name="board" lazy>
        <!-- 1) 主线共识决策区（常驻，三源对齐先给结论） -->
        <MainlineConsensusPanel />
        <!-- 2) 热门细分概念（常驻，锁强赛道 → 赛道内下钻龙头） -->
        <HotConceptsPanel />
        <!-- 3) 明细下钻（按需挂载，省请求） -->
        <el-collapse v-model="boardDetail" class="board-detail">
          <el-collapse-item name="ai" title="AI 大盘与板块研判结论">
            <BoardReviewConclusion v-if="boardDetail.includes('ai')" />
          </el-collapse-item>
          <el-collapse-item name="breadth" title="板块新高宽度（确定性主线锚 · 明细）">
            <BoardBreadthPanel v-if="boardDetail.includes('breadth')" />
          </el-collapse-item>
          <el-collapse-item name="themes" title="主线题材（多源协同度 · 明细）">
            <MarketThemesPanel v-if="boardDetail.includes('themes')" />
          </el-collapse-item>
          <el-collapse-item name="strength" title="行业 / 概念中线强弱（趋势 · 明细）">
            <BoardStrengthPanel v-if="boardDetail.includes('strength')" />
          </el-collapse-item>
        </el-collapse>
      </el-tab-pane>

      <!-- ===== 期货价格 ===== -->
      <el-tab-pane label="期货价格" name="futures">
        <div class="tab-actions">
          <span class="tab-tip">期货+外盘的 AI 传导研判已并入「大盘与板块研判」一键点评</span>
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
          <span class="tab-tip">期货+外盘的 AI 传导研判已并入「大盘与板块研判」一键点评</span>
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

      <!-- ===== 美股映射（隔夜美股龙头/行业 → A股概念·ETF·个股）===== -->
      <el-tab-pane v-if="enabled('usmap')" label="美股映射" name="usmap" lazy>
        <UsMappingPanel />
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
.board-detail {
  margin-top: 4px;
  border-top: none;
}
.board-detail :deep(.el-collapse-item__header) {
  font-size: 14px;
  font-weight: 600;
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
.col-cap {
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 6px;
}
.mine-moved {
  cursor: pointer;
}
.mine-moved-body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  color: var(--text-2);
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
