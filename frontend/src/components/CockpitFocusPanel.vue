<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Search } from '@element-plus/icons-vue';
import { api } from '@/api';
import { isTradingNow } from '@/composables/tradingHours';
import StockLink from '@/components/StockLink.vue';
import type { CockpitFocusItem } from '@stock-agent/shared';

const items = ref<CockpitFocusItem[]>([]);
const loading = ref(false);
const adding = ref(false);
const searchKw = ref('');

interface Suggest {
  value: string;
  code: string;
  name: string;
}

/** 在途请求互斥：接口慢于轮询间隔时请求会重叠堆积，返回乱序还会让报价来回跳 */
let inflight = false;

async function load(silent = false) {
  // 只让轮询让路：增删改后的显式刷新必须照常执行，否则列表要等下一个 tick 才更新
  if (inflight && silent) return;
  inflight = true;
  if (!silent) loading.value = true;
  try {
    items.value = await api.cockpit.listFocus();
  } catch (e) {
    if (!silent) ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    inflight = false;
    if (!silent) loading.value = false;
  }
}

/** el-autocomplete 远程联想：复用全站标的搜索 */
async function fetchSuggest(q: string, cb: (list: Suggest[]) => void) {
  const kw = q.trim();
  if (!kw) {
    cb([]);
    return;
  }
  try {
    const list = await api.searchStocks(kw);
    cb(list.map((s) => ({ value: `${s.name} (${s.code})`, code: s.code, name: s.name })));
  } catch {
    cb([]);
  }
}

async function addByCode(item: Suggest) {
  adding.value = true;
  try {
    await api.cockpit.addFocus({ code: item.code });
    searchKw.value = '';
    ElMessage.success(`已关注 ${item.name}(${item.code})`);
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    adding.value = false;
  }
}

async function saveNote(row: CockpitFocusItem, note: string) {
  const next = note.trim();
  if (next === (row.note ?? '')) return;
  try {
    await api.cockpit.updateFocus(row.code, { note: next });
    row.note = next || null;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
    await load();
  }
}

async function remove(row: CockpitFocusItem) {
  try {
    await ElMessageBox.confirm(`确定移除关注 ${row.name}(${row.code})？`, '移除关注', {
      type: 'warning',
    });
  } catch {
    return;
  }
  try {
    await api.cockpit.removeFocus(row.code);
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

// A股 红涨绿跌
const dir = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const pct = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';

// 轮询节流：盘中 3 秒盯报价，非交易时段行情不动、页面不可见时也没人看，都不必打接口。
// 用 setTimeout 自排而非 setInterval，间隔才能随交易时段切换。
const POLL_TRADING_MS = 3_000;
const POLL_IDLE_MS = 60_000;
let timer: ReturnType<typeof setTimeout> | undefined;

function scheduleNext(): void {
  const trading = isTradingNow();
  timer = setTimeout(() => {
    if (!document.hidden) void load(true);
    scheduleNext();
  }, trading ? POLL_TRADING_MS : POLL_IDLE_MS);
}

onMounted(() => {
  void load();
  scheduleNext();
});
onUnmounted(() => {
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <section class="panel focus-panel" v-loading="loading">
    <div class="panel-head">
      <span class="section-title">关注标的</span>
      <span class="panel-meta">自行添加 · 点标的直接进详情弹窗</span>
    </div>

    <div class="add-bar">
      <el-autocomplete
        v-model="searchKw"
        :fetch-suggestions="fetchSuggest"
        :debounce="250"
        :trigger-on-focus="false"
        :disabled="adding"
        value-key="value"
        clearable
        placeholder="搜索名称 / 代码，点击候选加入关注"
        style="width: 320px"
        @select="addByCode"
      >
        <template #prefix><el-icon><Search /></el-icon></template>
        <template #default="{ item }">
          <div class="sug-item">
            <span>{{ item.name }}</span>
            <span class="sug-code num">{{ item.code }}</span>
          </div>
        </template>
      </el-autocomplete>
    </div>

    <el-table v-if="items.length" :data="items" size="small" style="width: 100%">
      <el-table-column label="代码" width="88">
        <template #default="{ row }">
          <StockLink :code="row.code" :name="row.name" show="code" class="num" />
        </template>
      </el-table-column>
      <el-table-column label="名称" min-width="100">
        <template #default="{ row }">
          <StockLink :code="row.code" :name="row.name" />
        </template>
      </el-table-column>
      <el-table-column label="现价" min-width="84" align="right">
        <template #default="{ row }">
          <span v-if="row.quote" class="num" :class="dir(row.quote.pct)">
            {{ row.quote.price.toFixed(2) }}
          </span>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="涨跌幅" min-width="88" align="right">
        <template #default="{ row }">
          <span v-if="row.quote" class="num" :class="dir(row.quote.pct)">
            {{ pct(row.quote.pct) }}
          </span>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="备注" min-width="180">
        <template #default="{ row }">
          <el-input
            :model-value="row.note ?? ''"
            size="small"
            placeholder="点此写备注"
            @change="(v: string) => saveNote(row, v)"
          />
        </template>
      </el-table-column>
      <el-table-column label="操作" width="70" align="right">
        <template #default="{ row }">
          <el-button link type="danger" size="small" @click="remove(row)">移除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-empty v-else-if="!loading" description="还没有关注标的，搜索一只加入" :image-size="60" />
  </section>
</template>

<style scoped>
.add-bar {
  margin-bottom: 10px;
}
.sug-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.sug-code {
  color: var(--text-2);
  font-size: 12px;
}
.muted {
  color: var(--text-2);
}
</style>
