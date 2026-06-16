import type { SentimentComponents } from '@stock-agent/shared';
import { callAkshare } from '../market/akshare';
import { getEmotion } from '../market/eastmoney';
import { isSourceEnabled } from '../datasource/registry';

// S1 情绪指数原始取数层：合并两个互补数据源，best-effort 降级（任一源失败不阻断）。
//  - 乐咕乐股 stock_market_activity_legu（经 aktools）：上涨/下跌/平盘家数 + 涨停/真实涨停 + 跌停/真实跌停 + 停牌 + 活跃度%，
//    是「赚钱效应/广度 + 直读活跃度」的最佳现成快照。
//  - 东财涨停池 getEmotion：炸板数/炸板率 + 最高连板高度（乐咕不含），补「退潮信号 + 高度板」维度。
// 两源字段不重叠、互补，任一缺失仅令对应分项为 null，指数按可用分项归一后仍可计算（标记 stale）。

/** 乐咕活跃度返回的单行 {item, value} */
interface LeguRow {
  item?: string;
  value?: number | string;
}

/** 从乐咕返回数组中按 item 名取数值（活跃度为 "66.58%" 字符串，转 number；缺失/异常返回 null） */
function pick(rows: LeguRow[], item: string): number | null {
  const hit = rows.find((r) => String(r.item ?? '').trim() === item);
  if (!hit || hit.value == null) return null;
  const raw = String(hit.value).replace('%', '').trim();
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** 拉取乐咕乐股市场活跃度快照（best-effort，整源失败返回 null） */
async function fetchLegu(): Promise<{
  up: number | null;
  down: number | null;
  flat: number | null;
  limitUp: number | null;
  realLimitUp: number | null;
  limitDown: number | null;
  realLimitDown: number | null;
  suspended: number | null;
  activity: number | null;
} | null> {
  if (!isSourceEnabled('akshare')) return null;
  try {
    const data = await callAkshare('stock_market_activity_legu');
    const rows = Array.isArray(data) ? (data as LeguRow[]) : [];
    if (!rows.length) return null;
    return {
      up: pick(rows, '上涨'),
      down: pick(rows, '下跌'),
      flat: pick(rows, '平盘'),
      limitUp: pick(rows, '涨停'),
      realLimitUp: pick(rows, '真实涨停'),
      limitDown: pick(rows, '跌停'),
      realLimitDown: pick(rows, '真实跌停'),
      suspended: pick(rows, '停牌'),
      activity: pick(rows, '活跃度'),
    };
  } catch {
    return null;
  }
}

/** 拉取东财涨停池情绪温度（炸板率 + 最高连板，best-effort，失败返回 null） */
async function fetchEmotion(): Promise<{
  brokenBoard: number | null;
  brokenRate: number | null;
  maxStreak: number | null;
  limitUp: number | null;
  limitDown: number | null;
} | null> {
  try {
    const e = await getEmotion();
    return {
      brokenBoard: e.brokenBoard,
      brokenRate: e.brokenRate,
      maxStreak: e.maxStreak,
      limitUp: e.limitUp,
      limitDown: e.limitDown,
    };
  } catch {
    return null;
  }
}

/**
 * 汇总两源原始情绪指标。返回构成 + 是否降级（任一源缺失即 stale）。
 * 乐咕优先（真实涨停/活跃度），东财补炸板率/连板高度；涨停/跌停数乐咕缺失时回退东财。
 */
export async function fetchSentimentComponents(): Promise<{
  components: SentimentComponents;
  stale: boolean;
}> {
  const [legu, emotion] = await Promise.all([fetchLegu(), fetchEmotion()]);
  const stale = legu == null || emotion == null;

  const components: SentimentComponents = {
    up: legu?.up ?? null,
    down: legu?.down ?? null,
    flat: legu?.flat ?? null,
    limitUp: legu?.limitUp ?? emotion?.limitUp ?? null,
    realLimitUp: legu?.realLimitUp ?? null,
    limitDown: legu?.limitDown ?? emotion?.limitDown ?? null,
    realLimitDown: legu?.realLimitDown ?? null,
    brokenBoard: emotion?.brokenBoard ?? null,
    brokenRate: emotion?.brokenRate ?? null,
    maxStreak: emotion?.maxStreak ?? null,
    activity: legu?.activity ?? null,
    suspended: legu?.suspended ?? null,
  };

  return { components, stale };
}
