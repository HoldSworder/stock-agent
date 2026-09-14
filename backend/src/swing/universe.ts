import type { KlineBar, SwingTrackCategory } from '@stock-agent/shared';
import { callAkshare } from '../market/akshare';
import { cached } from '../lib/ttlCache';

// 波段扫描的标的宇宙：赛道 → 代表 ETF。
//
// 为什么用 ETF 代表赛道而不是直接用板块指数：
// 板块指数的历史 K 线在本环境取不到（东财 push2his 不通、aktools 板块历史接口 500，
// 实测见 scripts/swingBoards.probe.ts），而 ETF 与个股经 datasource/scheduler 多源
// failover 完全可用。ETF 还有个额外好处——它是能真正下单的东西，
// 而「畜禽饲料」这类板块指数即便算出信号也买不了。
//
// 为什么不手写 ETF 代码表：
// 仓库原有的 breadth/service.ts:BOARD_ETF_KEYWORDS 手写了 21 条，问题有三个——
// 覆盖不全（全市场 1601 只 ETF、五十多个赛道）、同赛道重复（半导体系有 26 只高度重叠）、
// 且会随改名/退市/流动性迁移而过期（同一赛道哪只最活跃是会变的）。
// 这里改成从实时清单自动挑：ETF 名称格式很规整（「赛道名 + ETF + 基金公司」），
// 先从名称提取赛道名，再用归并表合并语义重叠的赛道，最后每赛道取成交额最大者。
// 代码不写死，冷下去的赛道自动退出，启动后成交额上来自动回归。

/** ETF 清单缓存时长：成分与流动性慢变，6h 足够，避免每轮扫描都打一次 aktools */
const UNIVERSE_TTL_MS = 6 * 3600_000;

/**
 * 最低成交额门槛（元）。
 *
 * 按**本人实际下单规模**定，不按机构口径：单标的上限占总资产 10%、一笔至多几万元，
 * 5000 万日成交额的进出滑点可以忽略。
 * 标定过程中取过 2 亿（机构常用口径），结果把光伏（1.36 亿）、新能源车（1.06 亿）、
 * 家电（0.65 亿）这些「当下冷、将来可能启动」的赛道永久挡在外面——
 * 而中线主升浪恰恰要在冷的时候就盯上它们，所以这个门槛必须按散户口径放宽。
 */
export const MIN_AMOUNT = 50_000_000;

/**
 * 最低流通市值门槛（元）。
 *
 * 成交额高但盘子极小的标的容易被单笔资金推动，形态不可信。
 * 实测有新发港股 ETF 单日成交 7 亿而流通市值仅 2.3 亿——这种标的的分型与中枢没有参考价值。
 */
export const MIN_FLOAT_CAP = 1_000_000_000;

/**
 * 赛道类别：决定页面分组，也决定形态判断能否互相参照。
 *
 * 直接复用 shared 的对外类型，**不另立一套**——先前这里自定义过一个含 'excluded'
 * 的枚举，与对外类型（含 'own'、不含 'excluded'）语义交叉，
 * 结果每次跨边界都要转换，类型检查也报了错。
 * 「不参与扫描」不是一种赛道分类，而是分类的缺失，所以用 null 表示。
 */
export type TrackCategory = SwingTrackCategory;

/**
 * 语义归并表：把高度重叠的赛道名合并成一个大类。
 *
 * **顺序即优先级，跨境与商品必须排在 A 股行业之前。**
 * 标定过程中把行业规则写在前面过，结果「证券保险」选中香港证券 ETF、
 * 「创新药」选中港股创新药、「化工」选中能源化工期货、「农业养殖」选中豆粕期货。
 * 这类错误在页面上看不出来（赛道名与标的名都对得上），
 * 但拿港股或商品期货的形态当 A 股赛道的判断依据是错的。
 *
 * category 为 null 的不进波段扫描。
 */
