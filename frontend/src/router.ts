import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/chat' },
    { path: '/chat', name: 'chat', component: () => import('./views/ChatView.vue') },
    { path: '/tasks', name: 'tasks', component: () => import('./views/TasksView.vue') },
    { path: '/runs', name: 'runs', component: () => import('./views/RunsView.vue') },
    { path: '/picks', name: 'picks', component: () => import('./views/PicksView.vue') },
    {
      path: '/positions',
      name: 'positions',
      component: () => import('./views/PositionsView.vue'),
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('./views/SettingsView.vue'),
    },
  ],
});
