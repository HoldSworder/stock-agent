// 一次性：从最新 research-modes-seed.json 刷新模式库回测指标（复利/非复利收益等），
// 保留关注状态与每日跟踪。用法：pnpm --filter ./backend modes:reseed
import { reseedResearchModes } from '../seeds/researchModes';

const r = reseedResearchModes();
console.log(`[reseed] done: ${r.modes} modes / ${r.backtests} backtests`);
process.exit(0);
