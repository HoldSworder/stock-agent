<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import dayjs from 'dayjs';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Refresh, MagicStick, Plus, Delete, Setting } from '@element-plus/icons-vue';
import { api } from '@/api';
import ModuleScheduleDialog from '@/components/ModuleScheduleDialog.vue';
import MarkdownView from '@/components/MarkdownView.vue';
import { useKlineStore } from '@/stores/kline';
import type {
  EtfAction,
  EtfListItem,
  EtfOverview,
  EtfPoolItem,
  EtfSignal,
  EtfStatus,
  EtfTrigger,
  HomeModule,
} from '@stock-agent/shared';

const msg = (e: unknown) => (e instanceof Error ? e.message : '请求失败');
const kline = useKlineStore();
const openKline = (it: EtfListItem) => kline.open(it.code, it.name, it.secid);

const tab = ref<'overview' | 'pool'>('overview');
const status = ref<EtfStatus | null>(null);

// ===== Tab1 市场总览 =====
const ov = ref<EtfOverview | null>(null);
const ovLoading = ref(false);
const reviewing = ref(false);
const review = ref('');
// 面板显隐
const modules = ref<HomeModule[]>([]);
const drawer = ref(false);
const draft = ref<Record<string, boolean>>({});
const savingModules = ref(false);
const enabled = (id: string) => modules.value.find((m) => m.id === id)?.enabled ?? false;

// ===== Tab2 跟踪池 =====
const pool = ref<EtfPoolItem[]>([]);
const signals = ref<EtfSignal[]>([]);
const asOf = ref('');
const loading = ref(false);
const newCode = ref('');
const newTags = ref('');
const adding = ref(false);
const analyzeDialog = ref(false);
const analyzeText = ref('');
const analyzing = ref(false);

const ACTION_LABEL: Record<EtfAction, string> = {
  buy: '买入',
  add: '加仓',
  hold: '持有/观望',
  reduce: '减仓/止盈',
  avoid: '规避',
};
const actionTag = (a: EtfAction): 'danger' | 'warning' | 'success' | 'info' =>
  a === 'buy' ? 'danger' : a === 'add' ? 'warning' : a === 'reduce' ? 'success' : 'info';

