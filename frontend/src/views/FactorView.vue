<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { EChartsCoreOption } from 'echarts';
import type {
  FactorCatalogItem,
  FactorCatalogMeta,
  FactorIcStat,
  FactorSnapshotItem,
} from '@stock-agent/shared';
import { api } from '@/api';
import EChart from '@/components/EChart.vue';

// 因子探索页：只读展示离线预计算的因子目录 + IC，并支持按因子给当前 ETF 池排名、
// 勾选多因子组合打分。沿用项目暗色量化终端 token，单一琥珀强调色，红涨绿跌语义，数字等宽。
// 数据来自 backend/data/factor-catalog.json（pnpm factor:export 生成），不实时计算。

const CHAMPION = 'mom30_trend_quality_smooth';

const loading = ref(true);
const error = ref('');
const meta = ref<FactorCatalogMeta | null>(null);
const catalog = ref<FactorCatalogItem[]>([]);
const snapshot = ref<FactorSnapshotItem[]>([]);
const snapshotDate = ref('');

const activeTab = ref('catalog');

// ---- Tab1 因子目录筛选 ----
const search = ref('');
const filterCategory = ref('');
const filterCluster = ref('');
const filterStrength = ref('');
const horizon = ref<'5' | '10'>('5');

// ---- Tab1 抽屉 ----
const detailVisible = ref(false);
const detailItem = ref<FactorCatalogItem | null>(null);

// ---- Tab2 当前榜单 ----
const rankFactor = ref('');
const rankTopN = ref(15);

// ---- Tab3 因子组合 ----
const comboFactors = ref<string[]>([]);
const comboWeights = ref<Record<string, number>>({});

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [cat, snap] = await Promise.all([api.factors.catalog(), api.factors.snapshot()]);
    meta.value = cat.meta;
    catalog.value = cat.catalog;
    snapshot.value = snap.items;
    snapshotDate.value = snap.snapshotDate;
    rankFactor.value = catalog.value[0]?.name ?? '';
    // 组合默认放入信号有效且分属不同簇的几个代表因子
    const picks = pickDefaultCombo(cat.catalog);
    comboFactors.value = picks;
    for (const p of picks) comboWeights.value[p] = 1;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function pickDefaultCombo(items: FactorCatalogItem[]): string[] {
  const out: string[] = [];
  const champion = items.find((i) => i.name === CHAMPION);
  if (champion) out.push(champion.name);
  const themeTop = items.find((i) => i.cluster === '横截面/主题强度' && i.strength === 'strong');
  if (themeTop && !out.includes(themeTop.name)) out.push(themeTop.name);
  const guard = items.find((i) => i.cluster === '反向信号');
  if (guard && !out.includes(guard.name)) out.push(guard.name);
  return out.slice(0, 4);
}

onMounted(load);

// ---- 派生数据 ----
const categories = computed(() => {
  const set = new Set(catalog.value.map((c) => c.category));
  return Array.from(set);
});
const clusters = computed(() => {
  const set = new Set(catalog.value.map((c) => c.cluster));
  return Array.from(set);
});

function icOf(item: FactorCatalogItem, h: '5' | '10'): FactorIcStat | null {
  return h === '5' ? item.ic5 : item.ic10;
}

const filteredCatalog = computed(() => {
  const kw = search.value.trim().toLowerCase();
  const rows = catalog.value.filter((c) => {
    if (filterCategory.value && c.category !== filterCategory.value) return false;
    if (filterCluster.value && c.cluster !== filterCluster.value) return false;
    if (filterStrength.value && c.strength !== filterStrength.value) return false;
    if (kw && !c.name.toLowerCase().includes(kw) && !c.cn.toLowerCase().includes(kw)) return false;
    return true;
  });
  return rows.slice().sort((a, b) => {
    const ia = icOf(a, horizon.value)?.meanIc ?? -99;
    const ib = icOf(b, horizon.value)?.meanIc ?? -99;
    return ib - ia;
  });
});

