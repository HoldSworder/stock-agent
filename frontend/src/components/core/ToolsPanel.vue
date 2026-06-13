<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Search, Refresh, RefreshLeft, CaretRight, Document } from '@element-plus/icons-vue';
import { api } from '@/api';
import type { ToolAvailability, ToolInfo } from '@stock-agent/shared';

// 工具管理（主从式）：左侧分组密集列表（搜索 / 分组筛选 / 快捷启停），右侧详情编辑（启停 / 描述覆盖 / 参数查看）。
// 启停与描述覆盖统一收口在后端 getToolDefinitions，对尾盘 / 持仓 / 计划 / 对话等所有运行全局生效。

const loading = ref(false);
const tools = ref<ToolInfo[]>([]);
const toggling = reactive<Record<string, boolean>>({});
const togglingCore = reactive<Record<string, boolean>>({});
const saving = ref(false);

const keyword = ref('');
const activeGroup = ref<string>('全部');
const selectedName = ref<string | null>(null);

// 选中工具的描述草稿（空串=清除覆盖回落默认）
const descDraft = ref('');
const showParams = ref(false);

const AVAILABILITY_LABEL: Record<ToolAvailability, string> = {
  always: '常驻',
  strategy: '战法',
  strategy_skill: '战法+Skill',
  thinking: '思考',
};

const GROUP_ORDER = ['妙想', '行情持仓', '决策', '研报热点', '计划复盘', 'ETF', '战法', '通知', '推理', '其他'];

function groupRank(g: string): number {
  const i = GROUP_ORDER.indexOf(g);
  return i < 0 ? GROUP_ORDER.length : i;
}

const enabledCount = computed(() => tools.value.filter((t) => t.enabled).length);

// 分组 chip：全部 + 各分组及计数
const groupChips = computed(() => {
  const map = new Map<string, number>();
  for (const t of tools.value) map.set(t.group, (map.get(t.group) ?? 0) + 1);
  const chips = [...map.entries()]
    .sort((a, b) => groupRank(a[0]) - groupRank(b[0]))
    .map(([name, count]) => ({ name, count }));
  return [{ name: '全部', count: tools.value.length }, ...chips];
});

// 搜索（名称 + 生效描述）+ 分组筛选
const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return tools.value.filter((t) => {
    if (activeGroup.value !== '全部' && t.group !== activeGroup.value) return false;
    if (!kw) return true;
    return t.name.toLowerCase().includes(kw) || t.description.toLowerCase().includes(kw);
  });
});

// 过滤后按分组聚合，供左侧列表渲染
const groupedFiltered = computed(() => {
  const map = new Map<string, ToolInfo[]>();
  for (const t of filtered.value) {
    if (!map.has(t.group)) map.set(t.group, []);
    map.get(t.group)!.push(t);
  }
  return [...map.entries()].sort((a, b) => groupRank(a[0]) - groupRank(b[0]));
});

const selected = computed(() => tools.value.find((t) => t.name === selectedName.value) ?? null);

// 草稿与当前生效覆盖是否有差异
const dirty = computed(() => {
  const t = selected.value;
  if (!t) return false;
  const current = t.overridden ? t.description : '';
  return descDraft.value.trim() !== current.trim();
});

function paramsText(t: ToolInfo): string {
  return JSON.stringify(t.parameters, null, 2);
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    tools.value = await api.tools.list();
    // 保持选中（若仍存在），否则默认选首个
    if (!selectedName.value || !tools.value.some((t) => t.name === selectedName.value)) {
      select(tools.value[0] ?? null);
    } else {
      syncDraft();
    }
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

function syncDraft(): void {
  const t = selected.value;
  descDraft.value = t && t.overridden ? t.description : '';
}

function select(t: ToolInfo | null): void {
  selectedName.value = t?.name ?? null;
  showParams.value = false;
  syncDraft();
}

function replaceTool(info: ToolInfo): void {
  const i = tools.value.findIndex((t) => t.name === info.name);
  if (i >= 0) tools.value[i] = info;
  if (info.name === selectedName.value) syncDraft();
}

async function toggle(t: ToolInfo, enabled: boolean): Promise<void> {
  toggling[t.name] = true;
  try {
    replaceTool(await api.tools.config(t.name, { enabled }));
    ElMessage.success(`${t.name} 已${enabled ? '启用' : '禁用'}`);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '切换失败');
  } finally {
    toggling[t.name] = false;
  }
}

