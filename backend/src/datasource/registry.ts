import type {
  DataSourceCategory,
  DataSourceConfigField,
  DataSourceConfigUpdate,
  DataSourceHealth,
  DataSourceInfo,
  DataSourceProtocol,
} from '@stock-agent/shared';
import { getValue, setValue } from '../settings';
import { statsFor } from './metrics';
import { ping as pingEastmoney } from '../market/eastmoney';
import { getIndicesTencent } from '../market/tencent';
import { getKlineSina } from '../market/sina';
import { getQuotesNetease } from '../market/netease';
import { pingJisilu } from '../market/jisilu';
import { pingAkshare } from '../market/akshare';
import { pingThs } from '../realPositions';
import { pingIdingpan } from '../idingpan';
import { miaoxiang } from '../miaoxiang/client';
import { fetchList } from '../research/client';
import { callTool } from '../trendradar/mcpClient';
import { pingHtsc } from '../htsc/client';
import { pingIwencai, pingIwencaiStock } from '../iwencai/client';
import { callAkshare } from '../market/akshare';
import { pingAstock } from '../astock/client';
import { fetchCffexRank } from '../market/cffexRank';
import { buildUsMapping } from '../market/usMapping';
import { ping as pingCls } from '../cls/service';
import { sqlite } from '../db/client';

// 数据源注册中心：所有外部取数的单一元数据真相。
// 每个数据源声明 分类 / 协议 / 基址 / 凭据字段 / 启停键 / 健康探测，
// 供「数据源」页统一做健康检查、凭据配置、启停与调用统计。

interface ConfigFieldDef {
  /** AppSettings 字段名（camelCase） */
  key: string;
  label: string;
  /** 敏感字段：列表掩码、空串提交不覆盖 */
  secret: boolean;
  /** 该数据源就绪所必需 */
  required: boolean;
  placeholder?: string;
}

interface SourceDef {
  id: string;
  name: string;
  category: DataSourceCategory;
  protocol: DataSourceProtocol;
  baseUrl: string;
  description: string;
  /** 控制启停的设置键（'true'/'false'）；无则不可启停（恒启用） */
  enabledKey?: string;
  fields: ConfigFieldDef[];
  /** 健康探测：成功返回，失败抛错（错误信息作为 detail 展示） */
  healthCheck: () => Promise<void>;
}

