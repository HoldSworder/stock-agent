<script setup lang="ts">
import { computed } from 'vue';
import type { KolPlatform } from '@stock-agent/shared';

// 大V发帖富文本渲染：把原始文本里的表情占位、话题、@提及、链接标记切成带类型的片段，
// 各自套样式。强调色只用主题的 --brand，不引入第二种accent。
// 转发链（//@某人:）由父组件在渲染前切分，此处只管单段文本。
// 话题/@ 的落点随平台走，小红书笔记不能跳到微博去。

const props = withDefaults(defineProps<{ text: string; platform?: KolPlatform }>(), {
  platform: 'weibo',
});

/**
 * 微博表情占位（形如 [允悲]）到 Unicode emoji 的映射。
 * 只收录语义明确、不会歧义的常见项；未命中的保持 [xx] 原样并降级为浅色小标签，
 * 这样新表情不会被错误映射成含义不符的图形。
 */
const EMOJI: Record<string, string> = {
  笑cry: '😂', 允悲: '😭', 泪: '😢', 哈哈: '😄', 嘻嘻: '😃', 偷笑: '🤭',
  憧憬: '🤩', 色: '😍', 心: '❤️', 伤心: '💔', 鲜花: '🌹', 玫瑰: '🌹',
  赞: '👍', good: '👍', 拳头: '✊', 作揖: '🙏', 握手: '🤝', 鼓掌: '👏',
  摊手: '🤷', 思考: '🤔', 疑问: '❓', 汗: '😅', 挤眼: '😉', 馋嘴: '🤤',
  吃瓜: '🍉', doge: '🐶', 二哈: '🐶', 抱抱: '🤗', 加油: '💪', 熊猫: '🐼',
  太开心: '😁', 微笑: '🙂', 可怜: '🥺', 怒: '😠', 打脸: '👋', 傻眼: '😳',
  吃惊: '😲', 生病: '😷', 睡: '😴', 晕: '😵', 衰: '😔', 白眼: '🙄',
  抓狂: '😫', 阴险: '😏', 酷: '😎', 钱: '🤑', 蜡烛: '🕯️', 话筒: '🎤',
  music: '🎵', 太阳: '☀️', 月亮: '🌙', 下雨: '🌧️', 雪: '❄️', 咖啡: '☕',
  蛋糕: '🎂', 礼物: '🎁', 干杯: '🍻', 烟花: '🎆', 鞭炮: '🧨', 红包: '🧧',
  中国赞: '👍', 给力: '💪', 威武: '💪', 悲伤: '😞', 费解: '😕', 呵呵: '🙂',
};

type SegKind = 'text' | 'emoji' | 'raw-emoji' | 'topic' | 'mention' | 'link' | 'dead-link';
interface Seg {
  kind: SegKind;
  /** 展示文本 */
  v: string;
}

// 一次扫描切出全部标记：[表情] / #话题# / @用户 / 网页链接 / 裸 URL
const TOKEN =
  /(\[[^[\]\s]{1,10}\])|(#[^#\n]{1,40}#)|(@[\w\u4e00-\u9fa5.\-_]{1,30})|(https?:\/\/\S+)|(网页链接|查看图片|微博视频|О网页链接)/g;

/** 把原始文本切成片段序列 */
const segments = computed<Seg[]>(() => {
  const out: Seg[] = [];
  const s = props.text ?? '';
  let last = 0;
  for (const m of s.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ kind: 'text', v: s.slice(last, i) });
    const [tok, emoji, topic, mention, url, marker] = m;
    if (emoji) {
      const name = emoji.slice(1, -1);
      const mapped = EMOJI[name];
      out.push(mapped ? { kind: 'emoji', v: mapped } : { kind: 'raw-emoji', v: name });
    } else if (topic) {
      out.push({ kind: 'topic', v: topic.slice(1, -1) });
    } else if (mention) {
      out.push({ kind: 'mention', v: mention });
    } else if (url) {
      out.push({ kind: 'link', v: url });
    } else if (marker) {
      // 旧数据里外链被微博替换成了「网页链接」占位且未保留 href，
      // 按普通文字渲染，不做成看着能点其实不能点的假链接
      out.push({ kind: 'dead-link', v: marker });
    } else {
      out.push({ kind: 'text', v: tok });
    }
    last = i + tok.length;
  }
  if (last < s.length) out.push({ kind: 'text', v: s.slice(last) });
  return out;
});