async function toggleCore(t: ToolInfo, core: boolean): Promise<void> {
  togglingCore[t.name] = true;
  try {
    replaceTool(await api.tools.config(t.name, { core }));
    ElMessage.success(`${t.name} 已设为${core ? '常驻核心' : '按需检索'}`);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '切换失败');
  } finally {
    togglingCore[t.name] = false;
  }
}

async function saveDesc(): Promise<void> {
  const t = selected.value;
  if (!t) return;
  saving.value = true;
  try {
    replaceTool(await api.tools.config(t.name, { description: descDraft.value }));
    ElMessage.success(`${t.name} 描述已保存`);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

async function restoreDefault(): Promise<void> {
  const t = selected.value;
  if (!t) return;
  saving.value = true;
  try {
    replaceTool(await api.tools.config(t.name, { description: '' }));
    ElMessage.success(`${t.name} 已恢复默认描述`);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '恢复失败');
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="tools-panel">
    <div class="panel-head">
      <div class="panel-sub">
        系统提供给 agent 的全部工具清单。启停与描述覆盖统一收口在 getToolDefinitions，对尾盘 / 持仓 / 计划 / 对话等所有运行全局生效。描述留空即使用代码默认。渐进式披露下，仅「核心」工具初始即加载，其余由模型经 search_tools 按需检索；可逐工具切换核心常驻。
      </div>
      <div class="head-actions">
        <span class="head-stat">{{ enabledCount }} / {{ tools.length }} 启用</span>
        <el-button size="small" :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
      </div>
    </div>

    <!-- 工具栏：搜索 + 分组筛选 -->
    <div class="toolbar">
      <el-input
        v-model="keyword"
        class="search"
        size="small"
        clearable
        :prefix-icon="Search"
        placeholder="搜索工具名 / 描述"
      />
      <div class="chips">
        <button
          v-for="c in groupChips"
          :key="c.name"
          type="button"
          class="chip"
          :class="{ on: activeGroup === c.name }"
          @click="activeGroup = c.name"
        >
          {{ c.name }}<span class="chip-n">{{ c.count }}</span>
        </button>
      </div>
    </div>

    <!-- 主从布局 -->
    <div class="tool-layout">
      <!-- 左：分组密集列表 -->
      <aside class="master">
        <template v-if="loading">
          <div v-for="i in 10" :key="i" class="row-skeleton">
            <el-skeleton :rows="0" animated />
          </div>
        </template>

        <template v-else-if="filtered.length">
          <template v-for="[group, list] in groupedFiltered" :key="group">
            <div class="group-head">
              <span class="group-name">{{ group }}</span>
              <span class="group-count">{{ list.length }}</span>
            </div>
            <button
              v-for="t in list"
              :key="t.name"
              type="button"
              class="tool-row"
              :class="{ active: t.name === selectedName, off: !t.enabled }"
              @click="select(t)"
            >
              <span class="row-main">
                <span class="row-name">{{ t.name }}</span>
                <span class="row-meta">
                  <span v-if="t.core" class="core-badge" title="常驻核心：初始即加载">核心</span>
                  <span class="avail">{{ AVAILABILITY_LABEL[t.availability] }}</span>
                  <span v-if="t.overridden" class="dot-override" title="描述已覆盖" />
                </span>
              </span>
              <el-switch
                :model-value="t.enabled"
                :loading="toggling[t.name]"
                size="small"
                @click.stop
                @change="(v: any) => toggle(t, v === true)"
              />
            </button>
          </template>
        </template>

        <el-empty v-else description="无匹配工具" :image-size="64" />
      </aside>

      <!-- 右：详情编辑 -->
      <section class="detail">
        <Transition name="detail-fade" mode="out-in">
          <div v-if="selected" :key="selected.name" class="detail-body">
            <header class="detail-head">
              <div class="detail-title">
                <span class="detail-name">{{ selected.name }}</span>
                <span class="badge">{{ selected.group }}</span>
                <span class="badge ghost">{{ AVAILABILITY_LABEL[selected.availability] }}</span>
              </div>
              <el-switch
                :model-value="selected.enabled"
                :loading="toggling[selected.name]"
                inline-prompt
                active-text="启用"
                inactive-text="禁用"
                @change="(v: any) => toggle(selected!, v === true)"
              />
            </header>

            <div v-if="!selected.enabled" class="off-note">已禁用，不会下发给 LLM。</div>

            <!-- 渐进式披露：核心常驻开关 -->
            <div class="core-row">
              <div class="core-info">
                <span class="core-title">常驻核心</span>
                <span class="core-desc">
                  {{ selected.core ? '初始即加载，无需 search_tools 检索' : '默认隐藏，由模型按需经 search_tools 检索加载' }}
                </span>
              </div>
              <el-switch
                :model-value="selected.core === true"
                :loading="togglingCore[selected.name]"
                inline-prompt
                active-text="核心"
                inactive-text="按需"
                @change="(v: any) => toggleCore(selected!, v === true)"
              />
            </div>

            <!-- 描述编辑 -->
            <div class="field">
              <div class="field-label">
                <span>描述（下发给 LLM）</span>
                <span v-if="selected.overridden" class="tag-override">已覆盖</span>
              </div>
              <el-input
                v-model="descDraft"
                type="textarea"
                :rows="4"
                :placeholder="selected.baseDescription || '无默认描述'"
              />
              <div class="field-actions">
                <span v-if="dirty" class="dirty-hint">未保存</span>
                <el-button
                  size="small"
                  :icon="RefreshLeft"
                  :disabled="!selected.overridden || saving"
                  @click="restoreDefault"
                >
                  恢复默认
                </el-button>
                <el-button
                  size="small"
                  type="primary"
                  :loading="saving"
                  :disabled="!dirty"
                  @click="saveDesc"
                >
                  保存描述
                </el-button>
              </div>
            </div>

            <!-- 默认描述参考（仅在已覆盖时有对比价值） -->
            <div v-if="selected.overridden && selected.baseDescription" class="ref-default">
              <span class="ref-label">代码默认</span>
              <span class="ref-text">{{ selected.baseDescription }}</span>
            </div>

            <!-- 参数概览 -->
            <div class="params">
              <button class="params-toggle" type="button" @click="showParams = !showParams">
                <el-icon class="ic" :class="{ open: showParams }"><CaretRight /></el-icon>
                <el-icon><Document /></el-icon>
                <span>入参 Schema</span>
              </button>
              <pre v-show="showParams" class="params-code">{{ paramsText(selected) }}</pre>
            </div>
          </div>

          <el-empty v-else description="选择左侧工具查看与编辑" :image-size="80" />
        </Transition>
      </section>
    </div>
  </div>
</template>

<style scoped>
.panel-head {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}
.panel-sub {
  color: var(--text-2);
  font-size: 12.5px;
  line-height: 1.6;
  flex: 1;
}
.head-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 12px;
  flex: none;
}
.head-stat {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-2);
}

/* 工具栏 */
.toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 14px;
  flex-wrap: wrap;
}
.search {
  width: 240px;
  flex: none;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-1);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.chip:hover {
  color: var(--text-0);
  border-color: var(--text-2);
}
.chip.on {
  color: var(--brand);
  border-color: color-mix(in srgb, var(--brand) 55%, transparent);
  background: var(--brand-soft);
}
.chip-n {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-2);
}
.chip.on .chip-n {
  color: var(--brand);
}

