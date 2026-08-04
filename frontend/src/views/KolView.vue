<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Delete, Plus, Refresh, Search } from '@element-plus/icons-vue';
import { api } from '@/api';
import ModuleScheduleDialog from '@/components/ModuleScheduleDialog.vue';
import KolPostText from '@/components/KolPostText.vue';
import { useCachedResource } from '@/composables/useCachedResource';
import type {
  KolAccount,
  KolImage,
  KolPlatform,
  KolPost,
  KolSearchResult,
} from '@stock-agent/shared';

// 大V观点页：左侧关注名单（添加 / 启停 / 删除），右侧按发布时间倒序的发帖时间流。
// 覆盖微博大V与小红书博主两个平台，内容由后端定时抓取入库，本页只读库内数据；
// 「抓取最新」按钮触发一次现场抓取（串行，较慢）。

const msg = (e: unknown) => (e instanceof Error ? e.message : '请求失败');

/** 平台展示信息：徽标文案与配色（小红书红 / 微博橙），与各自品牌色对齐 */
const PLATFORM_META: Record<KolPlatform, { label: string; short: string; color: string }> = {
  weibo: { label: '微博', short: '博', color: '#e6a23c' },
  xiaohongshu: { label: '小红书', short: '书', color: '#ff2442' },
};

/** 新增平台或旧记录 platform 为空时的兜底，别让一条脏数据把整页渲染打断 */
const DEFAULT_PLATFORM_META = { label: '未知平台', short: '?', color: '#909399' };
const platMeta = (p: string | null | undefined) =>
  PLATFORM_META[p as KolPlatform] ?? DEFAULT_PLATFORM_META;

/** 当前筛选的大V uid，空串为全部 */
const activeUid = ref('');
/** 当前筛选的平台，空串为全部 */
const activePlatform = ref<KolPlatform | ''>('');

const accounts = ref<KolAccount[]>([]);
const accountsLoading = ref(false);

/** 按当前平台过滤后的关注名单 */
const shownAccounts = computed(() =>
  activePlatform.value ? accounts.value.filter((a) => a.platform === activePlatform.value) : accounts.value,
);

// 时间流走 SWR：切回页面瞬显，TTL 内不重复请求
const { data, loading, refreshing, load, reload } = useCachedResource<KolPost[]>(
  () => `kol:feed:${activePlatform.value || 'all'}:${activeUid.value || 'all'}`,
  () => api.kol.feed(activeUid.value || undefined, 100, activePlatform.value || undefined),
  { ttlMs: 60_000 },
);
const posts = computed(() => data.value ?? []);

/** 抓取中（现场串行抓取所有大V，耗时随名单长度增长） */
const fetching = ref(false);

// ===== 添加大V =====
const addVisible = ref(false);
/** 添加弹窗当前平台：微博搜昵称，小红书粘主页链接 */
const addPlatform = ref<KolPlatform>('weibo');
const keyword = ref('');
const searching = ref(false);
const candidates = ref<Array<KolSearchResult & { added: boolean }>>([]);
/** 小红书未配置 Cookie 时会出现「仅标题」的降级记录，据此在页面上给一次提示 */
const hasTitleOnly = computed(() => posts.value.some((p) => p.titleOnly));

async function loadAccounts() {
  accountsLoading.value = true;
  try {
    accounts.value = await api.kol.accounts();
  } catch (e) {
    ElMessage.error(msg(e));
  } finally {
    accountsLoading.value = false;
  }
}

// 切换筛选后重取时间流（命中缓存则瞬显）
watch([activeUid, activePlatform], () => void load().catch((e) => ElMessage.error(msg(e))));

/** 切平台时清掉不属于该平台的大V筛选，否则会筛出空列表 */
function switchPlatform(p: KolPlatform | '') {
  if (activePlatform.value === p) return;
  activePlatform.value = p;
  const cur = accounts.value.find((a) => a.uid === activeUid.value);
  if (cur && p && cur.platform !== p) activeUid.value = '';
}

