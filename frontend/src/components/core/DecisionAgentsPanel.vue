<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Refresh, RefreshLeft } from '@element-plus/icons-vue';
import { api } from '@/api';
import type {
  DecisionAgentGroup,
  DecisionAgentInfo,
  DecisionEngineConfig,
} from '@stock-agent/shared';

// 决策智能体管理：把硬编码在 decision/service.ts 的多 agent 辩论引擎角色显式化。
// 罗列全部角色（职责/模型档位/引用数据/启停），支持覆盖各角色职责（覆盖优先、留空回退默认）、
// 启停 7 个分析师，并把散落的 decision_* 全局参数收口为可视化配置。
// 该引擎同时被「决策页」与主 agent 工具（盯盘/对话等）调用，此处配置对二者同时生效。

const loading = ref(false);
const agents = ref<DecisionAgentInfo[]>([]);
const config = reactive<DecisionEngineConfig>({
  rounds: 1,
  riskRounds: 1,
  riskEnabled: true,
  quickModel: '',
  deepModel: '',
  targetedFetch: true,
});
const drafts = reactive<Record<string, string>>({});
const saving = reactive<Record<string, boolean>>({});
const savingConfig = ref(false);

// 数据块中文标签（分析师 dataKeys 展示用）
const DATA_LABELS: Record<string, string> = {
  quote: '行情/资金/估值',
  research: '研报一致预期',
  market: '大盘环境',
  news: '消息面',
  policy: '行业政策',
  lockup: '解禁/增减持/质押',
  hotspot: '全网热点/舆情',
  kline: 'K线技术位',
  series: '20日量价序列',
  relStrength: '相对强弱/均线',
  sector: '板块多日走势',
  intraday: '当日分时盘口',
  fundFlow: '资金流多日',
  valuation: '估值分位/同业',
  marketSeries: '大盘多日序列',
  stance: '大盘复盘',
  dragon: '龙虎榜席位',
  statements: '财报主表',
};

const GROUP_ORDER: DecisionAgentGroup[] = ['分析师', '辩论', '交易', '风控', '决策'];

const grouped = computed(() =>
  GROUP_ORDER.map((g) => ({ group: g, items: agents.value.filter((a) => a.group === g) })).filter(
    (x) => x.items.length > 0,
  ),
);

const analystCount = computed(() => agents.value.filter((a) => a.toggleable).length);
const enabledAnalysts = computed(() => agents.value.filter((a) => a.toggleable && a.enabled).length);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const ov = await api.decisionAgents.list();
    agents.value = ov.agents;
    Object.assign(config, ov.config);
    for (const a of ov.agents) drafts[a.key] = a.overridden ? a.instruction : '';
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

function isDirty(a: DecisionAgentInfo): boolean {
  const current = a.overridden ? a.instruction : '';
  return (drafts[a.key] ?? '').trim() !== current.trim();
}

function replaceAgent(info: DecisionAgentInfo): void {
  const i = agents.value.findIndex((a) => a.key === info.key);
  if (i >= 0) agents.value[i] = info;
  drafts[info.key] = info.overridden ? info.instruction : '';
}

async function saveInstruction(a: DecisionAgentInfo): Promise<void> {
  saving[a.key] = true;
  try {
    replaceAgent(await api.decisionAgents.config(a.key, { instruction: drafts[a.key] ?? '' }));
    ElMessage.success(`${a.label} 职责已保存`);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败');
  } finally {
    saving[a.key] = false;
  }
}

async function restore(a: DecisionAgentInfo): Promise<void> {
  saving[a.key] = true;
  try {
    replaceAgent(await api.decisionAgents.config(a.key, { instruction: '' }));
    ElMessage.success(`${a.label} 已恢复默认`);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '恢复失败');
  } finally {
    saving[a.key] = false;
  }
}

async function toggleEnabled(a: DecisionAgentInfo, val: boolean): Promise<void> {
  // 至少保留 1 个分析师，避免分析师层空跑
  if (!val && enabledAnalysts.value <= 1) {
    ElMessage.warning('至少需保留 1 个启用的分析师');
    return;
  }
  saving[a.key] = true;
  try {
    replaceAgent(await api.decisionAgents.config(a.key, { enabled: val }));
    ElMessage.success(`${a.label} 已${val ? '启用' : '停用'}`);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '操作失败');
    await load();
  } finally {
    saving[a.key] = false;
  }
}

