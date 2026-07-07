<script setup lang="ts">
// 尾盘套利确定性盯盘面板：展示引擎状态 + 今日信号流 + 今日卖出/跳过告警，并提供开关/手动建仓/手动检测。
// 全程无 LLM：卖点判定与卖出均为确定性规则，仅受全局 autoLocalSimEnabled 安全总闸约束。
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import dayjs from 'dayjs';
import type { WeipanExitReason } from '@stock-agent/shared';
import { api } from '@/api';
import { useWeipanStore } from '@/stores/weipan';

const store = useWeipanStore();
const toggling = ref(false);
const acting = ref(false);

const REASON_LABEL: Record<WeipanExitReason, string> = {
  stop_loss: '止损',
  take_profit: '止盈',
  trailing: '冲高回落',
  eod: '尾盘了结',
};
const REASON_TYPE: Record<WeipanExitReason, 'danger' | 'success' | 'warning' | 'info'> = {
  stop_loss: 'danger',
  take_profit: 'success',
  trailing: 'warning',
  eod: 'info',
};

const enabled = computed(() => !!store.status?.enabled);
const fmtTime = (iso: string | null) => (iso ? dayjs(iso).format('HH:mm:ss') : '—');
const dir = (v: number | null) => (v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');
const signed = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}`);

async function toggle(v: boolean) {
  toggling.value = true;
  try {
    await api.weipan.toggle(v);
    await store.refresh();
    ElMessage.success(v ? '已开启尾盘盯盘' : '已关闭尾盘盯盘');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    toggling.value = false;
  }
}

async function buildNow() {
  acting.value = true;
  try {
    const r = await api.weipan.build();
    ElMessage.success(r.note);
    await store.refresh();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    acting.value = false;
  }
}

async function triggerNow() {
  acting.value = true;
  try {
    await api.weipan.trigger();
    await store.refresh();
    ElMessage.success('已触发一次检测');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    acting.value = false;
  }
}

onMounted(() => {
  store.connect();
  void store.refresh().catch(() => {});
});
onUnmounted(() => store.disconnect());
</script>

<template>
  <div class="weipan-panel">
    <div class="wp-head">
      <div class="wp-title">
        尾盘套利盯盘
        <el-tag size="small" effect="plain" type="info">无 LLM · 确定性</el-tag>
        <el-tag v-if="store.status?.inSession" size="small" type="success" effect="plain">交易时段</el-tag>
        <el-tag v-else size="small" type="info" effect="plain">非交易时段</el-tag>
      </div>
      <div class="wp-actions">
        <el-switch
          :model-value="enabled"
          :loading="toggling"
          active-text="开"
          inactive-text="关"
          @update:model-value="(v: boolean) => toggle(v)"
        />
        <el-button size="small" :loading="acting" @click="buildNow">手动建仓</el-button>
        <el-button size="small" :loading="acting" @click="triggerNow">手动检测</el-button>
      </div>
    </div>

    <div class="wp-meta">
      <span>跟踪 {{ store.status?.trackedCount ?? 0 }} 只</span>
      <span>·</span>
      <span>上次轮询 {{ fmtTime(store.status?.lastPollAt ?? null) }}</span>
      <span>·</span>
      <span :class="store.connected ? 'ok' : 'off'">{{ store.connected ? '实时已连接' : '未连接' }}</span>
    </div>

    <el-alert
      type="warning"
      :closable="false"
      show-icon
      title="卖点为确定性规则（止损/止盈/移动止盈/尾盘了结），命中即自动模拟卖出；实际下单还需在安全控制台开启「本地自动模拟」总闸。"
    />

    <!-- 今日信号流 -->
    <div class="wp-section-title">今日信号</div>
    <div v-if="store.signals.length === 0" class="wp-empty">暂无信号</div>
    <div v-for="s in store.signals" :key="`${s.code}:${s.reason}`" class="wp-row">
      <el-tag size="small" :type="REASON_TYPE[s.reason]" effect="dark">{{ REASON_LABEL[s.reason] }}</el-tag>
      <span class="wp-name">{{ s.name }} <span class="code">{{ s.code }}</span></span>
      <span class="wp-detail">{{ s.detail }}</span>
      <el-tag v-if="s.disposition === 'skipped'" size="small" type="info">未成交</el-tag>
      <el-tag v-else-if="s.disposition === 'cooldown'" size="small" type="info">冷却</el-tag>
      <span class="wp-time">{{ fmtTime(s.at) }}<span v-if="s.count > 1"> ×{{ s.count }}</span></span>
    </div>

    <!-- 今日告警/卖出 -->
    <div class="wp-section-title">今日卖出</div>
    <div v-if="store.alerts.length === 0" class="wp-empty">暂无卖出</div>
    <div v-for="a in store.alerts" :key="a.id" class="wp-row">
      <el-tag size="small" :type="REASON_TYPE[a.reason]" effect="plain">{{ REASON_LABEL[a.reason] }}</el-tag>
      <span class="wp-name">{{ a.name }} <span class="code">{{ a.code }}</span></span>
      <span v-if="a.soldQty > 0" class="wp-detail">
        卖出 {{ a.soldQty }} 股 @{{ a.triggerPrice.toFixed(2) }}
        <b class="num" :class="dir(a.realizedProfit)">盈亏 {{ signed(a.realizedProfit) }}</b>
      </span>
      <span v-else class="wp-detail muted">未成交：{{ a.skipNote }}</span>
      <span class="wp-time">{{ fmtTime(a.createdAt) }}</span>
    </div>
  </div>
</template>

<style scoped>
.weipan-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.wp-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.wp-title {
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}
.wp-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.wp-meta {
  display: flex;
  gap: 8px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.wp-meta .ok {
  color: var(--el-color-success);
}
.wp-meta .off {
  color: var(--el-text-color-secondary);
}
.wp-section-title {
  font-size: 13px;
  font-weight: 600;
  margin-top: 6px;
  color: var(--el-text-color-regular);
}
.wp-empty {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  padding: 6px 0;
}
.wp-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
  font-size: 13px;
}
.wp-name {
  font-weight: 600;
  white-space: nowrap;
}
.wp-name .code {
  color: var(--el-text-color-secondary);
  font-weight: 400;
  font-size: 12px;
}
.wp-detail {
  flex: 1;
  color: var(--el-text-color-regular);
}
.wp-detail.muted {
  color: var(--el-text-color-secondary);
}
.wp-time {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  white-space: nowrap;
}
.num.up {
  color: var(--el-color-danger);
}
.num.down {
  color: var(--el-color-success);
}
</style>
