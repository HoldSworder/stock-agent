<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import dayjs from 'dayjs';
import { Bell, Cpu, Aim, Check, Delete } from '@element-plus/icons-vue';
import { useNotificationsStore, type NotificationItem } from '@/stores/notifications';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'open-agents'): void;
}>();

const store = useNotificationsStore();
const router = useRouter();

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

const items = computed(() => store.items);

function fmtTime(iso: string): string {
  const d = dayjs(iso);
  const diffSec = dayjs().diff(d, 'second');
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}分钟前`;
  if (d.isSame(dayjs(), 'day')) return d.format('HH:mm');
  return d.format('MM-DD HH:mm');
}

const levelClass = (n: NotificationItem) => `lv-${n.level}`;

function onClick(n: NotificationItem): void {
  store.markRead(n.id);
  visible.value = false;
  if (n.kind === 'watch') {
    void router.push('/watch');
  } else {
    emit('open-agents');
  }
}
</script>

<template>
  <el-drawer v-model="visible" title="消息中心" direction="rtl" size="380px">
    <template #header>
      <div class="nc-header">
        <span class="nc-title">
          <el-icon><Bell /></el-icon>
          消息中心
          <span v-if="store.unreadCount > 0" class="nc-unread">{{ store.unreadCount }}</span>
        </span>
        <div class="nc-actions">
          <el-button text size="small" :disabled="store.unreadCount === 0" @click="store.markAllRead()">
            <el-icon><Check /></el-icon> 全部已读
          </el-button>
          <el-button text size="small" :disabled="items.length === 0" @click="store.clearAll()">
            <el-icon><Delete /></el-icon> 清空
          </el-button>
        </div>
      </div>
    </template>

    <div v-if="items.length === 0" class="nc-empty">
      <el-icon class="nc-empty-ic"><Bell /></el-icon>
      <p>暂无消息</p>
    </div>

    <ul v-else class="nc-list">
      <li
        v-for="n in items"
        :key="n.id"
        class="nc-item"
        :class="[levelClass(n), { unread: !n.read }]"
        @click="onClick(n)"
      >
        <span class="nc-dot" />
        <el-icon class="nc-kind">
          <component :is="n.kind === 'watch' ? Aim : Cpu" />
        </el-icon>
        <div class="nc-body">
          <div class="nc-row">
            <span class="nc-name">{{ n.title }}</span>
            <span class="nc-time">{{ fmtTime(n.time) }}</span>
          </div>
          <p class="nc-summary">{{ n.summary }}</p>
        </div>
      </li>
    </ul>
  </el-drawer>
</template>

<style scoped>
.nc-header {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}
.nc-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-0);
}
.nc-unread {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--down, #e64545);
  color: #fff;
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}
.nc-actions {
  display: flex;
  gap: 4px;
}
.nc-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 60px 0;
  color: var(--text-2);
}
.nc-empty-ic {
  font-size: 32px;
  opacity: 0.5;
}
.nc-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.nc-item {
  position: relative;
  display: grid;
  grid-template-columns: 10px 20px 1fr;
  align-items: start;
  gap: 8px;
  padding: 10px 12px 10px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-2);
  cursor: pointer;
  transition: background 0.16s ease;
}
.nc-item:hover {
  background: var(--bg-hover);
}
.nc-dot {
  width: 7px;
  height: 7px;
  margin-top: 6px;
  border-radius: 50%;
  background: transparent;
}
.nc-item.unread .nc-dot {
  background: var(--brand, #f0b429);
  box-shadow: 0 0 6px var(--brand-glow, rgba(240, 180, 41, 0.6));
}
.nc-kind {
  margin-top: 2px;
  font-size: 16px;
  color: var(--text-2);
}
.nc-item.lv-success .nc-kind {
  color: var(--up, #f0b429);
}
.nc-item.lv-error .nc-kind {
  color: var(--down, #e64545);
}
.nc-item.lv-warning .nc-kind {
  color: #e6a23c;
}
.nc-body {
  min-width: 0;
}
.nc-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.nc-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nc-time {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-2);
}
.nc-summary {
  margin: 3px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-1);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