/** 现场抓取最新博文后刷新时间流 */
async function fetchLatest() {
  fetching.value = true;
  try {
    const r = await api.kol.refresh();
    if (r.failed.length > 0) {
      ElMessage.warning(`新增 ${r.inserted} 条；${r.failed.join('、')} 抓取失败`);
    } else {
      ElMessage.success(`抓取完成：${r.accounts} 个大V，新增 ${r.inserted} 条`);
    }
    await reload();
    await loadAccounts();
  } catch (e) {
    ElMessage.error(msg(e));
  } finally {
    fetching.value = false;
  }
}

/** 切换添加平台时清空上一个平台的候选，避免串台误加 */
function switchAddPlatform(p: KolPlatform) {
  if (addPlatform.value === p) return;
  addPlatform.value = p;
  keyword.value = '';
  candidates.value = [];
}

/**
 * 微博按昵称搜索；小红书搜用户的接口需要签名做不了，
 * 改为粘主页链接后拉一次资料当作唯一候选，让用户确认是不是要找的人。
 */
async function search() {
  const q = keyword.value.trim();
  if (!q) return;
  searching.value = true;
  try {
    if (addPlatform.value === 'xiaohongshu') {
      candidates.value = [await api.kol.previewXhs(q)];
    } else {
      candidates.value = await api.kol.search(q);
      if (candidates.value.length === 0) ElMessage.info('未搜到匹配的微博用户');
    }
  } catch (e) {
    candidates.value = [];
    ElMessage.error(msg(e));
  } finally {
    searching.value = false;
  }
}

async function add(u: KolSearchResult) {
  try {
    await api.kol.addAccount({ ...u, platform: u.platform ?? addPlatform.value });
    ElMessage.success(`已关注 ${u.screenName}`);
    const hit = candidates.value.find((c) => c.uid === u.uid);
    if (hit) hit.added = true;
    await loadAccounts();
  } catch (e) {
    ElMessage.error(msg(e));
  }
}

async function remove(a: KolAccount) {
  try {
    await ElMessageBox.confirm(`取消关注「${a.screenName}」？其历史发帖会一并删除。`, '确认', {
      type: 'warning',
    });
  } catch {
    return; // 用户取消
  }
  try {
    await api.kol.removeAccount(a.uid);
    if (activeUid.value === a.uid) activeUid.value = '';
    await loadAccounts();
    await reload();
  } catch (e) {
    ElMessage.error(msg(e));
  }
}

async function toggle(a: KolAccount, enabled: boolean) {
  try {
    await api.kol.toggleAccount(a.uid, enabled);
    a.enabled = enabled;
  } catch (e) {
    ElMessage.error(msg(e));
    await loadAccounts();
  }
}

// ===== 博文正文的结构化与折叠 =====

/** 正文超过此长度才折叠，阈值取「约 4 行」，短博文不加无谓的展开按钮 */
const CLAMP_CHARS = 160;
/** 已展开的博文 bid */
const expanded = ref<Set<string>>(new Set());

/**
 * 整行点击打开微博原文。行本身不能做成 <a>，否则会与正文里的话题/@/外链形成嵌套 a
 * （非法 HTML，浏览器会静默拆开）。故用点击处理器 + 时间戳保留真链接承担键盘可达性。
 * 选中文字后不跳转，避免复制正文时被弹走。
 */
function openPost(url: string) {
  if (window.getSelection()?.toString()) return;
  window.open(url, '_blank', 'noopener');
}

function toggleExpand(bid: string) {
  const s = new Set(expanded.value);
  if (s.has(bid)) s.delete(bid);
  else s.add(bid);
  expanded.value = s;
}

/**
 * 拆出转发链：微博把「我的话//@某人:原话//@另一人:更早的话」压在一个字段里，
 * 平铺出来极难读。首个 //@ 之前是本人发言，之后整体作为引用块弱化展示。
 */
