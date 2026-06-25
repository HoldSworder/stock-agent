import type { UsMappingOverview, UsSectorEtf } from '@stock-agent/shared';
import { getJson } from './eastmoney';
import { num } from '../datasource/codes';
import { record } from '../datasource/metrics';

// 美股映射底稿（纯确定性数据源，不内置 agent）：隔夜美股行业/主题 ETF 全集自动排名 → A股概念·ETF 桥接。
// 每只 sector/thematic ETF = 一个板块代理（东财/akshare 无现成「美股行业板块榜」，故用稳定 ETF 全集替代）。
// 复用现有东财 push2 通道抓 secid 隔夜涨跌，按涨跌幅降序；坏 secid 走空名剔除、自我校正。
// 动态映射到当下活跃 A股板块的工作交给消费方（大盘研判/今日计划 agent），本模块只产出确定性数据。

const PUSH2_GET = 'https://push2.eastmoney.com/api/qt/stock/get';
const SOURCE_ID = 'usmap';

interface EtfDef {
  /** 东财 secid（105=NASDAQ / 106=NYSE / 107=NYSE ARCA·AMEX） */
  secid: string;
  /** 主题大类 */
  theme: string;
  /** 对应 A股概念名 */
  aConcept: string;
  /** 对应 A股 ETF（代码+名） */
  aEtfs: { code: string; name: string }[];
}

// ===== 唯一维护点：美股行业/主题 ETF 全集（稳定清单，极少变动）=====
// 增删 ETF / 调整 A股桥接直接改本数组；secid 写错只会该只被自动剔除，不影响整体。
const ETF_UNIVERSE: EtfDef[] = [
  // 半导体 / AI 算力
  { secid: '105.SMH', theme: '半导体', aConcept: '半导体/芯片', aEtfs: [{ code: '159516', name: '半导体设备ETF' }, { code: '588200', name: '科创芯片ETF' }] },
  { secid: '105.SOXX', theme: '半导体', aConcept: '半导体/芯片', aEtfs: [{ code: '512480', name: '半导体ETF' }] },
  // 软件 / 云 / AI
  { secid: '105.IGV', theme: '软件/SaaS', aConcept: '软件/SaaS', aEtfs: [{ code: '159852', name: '软件ETF' }] },
  { secid: '105.SKYY', theme: '云计算', aConcept: '云计算', aEtfs: [{ code: '516510', name: '云计算ETF' }] },
  { secid: '105.BOTZ', theme: '机器人/AI', aConcept: '人形机器人', aEtfs: [{ code: '159770', name: '机器人ETF' }] },
  { secid: '105.WCLD', theme: '云计算', aConcept: '云计算', aEtfs: [{ code: '516510', name: '云计算ETF' }] },
  // 通信 / 网络
  { secid: '105.FIVG', theme: '通信/5G', aConcept: 'CPO/通信', aEtfs: [{ code: '159740', name: '通信ETF' }] },
  { secid: '105.CIBR', theme: '网络安全', aConcept: '网络安全/信创', aEtfs: [{ code: '159613', name: '信息安全ETF' }] },
  // 生物医药
  { secid: '107.XBI', theme: '生物科技', aConcept: '创新药', aEtfs: [{ code: '159992', name: '创新药ETF' }] },
  { secid: '105.IBB', theme: '生物科技', aConcept: '创新药', aEtfs: [{ code: '159992', name: '创新药ETF' }] },
  { secid: '107.IHI', theme: '医疗器械', aConcept: '医疗器械', aEtfs: [{ code: '159883', name: '医疗器械ETF' }] },
  // 军工 / 核电 / 量子
  { secid: '106.ITA', theme: '军工/国防', aConcept: '军工', aEtfs: [{ code: '512660', name: '军工ETF' }] },
  { secid: '107.URA', theme: '核电/铀', aConcept: '核电', aEtfs: [{ code: '561320', name: '核电ETF' }] },
  { secid: '106.NLR', theme: '核电/铀', aConcept: '核电', aEtfs: [{ code: '561320', name: '核电ETF' }] },
  { secid: '107.QTUM', theme: '量子科技', aConcept: '量子科技', aEtfs: [] },
  // 新能源 / 电力 / 锂电
  { secid: '107.TAN', theme: '光伏', aConcept: '光伏', aEtfs: [{ code: '515790', name: '光伏ETF' }] },
  { secid: '105.ICLN', theme: '清洁能源', aConcept: '新能源', aEtfs: [{ code: '516160', name: '新能源ETF' }] },
  { secid: '106.LIT', theme: '锂电池', aConcept: '锂电池', aEtfs: [{ code: '159840', name: '锂电池ETF' }] },
  { secid: '105.IDRV', theme: '新能源车', aConcept: '新能源车', aEtfs: [{ code: '515030', name: '新能源车ETF' }] },
  // 资源 / 周期
  { secid: '106.GDX', theme: '黄金矿', aConcept: '黄金', aEtfs: [{ code: '159562', name: '黄金股ETF' }] },
  { secid: '106.XLE', theme: '石油/能源', aConcept: '石油石化', aEtfs: [{ code: '159930', name: '能源ETF' }] },
  { secid: '107.XME', theme: '金属矿业', aConcept: '有色金属', aEtfs: [{ code: '512400', name: '有色金属ETF' }] },
  // 金融 / 区块链 / 中概
  { secid: '106.XLF', theme: '金融/银行', aConcept: '银行/券商', aEtfs: [{ code: '512800', name: '银行ETF' }] },
  { secid: '106.BLOK', theme: '区块链/数字货币', aConcept: '数字货币', aEtfs: [] },
  { secid: '106.KWEB', theme: '中概互联', aConcept: '中概互联/恒生科技', aEtfs: [{ code: '513050', name: '中概互联ETF' }] },
  // 消费 / 其它
  { secid: '107.XRT', theme: '零售/消费', aConcept: '大消费', aEtfs: [{ code: '159928', name: '消费ETF' }] },
  { secid: '105.SOCL', theme: '社交/传媒', aConcept: '传媒/游戏', aEtfs: [{ code: '159869', name: '游戏ETF' }] },
];

