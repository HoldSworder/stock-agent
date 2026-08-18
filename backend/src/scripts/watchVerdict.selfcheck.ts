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
import { eq } from 'drizzle-orm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WatchSignal } from '@stock-agent/shared';
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

// ===================================================================================
// 信号管道自检：缓存复用维度 / 迟滞门键与释放 / 涨跌停幅度 / 尾盘冷却时机。
// 以下模块会经 symbolPlans、strategy/sim 间接 import db/client，先把库指到临时文件再动态导入。
// ===================================================================================
const tmpDir = mkdtempSync(join(tmpdir(), 'watch-selfcheck-'));
process.env.DATABASE_PATH = join(tmpDir, 'test.sqlite');

const { ensureSchema } = await import('../db/migrate');
const { db: sdb, schema } = await import('../db/client');
const { findRecentAlertByCode, insertAlert } = await import('../watch/store');
const { approxLimitUp, limitRatioPct } = await import('../watch/rules');
const { gateSignals, releaseGate, resetGate } = await import('../watch/gate');
const { cooldownMsFor } = await import('../weipan/dispatcher');

ensureSchema();

/** 造一条最小 WatchSignal（只填规则/门控真正会读的字段） */
const mkSignal = (
  over: Partial<WatchSignal> & Pick<WatchSignal, 'code' | 'type' | 'severity'>,
): WatchSignal => ({
  name: over.code,
  source: 'position',
  price: 10,
  pct: 0,
  detail: 'selfcheck',
  score: 50,
  at: new Date().toISOString(),
  ...over,
});

// 11. 缓存复用必须区分信号类型/严重度，且不认沉默留痕
//     背景：只按 code 匹配时，一条 low 级 breakout 被初筛拦下所落的「跳过(初筛)」记录，
//     会让同一只票接下来整个复用窗口的 strategy_stop / limit_open 被整条丢弃——既不落库也不推送。
{
  const code = '600000';
  insertAlert({
    code,
    name: '浦发银行',
    source: 'watch',
    signalType: 'breakout',
    severity: 'low',
    detail: '创日内新高',
    runId: null,
    adviceText: '初筛跳过',
    verdict: '跳过(初筛)',
    shouldAlert: false, // 初筛留痕：沉默，不该参与缓存命中
    delivered: false,
  });
  assert.equal(
    findRecentAlertByCode(code, 20, { signalType: 'strategy_stop', severity: 'high' }),
    null,
    '一条 low 级初筛留痕不得让该标的的止损被判为「已研判过」',
  );
  assert.equal(
    findRecentAlertByCode(code, 20, { signalType: 'breakout', severity: 'low' }),
    null,
    'shouldAlert=false 的沉默记录不得参与缓存命中判断',
  );

  insertAlert({
    code,
    name: '浦发银行',
    source: 'position',
    signalType: 'drawdown_from_high',
    severity: 'medium',
    detail: '从高点回撤',
    runId: null,
    adviceText: '观察',
    verdict: '持有',
    shouldAlert: true,
    delivered: true,
  });
  assert.ok(
    findRecentAlertByCode(code, 20, { signalType: 'drawdown_from_high', severity: 'medium' }),
    '同类同级且已推送的研判才构成缓存复用',
  );
  assert.equal(
    findRecentAlertByCode(code, 20, { signalType: 'limit_open', severity: 'high' }),
    null,
    '炸板与回撤是两类信号，不得互相吞掉',
  );
  sdb.delete(schema.watchAlerts).run();
}

// 12. 迟滞门键须带 planId:conditionId，否则同一只票同 type 的第二条计划条件永久静默
{
  resetGate();
  const mkPlanSignal = (conditionId: string): WatchSignal =>
    mkSignal({
      code: '600001',
      type: 'plan_stop',
      severity: 'high',
      planHit: { planId: 'p1', planVersion: 1, conditionId },
    });
  const r = gateSignals([mkPlanSignal('cond-a'), mkPlanSignal('cond-b')], new Set(['position']));
  assert.equal(r.passed.length, 2, '同 type 不同条件的信号必须各自放行，不能被第一条的 active 状态吞掉');
  assert.equal(r.suppressed.length, 0);

  // A 条件持续成立（active，静默）时，B 条件仍应保有自己的独立状态
  const again = gateSignals([mkPlanSignal('cond-a')], new Set(['position']));
  assert.equal(again.passed.length, 0, '同一条件持续成立应被迟滞静默');
  resetGate();
}

// 13. 放行后被下游丢掉的信号要能还回迟滞门，否则「一天一次」的卖点当天彻底静默
{
  resetGate();
  const eod = mkSignal({ code: '600002', type: 'eod_settle', severity: 'high' });
  assert.equal(gateSignals([eod], new Set(['position'])).passed.length, 1, '首次出现应放行');
  assert.equal(
    gateSignals([eod], new Set(['position'])).passed.length,
    0,
    'active 期间不升级则静默',
  );
  releaseGate([eod]); // 模拟被 dispatcher 的限流/冷却丢弃
  assert.equal(
    gateSignals([eod], new Set(['position'])).passed.length,
    1,
    '被丢弃的信号释放状态后必须能重新放行，否则尾盘了结当天没有第二次机会',
  );
  resetGate();
}

