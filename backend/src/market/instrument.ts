/**
 * 品种与交易规则的单一出处。
 *
 * 波段、主线模式、竞价冠军、回测、选股、持仓都引用这里。
 * 同一条规则只写这一次，避免各处各写一句。
 */

/** 场内基金代码段：深市 15/16，沪市 51/52/56/58。16 开头的 LOF 不看名称。 */
export const EXCHANGE_FUND_PREFIXES = ['15', '16', '51', '52', '56', '58'] as const;

/** 股票印花税从这一天起，卖出由 10bps 改为 5bps。 */
export const STAMP_DUTY_CUTOVER = '2023-08-28';

/** 创业板涨跌幅由 10% 改为 20% 的生效日。 */
export const CHINEXT_BAND_DATE = '2020-08-24';

/** 主板新股上市前 5 个交易日不设涨跌幅的起始日。 */
export const MAIN_IPO_UNLIMITED_DATE = '2023-04-10';

/** A 股一年交易日。年化和斜率都用这个数。 */
export const TRADING_DAYS_PER_YEAR = 244;

/** 沪深股票过户费，双边，单位 bps。场内基金为 0。 */
export const STOCK_TRANSFER_FEE_BPS = 0.1;

/**
 * 是否场内基金。
 * @param code 6 位代码
 */
export function isExchangeFund(code: string): boolean {
  return EXCHANGE_FUND_PREFIXES.some((p) => code.startsWith(p));
}

/**
 * 是否可转债。沪 11、深 12 开头，申报单位 10 张。
 * @param code 6 位代码
 */
export function isConvertibleBond(code: string): boolean {
  return /^(11|12)\d{4}$/.test(code);
}

/** 科创板股票。买入至少 200 股。 */
export function isStarBoard(code: string): boolean {
  return /^(688|689)/.test(code);
}

/** 创业板股票。 */
export function isChiNext(code: string): boolean {
  return /^(300|301)/.test(code);
}

/** 北交所。涨跌幅 30% 这一档保持不动。 */
export function isBeijing(code: string): boolean {
  return /^[48]/.test(code) || /^(43|83|87|88|92)/.test(code);
}

/** 名称里带 ST。涨跌幅 5%，不能只看代码前缀。 */
export function isStName(name?: string): boolean {
  return !!name && /(^\*?ST|ST)/i.test(name);
}

/**
 * 跨境或商品 ETF。
 * 这两类不设涨跌幅，也不用百分比推断份额折算。
 * 没有名称时只认代码段能确定的：513/520 跨境、518 黄金。159 不靠前缀猜。
 * @param code 6 位代码
 * @param name 证券简称，可空
 */
export function isCrossBorderOrCommodityEtf(code: string, name?: string): boolean {
  if (!isExchangeFund(code)) return false;
  if (name && /恒生|港股|纳指|纳斯达克|标普|道琼斯|美国|美股|日经|日本|德国|法国|越南|印度|东南亚|亚太|沙特|全球|中韩|H股|豆粕|能源化工|原油|商品|黄金|白银|贵金属|上海金/.test(name)) {
    return true;
  }
  return /^(513|520|518)/.test(code);
}

/**
 * 跟踪创业板或科创板的 ETF 用该基金自己的幅度。
 * 不把所有 159 都当成 20%，也不把它们都当成 10%。
 * 跨境和商品返回 null，表示不设涨跌幅。
 * @param code 6 位代码
 * @param name 证券简称，可空
 */
export function etfLimitPercent(code: string, name?: string): number | null {
  if (!isExchangeFund(code)) return null;
  if (isCrossBorderOrCommodityEtf(code, name)) return null;
  if (name && /科创|双创|创业板/.test(name)) return 20;
  if (/^588/.test(code)) return 20;
  return 10;
}

/**
 * 当日涨跌幅极限，小数。例如 0.1 表示 ±10%。null 表示不设涨跌幅。
 * @param code 6 位代码
 * @param opts.name 简称，用于识别 ST 与 ETF 跟踪标的
 * @param opts.date 交易日 YYYY-MM-DD
 * @param opts.listedTradeDays 上市以来第几个交易日（从 1 起）。不知道就不套「前 5 日不设限」
 */
export function limitRatio(
  code: string,
  opts: { name?: string; date?: string; listedTradeDays?: number } = {},
): number | null {
  const { name, date, listedTradeDays } = opts;
  if (isExchangeFund(code)) {
    const pct = etfLimitPercent(code, name);
    return pct == null ? null : pct / 100;
  }
  if (isStName(name)) return 0.05;
  const firstFive = listedTradeDays != null && listedTradeDays <= 5;
  if (isChiNext(code)) {
    if (date && date < CHINEXT_BAND_DATE) return 0.1;
    if (firstFive) return null;
    return 0.2;
  }
  if (isStarBoard(code)) {
    if (firstFive) return null;
    return 0.2;
  }
  if (isBeijing(code)) return 0.3;
  if (firstFive && date && date >= MAIN_IPO_UNLIMITED_DATE) return null;
  return 0.1;
}

/**
 * 涨停或跌停价：昨收 ×（1 ± 幅度），四舍五入到分。
 * 幅度为 null 时没有这个价。
 * @param prevClose 昨收
 * @param ratio 涨跌幅极限，正数；跌停传入负数
 */
