<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import dayjs from 'dayjs';
import { ElMessage } from 'element-plus';
import { MagicStick, Clock, Memo, Warning } from '@element-plus/icons-vue';
import { api, openWs } from '@/api';
import ModuleScheduleDialog from '@/components/ModuleScheduleDialog.vue';
import MarkdownView from '@/components/MarkdownView.vue';
import StockLink from '@/components/StockLink.vue';
import { useKlineStore } from '@/stores/kline';
import type {
  MarketIndex,
  MarketOverview,
  MarketReviewResult,
  RealPortfolio,
  ReviewHistoryItem,
  StreamEvent,
} from '@stock-agent/shared';

const kline = useKlineStore();
const openIndexKline = (ix: MarketIndex) => kline.open(ix.code, ix.name, ix.secid);
// AI 热门板块仅有名称，按名称解析出 BK 代码再出 K 线
async function openSectorKline(name: string) {
  try {
    const list = await api.searchBoard(name);
    if (list.length > 0) kline.open(list[0].code, list[0].name || name);
    else ElMessage.warning(`未找到「${name}」对应板块行情`);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

type Phase = 'idle' | 'loading' | 'done';
interface ActStep {
  label: string;
  status: 'running' | 'ok' | 'fail';
}

const phase = ref<Phase>('idle');
const steps = ref<ActStep[]>([]);
const streamLog = ref('');
const generating = ref(false);
const result = ref<MarketReviewResult | null>(null);
const rawFallback = ref('');
const finishedAt = ref('');

// 数据面板（复用现有接口，静默拉取）
const overview = ref<MarketOverview | null>(null);
const portfolio = ref<RealPortfolio | null>(null);

// 复盘历史
const historyDrawer = ref(false);
const historyList = ref<ReviewHistoryItem[]>([]);
const historyLoading = ref(false);
const viewingHistory = ref(false);

const elapsedSec = ref(0);
let ws: WebSocket | null = null;
let elapsedTimer: ReturnType<typeof setInterval> | undefined;

function stopTimer() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = undefined;
}

// A股 红涨绿跌
const dir = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const pct = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
const fixed = (v: number, d = 2) => v.toFixed(d);
const amt = (yi: number) => (yi >= 10000 ? (yi / 10000).toFixed(2) + '万亿' : yi.toFixed(0) + '亿');

// 持仓建议色：加仓/持有偏多（红）、减仓/清仓偏空（绿）、观望中性
const actionClass = (a: string) =>
  a === '加仓' || a === '持有' ? 'up' : a === '减仓' || a === '清仓' ? 'down' : 'muted';

// 操作复盘结论 → Element Tag 语义类型（与价格红绿区分，文字本身已明确）
const verdictType = (v: string): 'success' | 'danger' | 'warning' | 'info' =>
  v === '正确' ? 'success' : v === '失误' ? 'danger' : v === '待观察' ? 'warning' : 'info';

// 情绪周期阶段 → Tag 类型
const phaseType = (p: string): 'success' | 'danger' | 'warning' | 'info' =>
  p === '高潮' ? 'danger' : p === '发酵' ? 'warning' : p === '启动' ? 'success' : 'info';

/** A股+外围综合方向 → 标签色（A股红涨绿跌：偏多 danger 红 / 偏空 success 绿） */
const stanceType = (b: string): 'success' | 'danger' | 'info' =>
  b === '偏多' ? 'danger' : b === '偏空' ? 'success' : 'info';

/** 情绪标杆类型 → 标签色（弱转强偏多红 / 强转弱偏空绿 / 龙头标杆中性） */
const benchmarkType = (t: string): 'success' | 'danger' | 'warning' | 'info' =>
  t === '弱转强' ? 'danger' : t === '强转弱' ? 'success' : t === '空间龙' ? 'warning' : 'info';

// 第三层自检明细折叠态：默认展开「持仓/操作复盘」，其余收起去噪
const detailOpen = ref<string[]>(['pos']);

const hasReview = computed(() => result.value !== null);

/** 工具名 → 友好活动描述 */
function toolLabel(name: string): string {
  const map: Record<string, string> = {
    mx_search: '检索消息面 / 资金面',
    mx_finance_data: '查询行情 / 财务数据',
    mx_screener: '选股筛选',
    real_positions: '读取真实持仓',
    mx_self_select: '读取自选股',
  };
  return map[name] ?? name;
}

/** 闭合被截断的 JSON：补全未结束的字符串与括号，去除尾随逗号 */
function closeJson(s: string): string {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') stack.pop();
  }
  let out = s;
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, '');
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']';
  return out;
}

/** 容错解析：原文→闭合补全→自尾部回退到最近的闭合点，尽量挽回截断输出 */
function looseParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    /* fallthrough */
  }
  try {
    return JSON.parse(closeJson(s)) as Record<string, unknown>;
  } catch {
    /* fallthrough */
  }
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === '}' || s[i] === ']') {
      try {
        return JSON.parse(closeJson(s.slice(0, i + 1))) as Record<string, unknown>;
      } catch {
        /* 继续向前回退 */
      }
    }
  }
  return null;
}

