<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '@/api';
import type { DataSourceHealth, DataSourceInfo, DataSourceRoute } from '@stock-agent/shared';

// 数据源中心：统一管理所有外部取数（行情/选股/账本/资讯/研报/热点/本地）。
// 总览行（始终可见）+ 点击展开详情（凭据/统计/健康/操作），是各模块取数路径的单一收口入口。

const loading = ref(false);
const sources = ref<DataSourceInfo[]>([]);
const routes = ref<DataSourceRoute[]>([]);
const health = reactive<Record<string, DataSourceHealth>>({});
const healthChecking = reactive<Record<string, boolean>>({});
const toggling = reactive<Record<string, boolean>>({});
const saving = reactive<Record<string, boolean>>({});

// 展开态：点击总览行切换，支持多行同时展开
const expanded = reactive<Set<string>>(new Set());

// 各数据源凭据编辑态：sourceId -> { fieldKey -> 输入值 }。明文回填，所见即所存。
const edits = reactive<Record<string, Record<string, string>>>({});

// 数据源 id → 中文名（调度链路展示用）
const NAME_BY_ID = computed<Record<string, string>>(() =>
  Object.fromEntries(sources.value.map((s) => [s.id, s.name])),
);

function isCookieField(key: string): boolean {
  return key.toLowerCase().includes('cookie');
}

const CATEGORY_ORDER = ['行情', '选股', '账本', '自选', '资讯', '研报', '热点', '本地'];

const grouped = computed(() => {
  const map = new Map<string, DataSourceInfo[]>();
  for (const s of sources.value) {
    if (!map.has(s.category)) map.set(s.category, []);
    map.get(s.category)!.push(s);
  }
  return [...map.entries()].sort(
    (a, b) => CATEGORY_ORDER.indexOf(a[0]) - CATEGORY_ORDER.indexOf(b[0]),
  );
});

// 顶部状态总览：总数 / 启用 / 就绪 / 已测在线
const summary = computed(() => {
  let enabled = 0;
  let ready = 0;
  let online = 0;
  for (const s of sources.value) {
    if (s.enabled) enabled += 1;
    if (s.ready) ready += 1;
    if (health[s.id]?.online) online += 1;
  }
  return { total: sources.value.length, enabled, ready, online };
});

function initEdits(): void {
  for (const s of sources.value) {
    const row: Record<string, string> = {};
    for (const f of s.config) row[f.key] = f.value;
    edits[s.id] = row;
  }
}

function toggleExpand(id: string): void {
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    sources.value = await api.datasource.list();
    initEdits();
    routes.value = await api.datasource.routes().catch(() => []);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

/** 仅刷新调用统计，不重置编辑态 */
async function refreshStats(): Promise<void> {
  try {
    const map = await api.datasource.stats();
    for (const s of sources.value) if (map[s.id]) s.stats = map[s.id];
  } catch {
    /* 统计刷新失败静默 */
  }
}

function replaceSource(info: DataSourceInfo): void {
  const i = sources.value.findIndex((s) => s.id === info.id);
  if (i >= 0) sources.value[i] = info;
}

async function testHealth(s: DataSourceInfo): Promise<void> {
  healthChecking[s.id] = true;
  try {
    health[s.id] = await api.datasource.health(s.id);
    if (!health[s.id].online && health[s.id].detail) {
      ElMessage.warning(`${s.name}：${health[s.id].detail}`);
    } else if (health[s.id].online) {
      ElMessage.success(`${s.name} 连通（${health[s.id].latencyMs}ms）`);
    }
    await refreshStats();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '健康检查失败');
  } finally {
    healthChecking[s.id] = false;
  }
}

async function toggle(s: DataSourceInfo, enabled: boolean): Promise<void> {
  toggling[s.id] = true;
  try {
    replaceSource(await api.datasource.toggle(s.id, enabled));
    ElMessage.success(`${s.name} 已${enabled ? '启用' : '禁用'}`);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '切换失败');
  } finally {
    toggling[s.id] = false;
  }
}

async function saveConfig(s: DataSourceInfo): Promise<void> {
  saving[s.id] = true;
  try {
    const info = await api.datasource.config(s.id, { ...edits[s.id] });
    replaceSource(info);
    // 明文回填最新值（所见即所存）
    const row: Record<string, string> = {};
    for (const f of info.config) row[f.key] = f.value;
    edits[s.id] = row;
    ElMessage.success(`${s.name} 配置已保存`);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败');
  } finally {
    saving[s.id] = false;
  }
}

const PROTOCOL_LABEL: Record<string, string> = {
  'http-rest': 'HTTP REST',
  'http-jsonp': 'HTTP/JSONP',
  mcp: 'MCP',
  local: '本地',
};