function splitChain(text: string): { own: string; chain: string } {
  const i = text.indexOf('//@');
  if (i < 0) return { own: text, chain: '' };
  return { own: text.slice(0, i).trim(), chain: text.slice(i + 2).trim() };
}

interface ViewPost extends KolPost {
  /** 本人发言部分 */
  own: string;
  /** 转发链（含被转原文），无则空串 */
  chain: string;
  /** 是否长到需要折叠 */
  clampable: boolean;
}

const viewPosts = computed<ViewPost[]>(() =>
  posts.value.map((p) => {
    const { own, chain } = splitChain(p.text);
    const full = own + chain + (p.retweetText ?? '');
    return { ...p, own, chain, clampable: full.length > CLAMP_CHARS };
  }),
);

/**
 * 单图按原始宽高比展示，不裁切：小红书的信息图本身就是内容，
 * 用统一方格裁掉一半等于把信息裁没了。多图仍走统一方格网格保持整齐。
 */
function singleRatio(images: KolImage[], im: KolImage): Record<string, string> | undefined {
  if (images.length !== 1 || !im.width || !im.height) return undefined;
  return { aspectRatio: `${im.width} / ${im.height}` };
}

/** 同日仅显示 HH:mm，跨日补 MM-DD */
const fmtTime = (iso: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return sameDay ? `今天 ${hm}` : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
};