/** 从 agent 最终文本中提取并解析结构化 JSON；失败返回 null */
function parseResult(text: string): MarketReviewResult | null {
  if (!text) return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1) return null;
  const slice = end > start ? s.slice(start, end + 1) : s.slice(start);
  const obj = looseParse(slice) as Partial<MarketReviewResult> | null;
  if (!obj) return null;
  {
    const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
    return {
      marketTrend: obj.marketTrend ?? '',
      emotionNote: obj.emotionNote ?? '',
      emotionCycle: obj.emotionCycle ?? null,
      capitalFlow: obj.capitalFlow ?? null,
      ladderQuality: obj.ladderQuality ?? null,
      dragonTiger: arr(obj.dragonTiger),
      sentimentBenchmark: arr(obj.sentimentBenchmark),
      mainThemes: arr(obj.mainThemes),
      hotSectors: arr(obj.hotSectors),
      hotStocks: arr(obj.hotStocks),
      strongSectors: arr(obj.strongSectors),
      strongStocks: arr(obj.strongStocks),
      positionsReview: arr(obj.positionsReview),
      myTradesReview: arr(obj.myTradesReview),
      watchlistReview: arr(obj.watchlistReview),
      risks: arr(obj.risks),
      tomorrowPlan: obj.tomorrowPlan ?? null,
      trendComparison: obj.trendComparison ?? null,
      overseasMarkets: obj.overseasMarkets ?? null,
      comprehensiveStance: obj.comprehensiveStance ?? null,
      suggestions: arr(obj.suggestions),
    };
  }
}

async function loadPanels() {
  const [ov, pf] = await Promise.all([
    api.getMarketOverview().catch(() => null),
    api.getRealPositions().catch(() => null),
  ]);
  overview.value = ov;
  portfolio.value = pf;
}

async function openHistory() {
  historyDrawer.value = true;
  historyLoading.value = true;
  try {
    historyList.value = await api.listReviews(50);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    historyLoading.value = false;
  }
}

/** 查看一条历史复盘：解析其 JSON 输出并渲染（不展示今日实时数据面板） */
function viewHistory(item: ReviewHistoryItem) {
  const parsed = parseResult(item.outputText ?? '');
  if (parsed) {
    result.value = parsed;
    rawFallback.value = '';
  } else {
    result.value = null;
    rawFallback.value = item.outputText || '（无输出）';
  }
  viewingHistory.value = true;
  finishedAt.value = dayjs(item.createdAt).format('MM-DD HH:mm');
  phase.value = 'done';
  historyDrawer.value = false;
}

function generate() {
  if (phase.value === 'loading') return;
  phase.value = 'loading';
  generating.value = true;
  viewingHistory.value = false;
  steps.value = [];
  streamLog.value = '';
  result.value = null;
  rawFallback.value = '';
  elapsedSec.value = 0;
  let finalText = '';
  let finished = false;

  stopTimer();
  elapsedTimer = setInterval(() => (elapsedSec.value += 1), 1000);

  void loadPanels();

  ws?.close();
  ws = openWs('/ws/review');

  ws.onmessage = (ev) => {
    const e: StreamEvent = JSON.parse(ev.data);
    if (e.type === 'token') {
      streamLog.value += e.text;
    } else if (e.type === 'tool_call') {
      steps.value.push({ label: toolLabel(e.name), status: 'running' });
    } else if (e.type === 'tool_result') {
      // 标记最近一个 running 步骤完成
      for (let i = steps.value.length - 1; i >= 0; i--) {
        if (steps.value[i].status === 'running') {
          steps.value[i].status = e.ok ? 'ok' : 'fail';
          break;
        }
      }
    } else if (e.type === 'message' && e.role === 'assistant') {
      finalText = e.content;
    } else if (e.type === 'run_finished') {
      finished = true;
      stopTimer();
      generating.value = false;
      const parsed = parseResult(finalText || streamLog.value);
      if (parsed) result.value = parsed;
      else rawFallback.value = finalText || streamLog.value || '（无输出）';
      if (e.status !== 'success') {
        ElMessage.warning(`复盘运行${e.status === 'timeout' ? '超时' : '未成功'}，已展示已生成内容`);
      }
      finishedAt.value = dayjs().format('HH:mm:ss');
      phase.value = 'done';
      ws?.close();
    } else if (e.type === 'error') {
      finished = true;
      stopTimer();
      generating.value = false;
      ElMessage.error(e.message);
      phase.value = result.value || rawFallback.value ? 'done' : 'idle';
      ws?.close();
    }
  };
  ws.onerror = () => {
    if (finished) return;
    finished = true;
    stopTimer();
    generating.value = false;
    ElMessage.error('无法连接复盘服务，请确认后端已启动');
    phase.value = 'idle';
  };
  ws.onclose = () => {
    if (!finished && phase.value === 'loading') {
      finished = true;
      stopTimer();
      generating.value = false;
      ElMessage.error('复盘连接已断开，生成未完成');
      phase.value = 'idle';
    }
  };

  const trigger = () => ws!.send(JSON.stringify({ action: 'generate' }));
  if (ws.readyState === WebSocket.OPEN) trigger();
  else ws.addEventListener('open', trigger, { once: true });
}