export const TRACK_MERGE: ReadonlyArray<{
  group: string;
  kw: RegExp;
  /** null 表示不参与波段扫描（货币与纯债价格几乎不动，算力道毫无意义） */
  category: TrackCategory | null;
}> = [
  // ===== 第一优先：不参与波段的 =====
  // 货币与纯债价格几乎不动，算背驰与区间毫无意义
  {
    group: '货币类',
    kw: /货币|日利|添益|现金|理财|国债|政金债|信用债|短融/,
    category: null,
  },

  // ===== 第二优先：跨境。必须早于行业，否则污染 A 股赛道 =====
  {
    group: '港股科技',
    kw: /恒生科技|港股科技|港股通信息技术|港股互联网|港股通互联网|恒生互联网|中概互联/,
    category: 'overseas',
  },
  { group: '港股医药', kw: /(港股|恒生).*(创新药|医药|医疗|生物)/, category: 'overseas' },
  { group: '港股金融', kw: /(港股|恒生|香港).*(金融|证券|非银|银行|保险)/, category: 'overseas' },
  { group: '港股其他', kw: /港股|恒生|H股/, category: 'overseas' },
  { group: '美股', kw: /纳指|纳斯达克|标普|道琼斯|美国|美股/, category: 'overseas' },
  // 中韩半导体等跨境双市场标的归海外，不能归港股——它跟踪中韩两地成分，
  // 归到港股会让人以为是港股赛道
  {
    group: '其他海外',
    kw: /日经|日本|德国|法国|越南|印度|东南亚|亚太|沙特|全球|中韩/,
    category: 'overseas',
  },

  // ===== 第三优先：商品期货。驱动逻辑与股票完全不同 =====
  {
    group: '商品期货',
    kw: /豆粕|能源化工|有色期货|粮食|农产品期货|原油|商品/,
    category: 'commodity',
  },
  { group: '黄金贵金属', kw: /黄金|^金$|白银|贵金属|上海金/, category: 'commodity' },

  // ===== 第四优先：宽基。单独成组，不与行业混排 =====
  { group: '宽基-科创', kw: /^科创(50|100|200)?$|科创综指/, category: 'broad' },
  { group: '宽基-创业板', kw: /^创业板(50|综指)?$/, category: 'broad' },
  { group: '宽基-沪深300', kw: /沪深300|^300$/, category: 'broad' },
  { group: '宽基-中证500', kw: /中证500|^500$/, category: 'broad' },
  { group: '宽基-中证1000', kw: /中证1000|^1000$/, category: 'broad' },
  { group: '宽基-中证2000', kw: /中证2000|^2000$/, category: 'broad' },
  { group: '宽基-A500', kw: /A500|中证A500/, category: 'broad' },
  { group: '宽基-A50', kw: /A50|中国A50/, category: 'broad' },
  { group: '宽基-中证800', kw: /中证800|^800$/, category: 'broad' },
  { group: '宽基-上证50', kw: /上证50|^50$/, category: 'broad' },
  { group: '宽基-上证180', kw: /上证180/, category: 'broad' },
  { group: '宽基-上证指数', kw: /上证指数|上证综指/, category: 'broad' },
  { group: '宽基-深证100', kw: /深证100|深证成指/, category: 'broad' },
  { group: '宽基-科创创业', kw: /科创创业|双创/, category: 'broad' },
  { group: '宽基-成长风格', kw: /^成长$|成长风格|科创成长|创业板成长/, category: 'broad' },
  { group: '红利低波', kw: /红利|低波|价值|高股息/, category: 'broad' },

  // ===== 第五优先：A 股行业赛道 =====
  { group: '半导体', kw: /半导体|芯片|集成电路|存储|封测/, category: 'industry' },
  { group: '人工智能', kw: /人工智能|AI|大模型|算力/, category: 'industry' },
  { group: '通信', kw: /通信|5G|光模块|光通信/, category: 'industry' },
  { group: '软件计算机', kw: /软件|计算机|信创|云计算|数据/, category: 'industry' },
  { group: '机器人', kw: /机器人|人形/, category: 'industry' },
  { group: '创新药', kw: /创新药|生物科技|生物医药/, category: 'industry' },
  { group: '医疗医药', kw: /医疗|医药|医疗器械|中药|疫苗/, category: 'industry' },
  { group: '证券保险', kw: /证券|券商|保险|非银/, category: 'industry' },
  { group: '银行', kw: /银行/, category: 'industry' },
  { group: '金融科技', kw: /金融科技|互联网金融/, category: 'industry' },
  { group: '军工', kw: /军工|国防|航空航天|航天/, category: 'industry' },
  { group: '卫星导航', kw: /卫星|导航|北斗/, category: 'industry' },
  { group: '新能源车', kw: /新能源车|汽车|智能汽车/, category: 'industry' },
  { group: '电池储能', kw: /电池|锂电|储能/, category: 'industry' },
  { group: '光伏风电', kw: /光伏|风电|绿电/, category: 'industry' },
  // 新能源综合是光伏+车+电池的混合口径，单独成组，不并进上面任一个——
  // 拿混合口径当单一赛道的判断依据会误导
  { group: '新能源综合', kw: /^新能源$/, category: 'industry' },
  { group: '电力电网', kw: /电力|电网|公用事业/, category: 'industry' },
  { group: '有色金属', kw: /有色|稀土|金属|铜|钢铁/, category: 'industry' },
  { group: '煤炭', kw: /煤炭|焦煤/, category: 'industry' },
  { group: '化工', kw: /化工|化纤/, category: 'industry' },
  { group: '石油天然气', kw: /石油|油气|天然气/, category: 'industry' },
  { group: '新材料', kw: /新材料|材料/, category: 'industry' },
  { group: '游戏传媒', kw: /游戏|传媒|影视|动漫|文化/, category: 'industry' },
  { group: '食品饮料', kw: /酒|食品|饮料|消费(?!电子)/, category: 'industry' },
  { group: '消费电子', kw: /消费电子|电子/, category: 'industry' },
  { group: '农业养殖', kw: /养殖|农业|种业|畜牧/, category: 'industry' },
  { group: '房地产', kw: /房地产|地产|建筑|建材/, category: 'industry' },
  { group: '家电', kw: /家电|家用电器/, category: 'industry' },
  { group: '机械制造', kw: /机械|工程机械|高端装备|智能制造|工业母机/, category: 'industry' },
  { group: '船舶', kw: /船舶|海工/, category: 'industry' },
  // 「科技」是跨行业综合口径（科技龙头指数），成分横跨多个赛道，
  // 不能并进半导体或软件——拿它的形态当任一细分赛道的依据都是错的
  { group: '科技综合', kw: /^科技$|科技龙头/, category: 'industry' },
  { group: '旅游酒店', kw: /旅游|酒店|餐饮|免税/, category: 'industry' },
  { group: '环保', kw: /环保|水务|节能/, category: 'industry' },
];

