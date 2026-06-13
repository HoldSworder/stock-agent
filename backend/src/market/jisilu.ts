import { requestJson } from '../datasource/httpClient';
import { numOrNull } from '../datasource/codes';
import { getValue } from '../settings';

// 集思录 ETF 折溢价/IOPV（best-effort 补充源）。公开列表端点偶发需登录 cookie，
// 故 cookie 可选、整源默认关闭（jisiluEnabled），仅在用户显式启用后参与 ETF 折溢价补充。

const JISILU_ETF = 'https://www.jisilu.cn/data/etf/etf_list/';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export class JisiluError extends Error {}

export interface JisiluPremium {
  /** 参考净值 IOPV */
  iopv: number | null;
  /** 折溢价率 %（正=溢价） */
  premiumRate: number | null;
}

function headers(): Record<string, string> {
  const cookie = getValue('jisiluCookie' as never);
  const h: Record<string, string> = {
    'User-Agent': UA,
    Referer: 'https://www.jisilu.cn/data/etf/',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (cookie) h.Cookie = cookie;
  return h;
}

/** 拉取集思录全市场 ETF 折溢价/IOPV（60s 缓存），返回 code→{iopv,premiumRate} */
export async function fetchEtfPremiumMap(): Promise<Map<string, JisiluPremium>> {
  const json = await requestJson({
    sourceId: 'jisilu',
    url: JISILU_ETF,
    headers: headers(),
    cacheTtlMs: 60_000,
    maxAttempts: 2,
    retryBaseMs: 500,
    errorLabel: '集思录ETF',
    makeError: (m) => new JisiluError(m),
    validate: (j) => (Array.isArray((j as { rows?: unknown }).rows) ? null : '集思录返回无 rows（可能需配置 cookie）'),
  });
  const rows = (json as { rows?: Array<{ id?: string; cell?: Record<string, unknown> }> }).rows ?? [];
  const map = new Map<string, JisiluPremium>();
  for (const r of rows) {
    const cell = r.cell ?? {};
    const code = String(cell.fund_id ?? r.id ?? '');
    if (!/^\d{6}$/.test(code)) continue;
    map.set(code, {
      iopv: numOrNull(cell.estimate_value),
      premiumRate: numOrNull(cell.discount_rt),
    });
  }
  return map;
}

/** 健康探测：拉一次列表，rows 非空即连通 */
export async function pingJisilu(): Promise<void> {
  const m = await fetchEtfPremiumMap();
  if (m.size === 0) throw new JisiluError('集思录无数据（可能需配置 cookie 或已被限流）');
}

/** 单只 ETF 折溢价（best-effort，失败/无数据返回 null，不抛错以免影响 ETF 主流程） */
export async function getEtfPremiumJisilu(code: string): Promise<JisiluPremium | null> {
  try {
    const m = await fetchEtfPremiumMap();
    return m.get(code) ?? null;
  } catch {
    return null;
  }
}