/** 首屏默认展示最近一次复盘：取最新一条历史并复用渲染逻辑，无记录则维持空态 */
async function loadLatestReview() {
  if (phase.value !== 'idle') return;
  try {
    const list = await api.listReviews(1);
    if (list.length > 0 && phase.value === 'idle') viewHistory(list[0]);
  } catch {
    /* 首屏静默：无记录或请求失败时保持空态 */
  }
}

onMounted(() => {
  void loadLatestReview();
});

onUnmounted(() => {
  stopTimer();
  if (ws) {
    // 切页卸载属正常关闭：先摘除处理器，避免 onclose 误报「连接已断开」
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
    ws = null;
  }
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-title">复盘</div>
      <div class="head-actions">
        <ModuleScheduleDialog module="review" />
        <el-button :icon="Clock" @click="openHistory">历史</el-button>
        <el-button
          :icon="MagicStick"
          type="primary"
          :loading="phase === 'loading'"
          @click="generate"
        >
          {{ phase === 'done' ? '重新复盘' : '生成复盘' }}
        </el-button>
      </div>
    </div>

    <div class="page-sub">
      AI 深度多维复盘 · 大盘 / 情绪周期 / 资金面 / 主线题材 / 持仓 / 自选 / 风险 / 明日策略
      <span v-if="phase === 'done' && finishedAt">
        · {{ viewingHistory ? '历史复盘' : '完成' }} {{ finishedAt }}
      </span>
    </div>

    <!-- 空态 -->
    <el-empty
      v-if="phase === 'idle'"
      description="点击「生成复盘」，AI 将结合实时盘面、真实持仓与自选股做一份当日深度复盘"
    />

    <!-- loading：执行活动时间线 + 结果骨架 -->
    <div v-else-if="phase === 'loading'" class="loading-wrap">
      <div class="act-card">
        <div class="act-head">
          <span class="pulse" />
          正在复盘 · 已 {{ elapsedSec }}s
          <span class="act-hint">通常需 1-2 分钟，请勿离开</span>
        </div>
        <div class="act-steps">
          <div v-for="(s, i) in steps" :key="i" class="act-step" :class="s.status">
            <span class="step-ic">{{ s.status === 'running' ? '◐' : s.status === 'ok' ? '✓' : '✕' }}</span>
            <span class="step-label">{{ s.label }}</span>
          </div>
          <div class="act-step running">
            <span class="step-ic">◐</span>
            <span class="step-label">{{ streamLog ? '生成复盘结论…' : '收集盘面 / 持仓 / 自选数据…' }}</span>
          </div>
        </div>
        <details v-if="streamLog" class="raw">
          <summary>原始输出</summary>
          <pre class="raw-body">{{ streamLog }}</pre>
        </details>
      </div>
      <!-- 结果骨架 -->
      <div class="sk-grid">
        <div class="sk sk-band" />
        <div class="sk sk-block" />
        <div class="sk-row">
          <div class="sk sk-half" />
          <div class="sk sk-half" />
        </div>
        <div class="sk sk-block" />
      </div>
    </div>

    <!-- 完成：模块化卡片 + 数据面板 -->
    <template v-else>
      <!-- 解析失败回退 -->
      <div v-if="!hasReview" class="panel block">
        <div class="panel-head"><span class="panel-title">复盘结论</span></div>
        <MarkdownView :source="rawFallback" />
      </div>

      <template v-else-if="result">
        <!-- 概览头条 -->
        <div class="band reveal" style="--i: 0">
          <div class="band-left">
            <div class="band-date">{{ finishedAt }}</div>
            <el-tag
              v-if="result.emotionCycle"
              size="large"
              effect="dark"
              :type="phaseType(result.emotionCycle.phase)"
            >
              情绪 · {{ result.emotionCycle.phase }}
            </el-tag>
          </div>
          <div v-if="!viewingHistory && overview" class="band-idx">
            <div
              v-for="ix in overview.indices"
              :key="ix.code"
              class="band-idx-cell idx-clickable"
              role="button"
              tabindex="0"
              @click="openIndexKline(ix)"
              @keydown.enter="openIndexKline(ix)"
            >
              <span class="band-idx-name">{{ ix.name }}</span>
              <span class="num" :class="dir(ix.pct)">{{ pct(ix.pct) }}</span>
            </div>
          </div>
          <div v-if="!viewingHistory && overview?.emotion" class="band-stats">
            <span>涨停 <b class="num up">{{ overview.emotion.limitUp }}</b></span>
            <span>跌停 <b class="num down">{{ overview.emotion.limitDown }}</b></span>
            <span>最高 <b class="num up">{{ overview.emotion.maxStreak }}</b> 连板</span>
            <span v-if="overview.turnoverTotal">成交 <b class="num">{{ amt(overview.turnoverTotal.total) }}</b></span>
          </div>
        </div>

        <!-- ===== 第一层 决策摘要 hero：一眼抓住「明天怎么干」 ===== -->
        <div class="hero reveal" style="--i: 1">
          <div class="hero-head">
            <span class="hero-cap">决策摘要</span>
            <el-tag
              v-if="result.comprehensiveStance"
              size="large"
              effect="dark"
              :type="stanceType(result.comprehensiveStance.bias)"
            >
              {{ result.comprehensiveStance.bias }}
            </el-tag>
            <el-tag
              v-if="result.emotionCycle"
              size="large"
              effect="dark"
              :type="phaseType(result.emotionCycle.phase)"
            >
              情绪 · {{ result.emotionCycle.phase }}
            </el-tag>
            <span v-if="result.tomorrowPlan?.positionAdvice" class="hero-pos">
              仓位 · {{ result.tomorrowPlan.positionAdvice }}
            </span>
          </div>
          <p v-if="result.comprehensiveStance?.summary" class="hero-summary">
            {{ result.comprehensiveStance.summary }}
          </p>
          <div class="hero-grid">
            <div v-if="result.tomorrowPlan?.focus?.length" class="hero-cell">
              <div class="hero-cell-cap">明日重点</div>
              <ul class="hero-list">
                <li v-for="(f, i) in result.tomorrowPlan.focus" :key="i">{{ f }}</li>
              </ul>
            </div>
            <div v-if="result.comprehensiveStance?.drivers?.length" class="hero-cell">
              <div class="hero-cell-cap">关键驱动</div>
              <ul class="hero-list">
                <li v-for="(d, i) in result.comprehensiveStance.drivers" :key="i">{{ d }}</li>
              </ul>
            </div>
            <div v-if="result.risks.length" class="hero-cell hero-risk">
              <div class="hero-cell-cap">风险 · {{ result.risks.length }}</div>
              <ul class="hero-list">
                <li v-for="(r, i) in result.risks" :key="i">{{ r.title }}</li>
              </ul>
            </div>
          </div>
        </div>

        <!-- ===== 第二层 核心论据 ===== -->
        <div class="layer-cap reveal" style="--i: 2">核心论据</div>

        <!-- 大盘走势 + 情绪 -->
        <div class="panel block reveal" style="--i: 2">
          <div class="panel-head"><span class="panel-title">大盘走势</span></div>
          <p class="prose">{{ result.marketTrend || '—' }}</p>
          <div v-if="result.emotionNote" class="sub-block">
            <div class="sub-cap">市场情绪</div>
            <p class="prose dim">{{ result.emotionNote }}</p>
          </div>
        </div>

        <!-- 情绪周期 + 资金面 -->
        <div
          v-if="result.emotionCycle || result.capitalFlow"
          class="grid reveal"
          style="--i: 2"
        >
          <div v-if="result.emotionCycle" class="panel">
            <div class="panel-head">
              <span class="panel-title">情绪周期定位</span>
              <el-tag size="small" effect="dark" :type="phaseType(result.emotionCycle.phase)">
                {{ result.emotionCycle.phase }}
              </el-tag>
            </div>
            <div class="kv">
              <span class="kv-k">赚钱效应</span>
              <span class="kv-v">{{ result.emotionCycle.moneyEffect || '—' }}</span>
            </div>
            <p class="prose dim sm">{{ result.emotionCycle.note }}</p>
          </div>

          <div v-if="result.capitalFlow" class="panel">
            <div class="panel-head"><span class="panel-title">资金面</span></div>
            <div class="kv"><span class="kv-k">北向</span><span class="kv-v">{{ result.capitalFlow.northbound || '—' }}</span></div>
            <div class="kv"><span class="kv-k">主力</span><span class="kv-v">{{ result.capitalFlow.mainForce || '—' }}</span></div>
            <div class="kv"><span class="kv-k">两融</span><span class="kv-v">{{ result.capitalFlow.margin || '—' }}</span></div>
            <div class="kv"><span class="kv-k">量能</span><span class="kv-v">{{ result.capitalFlow.volume || '—' }}</span></div>
            <div class="kv"><span class="kv-k">风格</span><span class="kv-v">{{ result.capitalFlow.styleNote || '—' }}</span></div>
          </div>
        </div>

        <!-- 主线题材 -->
        <div v-if="result.mainThemes.length" class="panel block reveal" style="--i: 3">
          <div class="panel-head"><span class="panel-title">当前主线题材</span></div>
          <div v-for="(t, i) in result.mainThemes" :key="i" class="theme-row">
            <div class="theme-top">
              <span class="theme-rank num">{{ i + 1 }}</span>
              <span class="theme-name">{{ t.name }}</span>
              <el-tag size="small" effect="dark" type="warning">{{ t.strength }}</el-tag>
            </div>
            <p class="prose dim">{{ t.reason }}</p>
          </div>
        </div>

        <!-- 连板梯队质量 -->
        <div v-if="result.ladderQuality" class="panel block reveal" style="--i: 4">
          <div class="panel-head"><span class="panel-title">连板梯队质量</span></div>
          <div class="stat-row">
            <div class="stat-cell">
              <div class="stat-cap">晋级率</div>
              <div class="stat-num num">{{ result.ladderQuality.promotionRate || '—' }}</div>
            </div>
            <div class="stat-cell">
              <div class="stat-cap">炸板率</div>
              <div class="stat-num num">{{ result.ladderQuality.brokenRate || '—' }}</div>
            </div>
            <div class="stat-cell">
              <div class="stat-cap">最高板</div>
              <div class="stat-num num up">{{ result.ladderQuality.maxHeight || '—' }}</div>
            </div>
            <div class="stat-cell">
              <div class="stat-cap">高度板分歧</div>
              <div class="stat-num">{{ result.ladderQuality.divergence || '—' }}</div>
            </div>
            <div v-if="result.ladderQuality.limitUpPremium" class="stat-cell">
              <div class="stat-cap">涨停溢价率</div>
              <div class="stat-num num">{{ result.ladderQuality.limitUpPremium }}</div>
            </div>
          </div>
        </div>

        <!-- 龙虎榜资金 + 情绪标杆 -->
        <div
          v-if="result.dragonTiger.length || result.sentimentBenchmark.length"
          class="grid reveal"
          style="--i: 4"
        >
          <div v-if="result.dragonTiger.length" class="panel">
            <div class="panel-head">
              <span class="panel-title">龙虎榜资金</span>
              <el-tag size="small" effect="plain" type="warning">妙想</el-tag>
            </div>
            <div v-for="(d, i) in result.dragonTiger" :key="i" class="line-item">
              <div class="line-top">
                <StockLink class="line-name" :code="d.code" :name="d.name" />
                <span class="code">{{ d.code }}</span>
                <span class="dt-net">{{ d.netBuy }}</span>
              </div>
              <p class="prose dim sm">{{ d.note }}</p>
            </div>
          </div>

          <div v-if="result.sentimentBenchmark.length" class="panel">
            <div class="panel-head"><span class="panel-title">情绪标杆</span></div>
            <div v-for="(s, i) in result.sentimentBenchmark" :key="i" class="line-item">
              <div class="line-top">
                <el-tag size="small" effect="dark" :type="benchmarkType(s.type)">{{ s.type }}</el-tag>
                <StockLink class="line-name" :code="s.code" :name="s.name" />
                <span class="code">{{ s.code }}</span>
              </div>
              <p class="prose dim sm">{{ s.note }}</p>
            </div>
          </div>
        </div>

        <!-- 热门板块 / 概念 + 热门个股 -->
        <div
          v-if="result.hotSectors.length || result.hotStocks.length"
          class="grid reveal"
          style="--i: 5"
        >
          <div v-if="result.hotSectors.length" class="panel">
            <div class="panel-head"><span class="panel-title">热门板块 / 细分概念</span></div>
            <div v-for="(s, i) in result.hotSectors" :key="i" class="line-item">
              <div class="line-top">
                <span class="line-name sec-link" @click="openSectorKline(s.name)">{{ s.name }}</span>
                <el-tag size="small" effect="plain">{{ s.kind }}</el-tag>
              </div>
              <p class="prose dim sm">{{ s.note }}</p>
            </div>
          </div>

          <div v-if="result.hotStocks.length" class="panel">
            <div class="panel-head"><span class="panel-title">热门个股</span></div>
            <div v-for="(s, i) in result.hotStocks" :key="i" class="line-item">
              <div class="line-top">
                <StockLink class="line-name" :code="s.code" :name="s.name" />
                <span class="code">{{ s.code }}</span>
              </div>
              <p class="prose dim sm">{{ s.note }}</p>
            </div>
          </div>
        </div>

        <!-- 妙想强势板块 / 强势个股 -->
        <div
          v-if="result.strongSectors.length || result.strongStocks.length"
          class="grid reveal"
          style="--i: 5"
        >
          <div v-if="result.strongSectors.length" class="panel">
            <div class="panel-head">
              <span class="panel-title">强势板块</span>
              <el-tag size="small" effect="plain" type="warning">妙想</el-tag>
            </div>
            <div v-for="(s, i) in result.strongSectors" :key="i" class="line-item">
              <div class="line-top">
                <span class="line-name sec-link" @click="openSectorKline(s.name)">{{ s.name }}</span>
                <span v-if="s.leader" class="code">领涨 {{ s.leader }}</span>
              </div>
              <p class="prose dim sm">{{ s.reason }}</p>
            </div>
          </div>

          <div v-if="result.strongStocks.length" class="panel">
            <div class="panel-head">
              <span class="panel-title">强势个股</span>
              <el-tag size="small" effect="plain" type="warning">妙想</el-tag>
            </div>
            <div v-for="(s, i) in result.strongStocks" :key="i" class="line-item">
              <div class="line-top">
                <StockLink class="line-name" :code="s.code" :name="s.name" />
                <span class="code">{{ s.code }}</span>
              </div>
              <p class="prose dim sm">{{ s.reason }}</p>
            </div>
          </div>
        </div>

        <!-- 风险警示 -->
        <div v-if="result.risks.length" class="callout reveal" style="--i: 6">
          <div class="callout-head">
            <el-icon><Warning /></el-icon><span>风险警示</span>
          </div>
          <div v-for="(r, i) in result.risks" :key="i" class="risk-item">
            <span class="risk-title">{{ r.title }}</span>
            <p class="prose dim sm">{{ r.detail }}</p>
          </div>
        </div>

        <!-- 明日策略（前瞻动作） -->
        <div v-if="result.tomorrowPlan" class="panel block reveal" style="--i: 6">
          <div class="panel-head"><span class="panel-title">明日策略</span></div>
          <template v-if="result.tomorrowPlan.focus?.length">
            <div class="sub-cap">重点关注</div>
            <ul class="sugg-list">
              <li v-for="(f, i) in result.tomorrowPlan.focus" :key="i">{{ f }}</li>
            </ul>
          </template>
          <template v-if="result.tomorrowPlan.contingency?.length">
            <div class="sub-cap">应对预案</div>
            <ul class="sugg-list">
              <li v-for="(c, i) in result.tomorrowPlan.contingency" :key="i">{{ c }}</li>
            </ul>
          </template>
          <div v-if="result.tomorrowPlan.positionAdvice" class="kv">
            <span class="kv-k">仓位</span>
            <span class="kv-v">{{ result.tomorrowPlan.positionAdvice }}</span>
          </div>
        </div>

        <!-- 操作建议 -->
        <div v-if="result.suggestions.length" class="panel block reveal" style="--i: 6">
          <div class="panel-head"><span class="panel-title">操作建议</span></div>
          <ul class="sugg-list">
            <li v-for="(s, i) in result.suggestions" :key="i">{{ s }}</li>
          </ul>
        </div>

        <!-- ===== 第三层 自检明细（折叠去噪） ===== -->
        <div class="layer-cap reveal" style="--i: 7">自检明细</div>
        <el-collapse v-model="detailOpen" class="layer3 reveal" style="--i: 7">
          <el-collapse-item
            v-if="result.positionsReview.length || result.myTradesReview.length"
            name="pos"
            title="持仓 / 操作复盘"
          >
            <div class="grid">
              <div v-if="result.positionsReview.length" class="panel">
                <div class="panel-head"><span class="panel-title">持仓复盘</span></div>
                <div v-for="(p, i) in result.positionsReview" :key="i" class="pos-row">
                  <div class="pos-top">
                    <StockLink class="line-name" :code="p.code" :name="p.name" />
                    <span class="code">{{ p.code }}</span>
                    <el-tag size="small" class="action-tag" :class="actionClass(p.action)">
                      {{ p.action }}
                    </el-tag>
                  </div>
                  <p class="prose dim sm">{{ p.todayNote }}</p>
                </div>
              </div>

              <div v-if="result.myTradesReview.length" class="panel">
                <div class="panel-head"><span class="panel-title">我的操作复盘</span></div>
                <div v-for="(m, i) in result.myTradesReview" :key="i" class="pos-row">
                  <div class="pos-top">
                    <StockLink class="line-name" :code="m.code" :name="m.name" />
                    <span class="code">{{ m.code }}</span>
                    <el-tag size="small" effect="dark" class="action-tag" :type="verdictType(m.verdict)">
                      {{ m.verdict }}
                    </el-tag>
                  </div>
                  <p class="prose dim sm">{{ m.assessment }}</p>
                </div>
              </div>
            </div>
          </el-collapse-item>

          <el-collapse-item v-if="result.watchlistReview.length" name="watch" title="自选股池复盘">
            <div class="watch-grid">
              <div v-for="(w, i) in result.watchlistReview" :key="i" class="watch-item">
                <div class="line-top">
                  <StockLink class="line-name" :code="w.code" :name="w.name" />
                  <span class="code">{{ w.code }}</span>
                  <el-tag size="small" effect="plain" class="action-tag">{{ w.strength }}</el-tag>
                </div>
                <p class="prose dim sm">{{ w.note }}</p>
              </div>
            </div>
          </el-collapse-item>

          <el-collapse-item v-if="result.overseasMarkets?.length" name="overseas" title="外围市场综述">
            <div v-for="(o, i) in result.overseasMarkets" :key="i" class="theme-row">
              <div class="theme-top">
                <span class="theme-name">{{ o.name }}</span>
                <el-tag size="small" effect="plain" type="info">{{ o.region }}</el-tag>
              </div>
              <div class="kv"><span class="kv-k">走势</span><span class="kv-v">{{ o.trend || '—' }}</span></div>
              <div class="kv"><span class="kv-k">对A股</span><span class="kv-v">{{ o.impact || '—' }}</span></div>
            </div>
          </el-collapse-item>

          <el-collapse-item v-if="result.trendComparison" name="trend" title="与近日对比">
            <div class="kv"><span class="kv-k">主线</span><span class="kv-v">{{ result.trendComparison.mainlineContinuity || '—' }}</span></div>
            <div class="kv"><span class="kv-k">情绪趋势</span><span class="kv-v">{{ result.trendComparison.emotionTrend || '—' }}</span></div>
            <p class="prose dim sm">{{ result.trendComparison.note }}</p>
          </el-collapse-item>
        </el-collapse>
      </template>

      <!-- 原始数据面板（仅实时复盘展示） -->
      <div v-if="!viewingHistory" class="grid reveal" style="--i: 11">
        <div v-if="overview" class="panel">
          <div class="panel-head"><span class="panel-title">大盘快照</span></div>
          <div class="idx-mini">
            <div
              v-for="ix in overview.indices"
              :key="ix.code"
              class="idx-cell idx-clickable"
              role="button"
              tabindex="0"
              @click="openIndexKline(ix)"
              @keydown.enter="openIndexKline(ix)"
            >
              <div class="idx-name">{{ ix.name }}</div>
              <div class="num" :class="dir(ix.pct)">{{ fixed(ix.point) }}</div>
              <div class="num sm" :class="dir(ix.pct)">{{ pct(ix.pct) }}</div>
            </div>
          </div>
          <div v-if="overview.moneyInflow?.length" class="sub-cap">板块资金净流入 TOP</div>
          <div v-for="s in overview.moneyInflow ?? []" :key="s.code" class="flow-row">
            <StockLink class="flow-name" :code="s.code" :name="s.name" />
            <span class="num up">+{{ fixed(s.netInflow) }}亿</span>
          </div>
        </div>

        <div v-if="portfolio" class="panel">
          <div class="panel-head"><span class="panel-title">今日持仓明细</span></div>
          <div class="snap-stats">
            <span>市值 <b class="num">{{ fixed(portfolio.totalMarketValue) }}</b></span>
            <span>
              今日盈亏
              <b class="num" :class="dir(portfolio.totalTodayProfit)">
                {{ fixed(portfolio.totalTodayProfit) }}
              </b>
            </span>
          </div>
          <div v-for="p in portfolio.positions" :key="p.code" class="flow-row">
            <StockLink class="flow-name" :code="p.code" :name="p.name" />
            <span class="num" :class="dir(p.todayRate)">{{ pct(p.todayRate * 100) }}</span>
          </div>
          <el-empty v-if="!portfolio.positions.length" :image-size="44" description="当前空仓" />
        </div>
      </div>
    </template>

    <!-- 复盘历史抽屉 -->
    <el-drawer v-model="historyDrawer" title="复盘历史" size="360px">
      <div v-loading="historyLoading" class="hist-list">
        <div
          v-for="item in historyList"
          :key="item.id"
          class="hist-item"
          @click="viewHistory(item)"
        >
          <el-icon class="hist-ic"><Memo /></el-icon>
          <span class="hist-time">{{ dayjs(item.createdAt).format('YYYY-MM-DD HH:mm') }}</span>
        </div>
        <el-empty v-if="!historyLoading && !historyList.length" :image-size="60" description="暂无复盘记录" />
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 8px;
}

/* ---- loading：活动时间线 + 骨架 ---- */
.loading-wrap {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.act-card {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
}
.act-head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 600;
  color: var(--brand);
  margin-bottom: 12px;
}
.act-hint {
  font-weight: 400;
  font-size: 12px;
  color: var(--text-2);
}
.pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--brand);
  box-shadow: 0 0 10px var(--brand-glow);
  animation: pulse 1.4s infinite;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
