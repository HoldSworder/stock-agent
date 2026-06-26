<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import dayjs from 'dayjs';
import { ElMessage } from 'element-plus';
import { Refresh } from '@element-plus/icons-vue';
import { api } from '@/api';
import { useCachedResource } from '@/composables/useCachedResource';
import StockLink from '@/components/StockLink.vue';
import MetricScaleHint from '@/components/MetricScaleHint.vue';
import type { HotConceptOverview, ConceptStocksResult, ConceptWindow } from '@stock-agent/shared';

// 热门细分概念（同花顺概念资金流·近N日排行，确定性只读）：按 近N日涨幅 + 资金净额 两维归一加权合成 0-100 热度分，
// 并按关键词归纳到父级主线主题，便于「锁强赛道 → 赛道内下钻」。默认近 5 日，可切 3/5/10/20 日。
// 点击概念可经问财展开板块全部成分股（标注龙头/今日领涨）。零量化术语，仅研判不下单。

// 时间窗口（近几日口径），默认近 5 日
const WINDOWS: ConceptWindow[] = ['3日', '5日', '10日', '20日'];
const win = ref<ConceptWindow>('5日');

// SWR 缓存（120s，慢变，按窗口分键）：重进/切窗口瞬显；后端涨幅/资金另有 90s 取数缓存
const { data, loading, refreshing, load, reload } = useCachedResource<HotConceptOverview>(
  () => `concepts:hot:${win.value}`,
  () => api.concepts.hot(win.value),
  { ttlMs: 120_000 },
);