function fmtPct(v: number | null): string {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-title">数据源</div>
      <div class="head-actions">
        <el-button size="small" :loading="loading" @click="load">刷新</el-button>
      </div>
    </div>
    <div class="page-sub">
      所有外部取数统一经此中枢（缓存 / 重试 / 鉴权失效判断 / 调用打点 / 行情自动调度）。点击任一数据源展开，可测试连通、配置凭据（明文）、启停与查看调用统计。
    </div>

    <div v-loading="loading" class="ds-wrap">
      <!-- 顶部状态总览 -->
      <div class="ds-summary">
        <div class="sum-item">
          <span class="sum-v">{{ summary.total }}</span>
          <span class="sum-k">数据源</span>
        </div>
        <div class="sum-item">
          <span class="sum-v ok">{{ summary.enabled }}</span>
          <span class="sum-k">已启用</span>
        </div>
        <div class="sum-item">
          <span class="sum-v ok">{{ summary.ready }}</span>
          <span class="sum-k">凭据就绪</span>
        </div>
        <div class="sum-item">
          <span class="sum-v ok">{{ summary.online }}</span>
          <span class="sum-k">已测在线</span>
        </div>
      </div>

      <!-- 行情调度链路 -->
      <div v-if="routes.length" class="ds-routes">
        <div v-for="r in routes" :key="r.capability" class="route-row">
          <span class="route-label">{{ r.label }}调度</span>
          <span class="route-chain">
            <template v-for="(pid, i) in r.providers" :key="pid">
              <span class="route-node" :class="{ served: pid === r.lastServed }">{{ NAME_BY_ID[pid] ?? pid }}</span>
              <span v-if="i < r.providers.length - 1" class="route-arrow">→</span>
            </template>
            <span v-if="!r.providers.length" class="route-empty">无启用数据源</span>
          </span>
          <span v-if="r.lastServed" class="route-served">当前命中：{{ NAME_BY_ID[r.lastServed] ?? r.lastServed }}</span>
        </div>
      </div>

      <!-- 分组总览列表 -->
      <template v-for="[cat, list] in grouped" :key="cat">
        <div class="cat-label">{{ cat }} · {{ list.length }}</div>
        <div class="ds-list">
          <section v-for="s in list" :key="s.id" class="ds-item" :class="{ open: expanded.has(s.id) }">
            <!-- 总览行（始终可见） -->
            <div class="ds-row" @click="toggleExpand(s.id)">
              <span class="chevron" :class="{ open: expanded.has(s.id) }">›</span>
              <div class="row-name">
                <span class="nm">{{ s.name }}</span>
                <span class="proto">{{ PROTOCOL_LABEL[s.protocol] ?? s.protocol }}</span>
              </div>
              <div class="row-status">
                <span class="dot" :class="s.ready ? 'ok' : 'warn'" :title="s.ready ? '凭据就绪' : '待配置'" />
                <span v-if="!s.enabled" class="badge muted">已禁用</span>
                <span
                  v-if="health[s.id]"
                  class="badge"
                  :class="health[s.id].online ? 'ok' : 'err'"
                >
                  {{ health[s.id].online ? `连通 ${health[s.id].latencyMs}ms` : '不通' }}
                </span>
              </div>
              <div class="row-stats">
                <span class="mini"><span class="mk">请求</span>{{ s.stats.requests }}</span>
                <span class="mini">
                  <span class="mk">错误率</span>
                  <span :class="{ bad: (s.stats.errorRate ?? 0) > 0 }">{{ fmtPct(s.stats.errorRate) }}</span>
                </span>
              </div>
              <div class="row-switch" @click.stop>
                <el-switch
                  v-if="s.toggleable"
                  :model-value="s.enabled"
                  :loading="toggling[s.id]"
                  inline-prompt
                  active-text="开"
                  inactive-text="关"
                  @change="(v: any) => toggle(s, v === true)"
                />
                <span v-else class="always-on" title="该源恒启用，不可关闭">常驻</span>
              </div>
            </div>

            <!-- 展开详情 -->
            <div v-if="expanded.has(s.id)" class="ds-detail">
              <div class="ds-base">{{ s.baseUrl }}</div>
              <div class="ds-desc">{{ s.description }}</div>

              <div
                v-if="health[s.id] && !health[s.id].online && health[s.id].detail"
                class="ds-healtherr"
              >
                {{ health[s.id].detail }}
              </div>

              <!-- 调用统计 -->
              <div class="ds-stats">
                <div class="stat"><span class="k">请求</span><span class="v">{{ s.stats.requests }}</span></div>
                <div class="stat">
                  <span class="k">错误率</span>
                  <span class="v" :class="{ bad: (s.stats.errorRate ?? 0) > 0 }">{{ fmtPct(s.stats.errorRate) }}</span>
                </div>
                <div class="stat"><span class="k">缓存命中</span><span class="v">{{ s.stats.cacheHits }}</span></div>
                <div class="stat"><span class="k">最近调用</span><span class="v">{{ fmtTime(s.stats.lastCallAt) }}</span></div>
              </div>
              <div v-if="s.stats.lastError" class="ds-lasterr">最近错误：{{ s.stats.lastError }}</div>

              <!-- 凭据 / 配置 -->
              <div v-if="s.config.length" class="ds-config">
                <div v-for="f in s.config" :key="f.key" class="cfg-item">
                  <label class="cfg-label">
                    {{ f.label }}
                    <span v-if="f.required" class="req">*</span>
                    <span v-if="f.configured" class="cfg-set">已配置</span>
                  </label>
                  <el-input
                    v-model="edits[s.id][f.key]"
                    :type="isCookieField(f.key) ? 'textarea' : 'text'"
                    :rows="isCookieField(f.key) ? 3 : undefined"
                    size="small"
                    :placeholder="f.placeholder || '未配置'"
                  />
                </div>
              </div>

              <div class="ds-actions">
                <el-button size="small" :loading="healthChecking[s.id]" @click="testHealth(s)">
                  测试连接
                </el-button>
                <el-button
                  v-if="s.config.length"
                  size="small"
                  type="primary"
                  :loading="saving[s.id]"
                  @click="saveConfig(s)"
                >
                  保存配置
                </el-button>
              </div>
            </div>
          </section>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.head-actions {
  margin-left: auto;
}
.page-head {
  display: flex;
  align-items: center;
}
.ds-wrap {
  margin-top: 12px;
}

/* 顶部状态总览 */
.ds-summary {
  display: flex;
  gap: 28px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 18px;
}
.sum-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sum-v {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 600;
  line-height: 1.1;
}
.sum-v.ok {
  color: var(--status-ok);
}
.sum-k {
  font-size: 11px;
  color: var(--text-2);
}

/* 调度链路 */
.ds-routes {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
}
.route-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12.5px;
}
.route-label {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.1em;
  color: var(--text-2);
  min-width: 72px;
}
.route-chain {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.route-node {
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-1);
}
.route-node.served {
  color: var(--status-ok);
  border-color: color-mix(in srgb, var(--status-ok) 45%, transparent);
}
.route-arrow {
  color: var(--text-2);
}
.route-empty {
  color: var(--status-err);
}
.route-served {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--text-2);
}

