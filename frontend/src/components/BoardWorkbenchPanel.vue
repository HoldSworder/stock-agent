<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import dayjs from 'dayjs';
import { ElMessage } from 'element-plus';
import { Refresh, MagicStick } from '@element-plus/icons-vue';
import { api } from '@/api';
import { useCachedResource } from '@/composables/useCachedResource';
import StockLink from '@/components/StockLink.vue';
import MetricScaleHint from '@/components/MetricScaleHint.vue';
import {
  ACTION_TAG_TYPE,
  EXPO_STATUS_LABEL,
  EXPO_STATUS_TYPE,
  STAGE_ACTION_LABEL,
  STAGE_LABEL,
} from '@/constants/boardTags';
import type {
  AiActionVerdict,
  BoardWorkbench,
  BoardWorkbenchDetail,
  BoardWorkbenchItem,
  MainlineConsensusLevel,
} from '@stock-agent/shared';

// 板块主线作战台：投影自今日主线共识，每条板块给「操盘动作 + 周期 + 阶段 + 风险」决策卡片，
// 点击卡片下钻单板块详情（龙头 / 补涨 / 持仓暴露 / 失效条件）。仅研判不下单。
const { data, loading, refreshing, load, reload } = useCachedResource<BoardWorkbench>(
  'boards:workbench',
  () => api.boards.workbench(),
  { ttlMs: 120_000 },
);

const items = computed<BoardWorkbenchItem[]>(() => data.value?.items ?? []);

const CONS_LABEL: Record<MainlineConsensusLevel, string> = {
  resonance: '三方共振',
  diverge: '出现分歧',
  watch: '观察',
};