async function saveConfig(): Promise<void> {
  savingConfig.value = true;
  try {
    Object.assign(config, await api.decisionAgents.setEngine({ ...config }));
    ElMessage.success('引擎参数已保存');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败');
  } finally {
    savingConfig.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="agents-panel">
    <div class="panel-head">
      <div class="panel-sub">
        决策引擎多 agent 辩论编排的全部角色。覆盖职责优先、留空回退代码默认；分析师可启停。配置同时对
        <b>决策页</b> 与主 agent 工具（盯盘/对话等）调用生效。
      </div>
      <el-button size="small" :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
    </div>

    <el-skeleton v-if="loading" :rows="8" animated style="margin-top: 16px" />

    <template v-else>
      <!-- 引擎全局参数 -->
      <section class="engine-card">
        <div class="engine-title">引擎参数</div>
        <div class="engine-grid">
          <label class="field">
            <span class="field-label">轻模型（quick）</span>
            <el-input v-model="config.quickModel" size="small" placeholder="留空回退轻模型→主模型" clearable />
            <span class="field-hint">分析师 / 多空 / Trader / 风控辩手</span>
          </label>
          <label class="field">
            <span class="field-label">重模型（deep）</span>
            <el-input v-model="config.deepModel" size="small" placeholder="留空回退主模型" clearable />
            <span class="field-hint">研究总监 + 组合经理（最终决策）</span>
          </label>
          <label class="field">
            <span class="field-label">多空辩论轮数</span>
            <el-input-number v-model="config.rounds" size="small" :min="1" :max="3" controls-position="right" />
          </label>
          <label class="field">
            <span class="field-label">风控辩论轮数</span>
            <el-input-number
              v-model="config.riskRounds"
              size="small"
              :min="1"
              :max="3"
              :disabled="!config.riskEnabled"
              controls-position="right"
            />
          </label>
          <label class="field field-switch">
            <span class="field-label">风控博弈层</span>
            <el-switch v-model="config.riskEnabled" />
            <span class="field-hint">关闭则跳过三方风控辩论</span>
          </label>
          <label class="field field-switch">
            <span class="field-label">定向热点取数</span>
            <el-switch v-model="config.targetedFetch" />
            <span class="field-hint">舆情/游资角色按需补搜热榜</span>
          </label>
        </div>
        <div class="engine-actions">
          <el-button type="primary" size="small" :loading="savingConfig" @click="saveConfig">
            保存引擎参数
          </el-button>
        </div>
      </section>

      <!-- 角色卡片（按流水线阶段分组）-->
      <section v-for="g in grouped" :key="g.group" class="group">
        <div class="group-head">
          <span class="group-title">{{ g.group }}</span>
          <span v-if="g.group === '分析师'" class="group-meta">
            {{ enabledAnalysts }}/{{ analystCount }} 启用
          </span>
        </div>

        <article v-for="a in g.items" :key="a.key" class="card" :class="{ disabled: !a.enabled }">
          <header class="card-head">
            <div class="card-title">
              <span class="title-text">{{ a.label }}</span>
              <span class="key">{{ a.key }}</span>
              <span class="tier" :class="a.tier">{{ a.tier === 'deep' ? '重模型' : '轻模型' }}</span>
              <span v-if="a.overridden" class="tag-override">已覆盖</span>
            </div>
            <el-switch
              v-if="a.toggleable"
              :model-value="a.enabled"
              size="small"
              :loading="saving[a.key]"
              @change="(v: boolean) => toggleEnabled(a, v)"
            />
          </header>

          <div v-if="a.dataKeys.length" class="datakeys">
            <span class="dk-label">引用数据</span>
            <span v-for="k in a.dataKeys" :key="k" class="dk">{{ DATA_LABELS[k] ?? k }}</span>
          </div>

          <el-input
            v-model="drafts[a.key]"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 10 }"
            :placeholder="a.baseInstruction"
          />

          <div class="actions">
            <span v-if="isDirty(a)" class="dirty-hint">未保存</span>
            <el-button
              size="small"
              :icon="RefreshLeft"
              :disabled="!a.overridden || saving[a.key]"
              @click="restore(a)"
            >
              恢复默认
            </el-button>
            <el-button
              size="small"
              type="primary"
              :loading="saving[a.key]"
              :disabled="!isDirty(a)"
              @click="saveInstruction(a)"
            >
              保存
            </el-button>
          </div>
        </article>
      </section>
    </template>
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
.engine-card {
  margin-top: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-2);
  padding: 16px 18px;
}
.engine-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-0);
  margin-bottom: 14px;
}
.engine-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field-switch {
  gap: 8px;
}
.field-label {
  font-size: 12.5px;
  color: var(--text-1);
  font-weight: 500;
}
.field-hint {
  font-size: 11px;
  color: var(--text-2);
}
.engine-actions {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}
.group {
  margin-top: 22px;
}
.group-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.group-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}
.group-meta {
  font-size: 11px;
  color: var(--text-2);
  font-family: var(--font-mono);
}
.card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-2);
  padding: 14px 16px;
  margin-bottom: 12px;
  transition: opacity 0.2s;
}
.card.disabled {
  opacity: 0.55;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.card-title {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
}
.title-text {
  font-size: 14.5px;
  font-weight: 600;
  color: var(--text-0);
}
.key {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 5px;
}
.tier {
  font-size: 10.5px;
  border-radius: 4px;
  padding: 0 5px;
}
.tier.quick {
  color: var(--text-2);
  border: 1px solid var(--border);
}
.tier.deep {
  color: var(--brand-2);
  border: 1px solid color-mix(in srgb, var(--brand-2) 45%, transparent);
}
.tag-override {
  font-size: 10.5px;
  color: var(--brand);
  border: 1px solid color-mix(in srgb, var(--brand) 45%, transparent);
  border-radius: 4px;
  padding: 0 5px;
}
.datakeys {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 10px 0;
}
.dk-label {
  font-size: 11px;
  color: var(--text-2);
}
.dk {
  font-size: 11px;
  color: var(--text-1);
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 6px;
}
.actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}
.dirty-hint {
  margin-right: auto;
  font-size: 11.5px;
  color: var(--brand-2);
  font-family: var(--font-mono);
}
</style>
