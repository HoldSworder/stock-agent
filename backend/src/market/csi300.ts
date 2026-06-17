import { getKline } from './eastmoney';

// 沪深300 区间收益小工具：决策复盘（reflection）与战法前向 Alpha（forward）共用，避免重复实现。

/** 沪深300 指数 secid（撞码须显式传，1=沪市指数） */
const CSI300_SECID = '1.000300';
const CSI300_CODE = '000300';

/**
 * 取沪深300 自 fromDate（YYYY-MM-DD）起的区间收益率（%）；失败返回 null（调用方降级为绝对收益）。
 * @param fromDate 起算日（含），取该日或之后首个交易日为基准
 * @param days 起算日距今自然日数，用于估算需拉取的 K 线根数
 */
export async function csi300Return(fromDate: string, days: number): Promise<number | null> {
  try {
    const bars = await getKline(CSI300_CODE, 'day', Math.max(days + 20, 40), CSI300_SECID);
    if (bars.length < 2) return null;
    const base = bars.find((b) => b.time >= fromDate) ?? bars[0];
    const last = bars[bars.length - 1];
    if (!base || !last || base.close <= 0) return null;
    return ((last.close - base.close) / base.close) * 100;
  } catch {
    return null;
  }
}
