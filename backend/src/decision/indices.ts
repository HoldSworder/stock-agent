import type { DecisionIndexInfo } from '@stock-agent/shared';

// 指数辩论决策白名单：指数 6 位码与个股撞码（沪深300=000300、上证=000001=平安银行），
// 且港股/外围指数无 6 位码，故按预置白名单经 secid（市场前缀.代码）取数，规避撞码/解析歧义。
// secid 取值与 market/eastmoney.ts 的 INDEX_SECIDS / GLOBAL_INDEX_DEFS 保持一致。

/** 单个可决策指数定义 */
export interface IndexDef {
  /** 稳定主键（历史 refKey / 前端选项 value），与 secid 一一对应 */
  key: string;
  /** 指数中文名 */
  name: string;
  /** 东财 secid（市场前缀.代码），取数唯一依据 */
  secid: string;
  /** 解析别名（用户输入/选择的容错匹配，全部小写比较） */
  aliases: string[];
}

/** 可决策指数白名单（A 股核心指数 + 港股 + 外围中概/美股关键指数） */
export const INDEX_DEFS: readonly IndexDef[] = [
  // —— 港股 ——
  {
    key: 'HSTECH',
    name: '恒生科技指数',
    // 港股指数 K 线（push2his）走真实市场号 124；100.* 仅实时快照聚合，取 K 线为空
    secid: '124.HSTECH',
    aliases: ['hstech', '恒生科技', '恒生科技指数', '恒科'],
  },
  { key: 'HSI', name: '恒生指数', secid: '100.HSI', aliases: ['hsi', '恒生', '恒生指数', '恒指'] },
  // —— 中概（A 股次日情绪关键参考）——
  {
    key: 'HXC',
    name: '纳斯达克中国金龙指数',
    secid: '100.HXC',
    aliases: ['hxc', '中国金龙', '金龙指数', '纳斯达克中国金龙', '中概'],
  },
  // —— 美股 ——
  { key: 'NDX', name: '纳斯达克100', secid: '100.NDX', aliases: ['ndx', '纳指', '纳指100', '纳斯达克100', '纳斯达克'] },
  { key: 'SPX', name: '标普500', secid: '100.SPX', aliases: ['spx', '标普', '标普500', 's&p500', 'sp500'] },
  { key: 'DJIA', name: '道琼斯指数', secid: '100.DJIA', aliases: ['djia', '道指', '道琼斯', '道琼斯指数'] },
  // —— A 股核心 ——
  {
    key: 'CSI300',
    name: '沪深300',
    secid: '1.000300',
    aliases: ['csi300', '沪深300', '沪深三百', '000300', 'hs300'],
  },
  { key: 'SSEC', name: '上证指数', secid: '1.000001', aliases: ['ssec', '上证', '上证指数', '大盘'] },
  { key: 'SZSE', name: '深证成指', secid: '0.399001', aliases: ['szse', '深成指', '深证成指', '深成'] },
  { key: 'CHINEXT', name: '创业板指', secid: '0.399006', aliases: ['chinext', '创业板', '创业板指', '创指'] },
  { key: 'STAR50', name: '科创50', secid: '1.000688', aliases: ['star50', '科创50', '科创板50', '科创'] },
  { key: 'BSE50', name: '北证50', secid: '0.899050', aliases: ['bse50', '北证50', '北交所50', '北证'] },
  { key: 'XIN9', name: '富时中国A50', secid: '100.XIN9', aliases: ['xin9', 'a50', '富时a50', '富时中国a50'] },
];

/** 按 key / 名称 / 别名（不区分大小写）解析指数定义，命中返回，否则 null */
export function resolveIndex(input: unknown): IndexDef | null {
  const s = String(input ?? '').trim().toLowerCase();
  if (!s) return null;
  return (
    INDEX_DEFS.find(
      (d) => d.key.toLowerCase() === s || d.name.toLowerCase() === s || d.aliases.includes(s),
    ) ?? null
  );
}

/** 指数白名单（供前端下拉，仅暴露 key/name/secid） */
export function listIndexDefs(): DecisionIndexInfo[] {
  return INDEX_DEFS.map((d) => ({ key: d.key, name: d.name, secid: d.secid }));
}

/**
 * 指数取数候选 secid（按命中概率排序，去重）：快照/K 线的真实市场号因指数而异且不一致，
 * 取数时依次尝试、命中首个有数据者即用，规避逐一确认市场号（同 akshare 指数取数兜底）。
 */
export function indexSecidCandidates(def: IndexDef): string[] {
  const code = def.secid.split('.')[1] ?? def.key;
  const candidates = [def.secid, `124.${code}`, `100.${code}`, `1.${code}`, `0.${code}`];
  return [...new Set(candidates)];
}
