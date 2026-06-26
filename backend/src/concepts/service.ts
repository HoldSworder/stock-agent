import type {
  ConceptStockItem,
  ConceptStocksResult,
  ConceptWindow,
  HotConceptGroup,
  HotConceptItem,
  HotConceptOverview,
} from '@stock-agent/shared';
import { nowIso, shanghaiToday } from '../util';
import { fetchConceptFundFlow, fetchConceptStocks, type ConceptFlowItem } from './data';

// 热门细分概念主线归纳（确定性、规则化、零量化知识）：
// 以同花顺「概念资金流·即时」为全集（覆盖六氟化钨等东财没有的细分概念），
// 当日涨幅 + 资金净额 两维组内归一加权成 0-100 热度分，并按关键词归纳到父级主线主题。
// 点击概念可经问财展开板块全部成分股，标注龙头(总市值最大)/今日领涨(涨幅最高)。
// 全程只读，不下单、不调 LLM（成分展开经问财属取数，非 LLM 推理）。

// ===== 可校准常量 =====
/** 扁平榜展示上限（按热度分降序截取） */
const MAX_FLAT = 50;
/** 综合热度分权重：涨幅 / 资金净额（和为 1；同花顺无成分接口，不含新高维） */
const W_PCT = 0.5;
const W_MONEY = 0.5;

/**
 * 应剔除的伪概念（同花顺指数/风格/交易行为/宽泛汇总类）：避免「同花顺新质50/昨日涨停/北交所」等噪声霸榜。
 * 命中即剔除。可按需增改。
 */
const JUNK_PATTERNS: readonly RegExp[] = [
  /同花顺.*指数|果指数|新质\d+|^融.*指数/,
  /昨日|连板|涨停|跌停|触板|打板|多板|振幅|新高|新低|破净|破发|高送转|送转|举牌|回购|增持|减持|质押|商誉|预盈|预增|预亏|预减|扭亏|摘帽|ST/,
  /MSCI|富时|标普|道琼斯|纳入|成份|成分|融资融券|两融|转债|可转债/,
  /小盘|中盘|大盘|微盘|蓝筹|白马|绩优|超大盘|中字头|央企|国企改革|地方国企|低价股|题材股|热股|风格/,
  /北交所|科创板|创业板|次新|注册制/,
];

function isJunk(name: string): boolean {
  return JUNK_PATTERNS.some((re) => re.test(name));
}

/**
 * 细分概念 → 父级主线主题归纳关键词表（按顺序匹配，先命中先归类）。未命中归入「其他」。
 */