onMounted(() => {
  void loadAccounts();
  void load().catch((e) => ElMessage.error(msg(e)));
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-title">大V观点</div>
      <div class="head-actions">
        <ModuleScheduleDialog module="kol" />
        <el-button :icon="Plus" size="small" @click="addVisible = true">添加大V</el-button>
        <el-button :icon="Refresh" :loading="fetching || loading || refreshing" @click="fetchLatest">
          抓取最新
        </el-button>
      </div>
    </div>
    <div class="page-sub">
      聚合关注的微博大V与小红书博主发帖，盘中跟进观点与情绪；内容由定时任务抓取，可手动「抓取最新」
    </div>

    <!-- 小红书未配置 Cookie 时只能抓到标题，一次性说清补救办法，不在每条帖子上重复唠叨 -->
    <el-alert
      v-if="hasTitleOnly"
      class="degrade-tip"
      type="info"
      show-icon
      :closable="false"
      title="部分小红书笔记只有标题"
      description="小红书未登录时会隐藏笔记 ID，拿不到正文与发布时间。到「数据源」页给小红书填一份登录 Cookie 即可抓取全文。"
    />

    <div class="layout">
      <!-- 关注名单 -->
      <div v-loading="accountsLoading" class="panel side">
        <div class="side-head">关注名单（{{ shownAccounts.length }}）</div>
        <!-- 平台筛选：名单与时间流同时收窄 -->
        <div class="plat-tabs">
          <button class="plat-tab" :class="{ on: activePlatform === '' }" @click="switchPlatform('')">
            全部
          </button>
          <button
            v-for="(meta, key) in PLATFORM_META"
            :key="key"
            class="plat-tab"
            :class="{ on: activePlatform === key }"
            @click="switchPlatform(key)"
          >
            {{ meta.label }}
          </button>
        </div>
        <div class="acc-list">
          <div class="acc-row" :class="{ active: activeUid === '' }" @click="activeUid = ''">
            <span class="acc-name">全部大V</span>
          </div>
          <div
            v-for="a in shownAccounts"
            :key="a.uid"
            class="acc-row"
            :class="{ active: activeUid === a.uid, disabled: !a.enabled }"
            @click="activeUid = a.uid"
          >
            <el-avatar :size="26" :src="a.avatar || undefined">{{ a.screenName.slice(0, 1) }}</el-avatar>
            <div class="acc-main">
              <span class="acc-name">
                <span
                  class="plat-dot"
                  :style="{ background: platMeta(a.platform).color }"
                  :title="platMeta(a.platform).label"
                />
                {{ a.screenName }}
              </span>
              <!-- 小红书号方便和 App 里看到的账号对上，比简介更值得占这一行 -->
              <span v-if="a.redId" class="acc-desc" :title="a.verifiedReason || undefined">
                小红书号 {{ a.redId }}
              </span>
              <span v-else-if="a.verifiedReason" class="acc-desc">{{ a.verifiedReason }}</span>
            </div>
            <div class="acc-ops" @click.stop>
              <el-switch
                :model-value="a.enabled"
                size="small"
                @update:model-value="(v: unknown) => toggle(a, v as boolean)"
              />
              <el-button :icon="Delete" size="small" text @click="remove(a)" />
            </div>
          </div>
        </div>
        <el-empty
          v-if="!accountsLoading && shownAccounts.length === 0"
          :description="activePlatform ? `尚未关注任何${platMeta(activePlatform).label}博主` : '尚未关注任何大V'"
          :image-size="60"
        />
      </div>

      <!-- 时间流 -->
      <div class="panel feed">
        <!-- 首次加载：骨架屏与真实行同形，避免 spinner 造成的空白跳变 -->
        <div v-if="loading && !posts.length" class="post-list">
          <div v-for="i in 4" :key="i" class="post-row skeleton-row">
            <div class="sk sk-avatar" />
            <div class="post-body">
              <div class="sk sk-line" style="width: 30%" />
              <div class="sk sk-line" style="width: 96%" />
              <div class="sk sk-line" style="width: 78%" />
            </div>
          </div>
        </div>

        <div v-else-if="viewPosts.length" class="post-list">
          <article
            v-for="p in viewPosts"
            :key="p.bid"
            class="post-row post-clickable"
            title="点击打开微博原文"
            @click="openPost(p.url)"
          >
            <el-avatar :size="34" :src="p.avatar || undefined">{{ p.screenName.slice(0, 1) }}</el-avatar>
            <div class="post-body">
              <div class="post-meta">
                <span
                  class="post-plat"
                  :style="{ color: platMeta(p.platform).color, borderColor: platMeta(p.platform).color }"
                  >{{ platMeta(p.platform).short }}</span
                >
                <span class="post-author">{{ p.screenName }}</span>
                <span v-if="p.isRetweet" class="post-kind">转发</span>
                <!-- 降级记录的时间是首次抓到的时间而非发布时间，标注出来免得被误读 -->
                <span v-if="p.titleOnly" class="post-kind" title="未配置小红书 Cookie，只抓到标题">
                  仅标题
                </span>
                <a
                  class="post-time num"
                  :href="p.url"
                  target="_blank"
                  rel="noopener"
                  :title="p.titleOnly ? '打开博主主页（无法定位到具体笔记）' : `在${platMeta(p.platform).label}打开原文`"
                  >{{ p.titleOnly ? `约 ${fmtTime(p.createdAt)}` : fmtTime(p.createdAt) }}</a
                >
              </div>

              <div class="post-content" :class="{ clamped: p.clampable && !expanded.has(p.bid) }">
                <div v-if="p.own" class="post-text">
                  <KolPostText :text="p.own" :platform="p.platform" />
                </div>
                <!-- 转发链与被转原文弱化为引用块，与本人发言拉开层次 -->
                <div v-if="p.chain" class="post-quote">
                  <KolPostText :text="p.chain" :platform="p.platform" />
                </div>
                <div v-else-if="p.retweetText" class="post-quote">
                  <KolPostText :text="p.retweetText" :platform="p.platform" />
                </div>
              </div>
              <button v-if="p.clampable" class="post-more" @click.stop="toggleExpand(p.bid)">
                {{ expanded.has(p.bid) ? '收起' : '展开全文' }}
              </button>

              <!--
                配图：小红书大量信息画在图里，正文常常只是引子，所以图要能看清。
                点击看大图（走 el-image 自带的预览层），并阻止冒泡以免同时打开原文。
              -->
              <div
                v-if="p.images?.length"
                class="post-images"
                :class="`cols-${Math.min(p.images.length, 3)}`"
                @click.stop
              >
                <el-image
                  v-for="(im, i) in p.images"
                  :key="im.src"
                  class="post-img"
                  :src="im.src"
                  :preview-src-list="p.images.map((x) => x.src)"
                  :initial-index="i"
                  :style="singleRatio(p.images, im)"
                  :fit="p.images.length === 1 ? 'contain' : 'cover'"
                  loading="lazy"
                  preview-teleported
                  hide-on-click-modal
                />
              </div>

              <!-- 降级记录拿不到互动数，一排 0 是噪音，直接不显示 -->
              <div v-if="!p.titleOnly" class="post-stats">
                <span class="stat"><span class="stat-k">转</span><span class="num">{{ p.reposts }}</span></span>
                <span class="stat"><span class="stat-k">评</span><span class="num">{{ p.comments }}</span></span>
                <span class="stat"><span class="stat-k">赞</span><span class="num">{{ p.attitudes }}</span></span>
              </div>
            </div>
          </article>
        </div>

        <div v-else class="feed-empty">
          <div class="empty-title">还没有内容</div>
          <p class="empty-desc">
            {{
              accounts.length
                ? '微博盘中每 10 分钟、小红书每小时自动抓取，也可以立刻拉一轮。'
                : '先在左侧添加要关注的大V，再抓取内容。'
            }}
          </p>
          <el-button
            v-if="accounts.length"
            type="primary"
            :icon="Refresh"
            :loading="fetching"
            @click="fetchLatest"
            >立即抓取</el-button
          >
          <el-button v-else type="primary" :icon="Plus" @click="addVisible = true">添加大V</el-button>
        </div>
      </div>
    </div>

    <!-- 添加大V：微博按昵称搜索，小红书粘主页链接（其搜用户接口需签名，做不了搜索） -->
    <el-dialog v-model="addVisible" title="添加大V" width="560px">
      <div class="plat-tabs dialog-tabs">
        <button
          v-for="(meta, key) in PLATFORM_META"
          :key="key"
          class="plat-tab"
          :class="{ on: addPlatform === key }"
          @click="switchAddPlatform(key)"
        >
          {{ meta.label }}
        </button>
      </div>
      <div class="search-bar">
        <el-input
          v-model="keyword"
          :placeholder="
            addPlatform === 'xiaohongshu'
              ? '粘贴博主主页链接 / App 分享链接 / 24 位用户 ID'
              : '输入微博昵称，如 但斌'
          "
          clearable
          @keyup.enter="search"
        />
        <el-button :icon="Search" :loading="searching" @click="search">
          {{ addPlatform === 'xiaohongshu' ? '解析' : '搜索' }}
        </el-button>
      </div>
      <!-- 小红书按昵称/小红书号检索的接口都要签名，只能靠链接定位，说清楚省得用户反复试 -->
      <p v-if="addPlatform === 'xiaohongshu'" class="add-hint">
        小红书不支持按昵称或小红书号检索。最省事的做法：在 App 里打开博主主页，点右上角分享、复制链接，直接粘到这里。
      </p>
      <div v-loading="searching" class="cand-list">
        <div v-for="c in candidates" :key="c.uid" class="cand-row">
          <el-avatar :size="30" :src="c.avatar || undefined">{{ c.screenName.slice(0, 1) }}</el-avatar>
          <div class="cand-main">
            <span class="cand-name">{{ c.screenName }}</span>
            <span class="cand-desc">
              {{ c.redId ? `小红书号 ${c.redId} · ` : '' }}粉丝
              {{ c.followersCount || '-' }}{{ c.verifiedReason ? ` · ${c.verifiedReason}` : '' }}
            </span>
          </div>
          <el-button v-if="c.added" size="small" disabled>已关注</el-button>
          <el-button v-else size="small" type="primary" @click="add(c)">关注</el-button>
        </div>
        <el-empty
          v-if="!searching && candidates.length === 0"
          :description="
            addPlatform === 'xiaohongshu' ? '粘贴链接后解析博主' : '搜索昵称后选择要关注的大V'
          "
          :image-size="60"
        />
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.degrade-tip {
  margin-bottom: 12px;
}
.layout {
  display: grid;
  grid-template-columns: 260px 1fr;
  gap: 12px;
  align-items: start;
}
.panel {
  background: var(--bg-2);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  padding: 10px 14px;
}
.side-head {
  font-size: 12.5px;
  color: var(--text-2);
  padding: 2px 0 8px;
}
/* 平台筛选：文字型 tab，不与下方名单的选中态抢视觉 */
.plat-tabs {
  display: flex;
  gap: 4px;
  padding-bottom: 8px;
}
.dialog-tabs {
  padding-bottom: 10px;
}
.plat-tab {
  font-size: 12px;
  color: var(--text-2);
  background: transparent;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  padding: 2px 10px;
  cursor: pointer;
  transition:
    color 0.14s ease,
    border-color 0.14s ease,
    background 0.14s ease;
}
.plat-tab:hover {
  color: var(--text-0);
}
.plat-tab.on {
  color: var(--brand);
  border-color: var(--brand);
  background: var(--brand-soft);
}
/* 名单里的平台标识：小圆点足够区分，不占昵称的横向空间 */
.plat-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-right: 5px;
  vertical-align: 1px;
}
.acc-list {
  display: flex;
  flex-direction: column;
}
.acc-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 6px;
  /* 与全局 --radius-sm 对齐，页面只用一套圆角刻度 */
  border-radius: var(--radius-sm);
  cursor: pointer;
  /* 选中态用左侧主题色竖条，避免只靠背景色导致的弱对比 */
  border-left: 2px solid transparent;
  transition:
    background 0.14s ease,
    border-color 0.14s ease;
}
.acc-row:hover {
  background: var(--bg-hover);
}
.acc-row:active {
  transform: translateY(1px);
}
.acc-row.active {
  background: var(--brand-soft);
  border-left-color: var(--brand);
}
.acc-row.active .acc-name {
  color: var(--brand);
}
/* 暂停抓取的大V整行淡化，仅承载真实状态 */
.acc-row.disabled {
  opacity: 0.55;
}
.acc-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.acc-name {
  font-size: 13px;
  color: var(--text-0);
}
.acc-desc {
  font-size: 11.5px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.acc-ops {
  display: flex;
  align-items: center;
  gap: 2px;
}
.feed {
  padding: 8px 18px;
  min-height: 200px;
}
.post-list {
  display: flex;
  flex-direction: column;
}
.post-row {
  display: flex;
  gap: 12px;
  padding: 14px 4px;
  border-bottom: 1px solid var(--border-soft);
  color: inherit;
}
.post-row:last-child {
  border-bottom: none;
}
.post-clickable {
  cursor: pointer;
  transition: background 0.14s ease;
}
.post-clickable:hover {
  background: var(--bg-hover);
}
/* 折叠渐隐要跟随行的 hover 背景，否则悬停时会露出一条与底色不符的横带 */
.post-clickable:hover .post-content.clamped::after {
  background: linear-gradient(transparent, var(--bg-hover));
}
.post-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  flex: 1;
}
.post-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.post-author {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-0);
}
/* 转发标记：中性描边，不用彩色标签抢正文注意力 */
.post-kind {
  font-size: 11px;
  color: var(--text-2);
  border: 1px solid var(--border-soft);
  border-radius: 4px;
  padding: 0 4px;
}
/* 平台徽标：单字描边标签，颜色取各平台品牌色，一眼区分内容出处 */
.post-plat {
  font-size: 10.5px;
  line-height: 15px;
  border: 1px solid;
  border-radius: 4px;
  padding: 0 4px;
  flex: none;
}
/* 时间即原文入口：整行不再是链接，避免与正文内的话题/@ 形成嵌套 a */
.post-time {
  font-size: 12.5px;
  color: var(--text-2);
  text-decoration: none;
  margin-left: auto;
}
.post-time:hover {
  color: var(--brand);
}
.post-text {
  font-size: 13.5px;
  color: var(--text-1);
}
.post-quote {
  font-size: 13px;
  color: var(--text-2);
  border-left: 2px solid var(--border-soft);
  padding-left: 10px;
  margin-top: 2px;
}
/*
 * 长博文折叠到 4 行。行高在此层用固定像素声明、由正文与引用块共同继承，
 * 两者字号不同（13.5 / 13）但行高一致，折叠高度才能正好落在行边界上，
 * 否则末行会被切在字形中间。
 */
