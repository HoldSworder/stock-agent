<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Refresh, MagicStick, Search, Files, Sort, Upload, Plus } from '@element-plus/icons-vue';
import { api } from '@/api';
import MarkdownView from '@/components/MarkdownView.vue';
import StockLink from '@/components/StockLink.vue';
import type { WatchlistEntry } from '@stock-agent/shared';

// embedded：作为「持仓与自选」父页的 Tab 面板嵌入时隐藏自身 page-head。
defineProps<{ embedded?: boolean }>();

const items = ref<WatchlistEntry[]>([]);
const loading = ref(false);

// 分组（复用 tags，一只票可属多组）；无「全部」tab，默认选中第一个分组
const activeGroup = ref('');
// 前端临时空分组：新建后即可选中并接收第一只标的，落库后随 tag 自动持久化
const extraGroups = ref<string[]>([]);
const groups = computed(() => {
  const set = new Set<string>();
  for (const i of items.value) {
    for (const t of (i.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      set.add(t);
    }
  }
  for (const g of extraGroups.value) set.add(g);
  // 「我的自选」始终排在最前（并作为默认选中分组）
  const rest = Array.from(set).filter((g) => g !== SELF_TAG);
  return set.has(SELF_TAG) ? [SELF_TAG, ...rest] : rest;
});
const filteredItems = computed(() => {
  if (!activeGroup.value) return items.value;
  return items.value.filter((i) =>
    (i.tags ?? '').split(',').map((s) => s.trim()).includes(activeGroup.value),
  );
});

// 新建分组：创建一个临时空分组并设为当前分组，加入第一只标的后即落库
async function createGroup() {
  try {
    const { value } = await ElMessageBox.prompt('输入新分组名称', '新建分组', {
      inputValidator: (v: string) => {
        const n = (v ?? '').trim();
        if (!n) return '分组名不能为空';
        if (n.includes(',')) return '分组名不能包含英文逗号';
        if (groups.value.includes(n)) return '该分组已存在';
        return true;
      },
    });
    const name = value.trim();
    if (!extraGroups.value.includes(name)) extraGroups.value.push(name);
    activeGroup.value = name;
    ElMessage.success(`已创建分组「${name}」，搜索或批量添加标的即可加入`);
  } catch {
    // 用户取消
  }
}

// 搜索添加（爱盯盘式）：搜索标的 → 点击候选 → 加入当前分组
const SELF_TAG = '我的自选';
const searchKw = ref('');
const adding = ref(false);
const searchRef = ref();

// 批量添加
const bulkVisible = ref(false);
const bulkForm = reactive({ codes: '', tags: '' });
const bulkLoading = ref(false);

// 整组分析
const reviewing = ref(false);
const review = ref('');

// 同花顺同步
const syncing = ref(false);

// 分组 tab 右键菜单
const ctxMenu = reactive({ visible: false, x: 0, y: 0, group: '' });
function openCtxMenu(e: MouseEvent, group: string) {
  e.preventDefault();
  ctxMenu.x = e.clientX;
  ctxMenu.y = e.clientY;
  ctxMenu.group = group;
  ctxMenu.visible = true;
}
function closeCtxMenu() {
  ctxMenu.visible = false;
}
async function deleteGroup() {
  const group = ctxMenu.group;
  closeCtxMenu();
  try {
    await ElMessageBox.confirm(
      `确定删除分组「${group}」？将从所有标的移除该分组，并同步删除同花顺对应分组（标的本身不会被删除）。`,
      '删除分组',
      { type: 'warning' },
    );
  } catch {
    return;
  }
  try {
    const r = await api.deleteWatchGroup(group);
    if (activeGroup.value === group) activeGroup.value = '';
    ElMessage.success(`已删除分组「${group}」，影响 ${r.affected} 只标的`);
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

// 推送到爱盯盘（单向镜像）
const pushing = ref(false);

// 单只分析弹窗
const dialogVisible = ref(false);
const dialogTitle = ref('');
const dialogLoading = ref(false);
const dialogText = ref('');

async function load(silent = false) {
  if (!silent) loading.value = true;
  try {
    items.value = await api.listWatchlist();
    // 默认选中第一个分组（无「全部」tab）；当前选中分组已不存在时回退到第一个
    const gs = groups.value;
    if (gs.length > 0 && !gs.includes(activeGroup.value)) activeGroup.value = gs[0];
  } catch (e) {
    if (!silent) ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    if (!silent) loading.value = false;
  }
}

async function bulkSubmit() {
  if (!bulkForm.codes.trim()) {
    ElMessage.warning('请粘贴股票代码');
    return;
  }
  bulkLoading.value = true;
  try {
    const r = await api.bulkAddWatch({
      codes: bulkForm.codes,
      tags: bulkForm.tags.trim() || undefined,
    });
    const msg = `成功添加 ${r.added.length} 只`;
    if (r.invalid.length) {
      ElMessage.warning(`${msg}，无效 ${r.invalid.length} 只：${r.invalid.join(', ')}`);
    } else {
      ElMessage.success(msg);
    }
    bulkVisible.value = false;
    bulkForm.codes = '';
    bulkForm.tags = '';
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    bulkLoading.value = false;
  }
}

async function syncThs() {
  syncing.value = true;
  try {
    const r = await api.syncWatchlist();
    const parts = [`分组 ${r.groups} 个`];
    if (r.added.length) parts.push(`新增 ${r.added.length}`);
    if (r.removed.length) parts.push(`移除 ${r.removed.length}`);
    if (r.regrouped) parts.push(`调整分组 ${r.regrouped}`);
    if (r.skipped.length) parts.push(`跳过 ${r.skipped.length}`);
    ElMessage.success(`同花顺同步完成：${parts.join('，')}`);
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    syncing.value = false;
  }
}

async function pushIdp() {
  pushing.value = true;
  try {
    const r = await api.pushIdingpan();
    await ElMessageBox.alert(
      `已镜像 ${r.codes} 只标的到 ${r.groups} 个分组。\n\n${r.note}`,
      '推送到爱盯盘',
      { confirmButtonText: '知道了' },
    );
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    pushing.value = false;
  }
}

interface Suggest {
  value: string;
  code: string;
  name: string;
}

// el-autocomplete 远程联想：返回 {value, code, name}
async function fetchSuggest(q: string, cb: (items: Suggest[]) => void) {
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

// 点击候选 → 加入当前分组（无分组默认我的自选）
async function addByCode(item: Suggest) {
  const tag = activeGroup.value || SELF_TAG;
  adding.value = true;
  try {
    await api.addWatch({ code: item.code, tags: tag });
    searchKw.value = '';
    ElMessage.success(`已将 ${item.name}(${item.code}) 加入分组「${tag}」`);
    if (!activeGroup.value) activeGroup.value = tag;
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    adding.value = false;
  }
}

async function remove(row: WatchlistEntry) {
  try {
    await ElMessageBox.confirm(`确定移除 ${row.name}(${row.code})？`, '移除自选', {
      type: 'warning',
    });
  } catch {
    return;
  }
  try {
    await api.removeWatch(row.code);
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

async function analyzeOne(row: WatchlistEntry) {
  dialogVisible.value = true;
  dialogTitle.value = `${row.name}(${row.code}) AI 研判`;
  dialogLoading.value = true;
  dialogText.value = '';
  try {
    const r = await api.analyzeWatch(row.code);
    dialogText.value = r.text || '（无输出）';
  } catch (e) {
    dialogText.value = '';
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    dialogLoading.value = false;
  }
}

async function analyzeAll() {
  if (items.value.length === 0) {
    ElMessage.warning('关注列表为空');
    return;
  }
  reviewing.value = true;
  review.value = '';
  try {
    const r = await api.analyzeWatchlist();
    review.value = r.text || '（无输出）';
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    reviewing.value = false;
  }
}

// A股 红涨绿跌
const dir = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const pct = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
const fixed = (v: number, d = 2) => v.toFixed(d);

let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  load();
  timer = setInterval(() => load(true), 3000);
  window.addEventListener('click', closeCtxMenu);
  window.addEventListener('contextmenu', closeCtxMenu, true);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
  window.removeEventListener('click', closeCtxMenu);
  window.removeEventListener('contextmenu', closeCtxMenu, true);
});
</script>

<template>
  <div :class="{ page: !embedded }">
    <div v-if="!embedded" class="page-head">
      <div class="page-title">自选股</div>
      <div class="head-actions">
        <el-button
          :icon="MagicStick"
          type="primary"
          :loading="reviewing"
          @click="analyzeAll"
        >
          一键 AI 分析
        </el-button>
        <el-button :icon="Plus" @click="createGroup">新建分组</el-button>
        <el-button :icon="Files" @click="bulkVisible = true">批量添加</el-button>
        <el-button :icon="Sort" :loading="syncing" @click="syncThs">同步同花顺</el-button>
        <el-button :icon="Upload" :loading="pushing" @click="pushIdp">推送到爱盯盘</el-button>
        <el-button :icon="Refresh" :loading="loading" @click="load()">刷新</el-button>
      </div>
    </div>
    <div v-if="!embedded" class="page-sub">添加 A 股主板 / 创业板标的跟踪（东方财富实时行情，红涨绿跌）</div>
    <div v-else class="embed-bar">
      <span class="embed-sub">添加 A 股主板 / 创业板标的跟踪（东方财富实时行情，红涨绿跌）</span>
      <el-button :icon="MagicStick" type="primary" :loading="reviewing" @click="analyzeAll">
        一键 AI 分析
      </el-button>
      <el-button :icon="Plus" @click="createGroup">新建分组</el-button>
      <el-button :icon="Files" @click="bulkVisible = true">批量添加</el-button>
      <el-button :icon="Sort" :loading="syncing" @click="syncThs">同步同花顺</el-button>
      <el-button :icon="Upload" :loading="pushing" @click="pushIdp">推送到爱盯盘</el-button>
      <el-button :icon="Refresh" :loading="loading" @click="load()">刷新</el-button>
    </div>

    <!-- 搜索添加：点击候选加入当前分组 -->
    <div class="add-bar">
      <el-autocomplete
        ref="searchRef"
        v-model="searchKw"
        :fetch-suggestions="fetchSuggest"
        :debounce="250"
        :trigger-on-focus="false"
        value-key="value"
        clearable
        placeholder="搜索股票名称 / 代码，点击候选加入当前分组"
        style="width: 360px"
        @select="addByCode"
      >
        <template #prefix><el-icon><Search /></el-icon></template>
        <template #default="{ item }">
          <div class="sug-item">
            <span class="sug-name">{{ item.name }}</span>
            <span class="sug-code num">{{ item.code }}</span>
          </div>
        </template>
      </el-autocomplete>
      <span class="add-hint">
        将加入：<b>{{ activeGroup || SELF_TAG }}</b>
      </span>
    </div>

    <!-- 整组分析结果 -->
    <div v-if="reviewing || review" class="review">
      <div class="review-head"><el-icon><MagicStick /></el-icon> 组合研判</div>
      <div v-if="reviewing" class="review-loading">正在结合关注标的盘面生成研判…</div>
      <MarkdownView v-else :source="review" />
    </div>

    <!-- 分组切换（无「全部」tab；右键 tab 可删除分组） -->
    <el-tabs v-if="groups.length" v-model="activeGroup" class="group-tabs">
      <el-tab-pane v-for="g in groups" :key="g" :name="g">
        <template #label>
          <span @contextmenu="openCtxMenu($event, g)">{{ g }}</span>
        </template>
      </el-tab-pane>
    </el-tabs>

    <el-table v-if="filteredItems.length" :data="filteredItems" size="small" style="width: 100%">
      <el-table-column label="代码" width="90">
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
          <span v-if="row.quote" class="num" :class="dir(row.quote.pct)">{{
            fixed(row.quote.price)
          }}</span>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="涨跌幅" min-width="88" align="right">
        <template #default="{ row }">
          <span v-if="row.quote" class="num" :class="dir(row.quote.pct)">{{
            pct(row.quote.pct)
          }}</span>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="标签" min-width="120">
        <template #default="{ row }">
          <template v-if="row.tags">
            <el-tag
              v-for="t in row.tags.split(',')"
              :key="t"
              size="small"
              type="info"
              class="tag"
              >{{ t }}</el-tag
            >
          </template>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column prop="note" label="备注" min-width="140" show-overflow-tooltip>
        <template #default="{ row }">
          <span v-if="row.note">{{ row.note }}</span>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="150" align="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="analyzeOne(row)">
            AI 分析
          </el-button>
          <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-empty
      v-else-if="!loading"
      :description="items.length ? `分组「${activeGroup}」下暂无标的` : '还没有自选股，添加一只开始跟踪'"
    />

    <!-- 批量添加弹窗 -->
    <el-dialog v-model="bulkVisible" title="批量添加关注标的" width="520px" top="10vh">
      <el-input
        v-model="bulkForm.codes"
        type="textarea"
        :rows="8"
        placeholder="粘贴 6 位股票代码，逗号 / 空格 / 换行混合分隔均可，如：&#10;600519, 002472&#10;300750 000636"
      />
      <el-input
        v-model="bulkForm.tags"
        placeholder="目标分组（可选，逗号分隔，如 机器人,算力）"
        style="margin-top: 12px"
        clearable
      />
      <template #footer>
        <el-button @click="bulkVisible = false">取消</el-button>
        <el-button type="primary" :loading="bulkLoading" @click="bulkSubmit">添加</el-button>
      </template>
    </el-dialog>

    <!-- 分组 tab 右键菜单 -->
    <teleport to="body">
      <div
        v-if="ctxMenu.visible"
        class="ctx-menu"
        :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
        @click.stop
      >
        <button class="ctx-item" @click="deleteGroup">删除分组「{{ ctxMenu.group }}」</button>
      </div>
    </teleport>

    <!-- 单只研判弹窗 -->
    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="640px" top="8vh">
      <div v-if="dialogLoading" class="review-loading">正在结合行情与消息面生成研判…</div>
      <MarkdownView v-else :source="dialogText" />
    </el-dialog>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 8px;
}
.embed-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 14px;
}
.embed-sub {
  flex: 1;
  min-width: 200px;
  font-size: 12.5px;
  color: var(--text-2);
}
.add-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 18px;
}
.add-hint {
  color: var(--text-2);
  font-size: 13px;
}
.add-hint b {
  color: var(--brand);
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
.review-body {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--text-0);
}
.group-tabs {
  margin-bottom: 4px;
}
.ctx-menu {
  position: fixed;
  z-index: 3000;
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
  padding: 4px;
}
.ctx-item {
  display: block;
  width: 100%;
  padding: 7px 14px;
  border: none;
  background: transparent;
  color: var(--el-color-danger);
  font-size: 13px;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
  border-radius: 6px;
}
.ctx-item:hover {
  background: var(--bg-2);
}
.tag {
  margin-right: 4px;
}
.muted {
  color: var(--text-2);
}
</style>