const THEME_KEYWORDS: ReadonlyArray<{ kw: RegExp; theme: string }> = [
  { kw: /半导体|芯片|集成电路|存储|封装|光刻|刻蚀|晶圆|玻璃基板|六氟化钨|碳化硅|第三代半导体|先进封装|HBM|高带宽内存|EDA|RISC|RCD|TCB|铜缆|氮化镓|氦气|工业气体|有机硅|电子特气|特气/, theme: '半导体' },
  { kw: /算力|数据中心|液冷|服务器|光模块|光通信|交换机|IDC|英伟达|GPU|PCB|铜连接|CPO/, theme: 'AI算力' },
  { kw: /人工智能|AI|大模型|多模态|AIGC|智能体|算法|机器视觉|语料|训练|算法/, theme: 'AI应用' },
  { kw: /通信|通讯|5G|6G|卫星|北斗|射频|天线/, theme: '通信' },
  { kw: /机器人|人形|减速器|灵巧手|丝杠|执行器|谐波/, theme: '机器人' },
  { kw: /电池|锂电|储能|固态|钠离子|钒电|氢能|燃料电池|换电|HJT|TOPCon|BC电池|钙钛矿/, theme: '电池储能' },
  { kw: /光伏|风电|绿电|绿色电力/, theme: '光伏风电' },
  { kw: /新能源车|整车|汽车零部件|汽车|智能驾驶|无人驾驶|车路协同|激光雷达|线控/, theme: '汽车智能化' },
  { kw: /军工|国防|航空航天|导弹|无人机|低空|eVTOL|大飞机|航发|商业航天|空间站|卫星互联网/, theme: '军工/低空' },
  { kw: /创新药|生物医药|医疗|医药|疫苗|CXO|减肥药|GLP|脑机|基因|细胞|牙科/, theme: '医药' },
  { kw: /白酒|食品饮料|消费|零食|预制菜|免税|旅游|酒店|商超|宠物|乳业|酿酒|鸡肉|猪肉/, theme: '消费' },
  { kw: /证券|券商|银行|保险|金融|多元金融/, theme: '大金融' },
  { kw: /有色|稀土|金属|黄金|白银|铜|铝|锂矿|钨|钼|永磁/, theme: '有色资源' },
  { kw: /煤炭|石油|油气|燃气|电力|电网|核电|特高压|虚拟电厂|页岩气/, theme: '能源电力' },
  { kw: /地产|房地产|建材|建筑|水泥|装修/, theme: '地产链' },
  { kw: /传媒|影视|游戏|出版|短剧|IP|元宇宙|虚拟人|电子竞技/, theme: '传媒游戏' },
  { kw: /计算机|软件|信创|国产|操作系统|数据库|网络安全|工业软件|云计算|SaaS/, theme: '计算机/信创' },
  { kw: /数字货币|稳定币|区块链|跨境支付|Web3/, theme: '数字货币' },
  { kw: /OLED|MiniLED|MicroLED|LED|柔性屏|折叠屏|裸眼3D|3D玻璃|显示|屏下摄像|纳米银|电子纸/, theme: '面板显示' },
];

/** 把细分概念名归纳到父级主线主题（未命中 → 其他） */
function mapTheme(name: string): string {
  for (const t of THEME_KEYWORDS) {
    if (t.kw.test(name)) return t.theme;
  }
  return '其他';
}

const r1 = (n: number): number => Math.round(n * 10) / 10;
const r2 = (n: number): number => Math.round(n * 100) / 100;
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** 在候选集内对某维做 min-max 归一到 0-100（全相等/空集返回全 0 映射） */
function normalize(values: number[]): (v: number) => number {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return () => 0;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (max - min < 1e-9) return () => 0;
  return (v: number) => (Number.isFinite(v) ? clamp(((v - min) / (max - min)) * 100, 0, 100) : 0);
}

/**
 * 组装热门细分概念总览（确定性只读）。
 * 两维：近 N 日涨幅 + 资金净额（同花顺概念资金流·N日排行），组内归一加权成热度分，再按主线主题归纳。
 */
