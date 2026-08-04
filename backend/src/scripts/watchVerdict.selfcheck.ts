/**
 * 盯盘终审解析自检。合并自原 backend/scripts/check-parse-verdict.ts，锁两条纪律：
 *   1. advice 永不回落成模型整段原文
 *   2. 尾部合法 JSON 里的 verdict / instruction 必须被切出来
 *
 * 背景：advice 直接进 Telegram 推送与驾驶舱告警行，曾出现模型把思考过程写在散文里、
 * JSON 里 advice 为空，整段英文自言自语被当成告警建议落库，前端一条 flex 行被撑到
 * 远超视口，页面底部多出横向滚动条。而 verdict/instruction 是自动卖出的输入
 * （dispatcher 的 maybeExecuteStrategySell 只读 verdict.verdict），切丢了会静默漏卖。
 */
import assert from 'node:assert/strict';
import { parseVerdict, parseInstruction } from '../watch/verdict';

/** 模拟模型「散文在前 + JSON 在后」的产出 */
const PROSE = 'Let me try the key data points before finalizing. Key discrepancies noted: '.repeat(12);

// 1. 散文 + 代码围栏 + 尾部 JSON（线上同款脏输出）：裁决与指令都要切出来，advice 不夹带围栏
{
  const dirty =
    '**看多理由**\n1. 资金净申购\n\n**裁决** 减仓\n\n' +
    '```json\n{"shouldAlert":true,"verdict":"减仓","advice":"MACD日线死叉确认中线动能转弱",' +
    '"instruction":{"action":"减仓","sizePct":50,"stopLoss":1.709,"takeProfit":null,' +
    '"invalidation":"放量站回1.884","reason":"日线死叉+主力净流出"}}\n```';
  const v = parseVerdict(dirty);
  assert.equal(v.verdict, '减仓', '应从尾部 json 切出 verdict');
  assert.equal(v.advice, 'MACD日线死叉确认中线动能转弱', 'advice 取 json 字段，不夹带散文/围栏');
  assert.ok(!v.advice.includes('```'), 'advice 不应残留代码围栏');
  assert.equal(v.instruction?.action, '减仓');
  assert.equal(v.instruction?.sizePct, 50);
  assert.equal(v.instruction?.stopLoss, 1.709);
  assert.equal(v.instruction?.takeProfit, null);
}

// 2. 散文里含花括号：不得毒化 JSON 切片，否则尾部真实裁决被丢弃 → 自动卖出静默漏执行
{
  const v = parseVerdict(
    '先看结构 {a:1} 再看量能 {b:2}\n{"shouldAlert":true,"verdict":"清仓","advice":"跌破颈线立即清仓","instruction":{"action":"清仓"}}',
  );
  assert.equal(v.verdict, '清仓', '散文含花括号时仍须切出尾部合法 JSON');
  assert.equal(v.instruction?.action, '清仓', 'instruction 是自动卖出的输入，不得因切片错位丢失');
  assert.equal(v.advice, '跌破颈线立即清仓');
}

// 3. 非法 action → instruction 回退 null，但裁决仍可用
{
  const v = parseVerdict('{"shouldAlert":false,"verdict":"持有","advice":"继续持有","instruction":{"action":"乱写"}}');
  assert.equal(v.shouldAlert, false);
  assert.equal(v.verdict, '持有');
  assert.equal(v.instruction, null, '非法 action 不构造指令');
}

// 4. JSON 里 advice 为空：绝不能把散文塞进来，且要留空让调用方回退到触发原因
{
  const v = parseVerdict(`${PROSE}\n{"shouldAlert":false,"verdict":"观望","advice":"","instruction":{"action":"观望"}}`);
  assert.ok(!v.advice.includes('Let me try'), 'advice 不得混入模型散文/思考过程');
  assert.equal(v.advice, '', 'advice 缺失须留空，占位文案会吃掉下游 `advice || detail` 的兜底');
  assert.equal(v.verdict, '观望', '正文缺失不影响裁决透传');
  assert.equal(v.shouldAlert, false, 'shouldAlert 须如实透传，不得被兜底改写');
  assert.equal(v.instruction?.action, '观望');
}

// 5. advice 字段整个缺失、或不是字符串：同样留空且不回落原文
{
  const missing = parseVerdict(`${PROSE}\n{"shouldAlert":false,"verdict":"持有"}`);
  assert.equal(missing.advice, '');
  assert.equal(missing.verdict, '持有');
  const wrongType = parseVerdict('{"shouldAlert":true,"verdict":"减仓","advice":123}');
  assert.equal(wrongType.advice, '', 'advice 非字符串按缺失处理，不得 String() 强转');
}

// 6. 超长 advice 必须截断留痕，且产出总长不超上限
{
  const long = '这是一段很长的建议正文。'.repeat(200);
  const v = parseVerdict(JSON.stringify({ shouldAlert: true, verdict: '减仓', advice: long }));
  assert.ok(v.advice.length < long.length, 'advice 超长必须截断');
  assert.ok(v.advice.includes('原文过长已截断'), '截断需留痕，避免误读成模型只说了这些');
  assert.ok(v.advice.length <= 400, `产出含标记不得超上限，实际 ${v.advice.length}`);
}

// 7. 截断按码点切分，不得切裂代理对produce孤立高位（会渲染成替换字符）
{
  const v = parseVerdict(JSON.stringify({ advice: `甲${'😀'.repeat(300)}` }));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(v.advice), '截断不得留下孤立高位代理');
}

// 8. JSON 完全解析不出：保守报警，正文用截断原文并标明格式异常
{
  const v = parseVerdict(PROSE);
  assert.equal(v.shouldAlert, true, '解析失败应保守按值得提示处理');
  assert.equal(v.verdict, '');
  assert.equal(v.instruction, null);
  assert.ok(v.advice.includes('未按结构化格式输出'), '需标明是格式异常而非模型结论');
  assert.ok(v.advice.length < PROSE.length, '兜底路径同样要截断');
}

// 9. 空产出不构成告警：否则会推一条尾巴悬空的空消息
{
  const v = parseVerdict('   \n  ');
  assert.equal(v.shouldAlert, false, '空产出不得强制推送');
  assert.equal(v.advice, '');
}

// 10. instruction 只认白名单动作，数值字段非法须为 null 而非 NaN
{
  assert.equal(parseInstruction({ action: '梭哈' }), null);
  assert.equal(parseInstruction(null), null);
  const ins = parseInstruction({ action: '减仓', sizePct: '30', stopLoss: 'abc' });
  assert.equal(ins?.action, '减仓');
  assert.equal(ins?.sizePct, 30, '数值字段接受字符串数字');
  assert.equal(ins?.stopLoss, null, '非法数值必须为 null 而非 NaN');
}

console.log('✅ 盯盘终审解析自检通过：裁决/指令稳健切出 · advice 不回落原文 · 截断留痕 · 空产出不报警');
