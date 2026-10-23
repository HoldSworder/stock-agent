import { requestJson } from '../datasource/httpClient';

// 同花顺公开涨跌家数。不需要登录。东财涨停池没有「全市场上涨/下跌多少家」，这里补上。

const UP_DOWN_URL = 'https://dq.10jqka.com.cn/fuyao/up_down_distribution/distribution/v2/realtime';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface ThsUpDown {
  up: number;
  down: number;
  flat: number;
}

function headers(): Record<string, string> {
  return { 'User-Agent': UA, Referer: 'https://dq.10jqka.com.cn/' };
}

/** 全市场上涨、下跌、平盘家数。失败抛错，调用方自己决定要不要显示 */
export async function fetchThsUpDown(): Promise<ThsUpDown> {
  const json = await requestJson({
    sourceId: 'ths-market',
    url: UP_DOWN_URL,
    headers: headers(),
    cacheTtlMs: 30_000,
    maxAttempts: 2,
    retryBaseMs: 400,
    errorLabel: '同花顺涨跌家数',
    validate: (j) => {
      const data = j.data as { up?: unknown; down?: unknown } | null;
      return typeof data?.up === 'number' && typeof data?.down === 'number' ? null : '同花顺涨跌家数没有数据';
    },
  });
  const data = json.data as { up: number; down: number; flat?: number };
  return { up: data.up, down: data.down, flat: typeof data.flat === 'number' ? data.flat : 0 };
}

/** 健康检查：能取到上涨家数就算通 */
export async function pingThsMarket(): Promise<void> {
  await fetchThsUpDown();
}