/** 全市场 ETF 行情行（只取本模块需要的字段） */
export interface EtfSpotRow {
  code: string;
  name: string;
  /** 从名称提取的原始赛道名，如「半导体设备ETF国泰」→「半导体设备」 */
  rawTrack: string;
  amount: number;
  floatCap: number;
  price: number;
}

/** 赛道代表标的 */
export interface TrackRepresentative {
  /** 归并后的赛道名 */
  track: string;
  category: TrackCategory;
  code: string;
  name: string;
  amount: number;
  floatCap: number;
  /** 同赛道候选只数，用于页面说明「这个赛道有 N 只 ETF，取最活跃的这只代看」 */
  peerCount: number;
}

/** 覆盖缺口：归并表里有这个赛道，但没有任何 ETF 达到流动性门槛 */
export interface TrackGap {
  track: string;
  category: TrackCategory;
  /** 该赛道最活跃的那只（未达门槛），无对应 ETF 时为 null */
  best: { code: string; name: string; amount: number; floatCap: number } | null;
  reason: string;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 从 ETF 名称提取赛道名：取「ETF」之前的部分 */
export function extractTrack(name: string): string {
  const i = name.indexOf('ETF');
  return (i > 0 ? name.slice(0, i) : name).trim();
}

/**
 * 归并到大类。
 *
 * 返回 null 表示**没归上类**（会进覆盖缺口报告，不静默丢弃）；
 * 返回的 category 为 null 表示归上了类但该类不参与扫描（货币与纯债）。
 * 这两种 null 含义不同，调用方要分开处理。
 */
export function mergeTrack(
  rawTrack: string,
): { group: string; category: TrackCategory | null } | null {
  for (const m of TRACK_MERGE) {
    if (m.kw.test(rawTrack)) return { group: m.group, category: m.category };
  }
  return null;
}

/**
 * 取全市场 ETF 行情（缓存 6h）。best-effort：失败抛错由调用方决定降级，
 * 不返回空数组——空数组会让上层以为「今天没有可扫的标的」而静默产出空快照。
 */
export async function fetchEtfSpot(signal?: AbortSignal): Promise<EtfSpotRow[]> {
  return cached('swing:etfSpot', UNIVERSE_TTL_MS, async () => {
    const data = await callAkshare('fund_etf_spot_em', {}, signal);
    if (!Array.isArray(data)) throw new Error('ETF 清单返回格式异常');
    return (data as Array<Record<string, unknown>>)
      .map((r) => {
        const name = String(r['名称'] ?? '').trim();
        return {
          code: String(r['代码'] ?? '').trim(),
          name,
          rawTrack: extractTrack(name),
          amount: num(r['成交额']),
          floatCap: num(r['流通市值']),
          price: num(r['最新价']),
        } satisfies EtfSpotRow;
      })
      .filter((r) => /^\d{6}$/.test(r.code) && r.name.length > 0);
  });
}

/**
 * 从 ETF 清单挑出各赛道代表标的，并如实报告覆盖缺口。
 *
 * 同赛道取成交额最大者。缺口分两种如实标注：
 * 「有 ETF 但流动性不够」与「全市场无对应 ETF」——
 * 前者将来可能回归，后者是永久缺口，页面上不能都显示成「这个赛道没信号」。
 */
export function pickRepresentatives(rows: EtfSpotRow[]): {
  representatives: TrackRepresentative[];
  gaps: TrackGap[];
  unmatched: EtfSpotRow[];
} {
  const liquid = rows
    .filter((r) => r.amount >= MIN_AMOUNT && r.floatCap >= MIN_FLOAT_CAP)
    .sort((a, b) => b.amount - a.amount);

  const best = new Map<string, TrackRepresentative>();
  const peers = new Map<string, number>();
  const unmatched: EtfSpotRow[] = [];

  for (const r of liquid) {
    const m = mergeTrack(r.rawTrack);
    if (!m) {
      unmatched.push(r);
      continue;
    }
    if (m.category == null) continue;
    peers.set(m.group, (peers.get(m.group) ?? 0) + 1);
    // liquid 已按成交额降序，首个命中即最活跃者
    if (!best.has(m.group)) {
      best.set(m.group, {
        track: m.group,
        category: m.category,
        code: r.code,
        name: r.name,
        amount: r.amount,
        floatCap: r.floatCap,
        peerCount: 0,
      });
    }
  }

  const representatives = [...best.values()]
    .map((r) => ({ ...r, peerCount: peers.get(r.track) ?? 1 }))
    .sort((a, b) => b.amount - a.amount);

  // 缺口：归并表定义了但无代表的赛道。回到全量清单找最活跃者以区分缺口性质
  const gaps: TrackGap[] = [];
  for (const m of TRACK_MERGE) {
    if (m.category == null || best.has(m.group)) continue;
    const cand = rows
      .filter((r) => m.kw.test(r.rawTrack))
      .sort((a, b) => b.amount - a.amount)[0];
    if (!cand) {
      gaps.push({ track: m.group, category: m.category, best: null, reason: '全市场无对应 ETF' });
    } else {
      gaps.push({
        track: m.group,
        category: m.category,
        best: {
          code: cand.code,
          name: cand.name,
          amount: cand.amount,
          floatCap: cand.floatCap,
        },
        reason:
          cand.amount < MIN_AMOUNT
            ? `最活跃的 ${cand.name} 日成交额仅 ${(cand.amount / 1e8).toFixed(2)} 亿`
            : `最活跃的 ${cand.name} 流通市值仅 ${(cand.floatCap / 1e8).toFixed(1)} 亿`,
      });
    }
  }

  return { representatives, gaps, unmatched };
}

/** K 线根数是否够算结构：区间、背驰、笔都要足够样本，不足则不参与判定 */
export const MIN_BARS_FOR_STRUCTURE = 60;

/** 样本是否足够；不足时调用方须如实标注而非当作「无信号」 */
export function hasEnoughBars(bars: KlineBar[]): boolean {
  return bars.length >= MIN_BARS_FOR_STRUCTURE;
}
