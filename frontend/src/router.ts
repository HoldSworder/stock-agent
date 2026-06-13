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
    { path: '/screener', name: 'screener', component: () => import('./views/ScreenerView.vue') },
    { path: '/plan', name: 'plan', component: () => import('./views/PlanView.vue') },
    { path: '/watch', name: 'watch', component: () => import('./views/WatchView.vue') },
    { path: '/intel', name: 'intel', component: () => import('./views/IntelView.vue') },
    { path: '/themes', name: 'themes', component: () => import('./views/ThemesView.vue') },
    { path: '/radar', name: 'radar', component: () => import('./views/RadarView.vue') },
    { path: '/research', name: 'research', component: () => import('./views/ResearchView.vue') },
    { path: '/etf', name: 'etf', component: () => import('./views/EtfView.vue') },
    { path: '/review', name: 'review', component: () => import('./views/ReviewView.vue') },
    { path: '/decision', name: 'decision', component: () => import('./views/DecisionView.vue') },
    { path: '/chat', name: 'chat', component: () => import('./views/ChatView.vue') },
    {
      path: '/watchlist',
      name: 'watchlist',
      component: () => import('./views/WatchlistView.vue'),
    },
    {
      path: '/positions',
      name: 'positions',
      component: () => import('./views/PositionsView.vue'),
    },
    {
      path: '/strategy',
      name: 'strategy',
      component: () => import('./views/StrategyView.vue'),
    },
    {
      path: '/usage',
      name: 'usage',
      component: () => import('./views/UsageView.vue'),
    },
    {
      path: '/datasource',
      name: 'datasource',
      component: () => import('./views/DataSourceView.vue'),
    },
    {
      path: '/core',
      name: 'core',
      component: () => import('./views/CoreView.vue'),
    },
    // 旧入口兜底：工具页已并入智能体中枢
    { path: '/tools', redirect: '/core' },
    {
      path: '/ops',
      name: 'ops',
      component: () => import('./views/OpsView.vue'),
    },
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