export async function buildHotConcepts(window: ConceptWindow = '5日'): Promise<HotConceptOverview> {
  const tradeDate = shanghaiToday();
  let stale = false;

  const flow = await fetchConceptFundFlow(window).catch(() => [] as ConceptFlowItem[]);
  if (flow.length === 0) stale = true;

  // 剔除伪概念
  const universe = flow.filter((f) => f.name && !isJunk(f.name));

  // 两维组内归一器
  const pctNorm = normalize(universe.map((f) => f.pct ?? 0));
  const moneyNorm = normalize(universe.map((f) => f.netInflow ?? 0));

  const items: HotConceptItem[] = universe.map((f) => {
    const pct = f.pct ?? 0;
    const netInflow = f.netInflow;
    const heatScore = Math.round(
      clamp(W_PCT * pctNorm(pct) + W_MONEY * moneyNorm(netInflow ?? 0), 0, 100),
    );
    const theme = mapTheme(f.name);
    const moneyText = netInflow == null ? '' : `·净额${netInflow >= 0 ? '+' : ''}${r1(netInflow)}亿`;
    const leadText = f.leadStock ? `·今日领涨${f.leadStock}${f.leadStockPct != null ? `(${f.leadStockPct >= 0 ? '+' : ''}${r1(f.leadStockPct)}%)` : ''}` : '';
    const note = `涨幅${pct >= 0 ? '+' : ''}${r1(pct)}%${moneyText}${f.companies != null ? `·${f.companies}家` : ''}${leadText}·热度${heatScore}`;
    return {
      boardName: f.name,
      pct: r1(pct),
      netInflow: netInflow == null ? null : r2(netInflow),
      companies: f.companies,
      heatScore,
      theme,
      leadStock: f.leadStock,
      leadStockPct: f.leadStockPct == null ? null : r1(f.leadStockPct),
      note,
    };
  });

  // 扁平榜（按热度降序，截断）
  const flat = [...items].sort((a, b) => b.heatScore - a.heatScore).slice(0, MAX_FLAT);

  // 按主线主题归纳分组（组内按热度降序，组按组内最高热度降序，「其他」沉底）
  const groupMap = new Map<string, HotConceptItem[]>();
  for (const it of items) {
    const arr = groupMap.get(it.theme) ?? [];
    arr.push(it);
    groupMap.set(it.theme, arr);
  }
  const groups: HotConceptGroup[] = [...groupMap.entries()]
    .map(([theme, arr]) => {
      const sorted = arr.sort((a, b) => b.heatScore - a.heatScore);
      return { theme, items: sorted, topHeat: sorted[0]?.heatScore ?? 0 };
    })
    .sort((a, b) => {
      if (a.theme === '其他') return 1;
      if (b.theme === '其他') return -1;
      return b.topHeat - a.topHeat;
    });

  return {
    asOf: nowIso(),
    tradeDate,
    window,
    groups,
    flat,
    note:
      `热门细分概念（同花顺概念资金流·近${window}，确定性只读，仅供参考，不构成投资建议）：按 近${window}涨幅 + 资金净额 两维归一加权合成热度分，` +
      '并按关键词归纳到父级主线主题，便于「锁强赛道 → 赛道内下钻」。点击概念可展开板块全部成分股（经问财，标注龙头/今日领涨）。' +
      (stale ? '⚠️ 同花顺概念资金流取数降级，榜为不完整估计（请到数据源页检查 AKShare/aktools 配置）。' : ''),
    stale,
  };
}

/**
 * 点击概念展开：取板块全部成分股并标注龙头(总市值最大)/今日领涨(涨幅最高)。
 * 经问财取数（同花顺成分接口已被 akshare 移除）。取数失败由路由层降级返回 502。
 */
export async function buildConceptStocks(concept: string): Promise<ConceptStocksResult> {
  const name = (concept ?? '').trim();
  const stocks = await fetchConceptStocks(name);
  // 标注龙头（总市值最大）与今日领涨（涨幅最高）
  let leaderIdx = -1;
  let topGainIdx = -1;
  let maxCap = -Infinity;
  let maxPct = -Infinity;
  stocks.forEach((s: ConceptStockItem, i: number) => {
    if (s.marketCap != null && s.marketCap > maxCap) {
      maxCap = s.marketCap;
      leaderIdx = i;
    }
    if (s.pct != null && s.pct > maxPct) {
      maxPct = s.pct;
      topGainIdx = i;
    }
  });
  if (leaderIdx >= 0) stocks[leaderIdx].isLeader = true;
  if (topGainIdx >= 0) stocks[topGainIdx].isTopGainer = true;
  // 默认按总市值降序（龙头在前）；无市值的沉底
  stocks.sort((a, b) => (b.marketCap ?? -1) - (a.marketCap ?? -1));
  return {
    concept: name,
    stocks,
    asOf: nowIso(),
    note:
      stocks.length === 0
        ? '未取到成分股（问财未配置或该概念无匹配；到数据源页配置「同花顺问财个股选股」后可用）。'
        : '成分股经问财取数（按总市值降序），★龙头=总市值最大，▲今日领涨=当日涨幅最高，仅供参考。',
  };
}