const strongCount = computed(() => catalog.value.filter((c) => c.strength === 'strong').length);
const reverseCount = computed(() => catalog.value.filter((c) => c.cluster === '反向信号').length);

// ---- Tab2 排名 ----
const rankFactorMeta = computed(() => catalog.value.find((c) => c.name === rankFactor.value) ?? null);

const rankedEtfs = computed(() => {
  const f = rankFactor.value;
  if (!f) return [] as Array<{ code: string; name: string; value: number; signed: number }>;
  const neg = rankFactorMeta.value?.direction === 'neg';
  const rows = snapshot.value
    .filter((s) => typeof s.values[f] === 'number')
    .map((s) => {
      const value = s.values[f];
      return { code: s.code, name: s.name, value, signed: neg ? -value : value };
    });
  return rows.sort((a, b) => b.signed - a.signed);
});

const rankChartOption = computed<EChartsCoreOption>(() => {
  const top = rankedEtfs.value.slice(0, rankTopN.value).reverse();
  return barOption(
    top.map((r) => r.name),
    top.map((r) => Number(r.value.toFixed(4))),
  );
});

// ---- Tab3 组合打分（横截面 z-score 加权，方向归一） ----
function zscores(factor: string): Map<string, number> {
  const vals: Array<{ code: string; v: number }> = [];
  for (const s of snapshot.value) {
    const v = s.values[factor];
    if (typeof v === 'number') vals.push({ code: s.code, v });
  }
  const n = vals.length;
  const out = new Map<string, number>();
  if (n < 2) return out;
  const mean = vals.reduce((a, b) => a + b.v, 0) / n;
  const std = Math.sqrt(vals.reduce((a, b) => a + (b.v - mean) ** 2, 0) / n) || 1e-9;
  for (const x of vals) out.set(x.code, (x.v - mean) / std);
  return out;
}

const comboRanked = computed(() => {
  if (!comboFactors.value.length) return [] as Array<{ code: string; name: string; score: number }>;
  const dirOf = new Map(catalog.value.map((c) => [c.name, c.direction] as const));
  const zmaps = comboFactors.value.map((f) => ({
    f,
    w: comboWeights.value[f] ?? 1,
    sign: dirOf.get(f) === 'neg' ? -1 : 1,
    z: zscores(f),
  }));
  const totalW = zmaps.reduce((a, b) => a + Math.abs(b.w), 0) || 1;
  const rows = snapshot.value.map((s) => {
    let acc = 0;
    let used = 0;
    for (const zm of zmaps) {
      const z = zm.z.get(s.code);
      if (z === undefined) continue;
      acc += zm.sign * zm.w * z;
      used += 1;
    }
    return { code: s.code, name: s.name, score: used ? acc / totalW : Number.NEGATIVE_INFINITY };
  });
  return rows
    .filter((r) => Number.isFinite(r.score))
    .sort((a, b) => b.score - a.score);
});

// 冠军因子（趋势质量）排名，供组合表对照
const championRank = computed(() => {
  const z = zscores(CHAMPION);
  const dir = catalog.value.find((c) => c.name === CHAMPION)?.direction === 'neg' ? -1 : 1;
  const ranked = Array.from(z.entries())
    .map(([code, v]) => ({ code, v: dir * v }))
    .sort((a, b) => b.v - a.v);
  const m = new Map<string, number>();
  ranked.forEach((r, i) => m.set(r.code, i + 1));
  return m;
});

const comboChartOption = computed<EChartsCoreOption>(() => {
  const top = comboRanked.value.slice(0, rankTopN.value).reverse();
  return barOption(
    top.map((r) => r.name),
    top.map((r) => Number(r.score.toFixed(3))),
  );
});

