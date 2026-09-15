import { defineStore } from 'pinia';
import { ref } from 'vue';

/**
 * 这个标的能不能唤起弹窗。有 secid（指数）或 code 为个股 6 位 / 板块 BKxxxx 才行。
 *
 * 导出给调用方在渲染入口前先问一次：open() 对不合格的 code 会静默返回，
 * 若调用方照样把「展开明细」画出来，点下去什么都不发生——
 * 一个看着能点却没反应的入口比没有入口更糟。
 */
export function canOpenKline(code: string, secid = ''): boolean {
  return !!secid || /^(\d{6}|BK\d+)$/i.test(code);
}

/** 全局 K 线弹窗：系统内任意可点击标的处调用 open() 唤起 */
export const useKlineStore = defineStore('kline', () => {
  const visible = ref(false);
  const code = ref('');
  const name = ref('');
  // 大盘指数因 code 与个股撞码，需显式 secid；个股/板块留空由后端按 code 解析
  const secid = ref('');

  function open(targetCode: string, targetName = '', targetSecid = '') {
    if (!canOpenKline(targetCode, targetSecid)) return;
    code.value = targetCode;
    name.value = targetName;
    secid.value = targetSecid;
    visible.value = true;
  }

  function close() {
    visible.value = false;
  }

  return { visible, code, name, secid, open, close };
});
