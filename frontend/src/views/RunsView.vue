<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import dayjs from 'dayjs';
import { api, openWs } from '@/api';
import type { RunMessage, StreamEvent, TaskRun } from '@stock-agent/shared';

const runs = ref<TaskRun[]>([]);
const drawer = ref(false);
const detail = ref<{ run: TaskRun; messages: RunMessage[] } | null>(null);
const liveLog = ref<string[]>([]);
let ws: WebSocket | null = null;

async function load() {
  runs.value = await api.listRuns();
}

async function openRun(r: TaskRun) {
  detail.value = await api.getRun(r.id);
  drawer.value = true;
}

const statusType = (s: string) =>
  s === 'success' ? 'success' : s === 'running' ? 'warning' : 'danger';
const fmt = (s?: string | null) => (s ? dayjs(s).format('MM-DD HH:mm:ss') : '-');

onMounted(() => {
  load();
  ws = openWs('/ws/runs');
  ws.onmessage = (ev) => {
    const e: StreamEvent = JSON.parse(ev.data);
    if (e.type === 'run_started') liveLog.value.unshift(`[${fmt(new Date().toISOString())}] 运行开始`);
    if (e.type === 'tool_call') liveLog.value.unshift(`  → 调用 ${e.name}`);
    if (e.type === 'tool_result')
      liveLog.value.unshift(`  ← ${e.name} ${e.ok ? '成功' : '失败'}: ${e.preview}`);
    if (e.type === 'run_finished') {
      liveLog.value.unshift(`运行结束: ${e.status}`);
      load();
    }
    if (liveLog.value.length > 100) liveLog.value.length = 100;
  };
});

onUnmounted(() => ws?.close());
</script>

<template>
  <div class="page">
    <div class="page-head"><div class="page-title">运行 / 复盘</div></div>
    <div class="page-sub">每次运行的完整工具调用轨迹 · 右侧实时监控定时/手动任务</div>
    <el-row :gutter="12">
      <el-col :span="16">
        <el-table :data="runs" stripe @row-click="openRun" style="cursor: pointer">
          <el-table-column prop="taskName" label="任务" min-width="160">
            <template #default="{ row }">{{ row.taskName || '聊天' }}</template>
          </el-table-column>
          <el-table-column prop="trigger" label="触发" width="90" />
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="statusType(row.status)" size="small">{{ row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="开始" width="150">
            <template #default="{ row }">{{ fmt(row.startedAt) }}</template>
          </el-table-column>
          <el-table-column label="Tokens" width="120">
            <template #default="{ row }">
              {{ (row.promptTokens || 0) + (row.completionTokens || 0) }}
            </template>
          </el-table-column>
        </el-table>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never" header="实时监控">
          <div class="mono" style="font-size: 12px; max-height: 70vh; overflow: auto">
            <div v-for="(l, i) in liveLog" :key="i">{{ l }}</div>
            <div v-if="!liveLog.length" style="color: #999">等待任务运行...</div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-drawer v-model="drawer" title="运行轨迹" size="50%">
      <div v-if="detail">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="任务">{{
            detail.run.taskName || '聊天'
          }}</el-descriptions-item>
          <el-descriptions-item label="状态">{{ detail.run.status }}</el-descriptions-item>
          <el-descriptions-item label="开始">{{
            fmt(detail.run.startedAt)
          }}</el-descriptions-item>
          <el-descriptions-item label="结束">{{
            fmt(detail.run.finishedAt)
          }}</el-descriptions-item>
        </el-descriptions>
        <div v-if="detail.run.error" style="color: #f56c6c; margin: 12px 0">
          错误: {{ detail.run.error }}
        </div>
        <el-timeline style="margin-top: 16px">
          <el-timeline-item
            v-for="m in detail.messages"
            :key="m.id"
            :timestamp="m.role + (m.toolName ? ` · ${m.toolName}` : '')"
          >
            <div class="mono" style="font-size: 12px">
              {{ m.content || m.toolCalls || '' }}
            </div>
          </el-timeline-item>
        </el-timeline>
      </div>
    </el-drawer>
  </div>
</template>