function barOption(names: string[], values: number[]): EChartsCoreOption {
  return {
    grid: { left: 8, right: 24, top: 8, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      backgroundColor: '#11151c',
      borderColor: '#283140',
      textStyle: { color: '#e8edf4' },
    },
    xAxis: {
      type: 'value',
      axisLine: { lineStyle: { color: '#283140' } },
      axisLabel: { color: '#788694', fontFamily: 'JetBrains Mono, monospace' },
      splitLine: { lineStyle: { color: '#161b22' } },
    },
    yAxis: {
      type: 'category',
      data: names,
      axisLine: { lineStyle: { color: '#283140' } },
      axisLabel: { color: '#9aa6b4' },
    },
    series: [
      {
        type: 'bar',
        data: values,
        barMaxWidth: 16,
        itemStyle: { color: '#f0b429', borderRadius: [0, 3, 3, 0] },
        label: {
          show: true,
          position: 'right',
          color: '#9aa6b4',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11,
        },
      },
    ],
  };
}

// ---- 展示辅助 ----
function fmtIc(v: number | null | undefined): string {
  return v === null || v === undefined ? '-' : v.toFixed(4);
}
function fmtPct(v: number | null | undefined): string {
  return v === null || v === undefined ? '-' : `${(v * 100).toFixed(1)}%`;
}
function icClass(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'mut';
  return v > 0 ? 'pos' : v < 0 ? 'neg' : 'mut';
}
const strengthLabel: Record<string, string> = { strong: '强信号', ok: '有效', weak: '弱', na: '样本不足' };
const clusterType: Record<string, string> = {
  '横截面/主题强度': 'warning',
  绝对趋势动量: 'primary',
  反向信号: 'success',
};

function openDetail(row: FactorCatalogItem): void {
  detailItem.value = row;
  detailVisible.value = true;
}
function addToCombo(name: string): void {
  if (comboFactors.value.includes(name)) return;
  comboFactors.value.push(name);
  comboWeights.value[name] = 1;
  detailVisible.value = false;
  activeTab.value = 'combine';
}
function removeFromCombo(name: string): void {
  comboFactors.value = comboFactors.value.filter((f) => f !== name);
  delete comboWeights.value[name];
}
function cnOf(name: string): string {
  return catalog.value.find((c) => c.name === name)?.cn ?? name;
}
</script>