const SOURCES: SourceDef[] = [
  {
    id: 'eastmoney',
    name: '东方财富行情',
    category: '行情',
    protocol: 'http-rest',
    baseUrl: 'push2.eastmoney.com',
    description: 'A 股/指数/期货/板块实时与历史行情主源（push2/push2his/push2ex），无需鉴权，主 host 失败自动切 push2delay。报价/ K 线调度的首选源。',
    enabledKey: 'eastmoneyEnabled',
    fields: [],
    healthCheck: () => pingEastmoney(),
  },
  {
    id: 'tencent',
    name: '腾讯财经行情',
    category: '行情',
    protocol: 'http-rest',
    baseUrl: 'web.ifzq.gtimg.cn',
    description: 'K 线调度第 2 兜底源（分时/K 线/指数），需 Referer: gu.qq.com。关闭后不参与 K 线调度。',
    enabledKey: 'tencentEnabled',
    fields: [],
    healthCheck: async () => {
      await getIndicesTencent(['1.000001']);
    },
  },
  {
    id: 'sina',
    name: '新浪财经行情',
    category: '行情',
    protocol: 'http-rest',
    baseUrl: 'money.finance.sina.com.cn',
    description: 'K 线调度第 3 兜底源（日 + 5/15/30/60 分钟 K 线）。关闭后不参与 K 线调度。',
    enabledKey: 'sinaEnabled',
    fields: [],
    healthCheck: async () => {
      await getKlineSina('000001', 'day', 5, '1.000001');
    },
  },
  {
    id: 'netease',
    name: '网易财经行情',
    category: '行情',
    protocol: 'http-jsonp',
    baseUrl: 'api.money.126.net',
    description: '报价调度兜底源（东财失败时接管批量实时报价），UTF-8 feed 名称不乱码，无需鉴权。',
    enabledKey: 'neteaseEnabled',
    fields: [],
    healthCheck: async () => {
      await getQuotesNetease(['000001']);
    },
  },
  {
    id: 'jisilu',
    name: '集思录',
    category: '行情',
    protocol: 'http-rest',
    baseUrl: 'www.jisilu.cn',
    description: 'ETF/可转债 折溢价与 IOPV 权威源。默认开启用于补 ETF 折溢价（优先采用其 discount_rt）；公开端点偶发需 cookie，被限流时填。',
    enabledKey: 'jisiluEnabled',
    fields: [
      { key: 'jisiluCookie', label: 'Cookie', secret: true, required: false, placeholder: '可选：jisilu.cn 登录 Cookie（公开端点被限流时填）' },
    ],
    healthCheck: () => pingJisilu(),
  },
  {
    id: 'akshare',
    name: 'AKShare（aktools）',
    category: '行情',
    protocol: 'http-rest',
    baseUrl: 'aktools 反代地址 → /api/public',
    description:
      'AKShare 全量开源财经接口（行情/财务/宏观/板块/资讯…），经 aktools HTTP 服务透传，Agent 通过 akshare_call 工具按函数名调用。建议 aktools 容器仅绑本机端口，经反向代理以 HTTPS 暴露，Base URL 填反代地址。',
    enabledKey: 'akshareEnabled',
    fields: [
      { key: 'akshareBaseUrl', label: 'Base URL', secret: false, required: true, placeholder: 'https://<aktools 反代地址>' },
    ],
    healthCheck: () => pingAkshare(),
  },
  {
    id: 'astockdata',
    name: 'a-stock-data（mootdx sidecar）',
    category: '行情',
    protocol: 'http-rest',
    baseUrl: 'a-stock-data sidecar → /api/call',
    description:
      'a-stock-data 全栈 28 端点专属 sidecar（独立容器部署，与 aktools 并行，稳定后可逐步替代）：mootdx 通达信 K线/五档/逐笔/财务（TCP 7709，不封 IP，K线调度首选源）、腾讯估值、百度K线MA、东财研报+行业研报、同花顺一致预期EPS、龙虎榜/全市场龙虎榜/解禁/板块归属/行业排名、两融/大宗/股东户数/分红/资金流、个股新闻/全球资讯、巨潮公告、新浪财报三表。Agent 经 astock_call 按端点名调用；东财端点内置 em_get 串行限流防封。Base URL 填 sidecar 暴露地址（NAS 独立容器为 http://<NAS局域网IP>:9119，如 http://192.168.31.144:9119）。mootdx 需国内 IP（部署在 NAS）。',
    enabledKey: 'astockEnabled',
    fields: [
      { key: 'astockBaseUrl', label: 'Base URL', secret: false, required: true, placeholder: 'http://192.168.31.144:9119（NAS 暴露端口）' },
    ],
    healthCheck: () => pingAstock(),
  },
  {
    id: 'cffex',
    name: '中金所持仓榜',
    category: '行情',
    protocol: 'http-rest',
    baseUrl: 'www.cffex.com.cn',
    description:
      '中金所股指期货（IF/IH/IC/IM）每日前20会员持仓排名原始 CSV（含中信期货）。政府公开源、无鉴权、GBK 编码，直连不走 aktools。用于宏观·资金面的「中信多空单」机构对冲背景。',
    enabledKey: 'cffexEnabled',
    fields: [],
    healthCheck: async () => {
      const r = await fetchCffexRank();
      if (!r || !r.items.length) throw new Error('CFFEX 持仓榜取数为空（近 7 日无数据或解析失败）');
    },
  },
  {
    id: 'usmap',
    name: '美股映射',
    category: '行情',
    protocol: 'http-rest',
    baseUrl: 'push2.eastmoney.com',
    description:
      '隔夜美股龙头/行业 ETF（如 NVDA/SMH）→ A股概念·ETF·个股 的盘前情绪/叙事传导底稿。经东财 push2 抓美股 secid 隔夜涨跌（无鉴权、复用现有通道），叠加人工维护映射表。仅作盘前背景，非择时信号。',
    enabledKey: 'usMapEnabled',
    fields: [],
    healthCheck: async () => {
      const r = await buildUsMapping();
      if (!r || !r.sectors.length) {
        throw new Error('美股映射取数为空（push2 无返回或 secid 全部失效）');
      }
    },
  },
  {
    id: 'ths',
    name: '同花顺（投资账本 + 自选）',
    category: '账本',
    protocol: 'http-rest',
    baseUrl: 'tzzb.10jqka.com.cn / ugc.10jqka.com.cn',
    description: '真实持仓（投资账本）与自选股双向同步数据源，Cookie 鉴权。',
    fields: [
      { key: 'thsCookie', label: 'Cookie', secret: true, required: true, placeholder: '同花顺登录 Cookie（含 userid）' },
      { key: 'thsUserId', label: 'UID', secret: false, required: true, placeholder: '同花顺 userid' },
      { key: 'thsFundKeys', label: 'fund_key', secret: false, required: true, placeholder: '逗号分隔的账本 fund_key' },
    ],
    healthCheck: () => pingThs(),
  },
  {
    id: 'idingpan',
    name: '爱盯盘云',
    category: '账本',
    protocol: 'http-rest',
    baseUrl: '52etf.site',
    description: '本系统 → 爱盯盘单向镜像（自选分组备份），Bearer token 鉴权。',
    fields: [
      { key: 'idpToken', label: 'Token', secret: true, required: true, placeholder: 'harvest-idp-token 脚本提取' },
    ],
    healthCheck: () => pingIdingpan(),
  },
  {
    id: 'miaoxiang',
    name: '妙想（东方财富）',
    category: '资讯',
    protocol: 'http-rest',
    baseUrl: 'mkapi2.dfcfs.com',
    description:
      '金融数据 / 选股 / 资讯 / 自选 / 模拟盘交易（claw 门户，mkt_ apikey）+ AI 金融问答助手（robo-advisor 门户，em_ apikey）。',
    fields: [
      { key: 'mxApiKey', label: 'API Key (claw)', secret: true, required: true, placeholder: 'mkt_ 前缀 apikey' },
      { key: 'emApiKey', label: 'API Key (问答助手)', secret: true, required: false, placeholder: 'em_ 前缀 apikey' },
    ],
    healthCheck: async () => {
      await miaoxiang.balance();
    },
  },
  {
    id: 'htsc',
    name: '华泰证券 AI 网关',
    category: '资讯',
    protocol: 'http-rest',
    baseUrl: 'ai.zhangle.com /edge/entry/gate',
    description:
      '华泰证券 涨乐/妙想 edge 网关（apiKey 鉴权，五技能共用同一 HT_APIKEY）：指标行情检索 / 分析诊断 / 市场洞察 / 条件选股 / A 股模拟交易 / 自选股管理。apiKey 取设置值，缺省回退环境变量 HT_APIKEY。',
    enabledKey: 'htscEnabled',
    fields: [
      { key: 'htApiKey', label: 'API Key', secret: true, required: true, placeholder: 'ht_ 前缀 apiKey（HT_APIKEY）' },
      { key: 'htscBaseUrl', label: 'Base URL', secret: false, required: false, placeholder: 'https://ai.zhangle.com' },
    ],
    healthCheck: () => pingHtsc(),
  },
  {
    id: 'iwencai',
    name: '同花顺问财 ETF 选股',
    category: '选股',
    protocol: 'http-rest',
    baseUrl: 'openapi.iwencai.com /v1/query2data',
    description:
      '同花顺问财 OpenAPI（hithink-etf-selector）：自然语言 ETF 智能选股 / 数据查询。Bearer + X-Claw 网关头鉴权，apiKey 取设置值，缺省回退环境变量 IWENCAI_API_KEY。',
    enabledKey: 'iwencaiEnabled',
    fields: [
      { key: 'iwencaiApiKey', label: 'API Key', secret: true, required: true, placeholder: 'sk-proj-... (IWENCAI_API_KEY)' },
      { key: 'iwencaiBaseUrl', label: 'Base URL', secret: false, required: false, placeholder: 'https://openapi.iwencai.com' },
    ],
    healthCheck: () => pingIwencai(),
  },
  {
    id: 'iwencai-stock',
    name: '同花顺问财个股选股',
    category: '选股',
    protocol: 'http-rest',
    baseUrl: 'openapi.iwencai.com /v1/query2data',
    description:
      '同花顺问财 OpenAPI 个股版：自然语言 A 股智能选股 / 个股数据查询。与 ETF 选股复用同一 apiKey/Base URL（数据源页「同花顺问财 ETF 选股」处配置），仅 skill id 不同（X-Claw-Skill-Id）。默认禁用，需账号开通对应 skill 后填 skill id 并启用。',
    enabledKey: 'iwencaiStockEnabled',
    fields: [
      { key: 'iwencaiStockSkillId', label: '个股 Skill ID', secret: false, required: true, placeholder: 'hithink-stock-selector（账号开通的个股选股 skill）' },
    ],
    healthCheck: () => pingIwencaiStock(),
  },
  {
    id: 'xueqiu',
    name: '雪球',
    category: '资讯',
    protocol: 'http-rest',
    baseUrl: 'xueqiu.com（经 AKShare 透传）',
    description:
      '雪球财经数据，经 AKShare(aktools) 透传：个股关注/讨论热度（stock_hot_follow_xq / stock_hot_tweet_xq）、公司概况（stock_individual_basic_info_xq）。依赖 AKShare 数据源连通，Agent 经 akshare_call 调用对应函数补充情绪/舆情面。',
    enabledKey: 'xueqiuEnabled',
    fields: [],
    healthCheck: async () => {
      await callAkshare('stock_hot_follow_xq', {}, undefined, 'xueqiu');
    },
  },
  {
    id: 'cls',
    name: '财联社电报',
    category: '资讯',
    protocol: 'http-rest',
    baseUrl: 'cls.cn/telegraph（经 AKShare 透传）',
    description:
      '财经快讯/电报，经 AKShare(aktools) 透传，免鉴权。首选财联社电报（stock_info_global_cls），不可用时按序降级到同花顺/富途/东财/新浪全球快讯；在情报页「财联社电报」Tab 展示。依赖 AKShare 数据源连通；财联社源需较新版 akshare。',
    enabledKey: 'clsEnabled',
    fields: [],
    healthCheck: () => pingCls(),
  },
  {
    id: 'research',
    name: '东方财富研报',
    category: '研报',
    protocol: 'http-jsonp',
    baseUrl: 'reportapi.eastmoney.com',
    description: '研报中心（个股/行业/策略/宏观/晨报）与全市场公告，免费无鉴权。',
    enabledKey: 'researchEnabled',
    fields: [
      { key: 'researchBaseUrl', label: 'Base URL', secret: false, required: false, placeholder: 'https://reportapi.eastmoney.com' },
    ],
    healthCheck: async () => {
      await fetchList('strategy', { pageSize: 1, days: 7 });
    },
  },
  {
    id: 'trendradar',
    name: 'TrendRadar 热点雷达',
    category: '热点',
    protocol: 'mcp',
    baseUrl: 'streamable-HTTP MCP',
    description: '群晖 TrendRadar MCP（热榜/新闻/RSS），streamable-HTTP 协议。',
    enabledKey: 'trendradarEnabled',
    fields: [
      { key: 'trendradarMcpUrl', label: 'MCP 地址', secret: false, required: true, placeholder: 'https://host:port/mcp' },
    ],
    healthCheck: async () => {
      await callTool('get_system_status', {}, 15000);
    },
  },
  {
    id: 'local',
    name: '本地 SQLite',
    category: '本地',
    protocol: 'local',
    baseUrl: 'better-sqlite3',
    description: '本机数据库：自选股 / 持仓快照 / 设置 / 战法 / ETF 池等持久化存储。',
    fields: [],
    healthCheck: async () => {
      sqlite.prepare('SELECT 1').get();
    },
  },
];