.act-steps {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.act-step {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 13px;
  color: var(--text-1);
}
.act-step .step-ic {
  font-family: var(--font-mono);
  width: 16px;
  text-align: center;
}
.act-step.running .step-ic {
  color: var(--brand);
  animation: spin 1.1s linear infinite;
}
.act-step.ok {
  color: var(--text-2);
}
.act-step.ok .step-ic {
  color: var(--down);
}
.act-step.fail .step-ic {
  color: var(--up);
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.raw {
  margin-top: 12px;
}
.raw summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--text-2);
}
.raw-body {
  margin: 8px 0 0;
  max-height: 40vh;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.65;
  color: var(--text-2);
}
.sk-grid {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.sk {
  background: linear-gradient(90deg, var(--bg-2) 25%, var(--bg-3) 37%, var(--bg-2) 63%);
  background-size: 280% 100%;
  border-radius: var(--radius-sm);
  animation: shimmer 1.4s ease-in-out infinite;
}
.sk-band {
  height: 64px;
}
.sk-block {
  height: 120px;
}
.sk-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.sk-half {
  height: 150px;
}
@keyframes shimmer {
  to {
    background-position: -280% 0;
  }
}

/* ---- 概览头条 ---- */
.band {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 18px;
  background: linear-gradient(180deg, var(--bg-3), var(--bg-2));
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 18px;
  margin-bottom: 16px;
}
.band-left {
  display: flex;
  align-items: center;
  gap: 12px;
}
.band-date {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text-2);
}
.band-idx {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.band-idx-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.band-idx-name {
  font-size: 11px;
  color: var(--text-2);
}
.band-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-left: auto;
  font-size: 13px;
  color: var(--text-2);
}