<template>
  <div class="factor-view">
    <header class="page-head">
      <div>
        <h1>因子探索</h1>
        <p class="sub">
          ETF 主线因子目录 · IC 有效性体检 · 当前榜单与组合实验
        </p>
      </div>
      <div v-if="meta" class="meta-strip">
        <span><b>{{ meta.factorCount }}</b> 因子</span>
        <span><b>{{ meta.sampleEtfCount }}</b> ETF</span>
        <span><b>{{ meta.tradingDays }}</b> 交易日</span>
        <span class="mono">{{ meta.generatedAt.slice(0, 10) }} 生成</span>
      </div>
    </header>

    <el-alert
      v-if="error"
      :title="`加载失败：${error}`"
      type="error"
      :closable="false"
      show-icon
      class="mb"
    />

    <el-skeleton v-if="loading" :rows="8" animated class="mb" />

    <template v-else-if="!error && meta">
      <!-- 导读卡：把 IC 含义 / 三簇 / 口径差异固化进 UI -->
      <section class="guide">
        <div class="guide-cards">
          <div class="gc">
            <div class="gc-h">什么是 IC</div>
            <p>
              每个交易日，跨全部 ETF 计算「因子值」与「未来收益」的秩相关，再对时间求均值。
              <b>mean_IC &gt; 0.03</b> 算有料，<b>|t| ≥ 3</b> 基本排除碰运气，正向天数越高越稳。
            </p>
          </div>
          <div class="gc">
            <div class="gc-h">三大信号簇</div>
            <p>
              <el-tag size="small" type="warning" effect="dark">横截面/主题强度</el-tag>
              IC 最高、适合分散持仓；
              <el-tag size="small" effect="dark">绝对趋势动量</el-tag>
              最擅长单仓押龙头；
              <el-tag size="small" type="success" effect="dark">反向信号</el-tag>
              IC 为负、做排雷减分。
            </p>
          </div>
          <div class="gc">
            <div class="gc-h">算法提醒</div>
            <p>
              IC 衡量「排对全场」，与你单仓押龙头的回测算法不同。高 IC 的横截面因子未必跑赢你手调的
              <span class="mono">{{ CHAMPION }}</span>。
            </p>
          </div>
        </div>
        <ul class="caveats">
          <li v-for="(c, i) in meta.caveats" :key="i">{{ c }}</li>
        </ul>
      </section>

      <el-tabs v-model="activeTab" class="tabs">
        <!-- ============ Tab1 因子目录 ============ -->
        <el-tab-pane label="因子目录" name="catalog">
          <div class="toolbar">
            <el-input
              v-model="search"
              placeholder="搜索因子名 / 中文名"
              clearable
              class="w220"
            />
            <el-select v-model="filterCategory" placeholder="全部分类" clearable class="w160">
              <el-option v-for="c in categories" :key="c" :label="c" :value="c" />
            </el-select>
            <el-select v-model="filterCluster" placeholder="全部信号簇" clearable class="w160">
              <el-option v-for="c in clusters" :key="c" :label="c" :value="c" />
            </el-select>
            <el-select v-model="filterStrength" placeholder="全部强度" clearable class="w130">
              <el-option label="强信号" value="strong" />
              <el-option label="有效" value="ok" />
              <el-option label="弱" value="weak" />
            </el-select>
            <el-radio-group v-model="horizon" class="ml-auto">
              <el-radio-button value="5">未来5日</el-radio-button>
              <el-radio-button value="10">未来10日</el-radio-button>
            </el-radio-group>
          </div>

          <div class="hint">
            共 {{ filteredCatalog.length }} 个 · 强信号 {{ strongCount }} · 反向 {{ reverseCount }} ·
            点击行查看介绍与公式
          </div>

          <el-table
            :data="filteredCatalog"
            height="560"
            size="small"
            class="tbl"
            @row-click="openDetail"
          >
            <el-table-column label="因子" min-width="220">
              <template #default="{ row }">
                <div class="fcell">
                  <span class="fcn">{{ row.cn }}</span>
                  <span class="fname mono">{{ row.name }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="分类" width="130">
              <template #default="{ row }">
                <span class="cat">{{ row.category }}</span>
              </template>
            </el-table-column>
            <el-table-column label="信号簇" width="130">
              <template #default="{ row }">
                <el-tag size="small" :type="clusterType[row.cluster]" effect="dark">
                  {{ row.cluster }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="mean_IC" width="100" align="right">
              <template #default="{ row }">
                <span class="mono" :class="icClass(icOf(row, horizon)?.meanIc)">
                  {{ fmtIc(icOf(row, horizon)?.meanIc) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="ICIR" width="80" align="right">
              <template #default="{ row }">
                <span class="mono mut">{{ icOf(row, horizon)?.icir?.toFixed(3) ?? '-' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="t值" width="80" align="right">
              <template #default="{ row }">
                <span class="mono" :class="icClass(icOf(row, horizon)?.t)">
                  {{ icOf(row, horizon)?.t?.toFixed(2) ?? '-' }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="正向天数" width="90" align="right">
              <template #default="{ row }">
                <span class="mono mut">{{ fmtPct(icOf(row, horizon)?.posRate) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="强度" width="92">
              <template #default="{ row }">
                <span class="badge" :class="row.strength">{{ strengthLabel[row.strength] }}</span>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <!-- ============ Tab2 当前榜单 ============ -->
        <el-tab-pane label="当前榜单" name="ranking">
          <div class="toolbar">
            <span class="lbl">按因子排名</span>
            <el-select
              v-model="rankFactor"
              filterable
              placeholder="选择因子"
              class="w260"
            >
              <el-option
                v-for="c in catalog"
                :key="c.name"
                :label="`${c.cn} (${c.name})`"
                :value="c.name"
              />
            </el-select>
            <el-select v-model="rankTopN" class="w120">
              <el-option :value="10" label="Top 10" />
              <el-option :value="15" label="Top 15" />
              <el-option :value="20" label="Top 20" />
            </el-select>
            <span class="snap-date mono">快照 {{ snapshotDate }}</span>
          </div>

          <div v-if="rankFactorMeta" class="rank-note">
            <span class="cat">{{ rankFactorMeta.category }}</span>
            <el-tag
              size="small"
              :type="rankFactorMeta.direction === 'neg' ? 'success' : 'danger'"
              effect="dark"
            >
              {{ rankFactorMeta.direction === 'neg' ? '反向（值越低越优）' : '正向（值越高越优）' }}
            </el-tag>
            <span class="desc">{{ rankFactorMeta.desc }}</span>
          </div>

          <div class="rank-body">
            <EChart :option="rankChartOption" height="440px" class="rank-chart" />
            <el-table :data="rankedEtfs.slice(0, rankTopN)" size="small" height="440" class="tbl rank-tbl">
              <el-table-column label="#" width="48" type="index" />
              <el-table-column label="ETF" min-width="150" prop="name" />
              <el-table-column label="代码" width="90">
                <template #default="{ row }"><span class="mono mut">{{ row.code }}</span></template>
              </el-table-column>
              <el-table-column label="因子值" width="110" align="right">
                <template #default="{ row }">
                  <span class="mono">{{ row.value.toFixed(4) }}</span>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </el-tab-pane>

        <!-- ============ Tab3 因子组合实验 ============ -->
        <el-tab-pane label="因子组合实验" name="combine">
          <el-alert type="info" :closable="false" class="mb" show-icon>
            <template #title>
              组合打分 = 各因子横截面 z-score 按权重加权（反向因子自动取负）。这是教学用的线性组合，
              不等于经过回测验证的策略；高 IC 适合分散多持仓，单仓押龙头仍以趋势质量族为主。
            </template>
          </el-alert>

          <div class="combo-pick">
            <el-select
              :model-value="''"
              filterable
              placeholder="+ 添加因子到组合"
              class="w260"
              @change="addToCombo"
            >
              <el-option
                v-for="c in catalog"
                :key="c.name"
                :label="`${c.cn} (${c.name})`"
                :value="c.name"
              />
            </el-select>
            <span class="hint">已选 {{ comboFactors.length }} 个因子</span>
          </div>

          <div v-if="!comboFactors.length" class="empty">
            还没有选因子。从上方下拉添加，或在「因子目录」点开某因子后「加入组合」。
          </div>

          <div v-else class="weights">
            <div v-for="f in comboFactors" :key="f" class="wrow">
              <div class="wname">
                <span class="fcn">{{ cnOf(f) }}</span>
                <span class="fname mono">{{ f }}</span>
              </div>
              <el-slider
                v-model="comboWeights[f]"
                :min="0"
                :max="3"
                :step="0.1"
                class="wslider"
              />
              <span class="wval mono">{{ (comboWeights[f] ?? 1).toFixed(1) }}</span>
              <button class="wdel" title="移除" @click="removeFromCombo(f)">移除</button>
            </div>
          </div>

          <div v-if="comboFactors.length" class="rank-body">
            <EChart :option="comboChartOption" height="440px" class="rank-chart" />
            <el-table :data="comboRanked.slice(0, rankTopN)" size="small" height="440" class="tbl rank-tbl">
              <el-table-column label="#" width="48" type="index" />
              <el-table-column label="ETF" min-width="150" prop="name" />
              <el-table-column label="组合分" width="100" align="right">
                <template #default="{ row }">
                  <span class="mono" :class="icClass(row.score)">{{ row.score.toFixed(3) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="趋势质量排名" width="120" align="right">
                <template #default="{ row }">
                  <span class="mono mut">{{ championRank.get(row.code) ?? '-' }}</span>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </el-tab-pane>
      </el-tabs>
    </template>

    <!-- 因子详情抽屉 -->
    <el-drawer v-model="detailVisible" :title="detailItem?.cn || '因子详情'" size="440px">
      <div v-if="detailItem" class="detail">
        <div class="d-name mono">{{ detailItem.name }}</div>
        <div class="d-tags">
          <span class="cat">{{ detailItem.category }}</span>
          <el-tag size="small" :type="clusterType[detailItem.cluster]" effect="dark">
            {{ detailItem.cluster }}
          </el-tag>
          <span class="badge" :class="detailItem.strength">{{ strengthLabel[detailItem.strength] }}</span>
        </div>

        <p class="d-desc">{{ detailItem.desc }}</p>

        <div v-if="detailItem.formula" class="d-block">
          <div class="d-block-h">公式</div>
          <pre class="d-formula mono">{{ detailItem.formula }}</pre>
        </div>

        <div class="d-block">
          <div class="d-block-h">IC 体检</div>
          <table class="d-ic">
            <thead>
              <tr><th></th><th>mean_IC</th><th>ICIR</th><th>t值</th><th>正向%</th></tr>
            </thead>
            <tbody>
              <tr>
                <td>未来5日</td>
                <td class="mono" :class="icClass(detailItem.ic5?.meanIc)">{{ fmtIc(detailItem.ic5?.meanIc) }}</td>
                <td class="mono mut">{{ detailItem.ic5?.icir?.toFixed(3) ?? '-' }}</td>
                <td class="mono" :class="icClass(detailItem.ic5?.t)">{{ detailItem.ic5?.t?.toFixed(2) ?? '-' }}</td>
                <td class="mono mut">{{ fmtPct(detailItem.ic5?.posRate) }}</td>
              </tr>
              <tr>
                <td>未来10日</td>
                <td class="mono" :class="icClass(detailItem.ic10?.meanIc)">{{ fmtIc(detailItem.ic10?.meanIc) }}</td>
                <td class="mono mut">{{ detailItem.ic10?.icir?.toFixed(3) ?? '-' }}</td>
                <td class="mono" :class="icClass(detailItem.ic10?.t)">{{ detailItem.ic10?.t?.toFixed(2) ?? '-' }}</td>
                <td class="mono mut">{{ fmtPct(detailItem.ic10?.posRate) }}</td>
              </tr>
            </tbody>
          </table>
          <p class="d-foot">
            {{ detailItem.direction === 'neg' ? '反向信号：值越高未来越弱，适合做排雷减分项。' : '正向信号：值越高越看多。' }}
          </p>
        </div>

        <el-button type="primary" class="d-add" @click="addToCombo(detailItem.name)">
          加入组合实验
        </el-button>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.factor-view {
  padding: 20px 24px 40px;
  max-width: 1400px;
  margin: 0 auto;
}
.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}
.page-head h1 {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 650;
  color: var(--text-0);
  margin: 0;
}
.page-head .sub {
  margin: 4px 0 0;
  color: var(--text-2);
  font-size: 13px;
}
.meta-strip {
  display: flex;
  gap: 16px;
  align-items: baseline;
  color: var(--text-2);
  font-size: 12px;
}
.meta-strip b {
  color: var(--text-0);
  font-family: var(--font-mono);
  font-size: 14px;
}
.mb {
  margin-bottom: 14px;
}

/* 导读 */
.guide {
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  background: var(--bg-2);
  padding: 16px;
  margin-bottom: 16px;
}
.guide-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}
@media (max-width: 768px) {
  .guide-cards {
    grid-template-columns: 1fr;
  }
}
.gc-h {
  font-size: 13px;
  font-weight: 650;
  color: var(--brand-2);
  margin-bottom: 6px;
}
.gc p {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-1);
}
.caveats {
  margin: 14px 0 0;
  padding: 12px 12px 12px 28px;
  border-top: 1px solid var(--grid-line);
  list-style: disc;
}
.caveats li {
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.7;
}

/* 工具栏 */
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.toolbar .lbl,
.toolbar .snap-date {
  font-size: 12px;
  color: var(--text-2);
}
.snap-date {
  margin-left: auto;
}
.ml-auto {
  margin-left: auto;
}
.w130 { width: 130px; }
.w120 { width: 120px; }
.w160 { width: 160px; }
.w220 { width: 220px; }
.w260 { width: 260px; }
.hint {
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 8px;
}

/* 表格 */
.tbl :deep(.el-table__row) {
  cursor: pointer;
}
.fcell {
  display: flex;
  flex-direction: column;
  line-height: 1.3;
}
.fcn {
  color: var(--text-0);
  font-size: 13px;
}
.fname {
  color: var(--text-2);
  font-size: 11px;
}
.cat {
  font-size: 12px;
  color: var(--text-1);
}
.mono {
  font-family: var(--font-mono);
}
.pos { color: var(--up); }
.neg { color: var(--down); }
.mut { color: var(--text-2); }

.badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  border: 1px solid var(--border);
  color: var(--text-2);
}
.badge.strong {
  background: var(--brand-soft);
  border-color: var(--brand-glow);
  color: var(--brand-2);
}
.badge.ok {
  border-color: var(--border);
  color: var(--text-1);
}

/* 榜单 / 组合 */
.rank-note {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
  font-size: 12.5px;
}
.rank-note .desc {
  color: var(--text-1);
  flex: 1;
  min-width: 240px;
}
.rank-body {
  display: grid;
  grid-template-columns: 1.3fr 1fr;
  gap: 16px;
}
@media (max-width: 920px) {
  .rank-body {
    grid-template-columns: 1fr;
  }
}

.combo-pick {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.weights {
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  background: var(--bg-2);
  padding: 8px 14px;
  margin-bottom: 16px;
}
.wrow {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 0;
}
.wrow + .wrow {
  border-top: 1px solid var(--grid-line);
}
.wname {
  width: 220px;
  display: flex;
  flex-direction: column;
  line-height: 1.3;
}
.wslider {
  flex: 1;
}
.wval {
  width: 38px;
  text-align: right;
  color: var(--brand-2);
}
.wdel {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-2);
  border-radius: var(--radius-sm);
  padding: 2px 10px;
  font-size: 12px;
  cursor: pointer;
}
.wdel:hover {
  border-color: var(--up);
  color: var(--up);
}
.empty {
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  padding: 32px;
  text-align: center;
  color: var(--text-2);
  font-size: 13px;
}

/* 抽屉 */
.detail {
  padding: 4px 4px 24px;
}
.d-name {
  color: var(--text-2);
  font-size: 12px;
  margin-bottom: 10px;
}
.d-tags {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
}
.d-desc {
  color: var(--text-1);
  font-size: 13.5px;
  line-height: 1.75;
}
.d-block {
  margin-top: 18px;
}
.d-block-h {
  font-size: 12px;
  color: var(--brand-2);
  font-weight: 650;
  margin-bottom: 8px;
}
.d-formula {
  background: var(--bg-1);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  font-size: 12px;
  color: var(--text-1);
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}
.d-ic {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.d-ic th,
.d-ic td {
  text-align: right;
  padding: 6px 8px;
  border-bottom: 1px solid var(--grid-line);
}
.d-ic th:first-child,
.d-ic td:first-child {
  text-align: left;
  color: var(--text-2);
}
.d-ic th {
  color: var(--text-2);
  font-weight: 500;
}
.d-foot {
  font-size: 12px;
  color: var(--text-2);
  margin: 10px 0 0;
}
.d-add {
  margin-top: 22px;
  width: 100%;
}
</style>