// A 股红涨绿跌
const dir = (v: number | null | undefined) => (v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');
const pct = (v: number | null | undefined) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
const fixed = (v: number | null | undefined, d = 2) => (v == null ? '—' : v.toFixed(d));
const fmtNum = (v: number | null, digits = 3) => (v == null ? '—' : v.toFixed(digits));
const fmtTrig = (t: EtfTrigger | null) => (t ? `${t.value}` : '—');
// 成交额（亿）→ 过万亿换算
const amt = (yi: number) => (yi >= 10000 ? (yi / 10000).toFixed(2) + '万亿' : yi.toFixed(0) + '亿');

const statusText = () => {
  const s = status.value;
  if (!s) return '连接中…';
  if (!s.enabled) return '模块未启用';
  return `在线 · ${s.poolSize} 只`;
};

// ===== Tab1 加载 =====
async function loadOverview(silent = false) {
  if (!silent) ovLoading.value = true;
  try {
    ov.value = await api.etf.overview();
  } catch (e) {
    if (!silent) ElMessage.error(msg(e));
  } finally {
    if (!silent) ovLoading.value = false;
  }
}

async function loadModules() {
  try {
    modules.value = await api.etf.modules();
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
    modules.value = await api.etf.updateModules({ ...draft.value });
    drawer.value = false;
    ElMessage.success('模块配置已保存');
  } catch (e) {
    ElMessage.error(msg(e));
  } finally {
    savingModules.value = false;
  }
}

async function runReview() {
  reviewing.value = true;
  review.value = '';
  try {
    const r = await api.etf.review();
    review.value = r.text || '（无输出）';
  } catch (e) {
    ElMessage.error(msg(e));
  } finally {
    reviewing.value = false;
  }
}

// ===== Tab2 加载 =====
async function loadStatus() {
  try {
    status.value = await api.etf.status();
  } catch {
    /* 状态失败不阻断主流程 */
  }
}

async function loadPool() {
  try {
    pool.value = await api.etf.pool();
  } catch (e) {
    ElMessage.error(msg(e));
  }
}

async function loadSignals() {
  loading.value = true;
  try {
    const r = await api.etf.signals();
    signals.value = r.signals;
    asOf.value = r.asOf;
  } catch (e) {
    ElMessage.error(msg(e));
  } finally {
    loading.value = false;
  }
}

async function refreshPool() {
  await Promise.all([loadStatus(), loadPool()]);
  await loadSignals();
}

async function addPool() {
  const code = newCode.value.trim();
  if (!/^\d{6}$/.test(code)) {
    ElMessage.warning('请输入 6 位 ETF 代码');
    return;
  }
  adding.value = true;
  try {
    pool.value = await api.etf.addPool({ code, tags: newTags.value.trim() || undefined });
    newCode.value = '';
    newTags.value = '';
    ElMessage.success('已加入跟踪池');
    await Promise.all([loadStatus(), loadSignals()]);
  } catch (e) {
    ElMessage.error(msg(e));
  } finally {
    adding.value = false;
  }
}

async function removePool(item: EtfPoolItem) {
  try {
    await ElMessageBox.confirm(`从跟踪池移除 ${item.name}(${item.code})？`, '确认', {
      type: 'warning',
    });
  } catch {
    return;
  }
  try {
    pool.value = await api.etf.removePool(item.code);
    signals.value = signals.value.filter((s) => s.code !== item.code);
    await loadStatus();
    ElMessage.success('已移除');
  } catch (e) {
    ElMessage.error(msg(e));
  }
}

async function runAnalyze() {
  analyzing.value = true;
  analyzeDialog.value = true;
  analyzeText.value = '';
  try {
    const r = await api.etf.analyze();
    analyzeText.value = r.text || '（无输出）';
  } catch (e) {
    analyzeText.value = '';
    ElMessage.error(msg(e));
    analyzeDialog.value = false;
  } finally {
    analyzing.value = false;
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
onMounted(async () => {
  await Promise.all([loadStatus(), loadModules()]);
  await Promise.all([loadOverview(), refreshPool()]);
  // 交易时段静默轮询市场总览（仅当前在总览 Tab 时刷新，省请求）
  timer = setInterval(() => {
    if (tab.value === 'overview') void loadOverview(true);
  }, 3000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-title">ETF</div>
      <div class="head-actions">
        <span class="st-chip" :class="{ live: status?.enabled }">
          <span class="dot" />
          {{ statusText() }}
        </span>
        <template v-if="tab === 'overview'">
          <el-button :icon="MagicStick" type="primary" :loading="reviewing" @click="runReview">
            一键 AI 点评
          </el-button>
          <el-button :icon="Setting" @click="openDrawer">模块管理</el-button>
          <el-button :icon="Refresh" :loading="ovLoading" @click="loadOverview()">刷新</el-button>
        </template>
        <template v-else>
          <el-button :icon="MagicStick" type="primary" :loading="analyzing" @click="runAnalyze">
            AI 综合研判
          </el-button>
          <ModuleScheduleDialog module="etf" />
          <el-button :icon="Refresh" :loading="loading" @click="refreshPool">刷新信号</el-button>
        </template>
      </div>
    </div>

    <el-tabs v-model="tab" class="etf-tabs">
      <!-- ===================== Tab1 市场总览 ===================== -->
      <el-tab-pane label="ETF 市场总览" name="overview">
        <div class="page-sub">
          全市场 ETF 实时盘面（东方财富行情，红涨绿跌）
          <span v-if="ov"> · 更新 {{ dayjs(ov.asOf).format('HH:mm:ss') }}</span>
        </div>

        <!-- 首屏加载骨架（仿最终布局：统计条 + 行情条 + 双列面板） -->
        <div v-if="!ov && ovLoading" class="ov-skeleton">
          <el-skeleton animated>
            <template #template>
              <div class="sk-strip">
                <el-skeleton-item v-for="i in 5" :key="i" variant="p" class="sk-stat" />
              </div>
              <div class="sk-strip">
                <el-skeleton-item v-for="i in 4" :key="i" variant="p" class="sk-idx" />
              </div>
              <div class="grid">
                <div v-for="i in 2" :key="i" class="panel">
                  <el-skeleton-item variant="h3" style="width: 40%" />
                  <el-skeleton-item v-for="r in 5" :key="r" variant="text" style="margin-top: 12px" />
                </div>
              </div>
            </template>
          </el-skeleton>
        </div>

        <template v-else-if="ov">
          <!-- 全市场概览统计 -->
          <div v-if="enabled('overviewStat') && ov.stat" class="stat-strip">
            <div class="stat">
              <div class="stat-label">ETF 总数</div>
              <div class="stat-val num">{{ ov.stat.total }}</div>
              <div class="stat-sub num" :class="dir(ov.stat.avgPct)">
                平均 {{ pct(ov.stat.avgPct) }}
              </div>
            </div>
            <div class="stat">
              <div class="stat-label">上涨</div>
              <div class="stat-val num up">{{ ov.stat.up }}</div>
            </div>
            <div class="stat">
              <div class="stat-label">下跌</div>
              <div class="stat-val num down">{{ ov.stat.down }}</div>
            </div>
            <div class="stat">
              <div class="stat-label">平盘</div>
              <div class="stat-val num">{{ ov.stat.flat }}</div>
            </div>
            <div class="stat">
              <div class="stat-label">总成交额</div>
              <div class="stat-val num">{{ amt(ov.stat.totalAmount) }}</div>
            </div>
          </div>

          <!-- 主流宽基行情条 -->
          <div v-if="enabled('broadStrip') && ov.broad.length" class="idx-strip">
            <div
              v-for="it in ov.broad"
              :key="it.code"
              class="idx idx-clickable"
              role="button"
              tabindex="0"
              @click="openKline(it)"
              @keydown.enter="openKline(it)"
            >
              <div class="idx-name">{{ it.name }}</div>
              <div class="idx-point num" :class="dir(it.pct)">{{ fixed(it.price, 3) }}</div>
              <div class="idx-pct num" :class="dir(it.pct)">{{ pct(it.pct) }}</div>
            </div>
          </div>

          <!-- AI 点评 -->
          <div v-if="reviewing || review" class="review">
            <div class="review-head"><el-icon><MagicStick /></el-icon> AI 市场点评</div>
            <div v-if="reviewing" class="review-loading">正在结合 ETF 盘面生成点评…</div>
            <MarkdownView v-else :source="review" />
          </div>

          <div class="grid">
            <!-- 涨跌幅双列榜 -->
            <div v-if="enabled('changeRank')" class="panel">
              <div class="panel-head"><span class="panel-title">涨跌幅榜</span></div>
              <div class="two-col">
                <div class="col">
                  <div class="col-cap up">涨幅 TOP</div>
                  <div v-for="it in ov.gainers" :key="it.code" class="flow-row">
                    <span class="flow-name link" role="button" @click="openKline(it)"
                      >{{ it.name }}</span
                    >
                    <span class="num up">{{ pct(it.pct) }}</span>
                  </div>
                  <el-empty v-if="!ov.gainers.length" :image-size="44" description="暂无" />
                </div>
                <div class="col">
                  <div class="col-cap down">跌幅 TOP</div>
                  <div v-for="it in ov.losers" :key="it.code" class="flow-row">
                    <span class="flow-name link" role="button" @click="openKline(it)"
                      >{{ it.name }}</span
                    >
                    <span class="num down">{{ pct(it.pct) }}</span>
                  </div>
                  <el-empty v-if="!ov.losers.length" :image-size="44" description="暂无" />
                </div>
              </div>
            </div>

            <!-- 主力资金流双列 -->
            <div v-if="enabled('moneyflow')" class="panel">
              <div class="panel-head"><span class="panel-title">主力资金流</span></div>
              <div class="two-col">
                <div class="col">
                  <div class="col-cap up">净流入 TOP</div>
                  <div v-for="it in ov.inflow" :key="it.code" class="flow-row">
                    <span class="flow-name link" role="button" @click="openKline(it)"
                      >{{ it.name }}</span
                    >
                    <span class="num up">+{{ fixed(it.netInflow) }}亿</span>
                  </div>
                  <el-empty v-if="!ov.inflow.length" :image-size="44" description="暂无" />
                </div>
                <div class="col">
                  <div class="col-cap down">净流出 TOP</div>
                  <div v-for="it in ov.outflow" :key="it.code" class="flow-row">
                    <span class="flow-name link" role="button" @click="openKline(it)"
                      >{{ it.name }}</span
                    >
                    <span class="num down">{{ fixed(it.netInflow) }}亿</span>
                  </div>
                  <el-empty v-if="!ov.outflow.length" :image-size="44" description="暂无" />
                </div>
              </div>
            </div>

            <!-- 成交额榜 -->
            <div v-if="enabled('turnoverRank')" class="panel">
              <div class="panel-head"><span class="panel-title">成交额榜（流动性 TOP）</span></div>
              <el-table :data="ov.turnover" size="small" style="width: 100%" @row-click="openKline">
                <el-table-column type="index" label="#" width="44" />
                <el-table-column label="名称" min-width="120">
                  <template #default="{ row }">{{ row.name }}<span class="muted">({{ row.code }})</span></template>
                </el-table-column>
                <el-table-column label="涨幅" min-width="84" align="right">
                  <template #default="{ row }"><span class="num" :class="dir(row.pct)">{{ pct(row.pct) }}</span></template>
                </el-table-column>
                <el-table-column label="成交额" min-width="92" align="right">
                  <template #default="{ row }"><span class="num">{{ fixed(row.amount) }}亿</span></template>
                </el-table-column>
              </el-table>
            </div>

            <!-- 规模榜 -->
            <div v-if="enabled('aumRank')" class="panel">
              <div class="panel-head"><span class="panel-title">规模榜（AUM TOP）</span></div>
              <el-table :data="ov.aum" size="small" style="width: 100%" @row-click="openKline">
                <el-table-column type="index" label="#" width="44" />
                <el-table-column label="名称" min-width="120">
                  <template #default="{ row }">{{ row.name }}<span class="muted">({{ row.code }})</span></template>
                </el-table-column>
                <el-table-column label="涨幅" min-width="84" align="right">
                  <template #default="{ row }"><span class="num" :class="dir(row.pct)">{{ pct(row.pct) }}</span></template>
                </el-table-column>
                <el-table-column label="规模" min-width="92" align="right">
                  <template #default="{ row }"><span class="num">{{ fixed(row.aum) }}亿</span></template>
                </el-table-column>
              </el-table>
            </div>

            <!-- 主题赛道分类 -->
            <div v-if="enabled('themeCat')" class="panel">
              <div class="panel-head"><span class="panel-title">主题赛道分类</span></div>
              <el-table :data="ov.themes" size="small" style="width: 100%">
                <el-table-column label="赛道" min-width="120">
                  <template #default="{ row }">{{ row.name }}</template>
                </el-table-column>
                <el-table-column label="平均涨幅" min-width="90" align="right">
                  <template #default="{ row }"><span class="num" :class="dir(row.avgPct)">{{ pct(row.avgPct) }}</span></template>
                </el-table-column>
                <el-table-column label="领涨代表" min-width="150">
                  <template #default="{ row }">
                    <span v-if="row.lead">
                      {{ row.lead.name }}
                      <span class="num" :class="dir(row.lead.pct)">{{ pct(row.lead.pct) }}</span>
                    </span>
                    <span v-else class="muted">—</span>
                  </template>
                </el-table-column>
              </el-table>
            </div>
          </div>
        </template>

        <el-empty v-else description="暂无 ETF 盘面数据，点右上角刷新重试" />
      </el-tab-pane>

      <!-- ===================== Tab2 我的跟踪池 ===================== -->
      <el-tab-pane label="我的跟踪池" name="pool">
        <div class="page-sub">
          独立跟踪池，叠加估值分位、年线偏离、折溢价、动量轮动、网格水位等确定性指标生成买卖信号，仅供研判，不自动下单
        </div>

        <div class="filters">
          <el-input
            v-model="newCode"
            placeholder="ETF 代码，如 510300"
            clearable
            class="f-input"
            @keyup.enter="addPool"
          />
          <el-input v-model="newTags" placeholder="标签（可空，逗号分隔）" clearable class="f-input" />
          <el-button type="primary" :icon="Plus" :loading="adding" @click="addPool">加入跟踪池</el-button>
          <span v-if="asOf" class="muted as-of">信号更新于 {{ dayjs(asOf).format('HH:mm:ss') }}</span>
        </div>

        <div v-loading="loading && signals.length > 0" class="panel pool-panel">
          <el-table v-if="signals.length" :data="signals" size="small" row-key="code">
            <el-table-column type="expand">
              <template #default="{ row }">
                <div class="expand-box">
                  <p v-if="row.warning" class="warn">⚠️ {{ row.warning }}</p>
                  <ul class="notes">
                    <li v-for="(n, i) in row.notes" :key="i">{{ n }}</li>
                  </ul>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="标的" min-width="150" fixed>
              <template #default="{ row }">
                <span>{{ row.name }}<span class="muted">({{ row.code }})</span></span>
              </template>
            </el-table-column>
            <el-table-column label="现价" width="90">
              <template #default="{ row }">{{ fmtNum(row.price) }}</template>
            </el-table-column>
            <el-table-column label="涨跌" width="80">
              <template #default="{ row }">
                <span :class="dir(row.pct)">{{ pct(row.pct) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="建议" width="100">
              <template #default="{ row }">
                <el-tag :type="actionTag(row.action)" effect="dark" size="small">
                  {{ ACTION_LABEL[row.action as EtfAction] }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="估值分位" width="90">
              <template #default="{ row }">
                {{ row.pricePercentile == null ? '—' : row.pricePercentile + '%' }}
              </template>
            </el-table-column>
            <el-table-column label="年线偏离" width="90">
              <template #default="{ row }">
                <span :class="dir(row.maDeviation)">{{ pct(row.maDeviation) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="折溢价" width="90">
              <template #default="{ row }">
                <span :class="dir(row.premiumPct)">{{ pct(row.premiumPct) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="动量(排名)" width="110">
              <template #default="{ row }">
                <span v-if="row.momentum == null" class="muted">—</span>
                <span v-else :class="dir(row.momentum)">
                  {{ pct(row.momentum) }}<span v-if="row.momentumRank" class="muted"> #{{ row.momentumRank }}</span>
                </span>
              </template>
            </el-table-column>
            <el-table-column label="波动" width="80">
              <template #default="{ row }">{{ row.volatility == null ? '—' : row.volatility + '%' }}</template>
            </el-table-column>
            <el-table-column label="触发价 买/卖/损/盈" min-width="190">
              <template #default="{ row }">
                <span class="trig">
                  <span class="up">{{ fmtTrig(row.buyTrigger) }}</span> /
                  <span class="down">{{ fmtTrig(row.sellTrigger) }}</span> /
                  <span>{{ fmtTrig(row.stopLoss) }}</span> /
                  <span>{{ fmtTrig(row.takeProfit) }}</span>
                </span>
              </template>
            </el-table-column>
            <el-table-column label="网格(档/下买/上卖)" min-width="160">
              <template #default="{ row }">
                <span v-if="row.grid" class="muted">
                  {{ row.grid.level }}/{{ row.grid.gridCount }}（{{ row.grid.stepPct }}%）
                  <span class="up">{{ row.grid.nextBuy ?? '—' }}</span> /
                  <span class="down">{{ row.grid.nextSell ?? '—' }}</span>
                </span>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="70" fixed="right">
              <template #default="{ row }">
                <el-button
                  :icon="Delete"
                  size="small"
                  text
                  type="danger"
                  @click="removePool({ code: row.code, name: row.name } as EtfPoolItem)"
                />
              </template>
            </el-table-column>
          </el-table>
          <div v-else-if="loading" class="pool-loading">
            <el-skeleton :rows="8" animated />
            <p class="pool-loading-tip">正在为 {{ status?.poolSize ?? '' }} 只 ETF 计算信号，标的较多时需要数秒…</p>
          </div>
          <el-empty v-else description="跟踪池为空，添加 ETF 后刷新信号" />
        </div>
      </el-tab-pane>
    </el-tabs>

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

    <el-dialog v-model="analyzeDialog" title="ETF 综合研判" width="720px" top="6vh">
      <div v-loading="analyzing" class="analyze-box">
        <MarkdownView v-if="analyzeText" :source="analyzeText" />
        <p v-else class="muted">研判中…</p>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
/* 全局 .page-sub 默认 margin-top:-12px 是为贴在 page-head 下；本页在 el-tabs 内，
   负边距会把说明文案顶到 tab 栏下方被遮挡，这里覆盖为正常间距 */
.page-sub {
  margin-top: 4px;
}
/* 状态徽标（与研报/盯盘页一致，此前缺失导致裸文本显示） */
.st-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-1);
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  white-space: nowrap;
}
.st-chip .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-2);
}
.st-chip.live .dot {
  background: var(--down);
  box-shadow: 0 0 8px var(--down);
}
/* 首屏加载骨架 */
.ov-skeleton {
  margin-top: 4px;
}
.sk-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
  margin-bottom: 14px;
}
.sk-stat {
  height: 64px;
  border-radius: var(--radius);
}
.sk-idx {
  height: 72px;
  border-radius: var(--radius);
}
/* 跟踪池加载：保证容器有高度，避免 spinner 贴在塌陷的细条上 */
.pool-panel {
  min-height: 160px;
}
.pool-loading {
  padding: 4px 2px;
}
.pool-loading-tip {
  margin: 14px 0 2px;
  font-size: 12.5px;
  color: var(--text-2);
  text-align: center;
}
/* ===== 市场总览（复用大盘页样式） ===== */
.idx-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin-bottom: 14px;
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
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.panel-title {
  font-weight: 600;
}
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
.link {
  cursor: pointer;
  color: var(--brand);
}
.link:hover {
  text-decoration: underline;
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
/* ===== 跟踪池 ===== */
.filters {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 12px 0;
  flex-wrap: wrap;
}
.f-input {
  width: 220px;
}
.as-of {
  margin-left: auto;
  font-size: 12px;
}
.muted {
  color: var(--text-2);
}
.up {
  color: #e54d42;
}
.down {
  color: #15a05a;
}
.trig {
  font-variant-numeric: tabular-nums;
}
.expand-box {
  padding: 6px 24px;
}
.expand-box .warn {
  color: var(--el-color-warning);
  margin: 0 0 6px;
}
.notes {
  margin: 0;
  padding-left: 18px;
  color: var(--el-text-color-regular);
}
.notes li {
  line-height: 1.7;
}
.analyze-box {
  min-height: 120px;
  max-height: 70vh;
  overflow: auto;
}
</style>