const byId = new Map(SOURCES.map((s) => [s.id, s]));

/** 该数据源是否启用（无启停键恒为 true；启停键默认 'true'，仅显式 'false' 关闭） */
function isEnabled(def: SourceDef): boolean {
  if (!def.enabledKey) return true;
  return getValue(def.enabledKey as never) !== 'false';
}

/** 按 id 判断数据源是否启用（供调度层过滤 provider；未知源视为禁用） */
export function isSourceEnabled(id: string): boolean {
  const def = byId.get(id);
  return def ? isEnabled(def) : false;
}

function buildFields(def: SourceDef): DataSourceConfigField[] {
  return def.fields.map((f) => {
    // 凭据一律明文回显（页面已在登录鉴权后访问），便于核对
    const raw = getValue(f.key as never);
    return {
      key: f.key,
      label: f.label,
      secret: f.secret,
      value: raw,
      configured: raw.length > 0,
      required: f.required,
      placeholder: f.placeholder,
    } satisfies DataSourceConfigField;
  });
}

/** 必需凭据是否齐备 */
function isReady(def: SourceDef): boolean {
  return def.fields.filter((f) => f.required).every((f) => getValue(f.key as never).length > 0);
}

function toInfo(def: SourceDef): DataSourceInfo {
  return {
    id: def.id,
    name: def.name,
    category: def.category,
    protocol: def.protocol,
    baseUrl: def.baseUrl,
    description: def.description,
    toggleable: !!def.enabledKey,
    enabled: isEnabled(def),
    ready: isReady(def),
    config: buildFields(def),
    stats: statsFor(def.id),
  };
}

