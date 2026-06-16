<script setup lang="ts">
import { computed } from 'vue';
import { Warning } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { api } from '@/api';
import MarkdownView from '@/components/MarkdownView.vue';
import StockLink from '@/components/StockLink.vue';
import { useKlineStore } from '@/stores/kline';
import type { MarketIndex, MarketOverview, MarketReviewResult, RealPortfolio } from '@stock-agent/shared';

// 一键复盘结构化结果富渲染（从 ReviewView 抽出，供复盘页与统一 AI 分析弹窗复用）。
// 入参 text 为模型原始输出（JSON / 文本），内部容错解析；解析失败回退 Markdown 原文。
// overview/portfolio 仅在实时复盘（非历史）时传入以展示当日数据面板。
const props = withDefaults(
  defineProps<{
    /** 模型最终输出（结构化 JSON 或纯文本） */
    text: string;
    /** 完成 / 历史时间展示 */
    finishedAt?: string;
    /** 实时盘面（仅实时复盘传入；历史不传） */
    overview?: MarketOverview | null;
    /** 真实持仓（仅实时复盘传入） */
    portfolio?: RealPortfolio | null;
    /** 是否查看历史（历史态隐藏实时数据面板） */
    viewingHistory?: boolean;
  }>(),
  { finishedAt: '', overview: null, portfolio: null, viewingHistory: false },
);

const kline = useKlineStore();
const openIndexKline = (ix: MarketIndex) => kline.open(ix.code, ix.name, ix.secid);
async function openSectorKline(name: string) {
  try {
    const list = await api.searchBoard(name);
    if (list.length > 0) kline.open(list[0].code, list[0].name || name);
    else ElMessage.warning(`未找到「${name}」对应板块行情`);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

// A股 红涨绿跌
const dir = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const pct = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
const fixed = (v: number, d = 2) => v.toFixed(d);
const amt = (yi: number) => (yi >= 10000 ? (yi / 10000).toFixed(2) + '万亿' : yi.toFixed(0) + '亿');

// 复盘对共享主线的验证结论着色
const verdictTag = (v: string) =>
  v === '加速' || v === '延续'
    ? 'success'
    : v === '分歧'
      ? 'warning'
      : v === '退潮' || v === '证伪'
        ? 'danger'
        : 'info';
const actionClass = (a: string) =>
  a === '加仓' || a === '持有' ? 'up' : a === '减仓' || a === '清仓' ? 'down' : 'muted';
const verdictType = (v: string): 'success' | 'danger' | 'warning' | 'info' =>
  v === '正确' ? 'success' : v === '失误' ? 'danger' : v === '待观察' ? 'warning' : 'info';
const phaseType = (p: string): 'success' | 'danger' | 'warning' | 'info' =>
  p === '高潮' ? 'danger' : p === '发酵' ? 'warning' : p === '启动' ? 'success' : 'info';
const stanceType = (b: string): 'success' | 'danger' | 'info' =>
  b === '偏多' ? 'danger' : b === '偏空' ? 'success' : 'info';
const benchmarkType = (t: string): 'success' | 'danger' | 'warning' | 'info' =>
  t === '弱转强' ? 'danger' : t === '强转弱' ? 'success' : t === '空间龙' ? 'warning' : 'info';

const detailOpen = ['pos'];

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

const result = computed(() => parseResult(props.text));
</script>

<template>
  <div class="review-result">
    <!-- 解析失败回退 -->
    <div v-if="!result" class="panel block">
      <div class="panel-head"><span class="panel-title">复盘结论</span></div>
      <MarkdownView :source="text || '（无输出）'" />
    </div>

    <template v-else>
      <!-- 概览头条 -->
      <div class="band">
        <div class="band-left">
          <div v-if="finishedAt" class="band-date">{{ finishedAt }}</div>
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

      <!-- 第一层 决策摘要 hero -->
      <div class="hero">
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

      <!-- 第二层 核心论据 -->
      <div class="layer-cap">核心论据</div>

      <div class="panel block">
        <div class="panel-head"><span class="panel-title">大盘走势</span></div>
        <p class="prose">{{ result.marketTrend || '—' }}</p>
        <div v-if="result.emotionNote" class="sub-block">
          <div class="sub-cap">市场情绪</div>
          <p class="prose dim">{{ result.emotionNote }}</p>
        </div>
      </div>

      <div v-if="result.emotionCycle || result.capitalFlow" class="grid">
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

      <div v-if="result.mainThemes.length" class="panel block">
        <div class="panel-head"><span class="panel-title">当前主线题材</span></div>
        <div v-for="(t, i) in result.mainThemes" :key="i" class="theme-row">
          <div class="theme-top">
            <span class="theme-rank num">{{ i + 1 }}</span>
            <span class="theme-name">{{ t.name }}</span>
            <el-tag size="small" effect="dark" type="warning">{{ t.strength }}</el-tag>
            <el-tag
              v-if="t.verdict"
              size="small"
              effect="plain"
              :type="verdictTag(t.verdict)"
              title="对照共享主线的验证结论"
            >
              {{ t.verdict }}
            </el-tag>
          </div>
          <p class="prose dim">{{ t.reason }}</p>
        </div>
      </div>

      <div v-if="result.ladderQuality" class="panel block">
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

      <div v-if="result.dragonTiger.length || result.sentimentBenchmark.length" class="grid">
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

      <div v-if="result.hotSectors.length || result.hotStocks.length" class="grid">
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

      <div v-if="result.strongSectors.length || result.strongStocks.length" class="grid">
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

      <div v-if="result.risks.length" class="callout">
        <div class="callout-head">
          <el-icon><Warning /></el-icon><span>风险警示</span>
        </div>
        <div v-for="(r, i) in result.risks" :key="i" class="risk-item">
          <span class="risk-title">{{ r.title }}</span>
          <p class="prose dim sm">{{ r.detail }}</p>
        </div>
      </div>

      <div v-if="result.tomorrowPlan" class="panel block">
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

      <div v-if="result.suggestions.length" class="panel block">
        <div class="panel-head"><span class="panel-title">操作建议</span></div>
        <ul class="sugg-list">
          <li v-for="(s, i) in result.suggestions" :key="i">{{ s }}</li>
        </ul>
      </div>

      <!-- 第三层 自检明细（折叠去噪） -->
      <div class="layer-cap">自检明细</div>
      <el-collapse :model-value="detailOpen" class="layer3">
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
    <div v-if="!viewingHistory && (overview || portfolio)" class="grid">
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
          <span class="num" :class="dir(p.todayRate * 100)">{{ pct(p.todayRate * 100) }}</span>
        </div>
        <el-empty v-if="!portfolio.positions.length" :image-size="44" description="当前空仓" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.review-result {
  display: flow-root;
}

/* 概览头条 */
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

/* 第一层 决策摘要 hero */
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
.layer3 {
  margin-bottom: 16px;
  border-top: none;
}
.layer3 :deep(.el-collapse-item__header) {
  font-weight: 600;
}
.dt-net {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--up);
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
.watch-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 18px;
}
.watch-item {
  padding: 7px 0;
  border-bottom: 1px solid var(--border-soft);
}
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
@media (max-width: 900px) {
  .grid,
  .watch-grid {
    grid-template-columns: 1fr;
  }
  .band-stats {
    margin-left: 0;
  }
}
</style>