/* ---- 第一层 决策摘要 hero ---- */
.hero {
  background: linear-gradient(135deg, var(--brand-soft), var(--bg-2));
  border: 1px solid var(--border);
  border-left: 3px solid var(--brand);
  border-radius: var(--radius);
  padding: 16px 18px;
  margin-bottom: 18px;
}
.hero-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 10px;
}
.hero-cap {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 15px;
  color: var(--brand);
}
.hero-pos {
  font-size: 13px;
  color: var(--text-1);
}
.hero-summary {
  margin: 0 0 14px;
  font-size: 15px;
  line-height: 1.7;
  font-weight: 500;
  color: var(--text-0);
}
.hero-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 14px;
}
.hero-cell {
  background: var(--bg-1);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
}
.hero-cell.hero-risk {
  border-color: var(--brand);
}
.hero-cell-cap {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  margin-bottom: 6px;
}
.hero-list {
  margin: 0;
  padding-left: 18px;
}
.hero-list li {
  margin: 4px 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-0);
}

/* 分层小标题 */
.layer-cap {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 13px;
  color: var(--text-2);
  letter-spacing: 0.04em;
  margin: 4px 0 12px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}

/* 第三层折叠容器：视觉降级 */
.layer3 {
  margin-bottom: 16px;
  border-top: none;
}
.layer3 :deep(.el-collapse-item__header) {
  font-weight: 600;
}