// 14. 涨跌停幅度按板块与 ST 判定：688 按 10% 推算会误报炸板、真涨停反而不报
{
  assert.equal(limitRatioPct('688001'), 20, '科创板 688 为 20%');
  assert.equal(limitRatioPct('689009'), 20, '科创板 CDR 689 为 20%');
  assert.equal(limitRatioPct('301001'), 20, '创业板 301 为 20%');
  assert.equal(limitRatioPct('600000', 'ST浦发'), 5, '主板 ST 为 5%');
  assert.equal(limitRatioPct('600000', '*ST浦发'), 5, '*ST 同样按 5%');
  assert.equal(limitRatioPct('300001', 'ST创业'), 20, '创业板 ST 仍是 20%，不得被 ST 规则改成 5%');
  assert.equal(limitRatioPct('600000', '浦发银行'), 10, '主板普通股为 10%');

  // 北交所 30%：坏价过滤（2×幅度）与涨停判定（0.98×幅度）都吃这个返回值，
  // 按 10% 算会把北交所涨 25% 判成东财坏数据整轮跳过（rollState 也不更新），涨 10% 又误记新晋涨停
  assert.equal(limitRatioPct('830001'), 30, '北交所 8 开头为 30%');
  assert.equal(limitRatioPct('430001'), 30, '北交所 4 开头为 30%');
  assert.equal(limitRatioPct('830001', 'ST北证'), 30, '北交所 ST 不得被主板 5% 规则改写');

  assert.equal(approxLimitUp('688001', 100), 120, '688 涨停价按 +20% 推算');
  assert.equal(approxLimitUp('600000', 10, 'ST浦发'), 10.5, 'ST 涨停价按 +5% 推算');
  assert.equal(approxLimitUp('830001', 100), undefined, '北交所规则不同，宁可不给涨停价也不误报');
  assert.equal(approxLimitUp('600000', 0), undefined, '无昨收不推算');
}

// 15. 尾盘盯盘冷却只在成交后才写满程；偶发失败只给极短退避（不能一点不写：上游持续报错时
//     每 tick 都会重下单 + 重推 Telegram + 重落库），拒单冷却下界不得被 cooldownMin=0 压掉
{
  assert.equal(cooldownMsFor('sold', 30), 30 * 60_000, '成交后写完整冷却');
  assert.equal(cooldownMsFor('transient', 30), 30_000, '偶发失败写 30 秒短退避，不刷屏也不误伤止损');
  assert.ok(
    cooldownMsFor('transient', 1) < cooldownMsFor('rejected', 1),
    '偶发失败的退避必须短于确定性拒单，上游一恢复就要能重试',
  );
  assert.equal(
    cooldownMsFor('rejected', 30),
    6 * 60_000,
    '确定性拒单用更短的独立冷却压重复推送，但仍留重试窗口',
  );
  assert.equal(cooldownMsFor('rejected', 2), 60_000, '短冷却不低于 1 分钟');
  assert.equal(cooldownMsFor('rejected', 0), 60_000, 'cooldownMin=0 时下界仍是 1 分钟，不得退化成零冷却');
  assert.ok(
    cooldownMsFor('rejected', 30) < cooldownMsFor('sold', 30),
    '拒单冷却必须短于成交冷却',
  );
}

// 16. ETF 死信队列的 verdict 过滤必须在 SQL 里：留痕（观察/放弃）永远 delivered=false，
//     过滤放到取数之后时它们会占满 limit 名额，更早那条推送失败的建仓再也补发不出去
{
  const { insertEtfAlert, listEtfUndelivered } = await import('../etfwatch/store');
  const mkAlert = (verdict: '建仓' | '观察', createdAtOffsetMin: number) => {
    const a = insertEtfAlert({
      code: '512880',
      name: '证券ETF',
      signalType: 'buy_layer',
      layer: 1,
      timeframe: '30m',
      positionPct: 20,
      detail: 'selfcheck',
      triggerPrice: 1,
      dif: 0.1,
      dea: 0.05,
      confidence: 70,
      verdict,
      advice: null,
      confirm: null,
      instruction: null,
      trendStage: null,
      barTime: null,
      runId: null,
      delivered: false,
    });
    // 人为把时间往前挪，模拟「更早的建仓 + 之后攒了一堆观察留痕」
    sdb
      .update(schema.etfWatchSignals)
      .set({ createdAt: new Date(Date.now() - createdAtOffsetMin * 60_000).toISOString() })
      .where(eq(schema.etfWatchSignals.id, a.id))
      .run();
    return a.id;
  };
  const buyId = mkAlert('建仓', 120); // 两小时前推送失败的建仓
  for (let i = 0; i < 25; i++) mkAlert('观察', 25 - i); // 之后的 25 条观察留痕

  const pending = listEtfUndelivered();
  assert.ok(
    pending.some((a) => a.id === buyId),
    '观察留痕不得把死信队列名额占满，真正推送失败的建仓必须仍在候选里',
  );
  assert.equal(
    pending.every((a) => a.verdict === '建仓' || a.verdict === '撤层' || a.verdict === '硬止损'),
    true,
    '死信队列只能出现需要投递的 verdict',
  );
  sdb.delete(schema.etfWatchSignals).run();
}

rmSync(tmpDir, { recursive: true, force: true });
console.log('✅ 盯盘信号管道自检通过：缓存复用分类型分级 · 计划条件各自迟滞 · 丢弃可回退 · 涨跌停分板块 · 冷却后置');
