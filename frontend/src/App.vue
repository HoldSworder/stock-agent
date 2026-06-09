<script setup lang="ts">
import { ChatDotRound, Timer, List, TrendCharts, Wallet, Setting } from '@element-plus/icons-vue';

const menus = [
  { to: '/chat', title: '对话', desc: 'Agent', icon: ChatDotRound },
  { to: '/tasks', title: '定时任务', desc: 'Schedule', icon: Timer },
  { to: '/runs', title: '运行 / 复盘', desc: 'Runs', icon: List },
  { to: '/picks', title: '选股留痕', desc: 'Picks', icon: TrendCharts },
  { to: '/positions', title: '真实持仓', desc: 'Positions', icon: Wallet },
  { to: '/settings', title: '设置', desc: 'Config', icon: Setting },
];
</script>

<template>
  <div class="shell">
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
        <router-link
          v-for="m in menus"
          :key="m.to"
          :to="m.to"
          class="nav-item"
          active-class="active"
        >
          <el-icon class="nav-ic"><component :is="m.icon" /></el-icon>
          <span class="nav-title">{{ m.title }}</span>
          <span class="nav-desc">{{ m.desc }}</span>
        </router-link>
      </nav>

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
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
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

.rail-foot {
  margin-top: auto;
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