/** 全部数据源元信息 + 当前状态 */
export function listSources(): DataSourceInfo[] {
  return SOURCES.map(toInfo);
}

/** 单个数据源（不存在返回 null） */
export function getSourceInfo(id: string): DataSourceInfo | null {
  const def = byId.get(id);
  return def ? toInfo(def) : null;
}

/** 实时健康探测（带延迟测量，失败返回 detail） */
export async function checkHealth(id: string): Promise<DataSourceHealth> {
  const def = byId.get(id);
  const checkedAt = new Date().toISOString();
  if (!def) {
    return { id, online: false, latencyMs: null, detail: `未知数据源 ${id}`, checkedAt };
  }
  if (def.enabledKey && !isEnabled(def)) {
    return { id, online: false, latencyMs: null, detail: '该数据源已禁用', checkedAt };
  }
  const started = Date.now();
  try {
    await def.healthCheck();
    return { id, online: true, latencyMs: Date.now() - started, detail: null, checkedAt: new Date().toISOString() };
  } catch (e) {
    return {
      id,
      online: false,
      latencyMs: null,
      detail: e instanceof Error ? e.message : String(e),
      checkedAt: new Date().toISOString(),
    };
  }
}

/** 启停数据源（仅 toggleable 生效），返回更新后的源信息 */
export function toggleSource(id: string, enabled: boolean): DataSourceInfo | null {
  const def = byId.get(id);
  if (!def || !def.enabledKey) return getSourceInfo(id);
  setValue(def.enabledKey as never, enabled ? 'true' : 'false');
  return toInfo(def);
}

/** 更新数据源凭据/配置（仅接受该源声明的字段；明文所见即所存，允许清空） */
export function updateSourceConfig(id: string, patch: DataSourceConfigUpdate): DataSourceInfo | null {
  const def = byId.get(id);
  if (!def) return null;
  const allowed = new Set(def.fields.map((f) => f.key));
  for (const [k, v] of Object.entries(patch)) {
    if (allowed.has(k)) setValue(k as never, v);
  }
  return toInfo(def);
}