/* 龙虎榜净买入额 */
.dt-net {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--up);
}

/* ---- 通用卡片 ---- */
.panel {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
}
.panel.block {
  margin-bottom: 16px;
}
/* 综合判断为核心输出，左侧加品牌色描边强调 */
.panel.block.stance {
  border-left: 3px solid var(--brand);
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.panel-title {
  font-family: var(--font-display);
  font-weight: 600;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-bottom: 16px;
  align-items: start;
}
.prose {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--text-0);
  word-break: break-word;
}
.prose.dim {
  color: var(--text-1);
}
.prose.sm {
  font-size: 12.5px;
  margin-top: 2px;
}
.sub-block {
  margin-top: 10px;
}
.sub-cap,
.idx-name {
  font-size: 12px;
  color: var(--text-2);
  margin: 6px 0;
}

/* key-value 行 */
.kv {
  display: flex;
  gap: 10px;
  padding: 5px 0;
  font-size: 13px;
  border-bottom: 1px solid var(--border-soft);
}
.kv:last-child {
  border-bottom: none;
}
.kv-k {
  flex: 0 0 56px;
  color: var(--text-2);
}
.kv-v {
  flex: 1;
  color: var(--text-0);
}

/* 主线题材 */
.theme-row {
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}
.theme-row:last-child {
  border-bottom: none;
}
.theme-top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.theme-rank {
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  border-radius: var(--radius-sm);
  background: var(--brand-soft);
  color: var(--brand);
}
.theme-name {
  font-weight: 600;
  font-size: 14px;
}