/* 分组标题 */
.cat-label {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.18em;
  color: var(--text-2);
  margin: 20px 0 8px;
}

/* 列表 */
.ds-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ds-item {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.ds-item.open {
  border-color: color-mix(in srgb, var(--brand) 32%, var(--border));
}

/* 总览行 */
.ds-row {
  display: grid;
  grid-template-columns: 18px minmax(0, 1.4fr) auto minmax(0, 1fr) 64px;
  align-items: center;
  gap: 12px;
  padding: 11px 14px;
  cursor: pointer;
  user-select: none;
}
.ds-row:hover {
  background: color-mix(in srgb, var(--text-1) 4%, transparent);
}
.chevron {
  font-size: 18px;
  line-height: 1;
  color: var(--text-2);
  transition: transform 0.15s ease;
}
.chevron.open {
  transform: rotate(90deg);
  color: var(--brand);
}
.row-name {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.row-name .nm {
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.proto {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.1em;
  color: var(--text-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 5px;
}
.row-status {
  display: flex;
  align-items: center;
  gap: 6px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  flex-shrink: 0;
}
.dot.ok {
  background: var(--status-ok);
}
.dot.warn {
  background: var(--status-warn);
}
.row-stats {
  display: flex;
  gap: 14px;
  justify-content: flex-end;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-1);
}
.mini .mk {
  font-family: var(--font-display);
  font-size: 10.5px;
  color: var(--text-2);
  margin-right: 5px;
}
.mini .bad {
  color: var(--status-err);
}
.row-switch {
  display: flex;
  justify-content: flex-end;
}
.always-on {
  font-size: 10.5px;
  color: var(--text-2);
}

/* 徽章 */
.badge {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-2);
  white-space: nowrap;
}
.badge.ok {
  color: var(--status-ok);
  border-color: color-mix(in srgb, var(--status-ok) 40%, transparent);
  background: color-mix(in srgb, var(--status-ok) 10%, transparent);
}
.badge.err {
  color: var(--status-err);
  border-color: color-mix(in srgb, var(--status-err) 40%, transparent);
  background: color-mix(in srgb, var(--status-err) 10%, transparent);
}
.badge.muted {
  opacity: 0.7;
}

/* 展开详情 */
.ds-detail {
  padding: 0 16px 16px;
  border-top: 1px solid var(--border-soft);
}
.ds-base {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--text-2);
  margin-top: 12px;
  word-break: break-all;
}
.ds-desc {
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-1);
  margin-top: 6px;
}
.ds-healtherr {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--status-err);
  word-break: break-all;
}
.ds-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border-soft);
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.stat .k {
  font-size: 10.5px;
  color: var(--text-2);
}
.stat .v {
  font-family: var(--font-mono);
  font-size: 13px;
}
.stat .v.bad {
  color: var(--status-err);
}
.ds-lasterr {
  margin-top: 6px;
  font-size: 11.5px;
  color: var(--text-2);
  word-break: break-all;
}
.ds-config {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border-soft);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cfg-label {
  display: block;
  font-size: 12px;
  color: var(--text-1);
  margin-bottom: 4px;
}
.cfg-label .req {
  color: var(--status-err);
  margin-left: 2px;
}
.cfg-label .cfg-set {
  margin-left: 6px;
  font-size: 10.5px;
  color: var(--status-ok);
}
.ds-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}
</style>
