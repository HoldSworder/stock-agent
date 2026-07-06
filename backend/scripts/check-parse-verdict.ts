import assert from 'node:assert/strict';
import { parseVerdict } from '../src/watch/verdict';

// 最小断言自检：parseVerdict 能从「散文在前 + JSON 在后」的脏文本里稳健切出裁决与结构化指令，
// 根治旧版围栏剥离失败导致整段 blob 混入 advice、verdict 丢失的问题。
// 用法：pnpm --filter ./backend exec tsx scripts/check-parse-verdict.ts

// 1) 散文在前、json 在后（截图同款脏输出）
const dirty =
  '**看多理由**\n1. 资金净申购\n\n**裁决** 减仓\n\n' +
  '```json\n{"shouldAlert":true,"verdict":"减仓","advice":"MACD日线死叉确认中线动能转弱",' +
  '"instruction":{"action":"减仓","sizePct":50,"stopLoss":1.709,"takeProfit":null,' +
  '"invalidation":"放量站回1.884","reason":"日线死叉+主力净流出"}}\n```';
const v1 = parseVerdict(dirty);
assert.equal(v1.verdict, '减仓', '应从尾部 json 切出 verdict');
assert.equal(v1.advice, 'MACD日线死叉确认中线动能转弱', 'advice 取 json 字段，不夹带散文/围栏');
assert.ok(!v1.advice.includes('```'), 'advice 不应残留代码围栏');
assert.ok(v1.instruction, '应解析出结构化指令');
assert.equal(v1.instruction?.action, '减仓');
assert.equal(v1.instruction?.sizePct, 50);
assert.equal(v1.instruction?.stopLoss, 1.709);
assert.equal(v1.instruction?.takeProfit, null);

// 2) 干净 json + 非法 action → instruction 回退 null，但裁决仍可用
const v2 = parseVerdict('{"shouldAlert":false,"verdict":"持有","advice":"继续持有","instruction":{"action":"乱写"}}');
assert.equal(v2.shouldAlert, false);
assert.equal(v2.verdict, '持有');
assert.equal(v2.instruction, null, '非法 action 不构造指令');

// 3) 完全无 json → 保守按值得提示，原文进 advice
const v3 = parseVerdict('模型没按格式输出，只有一段散文。');
assert.equal(v3.shouldAlert, true);
assert.equal(v3.verdict, '');
assert.equal(v3.instruction, null);
assert.equal(v3.advice, '模型没按格式输出，只有一段散文。');

console.log('OK: parseVerdict 稳健切出裁决+指令，脏输出/非法动作/无 json 均正确兜底');
