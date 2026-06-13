<script setup lang="ts">
import {
  Histogram,
  Memo,
  ChatDotRound,
  Star,
  Wallet,
  DataAnalysis,
  Setting,
  Aim,
  TrendCharts,
  Document,
  Coin,
  Files,
  PieChart,
  Connection,
  Opportunity,
  Cpu,
  Delete,
  Compass,
} from '@element-plus/icons-vue';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import KlineDialog from '@/components/KlineDialog.vue';
import AgentsPanel from '@/components/AgentsPanel.vue';
import { useAgentsStore } from '@/stores/agents';

const route = useRoute();
const blank = computed(() => route.meta.blank === true);

// 全局 Agent 运行入口
const agents = useAgentsStore();
const panelVisible = ref(false);
onMounted(() => agents.connect());
onUnmounted(() => agents.disconnect());

// 侧边栏按「投资工作流生命周期」分组：行情(输入) → 研判(发现+决策) → 交易(计划+执行) → 复盘(复盘+验证) → 系统(基础设施)
const groups = [
  {
    label: '行情',
    desc: 'MARKET',
    items: [
      { to: '/', title: '大盘', desc: 'Market', icon: Histogram },
      { to: '/etf', title: 'ETF', desc: 'ETF', icon: PieChart },
      { to: '/intel', title: '热点雷达', desc: 'Intel', icon: TrendCharts },
      { to: '/research', title: '研报', desc: 'Research', icon: Document },
    ],
  },
  {
    label: '研判',
    desc: 'ANALYZE',
    items: [
      { to: '/screener', title: '选股', desc: 'Screener', icon: Compass },
      { to: '/decision', title: '决策', desc: 'Decision', icon: Opportunity },
      { to: '/chat', title: '对话', desc: 'Agent', icon: ChatDotRound },
    ],
  },
  {
    label: '交易',
    desc: 'TRADE',
    items: [
      { to: '/plan', title: '今日计划', desc: 'War Room', icon: Files },
      { to: '/watch', title: '实时盯盘', desc: 'Watch', icon: Aim },
      { to: '/watchlist', title: '自选股', desc: 'Watchlist', icon: Star },
      { to: '/positions', title: '真实持仓', desc: 'Positions', icon: Wallet },
    ],
  },
  {
    label: '复盘',
    desc: 'REVIEW',
    items: [
      { to: '/review', title: '复盘', desc: 'Review', icon: Memo },
      { to: '/strategy', title: '战法模拟', desc: 'Strategy', icon: DataAnalysis },
    ],
  },
  {
    label: '系统',
    desc: 'SYSTEM',
    items: [
      { to: '/core', title: '智能体中枢', desc: 'Core', icon: Cpu },
      { to: '/datasource', title: '数据源', desc: 'Sources', icon: Connection },
      { to: '/usage', title: '调用记录', desc: 'Usage', icon: Coin },
      { to: '/ops', title: '运维', desc: 'Ops', icon: Delete },
      { to: '/settings', title: '设置', desc: 'Config', icon: Setting },
    ],
  },
];
</script>

