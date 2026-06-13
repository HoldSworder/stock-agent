import { defineStore } from 'pinia';
import { ref } from 'vue';

/** 全局 K 线弹窗：系统内任意可点击标的处调用 open() 唤起 */
export const useKlineStore = defineStore('kline', () => {
  const visible = ref(false);
  const code = ref('');
  const name = ref('');
  // 大盘指数因 code 与个股撞码，需显式 secid；个股/板块留空由后端按 code 解析
  const secid = ref('');

  function open(targetCode: string, targetName = '', targetSecid = '') {
    // 有 secid（指数）或 code 为个股 6 位 / 板块 BKxxxx 才唤起
    if (!targetSecid && !/^(\d{6}|BK\d+)$/i.test(targetCode)) return;
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