// 切窗口：按新窗口键加载（命中缓存瞬显，否则拉取）
async function onWindowChange() {
  try {
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

const ov = computed(() => data.value ?? null);
const groups = computed(() => ov.value?.groups ?? []);
const flat = computed(() => ov.value?.flat ?? []);

// 视图：按主题归纳 / 按热度平铺
const view = ref<'theme' | 'flat'>('theme');

// 红涨绿跌 + 热度分强弱着色
const dir = (v: number | null) => (v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');
const pct = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
const heatClass = (v: number) => (v >= 70 ? 'hot' : v >= 40 ? 'mid' : 'low');
const inflowText = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}亿`);
const inflowClass = (v: number | null) => (v == null ? 'flat' : v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const leadPctText = (v: number | null) => (v == null ? '' : ` ${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);
const capText = (v: number | null) => (v == null ? '—' : v >= 1 ? `${v.toFixed(0)}亿` : `${(v * 10000).toFixed(0)}万`);

async function refresh() {
  try {
    await reload();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

// ===== 点击概念 → 抽屉展开板块全部成分股（经问财，龙头/今日领涨标注）=====
const drawer = ref(false);
const consLoading = ref(false);
const cons = ref<ConceptStocksResult | null>(null);
const activeConcept = ref('');

async function openConcept(name: string) {
  activeConcept.value = name;
  drawer.value = true;
  consLoading.value = true;
  cons.value = null;
  try {
    cons.value = await api.concepts.stocks(name);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
    cons.value = { concept: name, stocks: [], asOf: new Date().toISOString(), note: '成分股取数失败（问财未配置或网关异常，请到数据源页检查「同花顺问财个股选股」）。' };
  } finally {
    consLoading.value = false;
  }
}

onMounted(() => void load().catch((e) => ElMessage.error(e instanceof Error ? e.message : String(e))));
</script>

<template>
  <div class="panel-block" v-loading="loading">
    <div class="block-head">
      <div class="block-title">
        热门细分概念 · 主线归纳
        <MetricScaleHint
          name="综合热度分 0-100"
          note="近 N 日涨幅 + 资金净额 两维组内归一后加权（各 0.5），非单一涨幅，越高越热。数据源：同花顺概念资金流·近N日排行。"
        />
        <span v-if="ov" class="sub">（近{{ ov.window }} · {{ flat.length }} 个上榜概念）</span>
      </div>
      <div class="block-actions">
        <el-radio-group v-model="win" size="small" @change="onWindowChange">
          <el-radio-button v-for="w in WINDOWS" :key="w" :value="w">近{{ w }}</el-radio-button>
        </el-radio-group>
        <el-radio-group v-model="view" size="small">
          <el-radio-button value="theme">按主题归纳</el-radio-button>
          <el-radio-button value="flat">按热度平铺</el-radio-button>
        </el-radio-group>
        <el-button :icon="Refresh" size="small" :loading="loading || refreshing" @click="refresh">刷新</el-button>
      </div>
    </div>
    <div class="block-sub">
      细分概念（如玻璃基板/光刻胶）按<b>近{{ ov?.window ?? '5日' }}</b>综合热度排序并归纳到父级主线主题，<b>点击任一概念可展开板块全部成分股</b>（标注龙头/今日领涨），便于先锁强赛道、再赛道内下钻龙头（确定性只读，仅研判不下单）。
    </div>

    <template v-if="ov">
      <!-- 按主题归纳 -->
      <div v-if="view === 'theme' && groups.length" class="theme-groups">
        <div v-for="g in groups" :key="g.theme" class="theme-group">
          <div class="theme-head">
            <span class="theme-name">{{ g.theme }}</span>
            <span class="theme-meta">{{ g.items.length }} 个 · 最高热度 <b :class="heatClass(g.topHeat)">{{ g.topHeat }}</b></span>
          </div>
          <div class="concept-chips">
            <div
              v-for="it in g.items"
              :key="it.boardName"
              class="concept-chip"
              :class="heatClass(it.heatScore)"
              role="button"
              :title="`点击展开「${it.boardName}」板块成分股`"
              @click="openConcept(it.boardName)"
            >
              <span class="chip-name">{{ it.boardName }}</span>
              <span class="chip-heat num">热{{ it.heatScore }}</span>
              <span class="chip-pct num" :class="dir(it.pct)">{{ pct(it.pct) }}</span>
              <span class="chip-money num" :class="inflowClass(it.netInflow)">{{ inflowText(it.netInflow) }}</span>
              <span v-if="it.leadStock" class="chip-lead muted">领涨{{ it.leadStock }}{{ leadPctText(it.leadStockPct) }}</span>
            </div>
          </div>
        </div>
      </div>
      <el-empty
        v-else-if="view === 'theme'"
        description="暂无热门细分概念数据（同花顺概念资金流取数降级，请到数据源页检查 AKShare/aktools 配置）"
      />

      <!-- 按热度平铺 -->
      <el-table v-else-if="view === 'flat' && flat.length" :data="flat" stripe size="small" style="width: 100%">
        <el-table-column label="#" width="48" align="center">
          <template #default="{ $index }"><span class="num sub">{{ $index + 1 }}</span></template>
        </el-table-column>
        <el-table-column label="细分概念" min-width="150">
          <template #default="{ row }">
            <a class="board-name link" @click="openConcept(row.boardName)">{{ row.boardName }}</a>
          </template>
        </el-table-column>
        <el-table-column label="主题" width="110">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" type="warning">{{ row.theme }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="热度" width="130">
          <template #default="{ row }">
            <div class="heat-cell">
              <div class="bar">
                <div class="bar-fill" :class="heatClass(row.heatScore)" :style="{ width: `${row.heatScore}%` }" />
              </div>
              <span class="num">{{ row.heatScore }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="涨幅" width="84" align="right">
          <template #default="{ row }">
            <span class="num" :class="dir(row.pct)">{{ pct(row.pct) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="资金净额" width="100" align="right">
          <template #default="{ row }">
            <span class="num" :class="inflowClass(row.netInflow)">{{ inflowText(row.netInflow) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="家数" width="68" align="right">
          <template #default="{ row }">
            <span class="num sub">{{ row.companies == null ? '—' : row.companies }}</span>
          </template>
        </el-table-column>
        <el-table-column label="今日领涨" min-width="120">
          <template #default="{ row }">
            <span v-if="row.leadStock" class="muted">
              {{ row.leadStock }}<span class="num" :class="dir(row.leadStockPct)">{{ leadPctText(row.leadStockPct) }}</span>
            </span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
      </el-table>
      <el-empty
        v-else-if="view === 'flat'"
        description="暂无热门细分概念数据（同花顺概念资金流取数降级，请到数据源页检查 AKShare/aktools 配置）"
      />

      <div class="note">
        {{ ov.note }}
        <span class="as-of">· 数据时间 {{ dayjs(ov.asOf).format('MM-DD HH:mm') }}</span>
      </div>
    </template>

    <!-- 概念成分股抽屉 -->
    <el-drawer v-model="drawer" :title="`${activeConcept} · 板块成分股`" size="46%" direction="rtl">
      <div v-loading="consLoading">
        <template v-if="cons">
          <el-table v-if="cons.stocks.length" :data="cons.stocks" stripe size="small" style="width: 100%">
            <el-table-column label="标的" min-width="150">
              <template #default="{ row }">
                <StockLink :code="row.code" :name="row.name" />
                <el-tag v-if="row.isLeader" size="small" type="danger" effect="dark" class="tag">★龙头</el-tag>
                <el-tag v-if="row.isTopGainer" size="small" type="warning" effect="plain" class="tag">▲今日领涨</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="现价" width="80" align="right">
              <template #default="{ row }"><span class="num">{{ row.price == null ? '—' : row.price }}</span></template>
            </el-table-column>
            <el-table-column label="涨幅" width="80" align="right">
              <template #default="{ row }">
                <span class="num" :class="dir(row.pct)">{{ row.pct == null ? '—' : pct(row.pct) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="总市值" width="90" align="right">
              <template #default="{ row }"><span class="num sub">{{ capText(row.marketCap) }}</span></template>
            </el-table-column>
          </el-table>
          <el-empty v-else :description="cons.note" />
          <div class="note">{{ cons.note }}</div>
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.panel-block {
  margin-top: 12px;
}
.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
  gap: 8px;
  flex-wrap: wrap;
}
.block-title {
  font-weight: 600;
  font-size: 15px;
}
.block-title .sub {
  font-weight: 400;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.block-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.block-sub {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 10px;
}
.theme-groups {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.theme-group {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 10px 12px;
}
.theme-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
}
.theme-name {
  font-weight: 600;
  font-size: 14px;
}
.theme-meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.concept-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.concept-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
  border-left: 3px solid var(--el-border-color);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
}
.concept-chip:hover {
  background: var(--el-fill-color);
}
.concept-chip.hot {
  border-left-color: #f56c6c;
}
.concept-chip.mid {
  border-left-color: #e6a23c;
}
.concept-chip.low {
  border-left-color: var(--el-border-color);
}
.chip-name {
  font-weight: 600;
}
.chip-heat {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.chip-lead {
  font-size: 12px;
}
.heat-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bar {
  flex: 1;
  height: 6px;
  background: var(--el-fill-color-dark);
  border-radius: 3px;
  overflow: hidden;
  min-width: 50px;
}
.bar-fill {
  height: 100%;
  border-radius: 3px;
}
.bar-fill.hot {
  background: #f56c6c;
}
.bar-fill.mid {
  background: #e6a23c;
}
.bar-fill.low {
  background: var(--el-text-color-secondary);
}
.board-name {
  font-weight: 600;
}
.board-name.link {
  cursor: pointer;
  color: var(--el-color-primary);
}
.board-name.link:hover {
  text-decoration: underline;
}
.tag {
  margin-left: 6px;
}
.muted {
  color: var(--el-text-color-secondary);
}
.num {
  font-variant-numeric: tabular-nums;
}
.num.sub {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
b.hot {
  color: #f56c6c;
}
b.mid {
  color: #e6a23c;
}
b.low {
  color: var(--el-text-color-regular);
}
.up {
  color: #f56c6c;
}
.down {
  color: #4eb61b;
}
.flat {
  color: var(--el-text-color-secondary);
}
.note {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 10px;
  line-height: 1.5;
}
.as-of {
  white-space: nowrap;
}
</style>