.post-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
  line-height: 23px;
}
.post-content.clamped {
  max-height: 92px;
  overflow: hidden;
  position: relative;
}
.post-content.clamped::after {
  content: '';
  position: absolute;
  inset: auto 0 0 0;
  height: 23px;
  background: linear-gradient(transparent, var(--bg-2));
  pointer-events: none;
}
.post-more {
  align-self: flex-start;
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-size: 12.5px;
  color: var(--brand);
  cursor: pointer;
}
.post-more:hover {
  text-decoration: underline;
}
/* 配图网格：单图给大一些（信息图需要看清），多图按方格排 */
.post-images {
  display: grid;
  gap: 4px;
  margin-top: 4px;
}
.post-images.cols-1 {
  grid-template-columns: minmax(0, 260px);
}
.post-images.cols-2 {
  grid-template-columns: repeat(2, minmax(0, 150px));
}
.post-images.cols-3 {
  grid-template-columns: repeat(3, minmax(0, 130px));
}
.post-img {
  aspect-ratio: 3 / 4;
  width: 100%;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-soft);
  overflow: hidden;
  cursor: zoom-in;
  background: var(--bg-3);
}
/* 单图比例由内联 style 按原图宽高给定，这里只兜底极端长图不要撑爆整行 */
.post-images.cols-1 .post-img {
  aspect-ratio: auto;
  max-height: 420px;
}
.post-stats {
  display: flex;
  gap: 14px;
  font-size: 12px;
  color: var(--text-2);
  margin-top: 2px;
}
/* 转/评/赞用列间距分隔，不用中点串起来 */
.stat {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.stat-k {
  opacity: 0.72;
}

/* 骨架屏：与真实行同形（头像 + 三行文本），避免加载完成时的布局跳变 */
.skeleton-row {
  pointer-events: none;
}
.sk {
  background: var(--bg-3);
  border-radius: var(--radius-sm);
}
.sk-avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  flex-shrink: 0;
}
.sk-line {
  height: 12px;
  margin: 5px 0;
}
@media (prefers-reduced-motion: no-preference) {
  .sk {
    animation: sk-pulse 1.4s ease-in-out infinite;
  }
}
@keyframes sk-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}

/* 空态：说明当前该做什么，并直接给出那一个动作 */
.feed-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 64px 20px;
  text-align: center;
}
.empty-title {
  font-family: var(--font-display);
  font-size: 15px;
  color: var(--text-0);
}
.empty-desc {
  margin: 0;
  max-width: 42ch;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-2);
}
.search-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}
.add-hint {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
  margin: 0 0 10px;
}
.cand-list {
  display: flex;
  flex-direction: column;
  max-height: 380px;
  overflow-y: auto;
}
.cand-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 2px;
  border-bottom: 1px solid var(--border-soft);
}
.cand-row:last-child {
  border-bottom: none;
}
.cand-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.cand-name {
  font-size: 13px;
  color: var(--text-0);
}
.cand-desc {
  font-size: 11.5px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
