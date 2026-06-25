import { createRouter, createWebHistory } from 'vue-router';
import { api, getToken } from '@/api';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('./views/LoginView.vue'),
      meta: { blank: true },
    },
    { path: '/', name: 'home', component: () => import('./views/CockpitView.vue') },
    { path: '/market', name: 'market', component: () => import('./views/MarketView.vue') },
    // 情绪周期已并入大盘页（情绪周期 Tab），旧链接兜底跳转
    { path: '/sentiment', redirect: { path: '/market', query: { tab: 'sentiment' } } },
    { path: '/screener', name: 'screener', component: () => import('./views/ScreenerView.vue') },
    { path: '/plan', name: 'plan', component: () => import('./views/PlanView.vue') },
    { path: '/watch', name: 'watch', component: () => import('./views/WatchView.vue') },
    {
      path: '/etf-watch',
      name: 'etf-watch',
      component: () => import('./views/EtfWatchView.vue'),
    },
    // 情报二合一：热点 + 研报合并为「情报」页
    { path: '/intel', name: 'intel', component: () => import('./views/IntelHubView.vue') },
    // 中线雷达 / 市场主线已折叠进大盘多 Tab，旧链接兜底跳转
    { path: '/themes', redirect: '/market' },
    { path: '/radar', redirect: '/market' },
    // 研报已并入情报页（研报 Tab）
    { path: '/research', redirect: { path: '/intel', query: { tab: 'research' } } },
    { path: '/etf', name: 'etf', component: () => import('./views/EtfView.vue') },
    { path: '/review', name: 'review', component: () => import('./views/ReviewView.vue') },
    { path: '/decision', name: 'decision', component: () => import('./views/DecisionView.vue') },
    { path: '/chat', name: 'chat', component: () => import('./views/ChatView.vue') },
    // 账户二合一：真实持仓 + 自选合并为「持仓与自选」页
    {
      path: '/positions',
      name: 'positions',
      component: () => import('./views/AccountView.vue'),
    },
    // 自选已并入账户页（自选 Tab）
    { path: '/watchlist', redirect: { path: '/positions', query: { tab: 'watchlist' } } },
    {
      path: '/strategy',
      name: 'strategy',
      component: () => import('./views/StrategyView.vue'),
    },
    {
      path: '/backtest',
      name: 'backtest',
      component: () => import('./views/BacktestView.vue'),
    },
    // 调用记录已并入智能体中枢（调用记录 Tab）
    { path: '/usage', redirect: { path: '/core', query: { tab: 'usage' } } },
    // 数据源已并入系统设置（数据源 Tab）
    { path: '/datasource', redirect: { path: '/settings', query: { tab: 'datasource' } } },
    {
      path: '/core',
      name: 'core',
      component: () => import('./views/CoreView.vue'),
    },
    // 旧入口兜底：工具页已并入智能体中枢
    { path: '/tools', redirect: '/core' },
    // 运维已并入系统设置（运维 Tab）
    { path: '/ops', redirect: { path: '/settings', query: { tab: 'ops' } } },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('./views/SettingsView.vue'),
    },
  ],
});

// 鉴权是否开启的内存缓存，避免每次跳转重复请求状态
let authEnabledCache: boolean | null = null;

router.beforeEach(async (to) => {
  if (to.path === '/login') return true;
  if (getToken()) return true;
  if (authEnabledCache === null) {
    try {
      authEnabledCache = (await api.authStatus()).enabled;
    } catch {
      authEnabledCache = true; // 状态获取失败按已启用处理，更安全
    }
  }
  if (!authEnabledCache) return true; // 未设密码，bootstrap 放行
  return { path: '/login', query: { redirect: to.fullPath } };
});