/* 主从布局 */
.tool-layout {
  display: grid;
  grid-template-columns: minmax(280px, 360px) 1fr;
  gap: 16px;
  margin-top: 14px;
  align-items: start;
}
.master {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-2);
  overflow: hidden;
  max-height: calc(100vh - 280px);
  overflow-y: auto;
}
.row-skeleton {
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-soft);
}
.group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px 6px;
  position: sticky;
  top: 0;
  background: var(--bg-2);
  z-index: 1;
}
.group-name {
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.16em;
  color: var(--text-2);
}
.group-count {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-2);
  opacity: 0.7;
}
.tool-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 8px 14px 8px 12px;
  border: none;
  border-left: 2px solid transparent;
  border-bottom: 1px solid var(--border-soft);
  background: transparent;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s, border-color 0.15s;
}
.tool-row:hover {
  background: var(--bg-hover);
}
.tool-row.active {
  background: var(--brand-soft);
  border-left-color: var(--brand);
}
.tool-row.off .row-name {
  color: var(--text-2);
}
.tool-row.off {
  opacity: 0.7;
}
.row-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.row-name {
  font-family: var(--font-mono);
  font-size: 12.5px;
  color: var(--text-0);
  word-break: break-all;
}
.row-meta {
  display: flex;
  align-items: center;
  gap: 7px;
}
.avail {
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.08em;
  color: var(--text-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 4px;
}
.dot-override {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--brand);
}
.core-badge {
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.08em;
  color: var(--brand);
  border: 1px solid color-mix(in srgb, var(--brand) 45%, transparent);
  background: var(--brand-soft);
  border-radius: 4px;
  padding: 0 4px;
}