async function refresh() {
  try {
    await reload();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

// 详情下钻抽屉
const drawer = ref(false);
const detail = ref<BoardWorkbenchDetail | null>(null);
const detailLoading = ref(false);
const detailTitle = ref('');
const detailCode = ref('');
// AI 行动建议（按需生成）
const aiAction = ref<AiActionVerdict | null>(null);
const aiLoading = ref(false);

async function openDetail(it: BoardWorkbenchItem) {
  if (!it.boardCode) {
    ElMessage.info('该板块暂无稳定代码，无法下钻详情');
    return;
  }
  detailTitle.value = `${it.board} 作战台`;
  detailCode.value = it.boardCode;
  detail.value = null;
  aiAction.value = null;
  drawer.value = true;
  detailLoading.value = true;
  try {
    detail.value = await api.boards.detail(it.boardCode);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    detailLoading.value = false;
  }
}

async function genAiAction() {
  if (!detailCode.value) return;
  aiLoading.value = true;
  try {
    aiAction.value = await api.boards.aiAction(detailCode.value);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    aiLoading.value = false;
  }
}

onMounted(() =>
  void load().catch((e) => ElMessage.error(e instanceof Error ? e.message : String(e))),
);
</script>

<template>
  <div class="wb">
    <div class="wb-head">
      <div class="wb-title">
        板块主线作战台
        <MetricScaleHint
          name="多源协同度"
          note="动作标签为确定性派生：共振+走强→加仓候选/试错，共振→持有，观察→观察，背离→减仓，退潮→回避。仅研判不下单。"
        />
        <span v-if="data" class="as-of">更新 {{ dayjs(data.asOf).format('MM-DD HH:mm') }}</span>
      </div>
      <el-button :icon="Refresh" size="small" :loading="loading || refreshing" @click="refresh">
        刷新
      </el-button>
    </div>
    <div class="wb-sub">
      投影自主线共识（确定性锚 + 多源协同 + 中线趋势），派生操盘动作 / 周期 / 风险；点击卡片下钻龙头·补涨·持仓暴露。
      <span class="muted">仅研判不下单，仅供参考</span>
    </div>

    <div v-if="items.length" class="wb-grid">
      <button
        v-for="it in items"
        :key="it.boardCode ?? it.board"
        type="button"
        class="wb-card"
        :class="it.consensus"
        @click="openDetail(it)"
      >
        <div class="wc-head">
          <el-tag size="small" effect="dark" :type="ACTION_TAG_TYPE[it.actionTag]">
            {{ it.actionTag }}
          </el-tag>
          <span class="wc-board">{{ it.board }}</span>
          <span class="wc-cycle">{{ it.cycleFit }}</span>
        </div>
        <div class="wc-meta">
          <span v-if="it.stage" class="wc-stage" :class="`st-${it.stage}`">
            {{ STAGE_LABEL[it.stage] }}
            <template v-if="it.stageAction">· {{ STAGE_ACTION_LABEL[it.stageAction] }}</template>
          </span>
          <span class="wc-cons">{{ CONS_LABEL[it.consensus] }}</span>
          <span v-if="it.phase" class="wc-phase">{{ it.phase }}</span>
          <span v-if="it.strength != null" class="wc-strength num">强度 {{ it.strength }}</span>
          <StockLink v-if="it.etf" :code="it.etf.code" :name="it.etf.name" class="wc-etf" />
        </div>
        <div v-if="it.riskTags.length" class="wc-risks">
          <span v-for="r in it.riskTags" :key="r" class="wc-risk">{{ r }}</span>
        </div>
        <div class="wc-note">{{ it.evidenceNote }}</div>
      </button>
    </div>

    <el-empty
      v-else-if="!loading"
      :image-size="80"
      description="暂无主线（收盘后板块新高宽度确认主线时生成）"
    />

    <!-- 单板块详情下钻 -->
    <el-drawer v-model="drawer" :title="detailTitle" size="520px">
      <div v-loading="detailLoading">
        <template v-if="detail">
          <div class="d-block">
            <div class="d-cap">龙头（市值 + 趋势强度）</div>
            <div v-if="detail.leaders.length" class="d-list">
              <div v-for="s in detail.leaders" :key="s.code" class="d-row">
                <StockLink :code="s.code" :name="s.name" />
                <span class="d-reason">{{ s.reason }}</span>
              </div>
            </div>
            <span v-else class="muted">暂无（成分取数为空或降级）</span>
          </div>

          <div class="d-block">
            <div class="d-cap">补涨（涨幅未起 + 位置不高 + 资金确认）</div>
            <div v-if="detail.laggards.length" class="d-list">
              <div v-for="s in detail.laggards" :key="s.code" class="d-row">
                <StockLink :code="s.code" :name="s.name" />
                <span class="d-reason">{{ s.reason }}</span>
              </div>
            </div>
            <span v-else class="muted">暂无符合补涨条件的标的</span>
          </div>

          <div v-if="detail.exposure.length" class="d-block">
            <div class="d-cap">我的持仓 / 自选暴露</div>
            <div class="d-list">
              <div v-for="h in detail.exposure" :key="`${h.account}:${h.code}`" class="d-row">
                <el-tag size="small" :type="EXPO_STATUS_TYPE[h.status]" effect="plain">
                  {{ EXPO_STATUS_LABEL[h.status] }}
                </el-tag>
                <StockLink :code="h.code" :name="h.name" />
              </div>
            </div>
          </div>

          <div class="d-block">
            <div class="d-cap">失效条件</div>
            <ul class="d-inval">
              <li v-for="(iv, i) in detail.invalidators" :key="i">{{ iv }}</li>
            </ul>
          </div>

          <!-- AI 行动建议（按需生成，统一行动结构：结论/理由/证据/失效条件/动作） -->
          <div class="d-block">
            <div class="d-cap">
              AI 行动建议
              <el-button
                :icon="MagicStick"
                size="small"
                text
                type="primary"
                :loading="aiLoading"
                @click="genAiAction"
              >
                {{ aiAction ? '重新生成' : '生成' }}
              </el-button>
            </div>
            <div v-if="aiAction" class="d-ai">
              <div class="d-ai-line">
                <el-tag size="small" effect="dark" :type="ACTION_TAG_TYPE[aiAction.action]">
                  {{ aiAction.action }}
                </el-tag>
                <span class="d-ai-concl">{{ aiAction.conclusion }}</span>
              </div>
              <div v-if="aiAction.reasons.length" class="d-ai-sub">
                <b>理由</b>
                <ul>
                  <li v-for="(r, i) in aiAction.reasons" :key="i">{{ r }}</li>
                </ul>
              </div>
              <div v-if="aiAction.evidence.length" class="d-ai-sub">
                <b>证据</b>
                <ul>
                  <li v-for="(ev, i) in aiAction.evidence" :key="i">{{ ev }}</li>
                </ul>
              </div>
              <div v-if="aiAction.invalidators.length" class="d-ai-sub">
                <b>失效条件</b>
                <ul>
                  <li v-for="(iv, i) in aiAction.invalidators" :key="i">{{ iv }}</li>
                </ul>
              </div>
            </div>
            <span v-else class="muted">点击「生成」按行动结构给出结论 / 理由 / 证据 / 失效条件 / 动作</span>
          </div>

          <div class="d-foot">数据快照 {{ detail.snapshotDate }} · {{ detail.note }}</div>
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.wb {
  margin-bottom: 12px;
}
.wb-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.wb-title {
  font-size: 16px;
  font-weight: 700;
}
.as-of {
  margin-left: 10px;
  font-size: 12px;
  font-weight: 400;
  color: var(--text-2);
  font-family: var(--font-mono);
}
.wb-sub {
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.8;
  margin-bottom: 12px;
}
.wb-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.wb-card {
  text-align: left;
  cursor: pointer;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--bg-2, rgba(255, 255, 255, 0.02));
  transition: border-color 0.15s;
}
.wb-card:hover {
  border-color: var(--brand, #409eff);
}
.wb-card.resonance {
  box-shadow: inset 3px 0 0 var(--danger, #f56c6c);
}
.wb-card.diverge {
  box-shadow: inset 3px 0 0 var(--warning, #e6a23c);
}
.wc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.wc-board {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-0);
}
.wc-cycle {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-2);
}
.wc-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-2);
}
.wc-stage {
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  border: 1px solid currentColor;
}
.st-advancing {
  color: #f56c6c;
}
.st-brewing {
  color: #e6a23c;
}
.st-diverging {
  color: #909399;
}
.st-fading {
  color: #4eb61b;
}
.st-none {
  color: var(--text-2);
  font-weight: 400;
}
.wc-strength {
  color: var(--text-1);
}
.wc-etf {
  font-size: 12px;
}
.wc-risks {
  margin-top: 6px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.wc-risk {
  font-size: 11px;
  color: var(--status-warn, #e6a23c);
  border: 1px solid currentColor;
  border-radius: 3px;
  padding: 0 4px;
}
.wc-note {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.5;
}
.muted {
  color: var(--text-3, var(--text-2));
  font-size: 12px;
}
.d-block {
  margin-bottom: 18px;
}
.d-cap {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--text-1);
}
.d-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.d-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.d-reason {
  font-size: 12px;
  color: var(--text-2);
}
.d-inval {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.8;
}
.d-ai {
  font-size: 13px;
}
.d-ai-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
}
.d-ai-concl {
  font-weight: 600;
  color: var(--text-0);
}
.d-ai-sub {
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--text-2);
}
.d-ai-sub b {
  color: var(--text-1);
}
.d-ai-sub ul {
  margin: 4px 0 0;
  padding-left: 18px;
  line-height: 1.7;
}
.d-foot {
  font-size: 11px;
  color: var(--text-3, var(--text-2));
  margin-top: 8px;
}
</style>
