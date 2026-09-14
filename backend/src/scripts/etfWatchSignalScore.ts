// ETF 盯盘信号的成绩单：这套买卖点比随便买强多少。
//
// 只读本地库，不联网、不写库、不调模型，同样的输入永远得出同样的分数。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/etfWatchSignalScore.ts [持有天数...]
// 例：  ./node_modules/.bin/tsx src/scripts/etfWatchSignalScore.ts 5 10 20
//
// 判分逻辑全在 src/scorecard/ 里，本脚本只负责把结果打成人看的表格。
// 这样脚本与接口用的是同一套口径——两处各写一份的话，两边的分数会慢慢对不上，
// 而「成绩单」这种东西一旦出现两个版本就没人信了。
import { scoreSignals, DEFAULT_HORIZONS } from '../scorecard/score';
import { poolFor, SIGNAL_SOURCES } from '../scorecard/sources';

const HORIZONS = (() => {
  const args = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return args.length ? args : [...DEFAULT_HORIZONS];
})();

const pct = (v: number): string => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;
/** 按显示宽度补齐（中文按两格算），否则中英混排的表头会错位 */
const pad = (s: string, w: number): string => {
  const width = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(1, w - width));
};

console.log('# ETF 盯盘信号成绩单');
console.log();

for (const src of SIGNAL_SOURCES) {
  const card = scoreSignals({
    source: src.id,
    label: src.label,
    signals: src.load(),
    side: src.side,
    horizons: HORIZONS,
    pool: poolFor(src),
  });
  if (card.count === 0) continue;

  console.log(`## ${card.label}`);
  console.log();
  console.log(`产生方式：${src.origin}`);
  console.log(
    `原始 ${card.rawCount} 条，同标的同日合并后 ${card.count} 条｜` +
      `区间 ${card.from} ~ ${card.to}｜对照池 ${card.poolSize} 只`,
  );
  if (src.side === 'short') {
    console.log('（看跌信号：下面的走势是「假如当时没卖、继续持有」的结果，');
    console.log('　所以走势越低说明当初该卖这个判断越对。价值两列已按此方向换算。）');
  }
  console.log();
  console.log(
    pad('持有', 8) +
      pad('可判', 7) +
      pad('后续走势', 12) +
      pad('上涨占比', 11) +
      pad('同标的随机日', 15) +
      pad('同日全池', 12) +
      pad('对比随机日', 13) +
      pad('对比全池', 11),
  );
  for (const r of card.rows) {
    console.log(
      pad(`${r.horizon}日`, 8) +
        pad(String(r.judged), 7) +
        pad(pct(r.mean), 12) +
        pad(`${(r.upRatio * 100).toFixed(0)}%`, 11) +
        pad(pct(r.baselineSameCode), 15) +
        pad(pct(r.baselineSameDate), 12) +
        pad(pct(r.edgeVsSameCode), 13) +
        pad(pct(r.edgeVsSameDate), 11),
    );
  }
  console.log();
  console.log(`结论：${card.verdict}`);
  console.log();

  // 分组：检验模型裁决那一层有没有增加信息。
  // 如果「建仓」和「放弃」的事后收益没有差别，这层裁决就是白花钱。
  if (card.byTag.length > 1) {
    console.log(`### 按裁决分组（持有 ${card.rows[0]?.horizon} 日）`);
    console.log();
    console.log(pad('裁决', 12) + pad('可判', 7) + pad('走势', 12) + pad('上涨占比', 11));
    for (const t of card.byTag) {
      console.log(
        pad(t.tag, 12) +
          pad(String(t.judged), 7) +
          pad(pct(t.mean), 12) +
          pad(`${(t.upRatio * 100).toFixed(0)}%`, 11),
      );
    }
    console.log();
  }
}

console.log('---');
console.log('怎么读：只看「对比随机日」和「对比全池」两列，它们已按信号方向换算成价值。');
console.log('后续走势那一列本身说明不了任何问题——区间里大盘怎么走，随便买也是那个结果。');
console.log('两列都明显为正，这套信号才算有本事；接近零或为负，说明它还不如瞎买。');
