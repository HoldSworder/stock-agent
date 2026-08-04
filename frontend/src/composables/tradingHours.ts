/**
 * A 股交易时段判定（前端轮询节流共用）。
 * 只看东八区星期与时分，不含法定节假日日历——节假日会被当作交易日，
 * 后果仅是多打几次只读行情接口，代价低于在前端维护一份假期表。
 */
export function isTradingNow(): boolean {
  const sh = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const day = sh.getDay();
  if (day === 0 || day === 6) return false;
  const hm = sh.getHours() * 60 + sh.getMinutes();
  return (hm >= 570 && hm <= 690) || (hm >= 780 && hm <= 900);
}
