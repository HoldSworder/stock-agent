<script setup lang="ts">
import { onMounted, ref } from 'vue';
import dayjs from 'dayjs';
import { ElMessage } from 'element-plus';
import { MagicStick, Clock, Memo, Warning } from '@element-plus/icons-vue';
import { api } from '@/api';
import MarkdownView from '@/components/MarkdownView.vue';
import ModuleScheduleDialog from '@/components/ModuleScheduleDialog.vue';
import StockLink from '@/components/StockLink.vue';
import type {
  ResearchAiAnalysis,
  ResearchAnnouncementNote,
  ResearchCategoryNote,
  ResearchOpportunityContinuity,
  ResearchOpportunityReport,
  ReviewHistoryItem,
} from '@stock-agent/shared';

type Phase = 'idle' | 'loading' | 'done';

const phase = ref<Phase>('idle');
const result = ref<ResearchOpportunityReport | null>(null);
const rawFallback = ref('');
const finishedAt = ref('');
const viewingHistory = ref(false);

const historyDrawer = ref(false);
const historyList = ref<ReviewHistoryItem[]>([]);
const historyLoading = ref(false);

// 自选股机构观点综述
const batchDialog = ref(false);
const batchResult = ref<ResearchAiAnalysis | null>(null);
const batchLoading = ref(false);

const hasReport = () => result.value !== null;

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

/** 容错解析：原文→闭合补全→自尾部回退到最近的闭合点 */
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
function parseResult(text: string): ResearchOpportunityReport | null {
  if (!text) return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1) return null;
  const slice = end > start ? s.slice(start, end + 1) : s.slice(start);
  const obj = looseParse(slice) as Partial<ResearchOpportunityReport> | null;
  if (!obj) return null;
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    date: obj.date ?? '',
    marketDigest: obj.marketDigest ?? '',
    hotSectors: arr(obj.hotSectors),
    opportunities: arr(obj.opportunities),
    themeSummary: obj.themeSummary ?? '',
    risks: arr(obj.risks),
    continuity: (obj.continuity as ResearchOpportunityContinuity | null) ?? null,
    strategyNotes: arr<ResearchCategoryNote>(obj.strategyNotes),
    macroNotes: arr<ResearchCategoryNote>(obj.macroNotes),
    morningNotes: arr<ResearchCategoryNote>(obj.morningNotes),
    announcements: arr<ResearchAnnouncementNote>(obj.announcements),
  };
}

/** 公告影响 tag 类型：利好(红/danger) / 利空(绿/success) / 中性，遵循 A 股红涨绿跌 */
function impactTagType(impact: string): 'danger' | 'success' | 'info' {
  if (impact.includes('利好')) return 'danger';
  if (impact.includes('利空')) return 'success';
  return 'info';
}

async function generate() {
  if (phase.value === 'loading') return;
  phase.value = 'loading';
  viewingHistory.value = false;
  result.value = null;
  rawFallback.value = '';
  try {
    const r = await api.research.discoverReview();
    const parsed = parseResult(r.text);
    if (parsed) result.value = parsed;
    else rawFallback.value = r.text || '（无输出）';
    if (r.status !== 'success') {
      ElMessage.warning(`研报分析${r.status === 'timeout' ? '超时' : '未成功'}，已展示已生成内容`);
    }
    finishedAt.value = dayjs().format('HH:mm:ss');
    phase.value = 'done';
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
    phase.value = result.value || rawFallback.value ? 'done' : 'idle';
  }
}

async function runBatch() {
  batchDialog.value = true;
  batchResult.value = null;
  batchLoading.value = true;
  try {
    batchResult.value = await api.research.analyzeBatch({ scope: 'watchlist', limit: 6 });
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    batchLoading.value = false;
  }
}

async function openHistory() {
  historyDrawer.value = true;
  historyLoading.value = true;
  try {
    historyList.value = await api.research.opportunityReviews(50);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    historyLoading.value = false;
  }
}

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

