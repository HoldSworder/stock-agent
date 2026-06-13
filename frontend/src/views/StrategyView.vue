<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import dayjs from 'dayjs';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus, Refresh } from '@element-plus/icons-vue';
import { api, openWs } from '@/api';
import TaskEditDialog from '@/components/TaskEditDialog.vue';
import RunResultDrawer from '@/components/RunResultDrawer.vue';
import type {
  ScheduledTask,
  SkillDimension,
  StrategyKind,
  StrategyListItem,
  StrategySkill,
  StrategySkillView,
  StrategySnapshot,
  StreamEvent,
  TaskRun,
} from '@stock-agent/shared';

const list = ref<StrategyListItem[]>([]);
const listLoading = ref(false);
const selectedId = ref<string | null>(null);
const snap = ref<StrategySnapshot | null>(null);
const snapLoading = ref(false);

// 详情区 Tab：持仓 / 成交流水 / 关联定时任务
const activeTab = ref('positions');

// 关联定时任务（全量任务/运行，按当前战法过滤展示）
const tasks = ref<ScheduledTask[]>([]);
const runs = ref<TaskRun[]>([]);
const strategyTasks = computed(() =>
  tasks.value.filter((t) => t.strategyId === selectedId.value),
);

// 每日产出：该战法绑定任务的历史运行，按上海日期倒序分组
const dailyRuns = ref<TaskRun[]>([]);
const dailyLoading = ref(false);
const shDate = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
const dailyGroups = computed(() => {
  const map = new Map<string, TaskRun[]>();
  for (const r of dailyRuns.value) {
    const d = shDate(r.startedAt);
    (map.get(d) ?? map.set(d, []).get(d)!).push(r);
  }
  return Array.from(map.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, items]) => ({ date, items }));
});
// 默认展开最近一天；后续保留用户手动展开状态
const openDays = ref<string[]>([]);
watch(dailyGroups, (groups) => {
  if (groups.length && !openDays.value.length) openDays.value = [groups[0].date];
});

const money = (v: number) =>
  v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (v: number) => (v >= 0 ? '+' : '') + money(v);
