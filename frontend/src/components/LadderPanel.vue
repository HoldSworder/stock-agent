<script setup lang="ts">
import { computed, onMounted } from 'vue';
import dayjs from 'dayjs';
import { ElMessage } from 'element-plus';
import { Refresh } from '@element-plus/icons-vue';
import { api } from '@/api';
import { useCachedResource } from '@/composables/useCachedResource';
import StockLink from '@/components/StockLink.vue';
import type { DragonOverview, DragonRole } from '@stock-agent/shared';

// S6 连板梯队 / 龙头辨识面板：确定性展示当日连板梯队 + 龙头分层（总龙头/中军/弹性）。
// 龙头分 = 连板高度 + 封板时间 + 封单额 + 换手率规则化合成，越高越强。

const msg = (e: unknown) => (e instanceof Error ? e.message : '请求失败');

// SWR 缓存（60s）：盘中梯队快变，重进/切 Tab 瞬显
const { data, loading, refreshing, load, reload } = useCachedResource<DragonOverview>(
  'dragon:panel',
  () => api.dragon.overview(),
  { ttlMs: 60_000 },
);
const ov = computed(() => data.value ?? null);

const ROLE_TAG: Record<DragonRole, 'danger' | 'warning' | 'info'> = {
  总龙头: 'danger',
  中军: 'warning',
  弹性: 'info',
};

const tierLabel = (streak: number): string => (streak === 1 ? '首板' : `${streak}连板`);

/** 龙头分配色：高分红、中分橙、低分灰 */
const scoreColor = (score: number): string => {
  if (score >= 75) return '#f56c6c';
  if (score >= 55) return '#e6a23c';
  return '#909399';
};

onMounted(() => void load());
</script>

<template>
  <div class="ladder-panel">
    <div class="panel-head">
      <span class="panel-title">连板梯队 · 龙头辨识</span>
      <el-button
        :icon="Refresh"
        size="small"
        text
        :loading="loading || refreshing"
        @click="reload"
      >
        刷新
      </el-button>
    </div>

    <div v-if="ov" class="sub">
      规则化龙头辨识（连板高度 + 封板时间 + 封单额 + 换手），仅供参考
      <span v-if="ov.asOf"> · 更新 {{ dayjs(ov.asOf).format('HH:mm:ss') }}</span>
    </div>

    <template v-if="ov">
      <!-- 统计条 -->
      <div class="stat-strip">
        <div class="stat">
          <div class="stat-label">涨停总数</div>
          <div class="stat-val num up">{{ ov.limitUpCount }}</div>
        </div>
        <div class="stat">
          <div class="stat-label">最高连板</div>
          <div class="stat-val num up">{{ ov.maxStreak }}<small>板</small></div>
        </div>
        <div class="stat">
          <div class="stat-label">炸板率</div>
          <div class="stat-val num">{{ ov.brokenRate.toFixed(1) }}%</div>
        </div>
        <div v-if="ov.topDragon" class="stat dragon-stat">
          <div class="stat-label">全场总龙头 👑</div>
          <div class="stat-val">
            <StockLink :code="ov.topDragon.code" :name="ov.topDragon.name" />
            <span class="dragon-meta num">
              {{ ov.topDragon.streak }}连板 · 龙头分 {{ ov.topDragon.dragonScore }}
            </span>
          </div>
        </div>
      </div>

      <!-- 梯队分层 -->
      <div v-if="ov.tiers.length" class="tiers">
        <div v-for="t in ov.tiers" :key="t.streak" class="tier-row">
          <div class="tier-tag" :class="{ hot: t.streak >= 3 }">
            {{ tierLabel(t.streak) }}
            <span class="tier-count">{{ t.count }}</span>
          </div>
          <div class="tier-stocks">
            <div
              v-for="s in t.stocks"
              :key="s.code"
              class="dstock"
              :class="{ leader: s.role === '总龙头' }"
            >
              <span v-if="s.role === '总龙头'" class="crown">👑</span>
              <StockLink :code="s.code" :name="s.name" />
              <el-tag :type="ROLE_TAG[s.role]" size="small" effect="plain" class="role-tag">
                {{ s.role }}
              </el-tag>
              <span class="dscore num" :style="{ color: scoreColor(s.dragonScore) }">
                {{ s.dragonScore }}
              </span>
              <span v-if="s.firstSealTime" class="dmeta">封{{ s.firstSealTime }}</span>
              <span v-if="s.sealFund != null" class="dmeta">{{ s.sealFund }}亿</span>
            </div>
          </div>
        </div>
      </div>
      <el-empty v-else :image-size="60" description="暂无涨停（盘前 / 非交易日）" />
    </template>

    <el-skeleton v-else :rows="6" animated />
  </div>
</template>

<style scoped>
.ladder-panel {
  padding: 4px 2px;
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.panel-title {
  font-weight: 600;
  font-size: 15px;
}
.sub {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  margin: 4px 0 12px;
}
.stat-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
  padding: 12px 16px;
  background: var(--el-fill-color-light);
  border-radius: 8px;
  margin-bottom: 14px;
}
.stat-label {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.stat-val {
  font-size: 20px;
  font-weight: 600;
  margin-top: 2px;
}
.stat-val small {
  font-size: 12px;
  font-weight: 400;
  margin-left: 1px;
}
.dragon-stat .stat-val {
  font-size: 15px;
}
.dragon-meta {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  margin-left: 8px;
}
.num.up {
  color: var(--el-color-danger);
}
.tier-row {
  display: flex;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.tier-row:last-child {
  border-bottom: none;
}
.tier-tag {
  flex: 0 0 70px;
  height: fit-content;
  text-align: center;
  font-weight: 600;
  font-size: 13px;
  padding: 4px 6px;
  border-radius: 6px;
  background: var(--el-fill-color);
}
.tier-tag.hot {
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}
.tier-count {
  display: inline-block;
  margin-left: 4px;
  font-size: 12px;
  opacity: 0.7;
}
.tier-stocks {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  flex: 1;
}
.dstock {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
  font-size: 13px;
}
.dstock.leader {
  background: var(--el-color-danger-light-9);
  outline: 1px solid var(--el-color-danger-light-5);
}
.crown {
  font-size: 12px;
}
.role-tag {
  transform: scale(0.86);
}
.dscore {
  font-weight: 600;
}
.dmeta {
  color: var(--el-text-color-secondary);
  font-size: 11px;
}
</style>