/* 连板梯队质量 stat */
.stat-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 10px;
}
.stat-cell {
  background: var(--bg-1);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
}
.stat-cap {
  font-size: 11.5px;
  color: var(--text-2);
  margin-bottom: 4px;
}
.stat-num {
  font-size: 15px;
  font-weight: 600;
}

/* 行项 */
.line-item {
  padding: 7px 0;
  border-bottom: 1px solid var(--border);
}
.line-item:last-child {
  border-bottom: none;
}
.line-top,
.pos-top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.line-name {
  font-weight: 500;
}
.code {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--text-2);
}
.pos-row {
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}
.pos-row:last-child {
  border-bottom: none;
}
.action-tag {
  margin-left: auto;
}
.action-tag.up {
  color: var(--up);
}
.action-tag.down {
  color: var(--down);
}
.action-tag.muted {
  color: var(--text-2);
}

/* 自选股网格 */
.watch-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 18px;
}
.watch-item {
  padding: 7px 0;
  border-bottom: 1px solid var(--border-soft);
}

/* 风险 callout */
.callout {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-left: 3px solid var(--brand);
  border-radius: var(--radius);
  padding: 12px 16px;
  margin-bottom: 16px;
}
.callout-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-display);
  font-weight: 600;
  color: var(--brand);
  margin-bottom: 10px;
}
.risk-item {
  padding: 6px 0;
  border-bottom: 1px solid var(--border-soft);
}
.risk-item:last-child {
  border-bottom: none;
}
.risk-title {
  font-weight: 600;
  font-size: 13px;
}