/** 批量抓美股 secid 隔夜行情（名称/涨跌幅）；单个失败/空名跳过（同 getGlobalIndices best-effort） */
async function fetchUsQuotes(secids: string[]): Promise<Map<string, { name: string; pct: number }>> {
  const out = new Map<string, { name: string; pct: number }>();
  await Promise.all(
    secids.map(async (secid) => {
      try {
        const url = `${PUSH2_GET}?fltt=2&fields=f43,f57,f58,f170&secid=${secid}`;
        const json = await getJson(url);
        const d = (json.data ?? {}) as Record<string, unknown>;
        const name = String(d.f58 ?? '');
        if (!name) return; // 空名（未生效/无数据 secid）剔除
        out.set(secid, { name, pct: num(d.f170) });
      } catch {
        /* 单个失败跳过 */
      }
    }),
  );
  return out;
}

/**
 * 取隔夜美股行业/主题 ETF 排名（每只 ETF = 一个板块代理）+ A股概念/ETF 桥接。
 * best-effort，整体失败返回 null；坏 secid 自动剔除。
 */
export async function buildUsMapping(): Promise<UsMappingOverview | null> {
  const startedAt = Date.now();
  try {
    const quotes = await fetchUsQuotes(Array.from(new Set(ETF_UNIVERSE.map((e) => e.secid))));
    if (!quotes.size) {
      record(SOURCE_ID, { ok: false, latencyMs: Date.now() - startedAt, error: '美股映射取数为空（push2 无返回）' });
      return null;
    }
    const sectors: UsSectorEtf[] = [];
    for (const def of ETF_UNIVERSE) {
      const q = quotes.get(def.secid);
      if (!q) continue; // 坏 secid / 无数据剔除
      sectors.push({
        name: q.name,
        secid: def.secid,
        pct: q.pct,
        theme: def.theme,
        aConcept: def.aConcept,
        aEtfs: def.aEtfs,
      });
    }
    if (!sectors.length) {
      record(SOURCE_ID, { ok: false, latencyMs: Date.now() - startedAt, error: '美股映射 secid 全部失效' });
      return null;
    }
    // 按隔夜涨跌幅降序：领涨在前、领跌在后
    sectors.sort((a, b) => b.pct - a.pct);
    record(SOURCE_ID, { ok: true, latencyMs: Date.now() - startedAt });
    return {
      asOf: new Date().toISOString(),
      sectors,
      note: '隔夜美股行业/主题 ETF 排名（每只 ETF 为一个板块代理）→ A股概念/ETF 桥接，仅作盘前情绪/方向背景，非择时信号。强势美股板块对应的 A股概念需结合系统内真实 A股板块强弱印证（两边共振才可信）；留意中美脱钩下「美股芯片利空→A股国产替代利好」的反向逻辑。',
    };
  } catch (e) {
    record(SOURCE_ID, {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/** 美股映射底稿文本（注入 agent prompt / market_snapshot；打印领涨 Top + 领跌 Bottom，never throw） */
export function formatUsMappingForAgent(m: UsMappingOverview): string {
  const sign = (x: number): string => (x >= 0 ? '+' : '');
  const fmt = (e: UsSectorEtf): string => {
    const etf = e.aEtfs.map((a) => `${a.name}(${a.code})`).join('/') || '—';
    return `${e.name}${sign(e.pct)}${e.pct}% → A股 概念「${e.aConcept}」/ ETF ${etf}`;
  };
  const lines: string[] = ['【美股映射·确定性底稿】（隔夜美股行业/主题 ETF 排名 → A股概念/ETF 桥接，盘前情绪/方向背景，非择时信号）'];
  const up = m.sectors.filter((s) => s.pct > 0).slice(0, 8);
  const down = m.sectors.filter((s) => s.pct < 0).slice(-5).reverse();
  if (up.length) {
    lines.push('· 领涨：');
    for (const e of up) lines.push(`  - ${fmt(e)}`);
  }
  if (down.length) {
    lines.push('· 领跌：');
    for (const e of down) lines.push(`  - ${fmt(e)}`);
  }
  if (up.length || down.length) lines.push(m.note);
  else lines.push('· 隔夜美股映射数据暂不可用（数据源未连通）。');
  return lines.join('\n');
}
