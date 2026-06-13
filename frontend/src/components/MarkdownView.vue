<script setup lang="ts">
import { computed } from 'vue';
import MarkdownIt from 'markdown-it';

const props = defineProps<{ source?: string | null }>();

// html:false 禁用原始 HTML，杜绝 XSS；linkify 自动识别链接；breaks 让单换行也成 <br>
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

const rendered = computed(() => (props.source ? md.render(props.source) : ''));
</script>

<template>
  <div class="md-body" v-html="rendered" />
</template>

<style scoped>
.md-body {
  font-size: 14px;
  line-height: 1.7;
  color: var(--text-0);
  word-break: break-word;
}
.md-body :deep(h1),
.md-body :deep(h2),
.md-body :deep(h3),
.md-body :deep(h4) {
  margin: 16px 0 8px;
  font-weight: 600;
  line-height: 1.4;
}
.md-body :deep(h1) {
  font-size: 20px;
}
.md-body :deep(h2) {
  font-size: 17px;
}
.md-body :deep(h3) {
  font-size: 15px;
}
.md-body :deep(p) {
  margin: 8px 0;
}
.md-body :deep(ul),
.md-body :deep(ol) {
  margin: 8px 0;
  padding-left: 22px;
}
.md-body :deep(li) {
  margin: 4px 0;
}
.md-body :deep(strong) {
  color: var(--text-0);
  font-weight: 600;
}
.md-body :deep(a) {
  color: var(--brand);
  text-decoration: none;
}
.md-body :deep(a:hover) {
  text-decoration: underline;
}
.md-body :deep(code) {
  font-family: var(--font-mono);
  font-size: 12.5px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bg-hover);
}
.md-body :deep(pre) {
  margin: 10px 0;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  background: var(--bg-2);
  border: 1px solid var(--border);
  overflow: auto;
}
.md-body :deep(pre code) {
  padding: 0;
  background: none;
}
.md-body :deep(blockquote) {
  margin: 10px 0;
  padding: 4px 14px;
  border-left: 3px solid var(--border);
  color: var(--text-1);
}
.md-body :deep(table) {
  border-collapse: collapse;
  margin: 10px 0;
  width: 100%;
  font-size: 13px;
}
.md-body :deep(th),
.md-body :deep(td) {
  border: 1px solid var(--border);
  padding: 6px 10px;
  text-align: left;
}
.md-body :deep(th) {
  background: var(--bg-2);
}
.md-body :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 14px 0;
}
</style>