/* 详情面板 */
.detail {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-2);
  padding: 18px 20px;
  min-height: 320px;
}
.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.detail-title {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
}
.detail-name {
  font-family: var(--font-mono);
  font-size: 17px;
  font-weight: 600;
  color: var(--text-0);
  word-break: break-all;
}
.badge {
  font-size: 11px;
  padding: 1px 9px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--brand) 45%, transparent);
  color: var(--brand);
}
.badge.ghost {
  border-color: var(--border);
  color: var(--text-2);
}
.off-note {
  margin-top: 12px;
  font-size: 12px;
  color: var(--text-2);
}

/* 核心常驻开关 */
.core-row {
  margin-top: 14px;
  padding: 10px 12px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-1);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.core-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.core-title {
  font-size: 12.5px;
  color: var(--text-1);
}
.core-desc {
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-2);
}

/* 字段 */
.field {
  margin-top: 18px;
}
.field-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-1);
  margin-bottom: 6px;
}
.tag-override {
  font-size: 10.5px;
  color: var(--brand);
  border: 1px solid color-mix(in srgb, var(--brand) 45%, transparent);
  border-radius: 4px;
  padding: 0 5px;
}
.field-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}
.dirty-hint {
  margin-right: auto;
  font-size: 11.5px;
  color: var(--brand-2);
  font-family: var(--font-mono);
}

/* 默认描述参考 */
.ref-default {
  margin-top: 14px;
  padding: 10px 12px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-1);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ref-label {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  color: var(--text-2);
}
.ref-text {
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--text-1);
}

/* 参数 */
.params {
  margin-top: 16px;
}
.params-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-1);
}
.params-toggle:hover {
  color: var(--text-0);
}
.params-toggle .ic {
  transition: transform 0.18s;
}
.params-toggle .ic.open {
  transform: rotate(90deg);
}
.params-code {
  margin: 8px 0 0;
  padding: 10px 12px;
  background: var(--bg-1);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.55;
  color: var(--text-1);
  max-height: 300px;
  overflow: auto;
  white-space: pre;
}

/* 详情切换动效 */
.detail-fade-enter-active,
.detail-fade-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.detail-fade-enter-from {
  opacity: 0;
  transform: translateY(4px);
}
.detail-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* 响应式：窄屏单列 */
@media (max-width: 860px) {
  .tool-layout {
    grid-template-columns: 1fr;
  }
  .master {
    max-height: 320px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .chip,
  .tool-row,
  .params-toggle .ic,
  .detail-fade-enter-active,
  .detail-fade-leave-active {
    transition: none;
  }
}
</style>