const pct = (v: number) => (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
// A股 红涨绿跌：盈利为正 -> up(红)，亏损 -> down(绿)
const dir = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

async function loadList() {
  listLoading.value = true;
  try {
    list.value = await api.listStrategies();
    if (!selectedId.value && list.value.length) {
      void select(list.value[0].strategy.id);
    } else if (selectedId.value && !list.value.some((s) => s.strategy.id === selectedId.value)) {
      selectedId.value = null;
      snap.value = null;
    }
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    listLoading.value = false;
  }
}

async function loadSnap() {
  if (!selectedId.value) return;
  snapLoading.value = true;
  try {
    snap.value = await api.getStrategy(selectedId.value);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    snapLoading.value = false;
  }
}

async function loadTasks() {
  tasks.value = await api.listTasks();
}
async function loadRuns() {
  runs.value = await api.listRuns();
}
async function loadDaily() {
  if (!selectedId.value) return;
  dailyLoading.value = true;
  try {
    dailyRuns.value = await api.getStrategyDailyOutput(selectedId.value);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    dailyLoading.value = false;
  }
}

async function select(id: string) {
  selectedId.value = id;
  await Promise.all([loadSnap(), loadTasks(), loadRuns(), loadDaily()]);
  await loadSkills();
}

async function refreshAll() {
  await Promise.all([loadList(), loadSnap(), loadTasks(), loadRuns(), loadDaily()]);
  await loadSkills();
}

const kindLabel = (k: StrategyKind) => (k === 'miaoxiang' ? '妙想镜像' : '本地虚拟');

// ===== 新建战法 =====
const createVisible = ref(false);
const createForm = ref<{
  name: string;
  description: string;
  initialCapital: number;
  kind: StrategyKind;
  skillEnabled: boolean;
}>({ name: '', description: '', initialCapital: 100000, kind: 'local', skillEnabled: true });
const creating = ref(false);

function openCreate() {
  createForm.value = {
    name: '',
    description: '',
    initialCapital: 100000,
    kind: 'local',
    skillEnabled: true,
  };
  createVisible.value = true;
}

async function submitCreate() {
  if (!createForm.value.name.trim()) return ElMessage.warning('请输入战法名称');
  creating.value = true;
  try {
    const s = await api.createStrategy({
      name: createForm.value.name.trim(),
      description: createForm.value.description.trim() || null,
      initialCapital: Number(createForm.value.initialCapital),
      kind: createForm.value.kind,
      skillEnabled: createForm.value.skillEnabled,
    });
    createVisible.value = false;
    ElMessage.success('已创建战法');
    await loadList();
    await select(s.id);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    creating.value = false;
  }
}

// ===== 编辑战法（名称/描述/Skill 开关；kind 与初始资金锁定）=====
const editVisible = ref(false);
const editForm = ref<{ name: string; description: string; skillEnabled: boolean }>({
  name: '',
  description: '',
  skillEnabled: false,
});
const editing = ref(false);

function openEdit() {
  if (!snap.value) return;
  editForm.value = {
    name: snap.value.strategy.name,
    description: snap.value.strategy.description ?? '',
    skillEnabled: !!snap.value.strategy.skillEnabled,
  };
  editVisible.value = true;
}

async function submitEdit() {
  if (!selectedId.value) return;
  if (!editForm.value.name.trim()) return ElMessage.warning('请输入战法名称');
  editing.value = true;
  try {
    await api.updateStrategy(selectedId.value, {
      name: editForm.value.name.trim(),
      description: editForm.value.description.trim() || null,
      skillEnabled: editForm.value.skillEnabled,
    });
    editVisible.value = false;
    ElMessage.success('已保存');
    await refreshAll();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    editing.value = false;
  }
}

async function removeStrategy(id: string, name: string) {
  try {
    await ElMessageBox.confirm(`确认归档战法【${name}】？历史流水保留，列表将不再展示。`, '归档战法', {
      type: 'warning',
    });
  } catch {
    return;
  }
  try {
    await api.deleteStrategy(id);
    if (selectedId.value === id) {
      selectedId.value = null;
      snap.value = null;
    }
    ElMessage.success('已归档');
    await loadList();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

// ===== 手动买/卖 =====
const tradeVisible = ref(false);
const tradeForm = ref<{
  side: 'buy' | 'sell';
  code: string;
  qty: number;
  price: string;
  reason: string;
  thesis: string;
  force: boolean;
}>({
  side: 'buy',
  code: '',
  qty: 100,
  price: '',
  reason: '',
  thesis: '',
  force: false,
});
const trading = ref(false);

function openTrade(side: 'buy' | 'sell') {
  tradeForm.value = { side, code: '', qty: 100, price: '', reason: '', thesis: '', force: false };
  tradeVisible.value = true;
}

async function submitTrade() {
  if (!selectedId.value) return;
  if (!/^\d{6}$/.test(tradeForm.value.code.trim())) return ElMessage.warning('请输入 6 位股票代码');
  if (tradeForm.value.qty % 100 !== 0) return ElMessage.warning('数量必须为 100 股的整数倍');
  trading.value = true;
  try {
    const priceStr = tradeForm.value.price.trim();
    const t = await api.simTrade(selectedId.value, {
      side: tradeForm.value.side,
      code: tradeForm.value.code.trim(),
      qty: Number(tradeForm.value.qty),
      price: priceStr ? Number(priceStr) : null,
      reason: tradeForm.value.reason.trim() || null,
      thesis: tradeForm.value.thesis.trim() || null,
      force: tradeForm.value.force,
    });
    tradeVisible.value = false;
    ElMessage.success(
      `模拟${t.side === 'buy' ? '买入' : '卖出'}成功：${t.name} ${t.qty}股 @${t.price}`,
    );
    await refreshAll();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    trading.value = false;
  }
}

// ===== 一键运行 agent =====
const runVisible = ref(false);
const runPrompt = ref('');
const running = ref(false);
const runResult = ref('');

function openRun() {
  runPrompt.value =
    '按本战法逻辑选股并执行模拟买卖：先用 sim_positions 查当前持仓与现金，再据行情给出操作并用 sim_trade 落单，最后小结本次操作与依据。';
  runResult.value = '';
  runVisible.value = true;
}

async function submitRun() {
  if (!selectedId.value) return;
  if (!runPrompt.value.trim()) return ElMessage.warning('请输入运行指令');
  running.value = true;
  runResult.value = '';
  try {
    const r = await api.runStrategy(selectedId.value, runPrompt.value.trim());
    runResult.value = r.text || '(无文本输出)';
    ElMessage.success('运行完成');
    await refreshAll();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    running.value = false;
  }
}

const currentName = computed(() => snap.value?.strategy.name ?? '');
const isMiaoxiang = computed(() => snap.value?.strategy.kind === 'miaoxiang');

// ===== 妙想镜像同步 =====
const syncing = ref(false);

async function doSync() {
  if (!selectedId.value) return;
  syncing.value = true;
  try {
    snap.value = await api.syncStrategy(selectedId.value);
    ElMessage.success('已同步妙想模拟盘');
    await loadList();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    syncing.value = false;
  }
}

// ===== 重置账户（仅本地战法）=====
const resetting = ref(false);

async function doReset() {
  if (!selectedId.value) return;
  try {
    await ElMessageBox.confirm(
      `确认重置战法【${currentName.value}】账户？将清空全部持仓与成交流水，现金回到初始资金，此操作不可撤销。`,
      '重置账户',
      { type: 'warning' },
    );
  } catch {
    return;
  }
  resetting.value = true;
  try {
    snap.value = await api.resetStrategy(selectedId.value);
    ElMessage.success('已重置账户');
    await refreshAll();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    resetting.value = false;
  }
}

// ===== 关联定时任务管理 =====
const taskDialog = ref(false);
const editingTask = ref<ScheduledTask | null>(null);
const runDrawer = ref(false);
const activeRun = ref<TaskRun | null>(null);
// 触发后自动打开运行抽屉（消费下一个 run_started）
const autoOpenRun = ref(false);

/** 某任务是否有正在运行的 run（状态点） */
function taskRunning(taskId: string): boolean {
  return runs.value.some((r) => r.taskId === taskId && r.status === 'running');
}
/** 某任务最近一次运行（点击查看） */
function latestRun(taskId: string): TaskRun | null {
  return runs.value.find((r) => r.taskId === taskId) ?? null;
}

function openCreateTask() {
  editingTask.value = null;
  taskDialog.value = true;
}
function openEditTask(t: ScheduledTask) {
  editingTask.value = t;
  taskDialog.value = true;
}
async function toggleTask(t: ScheduledTask) {
  try {
    await api.updateTask(t.id, { enabled: !t.enabled });
    await loadTasks();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}
async function triggerTask(t: ScheduledTask, forceTrade = false) {
  if (forceTrade) {
    try {
      await ElMessageBox.confirm(
        `确认按收盘价触发「${t.name}」？将放开 A 股交易时段校验，sim_trade 以当前（收盘后）现价强制成交。`,
        '收盘价触发',
        { type: 'warning' },
      );
    } catch {
      return;
    }
  }
  try {
    await api.triggerTask(t.id, { forceTrade });
    autoOpenRun.value = true;
    ElMessage.success('已触发，正在打开运行进度');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}
async function removeTask(t: ScheduledTask) {
  try {
    await ElMessageBox.confirm(`确认删除任务「${t.name}」？`, '确认', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await api.deleteTask(t.id);
    ElMessage.success('已删除');
    await loadTasks();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}
function openTaskRun(t: ScheduledTask) {
  const r = latestRun(t.id);
  if (!r) return ElMessage.info('该任务暂无运行记录');
  activeRun.value = r;
  runDrawer.value = true;
}
function openDailyRun(r: TaskRun) {
  activeRun.value = r;
  runDrawer.value = true;
}
const runStatusType = (s: string) =>
  s === 'success' ? 'success' : s === 'running' ? 'warning' : 'danger';
const runStatusLabel = (s: string) =>
  s === 'success' ? '成功' : s === 'running' ? '运行中' : s === 'timeout' ? '超时' : '失败';

const fmtTask = (s?: string | null) => (s ? dayjs(s).format('MM-DD HH:mm') : '-');

// ===== 战法 Skill 自迭代 =====
const skillView = ref<StrategySkillView | null>(null);
const skillLoading = ref(false);
const DIMENSIONS: SkillDimension[] = ['pick', 'buy', 'sell'];
const dimLabel = (d: SkillDimension) =>
  d === 'pick' ? '选股规则' : d === 'buy' ? '买入规则' : '卖出规则';

const skillEnabled = computed(() => !!snap.value?.strategy.skillEnabled);
const pendingCount = computed(() => skillView.value?.proposals.length ?? 0);

async function loadSkills() {
  if (!selectedId.value || !skillEnabled.value) {
    skillView.value = null;
    if (activeTab.value === 'skill') activeTab.value = 'positions';
    return;
  }
  skillLoading.value = true;
  try {
    skillView.value = await api.getStrategySkills(selectedId.value);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    skillLoading.value = false;
  }
}

/** 提案对应维度的当前 active 内容（用于 diff 对照） */
function activeContent(d: SkillDimension): string {
  return skillView.value?.active[d]?.content ?? '';
}

async function approveProposal(p: StrategySkill) {
  if (!selectedId.value) return;
  try {
    skillView.value = await api.approveSkillProposal(selectedId.value, p.id);
    ElMessage.success(`已采用新的${dimLabel(p.dimension)}`);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

async function rejectProposal(p: StrategySkill) {
  if (!selectedId.value) return;
  try {
    skillView.value = await api.rejectSkillProposal(selectedId.value, p.id);
    ElMessage.success('已驳回提案');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

async function approveAll() {
  if (!selectedId.value || !skillView.value) return;
  try {
    await ElMessageBox.confirm(`确认通过全部 ${pendingCount.value} 条提案？`, '全部通过', {
      type: 'warning',
    });
  } catch {
    return;
  }
  for (const p of [...skillView.value.proposals]) {
    try {
      skillView.value = await api.approveSkillProposal(selectedId.value, p.id);
    } catch (e) {
      ElMessage.error(e instanceof Error ? e.message : String(e));
    }
  }
  ElMessage.success('已处理全部提案');
}

async function rollback(d: SkillDimension, version: number) {
  if (!selectedId.value) return;
  try {
    await ElMessageBox.confirm(`确认将${dimLabel(d)}回滚至 v${version}？将生成一个新的生效版本。`, '回滚', {
      type: 'warning',
    });
  } catch {
    return;
  }
  try {
    skillView.value = await api.rollbackSkill(selectedId.value, d, version);
    ElMessage.success(`已回滚${dimLabel(d)}至 v${version}`);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

// 手动编辑 Skill
const skillEditVisible = ref(false);
const skillEditForm = ref<{ dimension: SkillDimension; content: string; reason: string }>({
  dimension: 'pick',
  content: '',
  reason: '',
});
const skillSaving = ref(false);

function openSkillEdit(d: SkillDimension) {
  skillEditForm.value = { dimension: d, content: activeContent(d), reason: '' };
  skillEditVisible.value = true;
}

async function submitSkillEdit() {
  if (!selectedId.value) return;
  if (!skillEditForm.value.content.trim()) return ElMessage.warning('内容不能为空');
  skillSaving.value = true;
  try {
    skillView.value = await api.updateSkill(
      selectedId.value,
      skillEditForm.value.dimension,
      skillEditForm.value.content.trim(),
      skillEditForm.value.reason.trim() || undefined,
    );
    skillEditVisible.value = false;
    ElMessage.success('已保存为新版本');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    skillSaving.value = false;
  }
}

let ws: WebSocket | null = null;

onMounted(() => {
  loadList();
  ws = openWs('/ws/runs');
  ws.onmessage = async (ev) => {
    const e: StreamEvent = JSON.parse(ev.data);
    if (e.type === 'run_started') {
      await loadRuns();
      if (autoOpenRun.value) {
        const r = runs.value.find((x) => x.id === e.runId);
        if (r) {
          activeRun.value = r;
          runDrawer.value = true;
        }
        autoOpenRun.value = false;
      }
    } else if (e.type === 'run_finished') {
      loadRuns();
      loadTasks();
      loadDaily();
      loadSkills();
    }
  };
});
onUnmounted(() => ws?.close());
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-title">战法模拟</div>
      <div class="head-actions">
        <el-button :icon="Plus" type="primary" @click="openCreate">新建战法</el-button>
        <el-button :icon="Refresh" :loading="listLoading || snapLoading" @click="refreshAll">
          刷新
        </el-button>
      </div>
    </div>
    <div class="page-sub">
      每个战法是独立的本地虚拟账户，买卖仅记录在本系统（不下真实/妙想单），强制涨跌停/100股/T+1/资金校验。
    </div>

    <div class="layout">
      <!-- 左：战法列表 -->
      <aside class="side">
        <div
          v-for="it in list"
          :key="it.strategy.id"
          class="sc"
          :class="{ active: it.strategy.id === selectedId }"
          @click="select(it.strategy.id)"
        >
          <div class="sc-name">
            {{ it.strategy.name }}
            <el-tag
              :type="it.strategy.kind === 'miaoxiang' ? 'warning' : 'info'"
              size="small"
              effect="plain"
            >
              {{ kindLabel(it.strategy.kind) }}
            </el-tag>
          </div>
          <div v-if="it.strategy.description" class="sc-desc">{{ it.strategy.description }}</div>
          <div class="sc-row">
            <span class="sc-label">总资产</span>
            <span class="num">{{ money(it.totalAsset) }}</span>
          </div>
          <div class="sc-row">
            <span class="sc-label">收益</span>
            <span class="num" :class="dir(it.totalProfit)">
              {{ signed(it.totalProfit) }} ({{ pct(it.totalProfitRate) }})
            </span>
          </div>
          <div class="sc-foot">
            <span class="num sub">{{ it.positionCount }} 持仓</span>
            <el-button
              link
              type="info"
              size="small"
              @click.stop="removeStrategy(it.strategy.id, it.strategy.name)"
            >
              归档
            </el-button>
          </div>
        </div>
        <el-empty v-if="!listLoading && !list.length" description="还没有战法，点右上角新建" />
      </aside>

      <!-- 右：选中战法详情 -->
      <section class="main" v-loading="snapLoading">
        <template v-if="snap">
          <div class="detail-head">
            <div>
              <div class="detail-name">
                {{ currentName }}
                <el-tag
                  :type="isMiaoxiang ? 'warning' : 'info'"
                  size="small"
                  effect="plain"
                >
                  {{ kindLabel(snap.strategy.kind) }}
                </el-tag>
              </div>
              <div v-if="snap.strategy.description" class="detail-desc">
                {{ snap.strategy.description }}
              </div>
              <div v-if="isMiaoxiang" class="detail-desc">
                最近同步：{{ snap.strategy.syncedAt ? dayjs(snap.strategy.syncedAt).format('MM-DD HH:mm:ss') : '未同步' }}
              </div>
            </div>
            <div class="detail-actions">
              <template v-if="isMiaoxiang">
                <el-button type="primary" plain :loading="syncing" :icon="Refresh" @click="doSync">
                  同步妙想
                </el-button>
              </template>
              <template v-else>
                <el-button type="danger" plain @click="openTrade('buy')">买入</el-button>
                <el-button type="success" plain @click="openTrade('sell')">卖出</el-button>
                <el-button type="warning" plain :loading="resetting" @click="doReset">
                  重置账户
                </el-button>
              </template>
              <el-button @click="openRun">一键运行</el-button>
              <el-button @click="openEdit">编辑</el-button>
            </div>
          </div>

          <div class="cards">
            <div class="card">
              <div class="card-label">总资产</div>
              <div class="card-value num">{{ money(snap.totalAsset) }}</div>
            </div>
            <div class="card">
              <div class="card-label">初始资金</div>
              <div class="card-value num">{{ money(snap.strategy.initialCapital) }}</div>
            </div>
            <div class="card">
              <div class="card-label">可用现金</div>
              <div class="card-value num">{{ money(snap.strategy.cash) }}</div>
            </div>
            <div class="card">
              <div class="card-label">持仓市值</div>
              <div class="card-value num">{{ money(snap.totalMarketValue) }}</div>
            </div>
            <div class="card">
              <div class="card-label">总收益</div>
              <div class="card-value num" :class="dir(snap.totalProfit)">
                {{ signed(snap.totalProfit) }}
                <span class="sub">{{ pct(snap.totalProfitRate) }}</span>
              </div>
            </div>
          </div>

          <el-tabs v-model="activeTab" class="detail-tabs">
          <el-tab-pane name="positions">
            <template #label>
              持仓
              <el-badge
                :value="snap.positions.length"
                :hidden="!snap.positions.length"
                type="info"
                class="tab-badge"
              />
            </template>
          <el-table :data="snap.positions" stripe style="width: 100%" max-height="440">
            <el-table-column label="代码" width="92">
              <template #default="{ row }"><span class="num">{{ row.code }}</span></template>
            </el-table-column>
            <el-table-column prop="name" label="名称" min-width="100" />
            <el-table-column label="现价" min-width="84" align="right">
              <template #default="{ row }"><span class="num">{{ row.price }}</span></template>
            </el-table-column>
            <el-table-column label="成本" min-width="84" align="right">
              <template #default="{ row }"><span class="num">{{ row.avgCost.toFixed(3) }}</span></template>
            </el-table-column>
            <el-table-column label="持仓 / 可卖" min-width="110" align="right">
              <template #default="{ row }">
                <span class="num">{{ row.qty }}</span>
                <span class="num sub"> / {{ row.sellableQty }}</span>
              </template>
            </el-table-column>
            <el-table-column label="市值" min-width="110" align="right">
              <template #default="{ row }"><span class="num">{{ money(row.marketValue) }}</span></template>
            </el-table-column>
            <el-table-column label="浮动盈亏" min-width="140" align="right">
              <template #default="{ row }">
                <span class="num" :class="dir(row.holdProfit)">{{ signed(row.holdProfit) }}</span>
                <span class="num sub" :class="dir(row.holdRate)"> {{ pct(row.holdRate) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="仓位" min-width="78" align="right">
              <template #default="{ row }"><span class="num">{{ (row.positionRate * 100).toFixed(1) }}%</span></template>
            </el-table-column>
            <el-table-column label="持有逻辑" min-width="160" show-overflow-tooltip>
              <template #default="{ row }">
                <span v-if="row.thesis">{{ row.thesis }}</span>
                <span v-else class="sub">—</span>
              </template>
            </el-table-column>
            <template #empty>暂无持仓</template>
          </el-table>
          </el-tab-pane>

          <el-tab-pane name="trades">
            <template #label>
              成交流水
              <el-badge
                :value="snap.trades.length"
                :hidden="!snap.trades.length"
                type="info"
                class="tab-badge"
              />
            </template>
          <el-table :data="snap.trades" stripe style="width: 100%" max-height="440">
            <el-table-column label="时间" min-width="140">
              <template #default="{ row }">
                <span class="num sub">{{ dayjs(row.createdAt).format('MM-DD HH:mm') }}</span>
              </template>
            </el-table-column>
            <el-table-column label="方向" width="70">
              <template #default="{ row }">
                <el-tag :type="row.side === 'buy' ? 'danger' : 'success'" size="small" effect="plain">
                  {{ row.side === 'buy' ? '买入' : '卖出' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="标的" min-width="120">
              <template #default="{ row }">
                {{ row.name }}<span class="num sub"> {{ row.code }}</span>
              </template>
            </el-table-column>
            <el-table-column label="数量" min-width="80" align="right">
              <template #default="{ row }"><span class="num">{{ row.qty }}</span></template>
            </el-table-column>
            <el-table-column label="成交价" min-width="84" align="right">
              <template #default="{ row }"><span class="num">{{ row.price }}</span></template>
            </el-table-column>
            <el-table-column label="金额" min-width="110" align="right">
              <template #default="{ row }"><span class="num">{{ money(row.amount) }}</span></template>
            </el-table-column>
            <el-table-column label="已实现盈亏" min-width="110" align="right">
              <template #default="{ row }">
                <span v-if="row.realizedProfit != null" class="num" :class="dir(row.realizedProfit)">
                  {{ signed(row.realizedProfit) }}
                </span>
                <span v-else class="sub">—</span>
              </template>
            </el-table-column>
            <el-table-column label="来源" width="72">
              <template #default="{ row }"><span class="num sub">{{ row.source }}</span></template>
            </el-table-column>
            <el-table-column label="操作原因" min-width="160" show-overflow-tooltip>
              <template #default="{ row }">
                <span v-if="row.reason">{{ row.reason }}</span>
                <span v-else class="sub">—</span>
              </template>
            </el-table-column>
            <template #empty>暂无成交</template>
          </el-table>
          </el-tab-pane>

          <el-tab-pane name="tasks">
            <template #label>
              关联任务
              <el-badge
                :value="strategyTasks.length"
                :hidden="!strategyTasks.length"
                type="info"
                class="tab-badge"
              />
            </template>
          <div class="pane-toolbar">
            <el-button size="small" :icon="Plus" @click="openCreateTask">新建任务</el-button>
          </div>
          <el-table :data="strategyTasks" stripe style="width: 100%" max-height="440">
            <el-table-column label="任务" min-width="180">
              <template #default="{ row }">
                <span v-if="taskRunning(row.id)" class="run-dot" />
                {{ row.name }}
              </template>
            </el-table-column>
            <el-table-column label="Cron" min-width="120">
              <template #default="{ row }">
                <span class="num sub">{{ row.cronExpr || '手动' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="下次运行" min-width="120">
              <template #default="{ row }">
                <span class="num sub">{{ fmtTask(row.nextRunAt) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="启用" width="70" align="center">
              <template #default="{ row }">
                <el-switch :model-value="row.enabled" size="small" @change="toggleTask(row)" />
              </template>
            </el-table-column>
            <el-table-column label="操作" min-width="260" align="right">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click="triggerTask(row)">触发</el-button>
                <el-button
                  v-if="!isMiaoxiang"
                  link
                  type="warning"
                  size="small"
                  @click="triggerTask(row, true)"
                >
                  收盘价触发
                </el-button>
                <el-button link size="small" @click="openTaskRun(row)">运行</el-button>
                <el-button link size="small" @click="openEditTask(row)">编辑</el-button>
                <el-button link type="danger" size="small" @click="removeTask(row)">删除</el-button>
              </template>
            </el-table-column>
            <template #empty>该战法暂无关联定时任务，点右上「新建任务」</template>
          </el-table>
          </el-tab-pane>

          <el-tab-pane name="daily">
            <template #label>
              每日产出
              <el-badge
                :value="dailyGroups.length"
                :hidden="!dailyGroups.length"
                type="info"
                class="tab-badge"
              />
            </template>
            <div v-loading="dailyLoading">
              <el-collapse v-if="dailyGroups.length" v-model="openDays">
                <el-collapse-item
                  v-for="g in dailyGroups"
                  :key="g.date"
                  :name="g.date"
                  :title="`${g.date}（${g.items.length} 次运行）`"
                >
                  <div v-for="r in g.items" :key="r.id" class="daily-run" @click="openDailyRun(r)">
                    <div class="daily-run-head">
                      <span class="daily-run-name">{{ r.taskName || '(未命名任务)' }}</span>
                      <el-tag :type="runStatusType(r.status)" size="small" effect="plain">
                        {{ runStatusLabel(r.status) }}
                      </el-tag>
                      <span class="num sub">{{ dayjs(r.startedAt).format('HH:mm') }}</span>
                    </div>
                    <pre class="daily-run-output">{{
                      r.status === 'success'
                        ? r.outputText || '(无文本输出)'
                        : r.error || '(运行未成功，无输出)'
                    }}</pre>
                  </div>
                </el-collapse-item>
              </el-collapse>
              <el-empty v-else-if="!dailyLoading" description="该战法暂无定时任务运行产出" />
            </div>
          </el-tab-pane>

          <el-tab-pane v-if="skillEnabled" name="skill">
            <template #label>
              Skill
              <el-badge
                :value="pendingCount"
                :hidden="!pendingCount"
                type="danger"
                class="tab-badge"
              />
            </template>
            <div v-loading="skillLoading">
              <!-- 待确认提案 -->
              <div v-if="pendingCount" class="skill-block">
                <div class="skill-block-head">
                  <span class="skill-block-title">待确认提案（{{ pendingCount }}）</span>
                  <el-button size="small" type="primary" @click="approveAll">全部通过</el-button>
                </div>
                <div v-for="p in skillView?.proposals" :key="p.id" class="proposal">
                  <div class="proposal-head">
                    <el-tag size="small" type="warning" effect="plain">{{ dimLabel(p.dimension) }}</el-tag>
                    <span class="proposal-reason">{{ p.reason || '（未填写理由）' }}</span>
                    <span class="num sub">{{ dayjs(p.createdAt).format('MM-DD HH:mm') }}</span>
                  </div>
                  <div class="diff">
                    <div class="diff-col">
                      <div class="diff-label">当前生效 v{{ skillView?.active[p.dimension]?.version ?? '-' }}</div>
                      <pre class="diff-text old">{{ activeContent(p.dimension) || '（无）' }}</pre>
                    </div>
                    <div class="diff-col">
                      <div class="diff-label">提案内容</div>
                      <pre class="diff-text new">{{ p.content }}</pre>
                    </div>
                  </div>
                  <div class="proposal-actions">
                    <el-button size="small" type="success" plain @click="approveProposal(p)">通过</el-button>
                    <el-button size="small" type="danger" plain @click="rejectProposal(p)">驳回</el-button>
                  </div>
                </div>
              </div>

              <!-- 三维度现行打法 + 历史 -->
              <div v-for="d in DIMENSIONS" :key="d" class="skill-block">
                <div class="skill-block-head">
                  <span class="skill-block-title">
                    {{ dimLabel(d) }}
                    <span v-if="skillView?.active[d]" class="num sub">v{{ skillView?.active[d]?.version }}</span>
                  </span>
                  <el-button size="small" @click="openSkillEdit(d)">编辑</el-button>
                </div>
                <pre class="skill-content">{{ activeContent(d) || '（暂无内容，点「编辑」设定）' }}</pre>
                <el-collapse v-if="(skillView?.history[d]?.length ?? 0) > 1" class="skill-history">
                  <el-collapse-item :title="`历史版本（${skillView?.history[d]?.length ?? 0}）`">
                    <div
                      v-for="h in skillView?.history[d]"
                      :key="h.id"
                      class="history-row"
                    >
                      <div class="history-meta">
                        <el-tag
                          size="small"
                          :type="h.status === 'active' ? 'success' : 'info'"
                          effect="plain"
                        >
                          v{{ h.version }}{{ h.status === 'active' ? ' · 生效中' : '' }}
                        </el-tag>
                        <span class="num sub">{{ dayjs(h.createdAt).format('MM-DD HH:mm') }}</span>
                        <span class="sub">{{ h.reason || '' }}</span>
                        <el-button
                          v-if="h.status !== 'active'"
                          link
                          type="primary"
                          size="small"
                          @click="rollback(d, h.version)"
                        >
                          回滚至此
                        </el-button>
                      </div>
                      <pre class="diff-text">{{ h.content }}</pre>
                    </div>
                  </el-collapse-item>
                </el-collapse>
              </div>
            </div>
          </el-tab-pane>
          </el-tabs>
        </template>
        <el-empty v-else-if="!snapLoading" description="选择左侧战法查看详情" />
      </section>
    </div>

    <!-- 新建战法 -->
    <el-dialog v-model="createVisible" title="新建战法" width="440px">
      <el-form label-width="80px">
        <el-form-item label="名称">
          <el-input v-model="createForm.name" placeholder="如：尾盘动能套利" maxlength="40" />
        </el-form-item>
        <el-form-item label="类型">
          <el-radio-group v-model="createForm.kind">
            <el-radio-button value="local">本地虚拟</el-radio-button>
            <el-radio-button value="miaoxiang">妙想镜像</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="描述">
          <el-input
            v-model="createForm.description"
            type="textarea"
            :rows="2"
            placeholder="战法逻辑简述（可选）"
          />
        </el-form-item>
        <el-form-item label="初始资金">
          <el-input-number v-model="createForm.initialCapital" :min="1000" :step="10000" :controls="false" style="width: 100%" />
        </el-form-item>
        <el-form-item label="Skill 自迭代">
          <el-switch v-model="createForm.skillEnabled" />
          <span class="form-tip">开启后复盘时 agent 可提议调整选股/买入/卖出打法（需你确认才生效）</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>

    <!-- 编辑战法 -->
    <el-dialog v-model="editVisible" :title="`编辑战法 · ${currentName}`" width="440px">
      <el-form label-width="80px">
        <el-form-item label="名称">
          <el-input v-model="editForm.name" placeholder="战法名称" maxlength="40" />
        </el-form-item>
        <el-form-item label="类型">
          <el-tag :type="isMiaoxiang ? 'warning' : 'info'" size="small" effect="plain">
            {{ snap ? kindLabel(snap.strategy.kind) : '' }}
          </el-tag>
          <span class="form-tip">类型不可修改</span>
        </el-form-item>
        <el-form-item label="描述">
          <el-input
            v-model="editForm.description"
            type="textarea"
            :rows="2"
            placeholder="战法逻辑简述（可选）"
          />
        </el-form-item>
        <el-form-item label="初始资金">
          <span class="num">{{ snap ? money(snap.strategy.initialCapital) : '' }}</span>
          <span class="form-tip">初始资金不可修改</span>
        </el-form-item>
        <el-form-item label="Skill 自迭代">
          <el-switch v-model="editForm.skillEnabled" />
          <span class="form-tip">开启后复盘时 agent 可提议调整选股/买入/卖出打法（需你确认才生效）</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="editing" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 手动编辑 Skill -->
    <el-dialog
      v-model="skillEditVisible"
      :title="`编辑${dimLabel(skillEditForm.dimension)} · ${currentName}`"
      width="560px"
    >
      <el-input
        v-model="skillEditForm.content"
        type="textarea"
        :rows="10"
        placeholder="该维度的完整规则文本"
      />
      <el-input
        v-model="skillEditForm.reason"
        placeholder="变更理由（可选）"
        style="margin-top: 10px"
      />
      <template #footer>
        <el-button @click="skillEditVisible = false">取消</el-button>
        <el-button type="primary" :loading="skillSaving" @click="submitSkillEdit">
          保存为新版本
        </el-button>
      </template>
    </el-dialog>

    <!-- 手动买/卖 -->
    <el-dialog
      v-model="tradeVisible"
      :title="`手动${tradeForm.side === 'buy' ? '买入' : '卖出'} · ${currentName}`"
      width="440px"
    >
      <el-form label-width="80px">
        <el-form-item label="方向">
          <el-radio-group v-model="tradeForm.side">
            <el-radio-button value="buy">买入</el-radio-button>
            <el-radio-button value="sell">卖出</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="代码">
          <el-input v-model="tradeForm.code" placeholder="6 位股票代码" maxlength="6" />
        </el-form-item>
        <el-form-item label="数量">
          <el-input-number v-model="tradeForm.qty" :min="100" :step="100" :controls="false" style="width: 100%" />
        </el-form-item>
        <el-form-item label="限价">
          <el-input v-model="tradeForm.price" placeholder="留空则按实时现价成交" />
        </el-form-item>
        <el-form-item label="操作原因">
          <el-input v-model="tradeForm.reason" placeholder="本次买卖原因（可选，便于复盘）" />
        </el-form-item>
        <el-form-item label="持有逻辑">
          <el-input
            v-model="tradeForm.thesis"
            type="textarea"
            :rows="2"
            placeholder="该标的当前持有逻辑，如「金属钨价格涨价」（可选，写入持仓）"
          />
        </el-form-item>
        <el-form-item label="强制成交">
          <el-checkbox v-model="tradeForm.force">非交易时段也成交（仅手动补模拟用）</el-checkbox>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="tradeVisible = false">取消</el-button>
        <el-button type="primary" :loading="trading" @click="submitTrade">提交</el-button>
      </template>
    </el-dialog>

    <!-- 一键运行 -->
    <el-dialog v-model="runVisible" :title="`一键运行 · ${currentName}`" width="560px">
      <el-input v-model="runPrompt" type="textarea" :rows="4" placeholder="给 agent 的运行指令" />
      <div v-if="runResult" class="run-result">{{ runResult }}</div>
      <template #footer>
        <el-button @click="runVisible = false">关闭</el-button>
        <el-button type="primary" :loading="running" @click="submitRun">运行</el-button>
      </template>
    </el-dialog>

    <!-- 关联任务：新建/编辑（锁定当前战法） + 运行结果 -->
    <TaskEditDialog
      v-model="taskDialog"
      :task="editingTask"
      :strategies="list"
      :locked-strategy-id="selectedId"
      @saved="loadTasks"
    />
    <RunResultDrawer v-model="runDrawer" :run="activeRun" />
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 8px;
}
.layout {
  display: grid;
  grid-template-columns: 260px 1fr;
  gap: 16px;
  margin-top: 16px;
}
.side {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sc {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  cursor: pointer;
  transition: all 0.16s ease;
}
.sc:hover {
  background: var(--bg-hover);
}
.sc.active {
  border-color: var(--brand);
  background: var(--brand-soft);
}
.sc-name {
  font-weight: 600;
  margin-bottom: 8px;
}
.sc-desc {
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.5;
  margin-bottom: 8px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.sc-row {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  margin-bottom: 4px;
}
.sc-label {
  color: var(--text-2);
}
.sc-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 4px;
}
.main {
  min-height: 320px;
}
.detail-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 16px;
}
.detail-name {
  font-size: 18px;
  font-weight: 600;
}
.detail-desc {
  font-size: 12px;
  color: var(--text-2);
  margin-top: 4px;
}
.detail-actions {
  display: flex;
  gap: 8px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
  margin-bottom: 18px;
}
.card {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
}
.card-label {
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 6px;
}
.card-value {
  font-size: 20px;
  font-weight: 600;
}
.detail-tabs {
  margin-top: 6px;
}
.tab-badge {
  margin-left: 2px;
}
.pane-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
.run-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 6px;
  border-radius: 50%;
  background: var(--up, #f0b429);
  box-shadow: 0 0 8px var(--up, #f0b429);
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
.sub {
  font-size: 11.5px;
  opacity: 0.85;
}
.run-result {
  margin-top: 12px;
  padding: 12px;
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 13px;
  white-space: pre-wrap;
  max-height: 320px;
  overflow: auto;
}
.form-tip {
  margin-left: 10px;
  font-size: 12px;
  color: var(--text-2);
}
.daily-run {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  margin-bottom: 10px;
  background: var(--bg-2);
  cursor: pointer;
  transition: background 0.16s ease;
}
.daily-run:hover {
  background: var(--bg-hover);
}
.daily-run-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.daily-run-name {
  font-weight: 600;
  font-size: 13px;
}
.daily-run-output {
  margin: 0;
  padding: 8px 10px;
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  max-height: 260px;
  overflow: auto;
}
.skill-block {
  margin-bottom: 18px;
}
.skill-block-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.skill-block-title {
  font-weight: 600;
}
.skill-content,
.diff-text {
  margin: 0;
  padding: 10px 12px;
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
}
.proposal {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
  margin-bottom: 12px;
  background: var(--bg-2);
}
.proposal-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.proposal-reason {
  flex: 1;
  font-size: 13px;
}
.diff {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.diff-label {
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 4px;
}
.diff-text.old {
  border-color: var(--down, #2e7d32);
}
.diff-text.new {
  border-color: var(--up, #f0b429);
}
.proposal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
.skill-history {
  margin-top: 8px;
}
.history-row {
  margin-bottom: 12px;
}
.history-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
  flex-wrap: wrap;
}
</style>
