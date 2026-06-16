import { createHash } from 'node:crypto';
import type { ClsTelegraph } from '@stock-agent/shared';
import { requestJson } from '../datasource/httpClient';

// 财联社电报签名直连客户端（绕开 akshare）。
// 现行接口：GET https://www.cls.cn/v1/roll/get_roll_list（老 /nodeapi/telegraphList 已下线）。
// 鉴权：sign = md5(sha1(按 key 升序拼接的 querystring))，参数 app/os/sv/rn/last_time。
// 注意：此为逆向私有接口，财联社改版（路径 / sv 版本号 / 签名算法）会失效；
// 失效时对照 RSSHub lib/routes/cls/utils 更新 sv 与签名/路径。service 层的 akshare
// 多源快讯（同花顺/富途/东财/新浪）始终作为兜底，失效期间仍有数据。

export class ClsError extends Error {}

const ENDPOINT = 'https://www.cls.cn/v1/roll/get_roll_list';
// 财联社 Web 端版本号；改版导致签名失效时优先调整此值（对照 RSSHub）
const SV = '8.7.9';
// get_roll_list 的 rn 上限：实测 rn>50 会返回 errno:0 但 roll_data 为空数组（被误判为有效→降级）。
// 该接口不支持 last_time 游标翻页（翻页返回相同 50 条），故单次最多 50 条，超出由调用方截断。
const MAX_RN = 50;

const HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Referer: 'https://www.cls.cn/telegraph',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

interface Roll {
  id?: number | string;
  title?: string;
  content?: string;
  brief?: string;
  /** 发布时间，unix 秒 */
  ctime?: number;
  /** 重要级别：A/B 为加红重点 */
  level?: string;
  /** 原文分享链接 */
  shareurl?: string;
}

/** 财联社 Web 签名：参数按 key 升序拼接 querystring → SHA1 → MD5（hex） */
function sign(params: Record<string, string>): string {
  const qs = Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join('&');
  const sha1 = createHash('sha1').update(qs).digest('hex');
  return createHash('md5').update(sha1).digest('hex');
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim());

/** unix 秒 → ISO；非法回退空串 */
function ctimeToIso(ctime: unknown): string {
  const n = Number(ctime);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/**
 * 拉取财联社电报（首选源），映射为 ClsTelegraph[]，按时间倒序、截断到 limit。
 * 始终返回全量并按 level A/B 标记 important（加红重点），由前端本地按 important 切换「全部/重点」。
 * 失败（网络 / errno≠0 / 无 roll_data）抛 ClsError，由 service 层降级到兜底源。
 */
export async function fetchTelegraph(
  limit = 50,
  signal?: AbortSignal,
): Promise<ClsTelegraph[]> {
  const rn = String(Math.min(Math.max(limit, 20), MAX_RN));
  const params: Record<string, string> = {
    app: 'CailianpressWeb',
    os: 'web',
    sv: SV,
    rn,
    last_time: String(Math.floor(Date.now() / 1000)),
  };
  params.sign = sign(params);
  const query = Object.keys(params)
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join('&');

  const json = await requestJson({
    sourceId: 'cls',
    url: `${ENDPOINT}?${query}`,
    headers: HEADERS,
    timeoutMs: 10_000,
    maxAttempts: 2,
    retryBaseMs: 600,
    validate: (j) => {
      const data = j.data as { roll_data?: unknown } | undefined;
      return j.errno === 0 && Array.isArray(data?.roll_data) ? null : '财联社返回异常（errno≠0 或无 roll_data，疑似签名/版本失效）';
    },
    errorLabel: '财联社电报',
    makeError: (m) => new ClsError(m),
    signal,
  });

  const rolls = ((json.data as { roll_data?: Roll[] }).roll_data ?? []) as Roll[];
  const list = rolls.map((r) => {
    const content = str(r.content) || str(r.brief);
    // 财联社加红重点：level A/B（实测红条稀少，与口径一致）；改版若口径变动在此调整
    const lv = str(r.level).toUpperCase();
    return {
      id: str(r.id) || createHash('md5').update(`${r.ctime} ${content}`).digest('hex').slice(0, 12),
      time: ctimeToIso(r.ctime),
      title: str(r.title),
      content,
      tag: 'neutral' as const,
      source: '财联社',
      important: lv === 'A' || lv === 'B',
      url: str(r.shareurl) || null,
    } satisfies ClsTelegraph;
  });
  list.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  return list.slice(0, Math.max(1, limit));
}
