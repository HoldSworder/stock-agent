<script setup lang="ts">
import { onMounted, ref } from 'vue';
import dayjs from 'dayjs';
import { api } from '@/api';
import type { StockPick } from '@stock-agent/shared';

const picks = ref<StockPick[]>([]);
const range = ref<[string, string] | null>(null);
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    picks.value = await api.listPicks({
      from: range.value?.[0],
      to: range.value?.[1],
      limit: 300,
    });
  } finally {
    loading.value = false;
  }
}

const fmt = (s: string) => dayjs(s).format('MM-DD HH:mm');

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-head"><div class="page-title">选股留痕</div></div>
    <div class="page-sub">结构化记录历次选股，按时间复盘改进</div>
    <div style="margin-bottom: 12px">
      <el-date-picker
        v-model="range"
        type="datetimerange"
        value-format="YYYY-MM-DDTHH:mm:ss.SSSZ"
        start-placeholder="开始"
        end-placeholder="结束"
      />
      <el-button style="margin-left: 8px" @click="load">查询</el-button>
    </div>
    <el-table :data="picks" v-loading="loading" stripe>
      <el-table-column label="时间" width="120">
        <template #default="{ row }">{{ fmt(row.pickedAt) }}</template>
      </el-table-column>
      <el-table-column label="代码" width="100">
        <template #default="{ row }"><span class="num">{{ row.code }}</span></template>
      </el-table-column>
      <el-table-column prop="name" label="名称" width="120" />
      <el-table-column label="现价" width="90">
        <template #default="{ row }">
          <span class="num">{{ row.price ?? '-' }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="tags" label="标签" width="160" />
      <el-table-column prop="reason" label="理由" min-width="240" show-overflow-tooltip />
    </el-table>
  </div>
</template>