// 微博一律走 m.weibo.cn：桌面版 s.weibo.com 搜索页强制登录，点过去只会看到登录墙。
// 移动端话题页与 /n/<昵称> 用户页在访客态就能正常打开（与正文里微博自己用的地址一致）。

/** 话题页（微博 containerid 为话题检索的固定前缀 231522；小红书走站内搜索） */
const topicUrl = (t: string) =>
  props.platform === 'xiaohongshu'
    ? `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(t)}`
    : `https://m.weibo.cn/search?containerid=${encodeURIComponent(`231522type=1&t=10&q=#${t}#`)}&isnewpage=1`;
/** 用户页：微博 /n/<昵称> 会解析成对应 uid 主页；小红书没有等价地址，退回用户搜索 */
const mentionUrl = (m: string) =>
  props.platform === 'xiaohongshu'
    ? `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(m.slice(1))}&type=54`
    : `https://m.weibo.cn/n/${encodeURIComponent(m.slice(1))}`;

/** 链接只展示域名，长 URL 会把一条博文撑得看不出重点，完整地址仍在 href 上 */
function shortUrl(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
}
</script>

<template>
  <span class="rich">
    <template v-for="(s, i) in segments" :key="i">
      <a
        v-if="s.kind === 'topic'"
        class="seg-topic"
        :href="topicUrl(s.v)"
        target="_blank"
        rel="noopener"
        @click.stop
        >#{{ s.v }}#</a
      >
      <a
        v-else-if="s.kind === 'mention'"
        class="seg-mention"
        :href="mentionUrl(s.v)"
        target="_blank"
        rel="noopener"
        @click.stop
        >{{ s.v }}</a
      >
      <a
        v-else-if="s.kind === 'link'"
        class="seg-link"
        :href="s.v"
        :title="s.v"
        target="_blank"
        rel="noopener"
        @click.stop
        >{{ shortUrl(s.v) }}</a
      >
      <span v-else-if="s.kind === 'dead-link'" class="seg-dead-link">{{ s.v }}</span>
      <span v-else-if="s.kind === 'emoji'" class="seg-emoji">{{ s.v }}</span>
      <span v-else-if="s.kind === 'raw-emoji'" class="seg-raw-emoji">{{ s.v }}</span>
      <template v-else>{{ s.v }}</template>
    </template>
  </span>
</template>

<style scoped>
.rich {
  white-space: pre-wrap;
  word-break: break-word;
}
/* 话题：主题色描边小标签，可点进微博话题页 */
.seg-topic {
  color: var(--brand);
  background: var(--brand-soft);
  border-radius: var(--radius-sm);
  padding: 0 5px;
  text-decoration: none;
  transition: background 0.14s ease;
}
.seg-topic:hover {
  background: var(--brand-glow);
}
/* @提及：只上色不加底，避免一句话里多个 @ 时视觉过重 */
.seg-mention {
  color: var(--brand);
  text-decoration: none;
}
.seg-mention:hover {
  text-decoration: underline;
}
.seg-link {
  color: var(--brand);
  text-decoration: none;
  border-bottom: 1px dashed var(--border);
}
.seg-link:hover {
  border-bottom-style: solid;
}
/* 不可点的外链占位：保持正文灰度，不给任何可点暗示 */
.seg-dead-link {
  color: var(--text-2);
}
/* 微博表情：略放大补偿 emoji 视觉重心偏低 */
.seg-emoji {
  font-size: 1.12em;
  line-height: 1;
  vertical-align: -0.08em;
}
/* 未收录的表情：降级为浅色小标签，不冒充 emoji */
.seg-raw-emoji {
  font-size: 11px;
  color: var(--text-2);
  background: var(--bg-3);
  border-radius: 4px;
  padding: 1px 4px;
  margin: 0 1px;
}
</style>