/** 首屏默认展示最近一次研报机会 */
async function loadLatest() {
  if (phase.value !== 'idle') return;
  try {
    const list = await api.research.opportunityReviews(1);
    if (list.length > 0 && phase.value === 'idle') viewHistory(list[0]);
  } catch {
    /* 首屏静默 */
  }
}

onMounted(() => {
  void loadLatest();
});
</script>

<template>
  <div class="rop">
    <div class="rop-head">
      <div class="rop-sub">
        基于近一日五类研报（个股/行业/策略/宏观/晨报）与全市场重大公告，综合研判板块 / 个股机会
        <span v-if="phase === 'done' && finishedAt">
          · {{ viewingHistory ? '历史' : '完成' }} {{ finishedAt }}
        </span>
      </div>
      <div class="head-actions">
        <el-button :icon="MagicStick" :loading="batchLoading" @click="runBatch">
          自选股综述分析
        </el-button>
        <ModuleScheduleDialog module="research" />
        <el-button :icon="Clock" @click="openHistory">历史</el-button>
        <el-button :icon="MagicStick" type="primary" :loading="phase === 'loading'" @click="generate">
          {{ phase === 'done' ? '重新分析' : '开始分析' }}
        </el-button>
      </div>
    </div>

    <!-- 空态 -->
    <el-empty
      v-if="phase === 'idle'"
      description="点击「开始分析」，AI 将聚合五类研报与全市场重大公告，输出综合研报分析"
    />

    <!-- loading 骨架 -->
    <div v-else-if="phase === 'loading'" class="loading-wrap">
      <div class="act-card">
        <span class="pulse" /> 正在聚合五类研报与全市场公告并综合研判 · 通常需 2-4 分钟，请勿离开
      </div>
      <div class="sk sk-band" />
      <div class="sk sk-block" />
      <div class="sk sk-block" />
    </div>

    <!-- 完成 -->
    <template v-else>
      <!-- 解析失败回退 -->
      <div v-if="!hasReport()" class="panel block">
        <div class="panel-head"><span class="panel-title">研报分析</span></div>
        <MarkdownView :source="rawFallback" />
      </div>

      <template v-else-if="result">
        <!-- 概述 -->
        <div class="band reveal" style="--i: 0">
          <div class="band-date">{{ result.date || finishedAt }}</div>
          <p class="prose">{{ result.marketDigest || '—' }}</p>
        </div>

        <!-- 热门板块 -->
        <div v-if="result.hotSectors.length" class="panel block reveal" style="--i: 1">
          <div class="panel-head"><span class="panel-title">研报集中关注板块</span></div>
          <div v-for="(s, i) in result.hotSectors" :key="i" class="sector-row">
            <div class="sector-top">
              <span class="sector-rank num">{{ i + 1 }}</span>
              <span class="sector-name">{{ s.name }}</span>
              <span class="sector-stats">
                <span class="chip">研报 {{ s.reportCount }}</span>
                <span class="chip up">上调 {{ s.upgradeCount }}</span>
              </span>
            </div>
            <p v-if="s.note" class="prose dim sm">{{ s.note }}</p>
          </div>
        </div>

        <!-- 个股机会 -->
        <div v-if="result.opportunities.length" class="panel block reveal" style="--i: 2">
          <div class="panel-head"><span class="panel-title">个股机会线索</span></div>
          <div v-for="(o, i) in result.opportunities" :key="i" class="opp-row">
            <div class="opp-top">
              <StockLink class="line-name" :code="o.code" :name="o.name" />
              <span class="code">{{ o.code }}</span>
              <el-tag v-if="o.sector" size="small" effect="plain">{{ o.sector }}</el-tag>
              <span class="opp-tags">
                <el-tag v-if="o.rating" size="small" type="danger" effect="dark">{{ o.rating }}</el-tag>
                <el-tag v-if="o.ratingChange" size="small" type="warning">{{ o.ratingChange }}</el-tag>
                <span v-if="o.targetPrice" class="tp num">目标价 {{ o.targetPrice }}</span>
              </span>
            </div>
            <p v-if="o.reason" class="prose dim sm">{{ o.reason }}</p>
          </div>
        </div>

        <!-- 主题归纳 -->
        <div v-if="result.themeSummary" class="panel block reveal" style="--i: 3">
          <div class="panel-head"><span class="panel-title">主线 / 主题归纳</span></div>
          <p class="prose">{{ result.themeSummary }}</p>
        </div>

        <!-- 策略 / 宏观 / 晨报要点 -->
        <div v-if="result.strategyNotes.length" class="panel block reveal" style="--i: 3">
          <div class="panel-head"><span class="panel-title">策略报告要点</span></div>
          <div v-for="(n, i) in result.strategyNotes" :key="i" class="note-row">
            <div class="note-top">
              <span class="note-title">{{ n.title }}</span>
              <span v-if="n.org" class="note-org">{{ n.org }}</span>
            </div>
            <p v-if="n.point" class="prose dim sm">{{ n.point }}</p>
          </div>
        </div>
        <div v-if="result.macroNotes.length" class="panel block reveal" style="--i: 3">
          <div class="panel-head"><span class="panel-title">宏观研究要点</span></div>
          <div v-for="(n, i) in result.macroNotes" :key="i" class="note-row">
            <div class="note-top">
              <span class="note-title">{{ n.title }}</span>
              <span v-if="n.org" class="note-org">{{ n.org }}</span>
            </div>
            <p v-if="n.point" class="prose dim sm">{{ n.point }}</p>
          </div>
        </div>
        <div v-if="result.morningNotes.length" class="panel block reveal" style="--i: 3">
          <div class="panel-head"><span class="panel-title">券商晨报要点</span></div>
          <div v-for="(n, i) in result.morningNotes" :key="i" class="note-row">
            <div class="note-top">
              <span class="note-title">{{ n.title }}</span>
              <span v-if="n.org" class="note-org">{{ n.org }}</span>
            </div>
            <p v-if="n.point" class="prose dim sm">{{ n.point }}</p>
          </div>
        </div>

        <!-- 重大公告影响 -->
        <div v-if="result.announcements.length" class="panel block reveal" style="--i: 4">
          <div class="panel-head"><span class="panel-title">重大公告影响</span></div>
          <div v-for="(a, i) in result.announcements" :key="i" class="ann-row">
            <div class="ann-top">
              <StockLink class="line-name" :code="a.code" :name="a.name" />
              <span class="code">{{ a.code }}</span>
              <el-tag v-if="a.type" size="small" effect="plain">{{ a.type }}</el-tag>
              <el-tag size="small" :type="impactTagType(a.impact)" effect="dark" class="ann-impact-tag">
                {{ a.impact.slice(0, 2) }}
              </el-tag>
            </div>
            <p class="prose sm ann-title">{{ a.title }}</p>
            <p v-if="a.impact" class="prose dim sm">{{ a.impact }}</p>
          </div>
        </div>

        <!-- 与历史的延续性对比 -->
        <div v-if="result.continuity" class="panel block reveal" style="--i: 4">
          <div class="panel-head"><span class="panel-title">趋势延续性（对比近几次）</span></div>
          <div class="kv">
            <span class="kv-k">延续</span>
            <span class="kv-v">{{ result.continuity.persisting || '—' }}</span>
          </div>
          <div class="kv">
            <span class="kv-k">新增升温</span>
            <span class="kv-v">{{ result.continuity.emerging || '—' }}</span>
          </div>
          <div class="kv">
            <span class="kv-k">退热降温</span>
            <span class="kv-v">{{ result.continuity.fading || '—' }}</span>
          </div>
          <p v-if="result.continuity.note" class="prose dim sm">{{ result.continuity.note }}</p>
        </div>

        <!-- 风险提示 -->
        <div v-if="result.risks.length" class="callout reveal" style="--i: 5">
          <div class="callout-head">
            <el-icon><Warning /></el-icon><span>风险提示</span>
          </div>
          <div v-for="(r, i) in result.risks" :key="i" class="risk-item">
            <span class="risk-title">{{ r.title }}</span>
            <p class="prose dim sm">{{ r.detail }}</p>
          </div>
        </div>
      </template>
    </template>

    <!-- 历史抽屉 -->
    <el-drawer v-model="historyDrawer" title="研报分析历史" size="360px">
      <div v-loading="historyLoading" class="hist-list">
        <div v-for="item in historyList" :key="item.id" class="hist-item" @click="viewHistory(item)">
          <el-icon class="hist-ic"><Memo /></el-icon>
          <span class="hist-time">{{ dayjs(item.createdAt).format('YYYY-MM-DD HH:mm') }}</span>
        </div>
        <el-empty v-if="!historyLoading && !historyList.length" :image-size="60" description="暂无研报分析记录" />
      </div>
    </el-drawer>

    <!-- 自选股机构观点综述 -->
    <el-dialog v-model="batchDialog" title="自选股研报机构观点综述" width="58%" top="6vh">
      <div v-loading="batchLoading" class="batch-body">
        <MarkdownView v-if="batchResult?.content" :source="batchResult.content" />
        <el-empty v-else-if="!batchLoading" description="暂无可分析的研报" :image-size="80" />
        <div v-if="batchResult" class="muted batch-foot">基于 {{ batchResult.reportCount }} 篇研报</div>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.rop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.rop-sub {
  font-size: 13px;
  color: var(--text-2);
}
.head-actions {
  display: flex;
  gap: 8px;
}
.loading-wrap {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.act-card {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
  font-weight: 600;
  color: var(--brand);
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
@keyframes shimmer {
  to {
    background-position: -280% 0;
  }
}

.band {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 14px;
  background: linear-gradient(180deg, var(--bg-3), var(--bg-2));
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 18px;
  margin-bottom: 16px;
}
.band-date {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text-2);
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

/* key-value 行（延续性对比） */
.kv {
  display: flex;
  gap: 10px;
  padding: 5px 0;
  font-size: 13px;
  border-bottom: 1px solid var(--border-soft);
}
.kv:last-of-type {
  border-bottom: none;
}
.kv-k {
  flex: 0 0 64px;
  color: var(--text-2);
}
.kv-v {
  flex: 1;
  color: var(--text-0);
}

/* 板块 */
.sector-row {
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}
.sector-row:last-child {
  border-bottom: none;
}
.sector-top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.sector-rank {
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
.sector-name {
  font-weight: 600;
  font-size: 14px;
}
.sector-stats {
  display: flex;
  gap: 6px;
  margin-left: auto;
}
.chip {
  font-size: 11.5px;
  padding: 1px 7px;
  border-radius: 10px;
  background: var(--bg-1);
  border: 1px solid var(--border-soft);
  color: var(--text-2);
}
.chip.up {
  color: var(--up);
  border-color: var(--up);
}

/* 个股机会 */
.opp-row {
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}
.opp-row:last-child {
  border-bottom: none;
}
.opp-top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.line-name {
  font-weight: 500;
}
.code {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--text-2);
}
.opp-tags {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
.tp {
  font-size: 12px;
  color: var(--up);
}

/* 策略/宏观/晨报要点 */
.note-row {
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}
.note-row:last-child {
  border-bottom: none;
}
.note-top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.note-title {
  font-weight: 500;
  font-size: 13.5px;
}
.note-org {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--text-2);
}

/* 公告影响 */
.ann-row {
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}
.ann-row:last-child {
  border-bottom: none;
}
.ann-top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ann-impact-tag {
  margin-left: auto;
}
.ann-title {
  margin-top: 4px;
  color: var(--text-0);
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

.muted {
  color: var(--text-2);
}
.batch-foot {
  font-size: 12px;
  margin-top: 10px;
}

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
  .reveal,
  .sk,
  .pulse {
    animation: none;
  }
}
</style>