export function limitPrice(prevClose: number, ratio: number | null): number | null {
  if (ratio == null || !(prevClose > 0)) return null;
  return Math.round(prevClose * (1 + ratio) * 100) / 100;
}

/**
 * 收盘是否封住涨停价或跌停价。没封住不叫涨停，也不叫暴跌。
 * @param close 收盘价
 * @param prevClose 昨收
 * @param ratio 当日幅度极限（正数）。null 表示该品种不设涨跌幅
 * @param dir up 涨停 / down 跌停
 */
export function isSealedLimit(
  close: number,
  prevClose: number,
  ratio: number | null,
  dir: 'up' | 'down',
): boolean {
  const px = limitPrice(prevClose, ratio == null ? null : dir === 'up' ? ratio : -ratio);
  if (px == null || !(close > 0)) return false;
  return Math.round(close * 100) === Math.round(px * 100);
}

/**
 * 卖出印花税，单位 bps。场内基金为 0。
 * 股票在 2023-08-28 之前为 10，从该日起为 5。
 * @param code 6 位代码
 * @param tradeDate 成交日 YYYY-MM-DD
 */
export function sellStampBps(code: string, tradeDate: string): number {
  if (isExchangeFund(code)) return 0;
  return tradeDate < STAMP_DUTY_CUTOVER ? 10 : 5;
}

/**
 * 过户费，双边，单位 bps。场内基金为 0，沪深股票为 0.1。
 * @param code 6 位代码
 */
export function transferFeeBps(code: string): number {
  return isExchangeFund(code) ? 0 : STOCK_TRANSFER_FEE_BPS;
}

/**
 * 申报数量取整。
 * 科创板买入不足 200 不下单，达到 200 后按 1 股递增。
 * 可转债按 10 张。其余按 100 股。
 * @param code 6 位代码
 * @param qty 拟申报数量
 * @param side 买或卖。200 股门槛只约束买入
 */
export function roundOrderQty(code: string, qty: number, side: 'buy' | 'sell'): number {
  if (!(qty > 0)) return 0;
  if (isConvertibleBond(code)) return Math.floor(qty / 10) * 10;
  if (isStarBoard(code) && side === 'buy') {
    if (qty < 200) return 0;
    return Math.floor(qty);
  }
  if (isStarBoard(code)) return Math.floor(qty);
  return Math.floor(qty / 100) * 100;
}

/**
 * 数量是否符合申报单位。不符合时返回人话，符合时返回 null。
 * @param code 6 位代码
 * @param qty 申报数量
 * @param side 买或卖
 */
export function orderQtyError(code: string, qty: number, side: 'buy' | 'sell'): string | null {
  if (!Number.isFinite(qty) || qty <= 0) return '数量需为正数';
  if (isConvertibleBond(code)) {
    return qty % 10 === 0 ? null : '可转债按 10 张申报';
  }
  if (isStarBoard(code) && side === 'buy') {
    if (qty < 200) return '科创板买入至少 200 股，不足 200 不下单';
    return Number.isInteger(qty) ? null : '科创板买入超过 200 的部分按 1 股递增';
  }
  if (isStarBoard(code)) return Number.isInteger(qty) ? null : '科创板卖出按 1 股递增';
  return qty % 100 === 0 ? null : '数量必须为 100 股的整数倍';
}

/**
 * 日线除权跳空门槛：开盘/前收低于 `1 - 返回值` 才进入折算判断。
 * null 表示关闭百分比推断（跨境、商品、无涨跌幅）。
 * ±10% 用 12%（严于 10%）。±20% 不用 12%，用 23%。
 * @param code 6 位代码，可空
 * @param name 简称，可空
 */
export function splitGapRatio(code?: string, name?: string): number | null {
  if (!code) return 0.12;
  if (isExchangeFund(code)) {
    const pct = etfLimitPercent(code, name);
    if (pct == null) return null;
    return pct >= 20 ? 0.23 : 0.12;
  }
  if (isChiNext(code) || isStarBoard(code)) return 0.23;
  if (isBeijing(code)) return 0.33;
  return 0.12;
}

/**
 * 周线内部折算门槛：`收盘/开盘` 低于该值才认定 bar 内折算。
 * ±10% 保留 0.55（严于 0.9^5）。±20% 改为 0.30（严于 0.8^5），不用 0.55。
 * 无涨跌幅品种返回 null，关闭这条推断。月线不使用本函数。
 * @param code 6 位代码，可空
 * @param name 简称，可空
 */
export function intrabarSplitRatio(code?: string, name?: string): number | null {
  const daily = splitGapRatio(code, name);
  if (daily == null) return null;
  return daily >= 0.2 ? 0.3 : 0.55;
}

/**
 * 这笔成交的 1R：成交价到存档止损的距离。
 * 区间上沿买入时，这段距离是区间宽 0.75 倍 ATR 加上止损 0.5 倍 ATR，共 1.25 倍 ATR。
 * @param fillPrice 这笔成交价
 * @param archivedStop 存档止损，下单后不改
 */
export function oneRDistance(fillPrice: number, archivedStop: number): number | null {
  if (!(fillPrice > 0) || !(archivedStop > 0) || !(fillPrice > archivedStop)) return null;
  return fillPrice - archivedStop;
}