/* 清单 */
.sugg-list {
  margin: 4px 0 10px;
  padding-left: 20px;
}
.sugg-list li {
  margin: 5px 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-0);
}

/* 数据面板 */
.idx-mini {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}
.idx-cell {
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
}
.snap-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-size: 13px;
  color: var(--text-2);
  margin-bottom: 12px;
}
.num.sm {
  font-size: 12px;
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

/* 可点击指数格 / 板块名 */
.idx-clickable {
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.idx-clickable:hover {
  border-color: var(--brand);
  background: var(--bg-2);
}
.sec-link {
  cursor: pointer;
  border-bottom: 1px dashed transparent;
  transition: color 0.15s ease, border-color 0.15s ease;
}
.sec-link:hover {
  color: var(--brand);
  border-bottom-color: var(--brand);
}

/* 历史抽屉 */
.hist-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.hist-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.16s ease;
}
.hist-item:hover {
  background: var(--bg-hover);
  border-color: var(--brand);
}
.hist-ic {
  color: var(--brand);
}
.hist-time {
  font-family: var(--font-mono);
  font-size: 13px;
}

/* 入场动效（reduced-motion 降级） */
.reveal {
  animation: rise 0.5s cubic-bezier(0.16, 1, 0.3, 1) both;
  animation-delay: calc(var(--i, 0) * 55ms);
}
@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .reveal {
    animation: none;
  }
  .sk,
  .pulse,
  .act-step.running .step-ic {
    animation: none;
  }
}
@media (max-width: 900px) {
  .grid,
  .sk-row,
  .watch-grid {
    grid-template-columns: 1fr;
  }
  .band-stats {
    margin-left: 0;
  }
}
</style>