<template>
  <router-view v-if="blank" />
  <div v-else class="shell">
    <aside class="rail">
      <div class="brand">
        <div class="brand-mark">
          <span class="bar b1" />
          <span class="bar b2" />
          <span class="bar b3" />
        </div>
        <div class="brand-text">
          <div class="brand-name">选股 Agent</div>
          <div class="brand-tag">QUANT TERMINAL</div>
        </div>
      </div>

      <nav class="nav">
        <div v-for="g in groups" :key="g.label" class="nav-group">
          <div class="nav-group-label">
            <span class="ngl-title">{{ g.label }}</span>
            <span class="ngl-desc">{{ g.desc }}</span>
          </div>
          <router-link
            v-for="m in g.items"
            :key="m.to"
            :to="m.to"
            class="nav-item"
            exact-active-class="active"
          >
            <el-icon class="nav-ic"><component :is="m.icon" /></el-icon>
            <span class="nav-title">{{ m.title }}</span>
            <span class="nav-desc">{{ m.desc }}</span>
          </router-link>
        </div>
      </nav>

      <button
        class="agents-entry"
        :class="{ busy: agents.runningCount > 0 }"
        @click="panelVisible = true"
      >
        <span class="ae-dot" />
        <span class="ae-text">
          <template v-if="agents.runningCount > 0">
            {{ agents.runningCount }} 个 Agent 运行中
          </template>
          <template v-else>Agent 空闲</template>
        </span>
        <el-icon class="ae-arrow"><ArrowRightBold /></el-icon>
      </button>

      <div class="rail-foot">
        <span class="dot" />
        本地运行 · localhost
      </div>
    </aside>

    <main class="stage">
      <router-view v-slot="{ Component }">
        <transition name="fade-up" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </main>

    <!-- 全局 K 线弹窗：系统内任意可点击标的处唤起 -->
    <KlineDialog />

    <!-- 全局 Agent 运行列表抽屉 -->
    <AgentsPanel v-model="panelVisible" />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100vh;
  overflow: hidden;
}
.rail {
  width: 232px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: linear-gradient(180deg, var(--bg-2), var(--bg-1));
  border-right: 1px solid var(--border);
  padding: 18px 14px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 8px 18px;
}
.brand-mark {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 26px;
}
.brand-mark .bar {
  width: 5px;
  border-radius: 2px;
  background: var(--brand);
  box-shadow: 0 0 10px var(--brand-glow);
}
.brand-mark .b1 {
  height: 12px;
  background: var(--down);
  box-shadow: none;
}
.brand-mark .b2 {
  height: 24px;
}
.brand-mark .b3 {
  height: 17px;
  background: var(--up);
  box-shadow: none;
}
.brand-name {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 16px;
  letter-spacing: -0.01em;
}
.brand-tag {
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.22em;
  color: var(--text-2);
}

.nav {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 6px -14px 0;
  padding: 0 14px;
}
.nav-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.nav-group + .nav-group {
  margin-top: 14px;
}
.nav-group-label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 12px 4px;
}
.ngl-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-2);
}
.ngl-desc {
  font-family: var(--font-mono);
  font-size: 8.5px;
  letter-spacing: 0.2em;
  color: var(--text-2);
  opacity: 0.55;
}

.nav-item {
  position: relative;
  display: grid;
  grid-template-columns: 22px 1fr;
  grid-template-rows: auto auto;
  column-gap: 12px;
  align-items: center;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  text-decoration: none;
  color: var(--text-1);
  transition: all 0.16s ease;
}
.nav-ic {
  grid-row: 1 / 3;
  font-size: 18px;
}
.nav-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-0);
}
.nav-desc {
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.16em;
  color: var(--text-2);
}
.nav-item:hover {
  background: var(--bg-hover);
}
.nav-item.active {
  background: var(--brand-soft);
}
.nav-item.active .nav-ic,
.nav-item.active .nav-title {
  color: var(--brand);
}
.nav-item.active::before {
  content: '';
  position: absolute;
  left: -14px;
  top: 8px;
  bottom: 8px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--brand);
  box-shadow: 0 0 12px var(--brand-glow);
}

.agents-entry {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-2);
  color: var(--text-1);
  font-size: 12.5px;
  cursor: pointer;
  transition: all 0.16s ease;
}
.agents-entry:hover {
  background: var(--bg-hover);
}
.agents-entry.busy {
  border-color: var(--brand);
  background: var(--brand-soft);
  color: var(--brand);
}
.agents-entry .ae-dot {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--text-2);
}
.agents-entry.busy .ae-dot {
  background: var(--up, #f0b429);
  box-shadow: 0 0 8px var(--up, #f0b429);
  animation: pulse 1.4s infinite;
}
.agents-entry .ae-text {
  flex: 1;
  text-align: left;
}
.agents-entry .ae-arrow {
  font-size: 12px;
  opacity: 0.6;
}

.rail-foot {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-2);
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--down);
  box-shadow: 0 0 8px var(--down);
  animation: pulse 2s infinite;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}

.stage {
  flex: 1;
  overflow: auto;
}

.fade-up-enter-active,
.fade-up-leave-active {
  transition: all 0.22s ease;
}
.fade-up-enter-from {
  opacity: 0;
  transform: translateY(8px);
}
.fade-up-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
