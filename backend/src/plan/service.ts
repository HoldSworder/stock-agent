import type {
  DailyPlan,
  DailyPlanDetail,
  DailyPlanItem,
  MarketStance,
  NotifyChannel,
  PlanAssetType,
  PlanFocusSector,
  PlanFulfillment,
  PlanItemStatus,
  PlanTrigger,
  RunTrigger,
} from '@stock-agent/shared';
import { isIndividualStock } from '../decision/sellcheck';
import { mapDecisionToVerdict, runDecisionBatch } from '../decision/service';
import { runTask, type RunTaskResult } from '../runner';
import * as gateway from '../agent/gateway';
import { signals as etfSignals } from '../etf/service';
import { fetchRealPositions } from '../realPositions';
import { buildRotationOverview, formatForAgent } from '../rotation/service';
import { shanghaiToday } from '../util';
import * as repo from './repo';

// 今日计划业务封装：按 Asia/Shanghai 推算当日，负责生成落库（save）、盘中读取/对照（get/update）、
// 收盘复盘回填（close），以及给 agent 看的纯文本格式化。

export const PLAN_GEN_TASK_NAME = '今日计划-0830-生成';
export const PLAN_REVIEW_TASK_NAME = '今日计划-1530-收盘复盘';
export const PLAN_REEVAL_TASK_NAME = '今日计划-盘中重评估';

/** 盘前生成 prompt：以六源最新持久化 AI 分析 + 持仓纪律为基准，妙想筛选校验，落结构化计划 */
export const PLAN_GEN_PROMPT =
  '生成今日 A 股【作战计划】：以情报研判/大盘与板块研判/复盘/ETF综合研判/上一计划复盘五源【最新一次产出的 AI 分析】为基准，串成一份可被盘中盯盘程序化执行的结构化计划。' +
  '专业框架（务必体现，重心在 ETF）：先以大盘近期走势/资金面/情绪（含外盘）定「今日择时档位」作为前提闸门；在闸门约束下，【ETF 为本计划主线、是真实大仓位的主战场】，重中线（强势赛道右侧介入+消息催化），是优先研判、优先落实可执行触发价的对象；【个股为模拟参考层】，重短线（资金面+情绪+近期走势+消息催化），仅作辅助参考、不挤占 ETF 主仓。消息面贯穿两者，优先找「起爆前/消息催化」而非追高。本任务仅研判规划，不下单。\n\n' +
  '交易日校验（默认放行）：仅周一至周五触发，默认按交易日执行；接口异常一律按交易日继续，不据此判休市。\n\n' +
  '第1步 读基准（核心）：调用 get_plan_context 一次性取五源最新 AI 分析，注意各源在本框架中的职责——①情报研判（研报机会 + 全网热点 合并）＝消息催化来源：重点抽取「起爆前·尚未充分发酵」的催化板块/个股，区别于已发酵高位；②大盘与板块研判（大盘复盘 + 板块主线 + 期货外盘 合并）＝择时前提：取其大盘方向/情绪温度档位/资金持续性 + 确定性主线/中线行业 + 期货外盘对次日开盘的传导（商品产业链受益/承压、VIX 避险、中概金龙映射）；③一键复盘（综合方向/外围/主线/次日策略，含「明日重点关注」「强势板块/个股候选」「风险清单」）；④ETF 综合研判（操作信号 + 中线赛道轮动 合并）＝【本计划 ETF 主线的核心基准】：取「该进攻赛道（上升/加速+RS正+周线多头）/该等回踩/该回避」；⑤上一计划收盘复盘（含命中得失与「次日预案草稿」，作为延续与纠偏起点）。' +
  '严禁再现场重跑 trendradar_hotspots(summary) 或 research_reports(discover) 等重型分析；本计划以这五份已产出的分析为唯一基准。某源若标注缺失或非当日产出，照常使用但在 narrative 风险项注明时效。\n' +
  '第2步 定「今日择时档位」（前提闸门，半硬约束）：综合②大盘与板块研判（方向/情绪温度档位/资金持续性 + 期货外盘 VIX 避险/中概金龙映射/隔夜方向），先判定今日档位，并据档位约束后续所有 ETF/个股 的 direction 与仓位——\n' +
  '  · 防守（大盘偏空 / 缩量 / 赚钱效应差 / 外盘大跌避险）：ETF 仅保留右侧最强且已持有的，其余降为 watch；个股一律只给 watch/reduce/sell，禁新开多、禁追高；marketStance.positionPct ≤ 30。\n' +
  '  · 均衡（中性 / 主线分歧 / 量能温和）：ETF 取该进攻赛道 1-2 个右侧标的；个股精选 1-2 只低吸或右侧确认（buy 从严），positionPct 约 30-60。\n' +
  '  · 进攻（大盘偏多 / 放量 / 赚钱效应好 / 外盘配合）：ETF 与个股均可右侧进攻，可正常给 buy，positionPct 约 60-90。\n' +
  '  档位与理由要落到 marketStance.summary 与 narrative，且后续每个 buy/加仓决策都必须与档位一致。\n' +
  '第3步【主线】ETF 中线右侧计划（重中线：强势赛道右侧介入+消息催化，本计划最优先、最该给透可执行性的部分）：候选优先来自④ETF 综合研判的「该进攻赛道」（上升/加速 + RS 跑赢沪深300 + 周线多头＝右侧强势），而非简单取信号买入区；右侧纪律——回避「过热/破位/抄底左侧」，对「该等回踩」赛道列 watch 并给回踩确认触发价；与情报研判的催化赛道交叉印证（消息催化 + 右侧强势＝优先）。' +
  'ETF 的 direction 由轮动状态决定（上升/加速→可 buy，回踩→watch，过热/破位→reduce 或不入计划）；再用 etf_signals(action=signals) 取这些右侧候选的结构化信号，etf_signals 只负责提供 buyTrigger/sellTrigger/stopLoss/takeProfit 触发价与折溢价风险，不用它的买卖建议覆盖轮动结论（折溢价缺失的用 mx_finance_data 补 IOPV 再定夺追高风险）；用 real_positions 识别已持有 ETF（结合成本/盈亏判断加减仓）；ETF 候选 source 填 sector。每只 ETF thesis 写清右侧/回踩状态 + RS/周线/资金 + 消息催化，并给 confidence。\n' +
  '第4步【参考层】个股短线选股（模拟参考，重短线：资金面+情绪+近期走势+消息催化）：在第2步档位约束下选个股（限定主板/创业板：60/000/001/002/003/300/301 开头，排除 ST、科创板 688/689、北交所 8/4 开头）。个股为辅助参考层，不挤占 ETF 主仓，宁缺毋滥。\n' +
  '  · 起爆前催化候选：先调用 list_catalysts(unfermentedOnly=true) 读近期结构化催化主线，重点关注「反复出现(seenCount≥2)但仍未发酵」的潜伏题材——它们是起爆前埋伏的优先来源；把这些题材关键词纳入下面 screen_stocks 的 context。\n' +
  '  · 第一层候选池：用 screen_stocks 取活跃题材候选——起爆前埋伏优先用 strategyId=pre_breakout_catalyst（会对候选池逐只补「趋势：多头排列/临近20日新高/量能放大」与「资金流：主力净流入持续性」因子，最贴合本框架四要素中的走势+资金面），进攻追涨用 theme_momentum（题材动量），放量突破用 volume_breakout；context 传今日主线关键词（取自上面催化主线 + 大盘与板块研判确定性主线，如「机器人 算力 固态电池」）。注意：theme_momentum/volume_breakout 是【当日横截面】引擎，算不出资金面连续性/均线走势/消息催化；pre_breakout_catalyst 已补趋势与资金面但仍不含消息催化——消息催化必须对照 list_catalysts/情报研判逐只补齐，不要把候选池当成已完成的四要素选股。\n' +
  '  · 第二层四要素校验：对候选用 mx_assistant_ask/mx_finance_data 逐只核实——①资金面（主力净流入是否为正且连续、大单/北向）②情绪（是否涨停/连板梯队、题材热度、量比活跃）③近期走势（5/10/20 日均线是否多头、是否放量突破平台或创阶段新高、是否已连续大涨高位透支）④消息催化（对照情报研判，是否有「起爆前·未充分发酵」催化）。\n' +
  '  · 个股两类打法明确区分，不可混写：【起爆前埋伏】催化未发酵+低位/平台首次异动→低仓试探（positionHint 小、buy 从严或先 watch+突破确认）；【右侧确认】放量突破+均线多头+资金流入→标准仓 buy。\n' +
  '  · 触发价「次日可参与性」纪律（个股 buyTrigger 必须次日盯盘真能照做，禁止给伪参考）：个股的 buyTrigger 若为回踩/低吸型（type=pullback 或 price），其 value 距已校验现价的回撤不得超过 3%（即 value≥现价×0.97；创业板 300/301 可放宽至 ≤4%）。超过该幅度的低吸位次日基本不可达、且真到达则原买入逻辑（趋势/资金/催化）已同步走坏，严禁作为 buyTrigger。此时二选一：①改用右侧突破型 buyTrigger（type=breakout，value=贴近现价上沿的突破确认价）；②若当前没有次日可参与的合理介入点，则该标的 direction 直接给 watch，把那个远端低吸位写进 confirmConditions/thesis 描述，而不要塞进 buyTrigger 冒充可执行计划。\n' +
  '  · 同时用 real_positions 读真实持仓（只读）、mx_self_select(get) 读自选股，把需重点对照的持仓/自选纳入候选并标注 source；用 get_position_discipline 读持仓纪律体检，破止损/达止盈/超期/超配的持仓优先纳入（direction 倾向 reduce/sell，source=position，thesis 注明纪律触发类型与建议动作）。\n' +
  '  · 每只个股 thesis 必须给短线四要素打分（资金面/情绪/走势/催化 各标 强/中/弱/缺失）+ 线索来源；任一 buy 至少满足 3 项、且催化须注明来源与是否已发酵。来源标识：经 screen_stocks 选入的个股 source 填 screener；来自研报/热点/板块/持仓/自选的分别填 research/hotspot/sector/position/watchlist。\n' +
  '  · 每只标的给 confidence 置信度(0-100)：四要素全强/右侧确认成立≈80-95，三项强+催化明确≈65-80，仅潜伏埋伏≈45-60，观察级<45。阈值纪律：confidence≥65 才宜 direction=buy（且满足档位约束），45-65 一律 watch+确认条件，<45 不入计划。\n' +
  '第5步 校验触发价：对 ETF 与个股候选用 mx_finance_data / etf_signals 批量校验现价/涨跌停价，据此为每只给出真实可执行的结构化触发价（买/卖/损/盈）；价位务必基于校验过的真实数据，不得凭空编造。落库前对每只【个股】自检 buyTrigger 可参与性：buy 方向标的的 buyTrigger 距现价回撤须 ≤3%（创业板 300/301 放宽至 ≤4%），不满足者按第4步纪律降级为 watch 或改右侧突破价；ETF 主线不受此约束（中线右侧/回踩逻辑保留原样）。\n' +
  '第6步 综合落库：把上面信息综合成结构化计划，调用 save_today_plan 一次性落库——\n' +
  '  - marketStance：方向(bias)/择时档位(timingLevel：attack 进攻 / balanced 均衡 / defense 防守，须与第2步一致)/建议仓位(positionPct，须与档位上限一致)/关键支撑(support)/压力(resistance)/一句话定调(summary，含择时档位与理由)；其中 support/resistance 必须围绕 get_plan_context 返回的【实时大盘点位】（上证/深成指当前点位）上下合理推算（一般在当前点位 ±1~3% 的关键整数关口），严禁沿用记忆中的历史点位，落库前自检支撑<现价<压力且与实时点位同量级；\n' +
  '  - focusSectors：今日重点板块（名称+强度阶段+理由）；\n' +
  '  - externalContext：隔夜外围与政策要点；\n' +
  '  - items：每只标的给 code/name/direction(buy/hold/reduce/sell/watch)/thesis(ETF 写右侧/回踩状态，个股写四要素打分，均注明来源)/source(research/hotspot/sector/screener/position/watchlist)/confidence(0-100 置信度，按上面阈值纪律)/positionHint，' +
  '并给 confirmConditions（右侧确认条件：ETF 回踩不破均线后再放量转强，个股放量突破某价/均线多头确认）与 invalidConditions（逻辑失效条件：大盘跌破支撑且缩量、板块跌出资金流入榜、个股跌破昨高或平台下沿等，满足则当天取消），' +
  '并尽量给结构化触发价 buyTrigger/sellTrigger/stopLoss/takeProfit（{type:"price|breakout|pullback", value:数字, note}），触发价务必用 mx_finance_data/etf_signals 校验过的真实价位；\n' +
  '  - 落库前自检（档位一致性）：当前 timingLevel 下，每个 buy 是否合规——防守档不得对新个股标的（source≠position）给 buy，一律改 watch；均衡档个股 buy 从严（≤2 只）；进攻档同题材个股 buy ≤2 只。不合规的先降级再落库。\n' +
  '  - narrative：给人看的完整作战图（Markdown，固定分段依次为：基准时效（六源各自当日/非当日/缺失）→ 大盘定调 → 今日择时档位（进攻/均衡/防守 + 理由 + 仓位上限）→ 今日可执行清单（以 ETF 为先，按 confidence×优先级排序的 Top 标的，逐条一行：方向 + 名称(代码) + 触发价 + 仓位 + 置信度 + 一句确认信号，让人开盘即可照做）→ 板块主线 → ETF计划（主线·逐只，标右侧/回踩等待与确认/失效条件）→ 个股计划（参考·逐只，标四要素打分、置信度与确认/失效条件）→ 风险提示 → 次日预案占位（先留「待收盘复盘回填」））。\n' +
  '注意：ETF 跟踪池标的（基金代码，如 15/51/56/58 开头）不受个股板块限制；个股只可选主板/创业板标的（60/000/001/002/003/300/301 开头），排除科创板(688/689)与北交所(8/4 开头)。落库后简要汇报计划概要即可，平台会自动推送 narrative。';

/** 旧版盘前生成 prompt（现场重跑各模块）：仅供种子迁移识别覆盖，勿用于运行 */
export const PLAN_GEN_PROMPT_LEGACY =
  '生成今日 A 股【作战计划】，把研报/热点/板块/持仓/大盘/外围串成一份可被盘中盯盘程序化执行的结构化计划。本任务仅研判规划，不下单。\n\n' +
  '交易日校验（默认放行）：仅周一至周五触发，默认按交易日执行；接口异常一律按交易日继续，不据此判休市。\n\n' +
  '第1步 大环境趋势 + 复盘继承：先用 get_latest_review_stance 取上一交易日复盘核心结论——' +
  '既作为大环境趋势基准（综合方向/定调/外围影响），也把其中的「明日重点关注」「强势板块/个股候选」「值得关注自选」作为今日计划的候选标的来源之一，' +
  '并把复盘「风险清单」并入今日计划的风险提示；' +
  '再用 trendradar_hotspots(action=summary 或 trending) 取隔夜美股/港股/政策与全网热点；结合二者提炼对今日 A 股的方向影响。\n' +
  '第2步 研报机会：用 research_reports(action=discover, days=1) 取当日新研报聚合，找出被密集上调/覆盖的板块与个股机会线索。\n' +
  '第3步 大盘与板块：用 market_snapshot 读大盘指数/成交额/情绪温度/涨停梯队/板块资金流与领涨领跌，定调今日方向与建议仓位。\n' +
  '第4步 持仓与自选：用 real_positions 读真实持仓（只读）、mx_self_select(get) 读自选股，标注需重点对照的标的。\n' +
  '第4.5步 ETF 计划项：用 etf_signals(action=signals) 取 ETF 跟踪池量化信号（估值分位/折溢价/动量排名/网格水位/操作建议与结构化触发价）；把命中买入区（建议 buy/add）或减仓·止盈区（建议 reduce）的 ETF 一并纳入下方 items——direction 映射为 buy/hold/reduce/sell，source 填 other，并直接采用 etf_signals 返回的 buyTrigger/sellTrigger/stopLoss/takeProfit 作为结构化触发价（折溢价标注缺失的，可用 mx_finance_data 补 IOPV 再定夺追高风险）。处于持有/规避的 ETF 不必入计划。\n' +
  '第5步 综合落库：把上面信息综合成结构化计划，调用 save_today_plan 一次性落库——\n' +
  '  - marketStance：方向(bias)/建议仓位(positionPct)/关键支撑(support)/压力(resistance)/一句话定调(summary)；\n' +
  '  - focusSectors：今日重点板块（名称+强度阶段+理由）；\n' +
  '  - externalContext：隔夜外围与政策要点；\n' +
  '  - items：每只标的给 code/name/direction(buy/hold/reduce/sell/watch)/thesis(逻辑)/source(research/hotspot/sector/position/watchlist)/positionHint，' +
  '并尽量给结构化触发价 buyTrigger/sellTrigger/stopLoss/takeProfit（{type:"price|breakout|pullback", value:数字, note}），触发价务必用 market_snapshot/mx_finance_data 校验过的真实价位；\n' +
  '  - narrative：给人看的完整作战图（Markdown，含大盘定调、板块主线、逐只标的计划、风险提示）。\n' +
  '注意：个股只可选主板/创业板标的（60/000/001/002/003/300/301 开头），排除科创板(688/689)与北交所(8/4 开头)；ETF 跟踪池标的（基金代码，如 15/51/56/58 开头）不受此个股板块限制，按 etf_signals 信号纳入。落库后简要汇报计划概要即可，平台会自动推送 narrative。';

/** 收盘复盘 prompt：计划 vs 实际，回填 + 闭环 */
export const PLAN_REVIEW_PROMPT =
  '对今日【作战计划】做收盘复盘闭环。本任务只复盘不下单。\n\n' +
  '交易日校验（默认放行）：仅周一至周五触发，默认按交易日执行；接口异常一律按交易日继续。\n\n' +
  '第1步 读计划：用 get_today_plan 读今日计划（含各标的方向/触发价/盘中已触发状态与备注）。若今日无计划，直接说明并结束。\n' +
  '第2步 读实际：用 real_positions 读真实持仓，用 market_snapshot 看收盘盘面；对计划内标的用 mx_finance_data 核验当日表现；' +
  '并调用 get_attribution 一次，读当日【持仓归因】（账户当日盈亏/贡献、最大赢家/输家、逐票当日盈亏贡献=当日盈亏率×仓位权重），作为账户层得失的确定性事实基础。\n' +
  '第3步 逐项评估：对每只计划标的判断「计划 vs 实际」——是否触发、是否兑现、结果对错；调用 update_plan_item(code, status, note) 回写：' +
  '已按计划完成/已了结=done，逻辑已破坏/全天未触发且失效=invalid，仍有效待续=保持 pending，note 写一句结果点评。\n' +
  '第4步 收盘归档：调用 close_today_plan(reviewSummary) 回填复盘总结。reviewSummary 用 Markdown 覆盖：①大盘与情绪小结（结合持仓归因点出当日账户是谁在贡献/谁在拖累，给出最大赢家与最大输家及其贡献）②计划命中率与得失 ' +
  '③逐只标的结果（持仓标的结合其当日盈亏贡献评价）④战法/打法改进建议 ⑤次日预案草稿（重点关注方向与应对）。\n' +
  '推送禁止 Markdown 表格，用竖排清单。';

export const PLAN_REEVAL_PROMPT =
  '对今日【作战计划】做一次「盘中重评估」，只纠偏不下单：按当前盘面把已失效的计划项标 invalid、已触发的标 triggered，让计划与实时行情对齐。\n\n' +
  '交易日校验（默认放行）：仅周一至周五触发，默认按交易日执行；接口异常一律按交易日继续。\n\n' +
  '第1步 读计划：用 get_today_plan 读今日计划（含择时档位、各标的方向/触发价/确认条件 confirm/失效条件 invalid/当前状态）。若今日无计划或计划非 active，直接说明并结束。\n' +
  '第2步 读盘面：用 market_snapshot 看实时大盘与板块强弱、情绪温度；对仍是 pending/triggered 的计划标的用 quotes 取实时价（必要时 mx_finance_data 核验），判断是否触及触发价/确认条件或满足失效条件。\n' +
  '第3步 逐项判定（仅处理 pending/triggered，done/invalid 跳过）：\n' +
  '  · 满足该标的「失效条件 invalidConditions」任一项，或大盘明显转弱已跌破其依赖的支撑/板块跌出资金流入榜 → update_plan_item(code, "invalid", note)，note 写明触发了哪条失效逻辑；\n' +
  '  · 已突破触发价且满足「确认条件 confirmConditions」（右侧确认成立）→ update_plan_item(code, "triggered", note)，note 写明确认信号；\n' +
  '  · 逻辑仍成立、尚未触发 → 保持 pending，不调用工具。\n' +
  '  判定保守：证据不足时维持原状，宁可不动也不要误杀有效计划。\n' +
  '第4步 简报：用竖排清单输出本次重评估结论——当前大盘择时是否仍成立、被标 invalid 的标的及原因、被标 triggered 的标的及确认信号、仍有效待续的清单。不要新增标的、不要改触发价、不调用 save_today_plan。\n' +
  '⚠️ 仅供参考，不构成投资建议。';

/** 当日（Asia/Shanghai）计划主记录，无则 null */
export function getTodayPlan(): DailyPlan | null {
  return repo.getPlanByDate(shanghaiToday());
}

/** 当日生效计划的标的项（供盯盘引擎并池；非 active 或无计划返回空） */
export function getActivePlanItems(): DailyPlanItem[] {
  const plan = getTodayPlan();
  if (!plan || plan.status !== 'active') return [];
  return repo.listItems(plan.id);
}

/** 某日完整详情（计划+标的+事件） */
export function getDetailByDate(date: string): DailyPlanDetail | null {
  const plan = repo.getPlanByDate(date);
  if (!plan) return null;
  return { plan, items: repo.listItems(plan.id), events: repo.listEvents(plan.id) };
}

/** 当日完整详情 */
export function getTodayDetail(): DailyPlanDetail | null {
  return getDetailByDate(shanghaiToday());
}

/** 历史计划摘要列表（按计划日倒序，供历史抽屉） */
export function listSummaries(limit?: number) {
  return repo.listPlanSummaries(limit);
}

export interface SavePlanItemInput {
  code: string;
  name: string;
  assetType?: PlanAssetType;
  direction?: DailyPlanItem['direction'];
  thesis?: string;
  buyTrigger?: PlanTrigger | null;
  sellTrigger?: PlanTrigger | null;
  stopLoss?: PlanTrigger | null;
  takeProfit?: PlanTrigger | null;
  positionHint?: string;
  confirmConditions?: string[];
  invalidConditions?: string[];
  source?: DailyPlanItem['source'];
  confidence?: number | null;
  priority?: number;
}

export interface SavePlanInput {
  marketStance?: MarketStance | null;
  focusSectors?: PlanFocusSector[];
  externalContext?: string;
  narrative?: string;
  items?: SavePlanItemInput[];
}

/** 择时档位：未显式给出时按大盘方向推断（偏空=防守 / 中性=均衡 / 偏多=进攻） */
function resolveTimingLevel(stance?: MarketStance | null): MarketStance['timingLevel'] {
  if (stance?.timingLevel) return stance.timingLevel;
  if (!stance) return undefined;
  if (stance.bias === 'bear') return 'defense';
  if (stance.bias === 'bull') return 'attack';
  return 'balanced';
}

/** 各择时档位允许的「新开仓 buy」上限（防守 0 / 均衡 2 / 进攻 6；缺省按均衡处理） */
const MAX_NEW_BUYS: Record<NonNullable<MarketStance['timingLevel']>, number> = {
  defense: 0,
  balanced: 2,
  attack: 6,
};

/** 把某标的降级为 watch，并把原因追加进 thesis 与 invalidConditions（保留原信息，仅纠偏方向） */
function downgradeToWatch(it: SavePlanItemInput, note: string): SavePlanItemInput {
  return {
    ...it,
    direction: 'watch',
    thesis: it.thesis ? `${it.thesis}（${note}）` : note,
    invalidConditions: [...(it.invalidConditions ?? []), note],
  };
}

/**
 * 计划闸门（择时 + 组合风控，半硬约束，落库前代码层强制）：
 *  1) 择时：防守档下「新开仓 buy」（source≠position）一律降级为 watch（不新开多），ETF 与个股同受此约束。
 *  2) 组合风控：限制「个股新开仓 buy」总数不超过当前档位上限（attack 6 / balanced 2 / defense 0），
 *     超额的按 priority 升序（最不重要的先）降级为 watch，避免组合过度分散/超配。
 *     ETF 为本计划主线（真实大仓位主战场），其右侧买入由轮动纪律自管、不计入该数量上限，避免被个股名额挤掉。
 * 持仓相关动作（source=position 的 reduce/sell/hold）不受限。返回处理后的 items 与被降级清单。
 */
function enforcePlanGate(
  level: MarketStance['timingLevel'],
  items: SavePlanItemInput[],
): { items: SavePlanItemInput[]; downgraded: string[] } {
  const downgraded: string[] = [];
  const lv = level ?? 'balanced';
  const cap = MAX_NEW_BUYS[lv];
  const isEtf = (it: SavePlanItemInput) =>
    (it.assetType ?? repo.classifyAsset(it.code)) === 'etf';
  // 「新开仓 buy」= 方向 buy 且非持仓项；它们是被风控约束的对象
  const isNewBuy = (it: SavePlanItemInput) => it.direction === 'buy' && it.source !== 'position';

  // 第一遍：防守档先把所有新开仓 buy 降级（择时纪律优先，ETF/个股同受约束）
  let work = items.map((it) => {
    if (lv === 'defense' && isNewBuy(it)) {
      downgraded.push(`${it.name}(${it.code})`);
      return downgradeToWatch(it, '防守档自动降级：大盘择时防守，不新开多');
    }
    return it;
  });

  // 第二遍：剩余【个股】新开仓 buy 若超过档位上限，按 priority 升序降级超额部分；ETF 不计入此上限
  const remainingBuyIdx = work
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => isNewBuy(it) && !isEtf(it))
    .sort((a, b) => (a.it.priority ?? 0) - (b.it.priority ?? 0));
  if (remainingBuyIdx.length > cap) {
    const excess = remainingBuyIdx.slice(0, remainingBuyIdx.length - cap);
    const excessSet = new Set(excess.map((e) => e.i));
    work = work.map((it, i) => {
      if (excessSet.has(i)) {
        downgraded.push(`${it.name}(${it.code})`);
        return downgradeToWatch(it, `组合风控自动降级：超出${lv === 'attack' ? '进攻' : lv === 'defense' ? '防守' : '均衡'}档个股新开仓上限(${cap})`);
      }
      return it;
    });
  }
  return { items: work, downgraded };
}

/** 盘前生成：按当日 upsert 计划主记录并全量替换标的项，记 created/regenerated 事件 */
export function savePlan(input: SavePlanInput, runId: string | null): DailyPlanDetail {
  const date = shanghaiToday();
  const existed = repo.getPlanByDate(date);
  // 择时档位归一化（缺省按 bias 推断）并写回 stance，保证落库与前端一致
  const level = resolveTimingLevel(input.marketStance);
  const stance: MarketStance | null = input.marketStance
    ? { ...input.marketStance, timingLevel: level }
    : null;
  const planId = repo.upsertPlan({
    planDate: date,
    status: 'active',
    marketStance: stance,
    focusSectors: input.focusSectors ?? [],
    externalContext: input.externalContext ?? '',
    narrative: input.narrative ?? '',
    runId,
  });
  const gated = enforcePlanGate(level, input.items ?? []);
  if (input.items) repo.replaceItems(planId, gated.items);
  repo.appendEvent({
    planId,
    kind: existed ? 'regenerated' : 'created',
    payload: {
      itemCount: gated.items.length,
      timingLevel: level ?? null,
      gateDowngraded: gated.downgraded,
    },
    runId,
  });
  return getDetailByDate(date)!;
}

/**
 * 落库后增强：对当日计划中的【个股】候选（剔除 ETF）逐只串行跑多 agent 辩论（决策引擎），
 * 把辩论结论回写到对应 item（debateVerdict/debateConfidence/debateNote）并在 narrative 追加辩论摘要段。
 * 「始终自动」：计划生成完成后调用。无个股候选则直接返回 0。失败不抛（best-effort，不拖垮计划生成）。
 * 返回成功回写的标的数。
 */
export async function enrichTodayPlanWithDebate(runId: string | null): Promise<number> {
  const plan = getTodayPlan();
  if (!plan) return 0;
  const items = repo.listItems(plan.id);
  // 仅个股（剔除 ETF/场内基金）；方向不限（buy/hold/reduce/sell/watch 均做研判）；按 code 去重
  const seen = new Set<string>();
  const stocks = items.filter((it) => {
    if (it.assetType === 'etf' || !isIndividualStock(it.code) || seen.has(it.code)) return false;
    seen.add(it.code);
    return true;
  });
  if (stocks.length === 0) return 0;

  let results;
  try {
    results = await runDecisionBatch(
      stocks.map((it) => ({ code: it.code, name: it.name, context: '今日计划候选研判' })),
      { purpose: 'plan-debate' },
    );
  } catch (e) {
    console.warn('[plan] 候选辩论增强失败:', e instanceof Error ? e.message : e);
    return 0;
  }

  const byCode = new Map(results.map((r) => [r.code, r]));
  const lines: string[] = [];
  for (const it of stocks) {
    const r = byCode.get(it.code);
    if (!r) continue;
    const v = mapDecisionToVerdict(r);
    repo.updateItemDebate(plan.id, it.code, {
      verdict: v.verdict,
      confidence: r.confidence,
      note: r.thesis,
    });
    lines.push(`- ${it.name}(${it.code})：${v.verdict}（置信度 ${r.confidence}）— ${r.thesis}`);
  }
  if (lines.length === 0) return 0;

  // narrative 追加辩论摘要段（保留原作战图，附多 agent 结论）
  const section = `\n\n## 多 agent 辩论增强（落库后自动，共 ${lines.length} 只个股）\n${lines.join('\n')}`;
  repo.upsertPlan({ planDate: plan.planDate, narrative: (plan.narrative ?? '') + section });
  repo.appendEvent({ planId: plan.id, kind: 'note', payload: { debateEnriched: lines.length }, runId });
  return lines.length;
}

/** ETF 计划项研判结果（结构化解析自 oneshot JSON 输出） */
interface EtfPlanVerdict {
  code: string;
  verdict: string;
  confidence: number | null;
  note: string;
}

/** 从 LLM 输出中抽取 JSON 数组并解析为 ETF 研判清单（容错：去围栏、定位首[末]、逐项校验） */
function parseEtfVerdicts(text: string): EtfPlanVerdict[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: EtfPlanVerdict[] = [];
  for (const x of arr) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const code = typeof o.code === 'string' ? o.code.trim() : '';
    const verdict = typeof o.verdict === 'string' ? o.verdict.trim() : '';
    if (!code || !verdict) continue;
    const confRaw =
      typeof o.confidence === 'number' ? o.confidence : Number.parseFloat(String(o.confidence ?? ''));
    const confidence = Number.isFinite(confRaw)
      ? Math.round(Math.min(Math.max(confRaw, 0), 100))
      : null;
    const note = typeof o.note === 'string' ? o.note.trim() : '';
    out.push({ code, verdict, confidence, note });
  }
  return out;
}

/**
 * 落库后增强（ETF 主线）：对当日计划中的【ETF】项跑一次 agent 深度研判，结构化绑定到对应 item。
 * ETF 无基本面，不走个股决策引擎（多空辩论）；改以本系统已算好的「轮动 5 态/RS/周线/资金流」+「逐只量化信号」
 * +「真实持仓成本盈亏」为确定性底稿，经单次结构化 JSON 调用产出 per-code 右侧研判（verdict/confidence/note），
 * 经 updateItemDebate 回写 debate* 字段，并在 narrative 追加 ETF 研判摘要段。
 * best-effort：失败不抛、不拖垮计划生成。返回成功回写的 ETF 数。
 */
export async function enrichTodayPlanWithEtfReview(runId: string | null): Promise<number> {
  const plan = getTodayPlan();
  if (!plan) return 0;
  const items = repo.listItems(plan.id);
  // 仅 ETF（按 assetType 或代码前缀判定）；按 code 去重
  const seen = new Set<string>();
  const etfs = items.filter((it) => {
    const isEtf = it.assetType === 'etf' || repo.classifyAsset(it.code) === 'etf';
    if (!isEtf || seen.has(it.code)) return false;
    seen.add(it.code);
    return true;
  });
  if (etfs.length === 0) return 0;
  const codeSet = new Set(etfs.map((it) => it.code));

  // 确定性底稿（best-effort，单点失败降级为占位文案，不拖垮整体）
  const [rotationBlock, signalBlock, positionBlock] = await Promise.all([
    buildRotationOverview()
      .then((ov) => formatForAgent(ov))
      .catch(() => 'ETF 行业轮动：取数失败，暂无轮动底稿。'),
    etfSignals()
      .then(
        (res) =>
          res.signals
            .filter((s) => codeSet.has(s.code))
            .map((s) => {
              const grid = s.grid ? `网格${s.grid.level}/${s.grid.gridCount}档` : '网格—';
              return (
                `${s.name}(${s.code})：信号建议${s.action}｜分位${s.pricePercentile ?? '—'}%｜年线偏离${s.maDeviation ?? '—'}%｜` +
                `动量排名${s.momentumRank != null ? '#' + s.momentumRank : '—'}｜折溢价${s.premiumPct ?? '—'}%｜${grid}` +
                (s.notes.length ? `｜${s.notes.join('，')}` : '')
              );
            })
            .join('\n') || '（计划内 ETF 暂无可用量化信号）',
      )
      .catch(() => 'ETF 量化信号：取数失败。'),
    fetchRealPositions(false)
      .then((p) => {
        const held = p.positions.filter((pos) => codeSet.has(pos.code));
        if (!held.length) return '（计划内 ETF 均未持有）';
        return held
          .map(
            (pos) =>
              `${pos.name}(${pos.code})：已持有，成本${pos.avgCost}，现价${pos.price}，浮盈${pos.holdRate.toFixed(1)}%，仓位${pos.positionRate.toFixed(1)}%`,
          )
          .join('\n');
      })
      .catch(() => '真实持仓：取数失败（按未持有处理）。'),
  ]);

  const itemBlock = etfs
    .map((it) => `${it.name}(${it.code})：当前方向 ${it.direction}｜思路 ${it.thesis ?? '（无）'}`)
    .join('\n');

  const prompt = [
    '你是 ETF 中线右侧交易研判员。下面是今日计划已纳入的 ETF 标的，以及本系统确定性算出的轮动榜、逐只量化信号与真实持仓。请对【每一只计划内 ETF】给出一句中线右侧研判。',
    '右侧纪律：只做右侧不抄左侧（破位不接飞刀）；过热应等回踩而非追高；RS 跑赢沪深300 + 周线多头 + 资金净流入才算真强；涨幅靠后≠该卖（看趋势与 RS）。',
    `\n【计划内 ETF】\n${itemBlock}`,
    `\n【ETF 行业轮动榜（确定性）】\n${rotationBlock}`,
    `\n【逐只量化信号（确定性）】\n${signalBlock}`,
    `\n【真实持仓】\n${positionBlock}`,
    '\n只能引用上面给出的 ETF，禁止编造其它标的或数据。仅输出一个 JSON 数组，不要任何额外文字，元素形如：',
    '{"code":"6位代码","verdict":"进攻|回踩等待|规避|减仓|持有","confidence":0-100整数,"note":"一句研判依据(含状态/RS/资金/消息)"}',
  ].join('\n');

  const res = await gateway
    .call({
      mode: 'oneshot',
      trigger: 'manual',
      purpose: 'plan-etf-review',
      taskName: 'ETF 计划项研判',
      recordRun: false,
      prompt,
    })
    .catch((e) => {
      console.warn('[plan] ETF 研判增强失败:', e instanceof Error ? e.message : e);
      return null;
    });
  if (!res || res.status !== 'success' || !res.outputText) return 0;

  const parsed = parseEtfVerdicts(res.outputText);
  if (!parsed.length) return 0;

  const byCode = new Map(parsed.map((v) => [v.code, v]));
  const lines: string[] = [];
  for (const it of etfs) {
    const v = byCode.get(it.code);
    if (!v) continue;
    repo.updateItemDebate(plan.id, it.code, {
      verdict: v.verdict,
      confidence: v.confidence,
      note: v.note || null,
    });
    lines.push(`- ${it.name}(${it.code})：${v.verdict}（置信度 ${v.confidence ?? '—'}）— ${v.note}`);
  }
  if (lines.length === 0) return 0;

  // narrative 追加 ETF 研判摘要段（重读当前 narrative，避免覆盖个股辩论已追加段）
  const cur = getTodayPlan();
  const section = `\n\n## ETF 研判增强（落库后自动，共 ${lines.length} 只 ETF）\n${lines.join('\n')}`;
  repo.upsertPlan({
    planDate: plan.planDate,
    narrative: (cur?.narrative ?? plan.narrative ?? '') + section,
  });
  repo.appendEvent({ planId: plan.id, kind: 'note', payload: { etfReviewEnriched: lines.length }, runId });
  return lines.length;
}

/** 落库后增强统一编排：先个股辩论、再 ETF 研判（串行，避免两者并发改写 narrative 互相覆盖）。 */
async function enrichTodayPlan(runId: string | null): Promise<void> {
  await enrichTodayPlanWithDebate(runId).catch((e) =>
    console.warn('[plan] 候选辩论增强失败:', e instanceof Error ? e.message : e),
  );
  await enrichTodayPlanWithEtfReview(runId).catch((e) =>
    console.warn('[plan] ETF 研判增强失败:', e instanceof Error ? e.message : e),
  );
}

/**
 * 今日计划生成统一执行体：跑 agent 产出结构化计划落库，成功后串行做个股辩论 + ETF 研判增强回写。
 * 手动路由 / 定时 / 一键计划编排共用，避免复制 prompt/modelConfig 与增强逻辑。
 * @param awaitDebate true=等待增强完成（编排链需保证完整产出）；false=后台跑不阻塞响应。
 */
export async function runPlanGeneration(opts: {
  trigger: RunTrigger;
  channels: NotifyChannel[];
  maxSteps?: number;
  awaitDebate?: boolean;
}): Promise<RunTaskResult> {
  const result = await runTask(
    {
      id: null,
      name: PLAN_GEN_TASK_NAME,
      prompt: PLAN_GEN_PROMPT,
      modelConfig: { thinking: false, maxSteps: opts.maxSteps ?? 20 },
      notifyChannels: opts.channels,
      timeoutSec: 900,
    },
    opts.trigger,
  );
  if (result.status === 'success') {
    if (opts.awaitDebate) await enrichTodayPlan(result.runId);
    else void enrichTodayPlan(result.runId);
  }
  return result;
}

/** 盘中对照回写某标的状态/备注，记 note/trigger_hit 事件 */
export function updateItem(
  code: string,
  status: PlanItemStatus | undefined,
  note: string | null,
  runId: string | null,
): DailyPlanItem | null {
  const plan = getTodayPlan();
  if (!plan) return null;
  const item = repo.updateItemByCode(plan.id, code, { status, note });
  if (!item) return null;
  repo.appendEvent({
    planId: plan.id,
    itemId: item.id,
    kind: status === 'triggered' ? 'trigger_hit' : 'note',
    payload: { code, status, note },
    runId,
  });
  return item;
}

/** 盯盘命中回写：标记 triggered（仅当前为 pending）并记事件 */
export function recordWatchTrigger(
  code: string,
  signalType: string,
  note: string,
  runId: string | null,
): void {
  const plan = getTodayPlan();
  if (!plan) return;
  const items = repo.listItems(plan.id);
  const item = items.find((i) => i.code === code);
  if (!item) return;
  const nextStatus: PlanItemStatus = item.status === 'pending' ? 'triggered' : item.status;
  repo.updateItemByCode(plan.id, code, { status: nextStatus, note });
  repo.appendEvent({
    planId: plan.id,
    itemId: item.id,
    kind: 'trigger_hit',
    payload: { code, signalType, note },
    runId,
  });
}

/** 是否设了任一触发价（买/卖/损/盈），作为兑现率分母判定 */
function hasTrigger(it: DailyPlanItem): boolean {
  return !!(it.buyTrigger || it.sellTrigger || it.stopLoss || it.takeProfit);
}

/**
 * 计划兑现度统计：纯代码按标的状态/触发价计数，不经 AI 估算。
 * 收盘复盘与作战室共用此为唯一权威口径，避免模型臆测命中率。
 */
export function computePlanFulfillment(detail?: DailyPlanDetail | null): PlanFulfillment | null {
  const d = detail ?? getTodayDetail();
  if (!d) return null;
  const items = d.items;
  const withTriggerItems = items.filter(hasTrigger);
  const triggeredWithTrigger = withTriggerItems.filter(
    (i) => i.status === 'triggered' || i.status === 'done',
  ).length;
  return {
    planDate: d.plan.planDate,
    total: items.length,
    withTrigger: withTriggerItems.length,
    triggered: items.filter((i) => i.status === 'triggered' || i.status === 'done').length,
    done: items.filter((i) => i.status === 'done').length,
    invalid: items.filter((i) => i.status === 'invalid').length,
    pending: items.filter((i) => i.status === 'pending').length,
    hitRate:
      withTriggerItems.length > 0
        ? Math.round((triggeredWithTrigger / withTriggerItems.length) * 100) / 100
        : null,
  };
}

/** 收盘归档：回填复盘总结并置 closed */
export function closeToday(reviewSummary: string, runId: string | null): boolean {
  const plan = getTodayPlan();
  if (!plan) return false;
  repo.closePlan(plan.id, reviewSummary);
  repo.appendEvent({ planId: plan.id, kind: 'review', payload: { length: reviewSummary.length }, runId });
  return true;
}

const DIR_LABEL: Record<DailyPlanItem['direction'], string> = {
  buy: '买入',
  hold: '持有',
  reduce: '减仓',
  sell: '卖出',
  watch: '观察',
};

const STATUS_LABEL: Record<PlanItemStatus, string> = {
  pending: '待触发',
  triggered: '已触发',
  done: '已完成',
  invalid: '已失效',
};

function fmtTrigger(label: string, t: PlanTrigger | null): string {
  if (!t) return '';
  return ` ${label}${t.value}${t.note ? `(${t.note})` : ''}`;
}

/** 给 agent 看的纯文本计划摘要（get_today_plan 工具输出） */
export function formatPlanForAgent(detail: DailyPlanDetail): string {
  const { plan, items } = detail;
  const lines: string[] = [`今日计划（${plan.planDate}，状态 ${plan.status}）`];
  if (plan.marketStance) {
    const m = plan.marketStance;
    const biasZh = m.bias === 'bull' ? '偏多' : m.bias === 'bear' ? '偏空' : '中性';
    const levelZh =
      m.timingLevel === 'attack'
        ? '进攻'
        : m.timingLevel === 'defense'
          ? '防守'
          : m.timingLevel === 'balanced'
            ? '均衡'
            : '—';
    lines.push(
      `大盘研判：${biasZh} | 择时档位 ${levelZh} | 建议仓位 ${m.positionPct}% | 支撑 ${m.support} | 压力 ${m.resistance}`,
      `定调：${m.summary}`,
    );
  }
  if (plan.focusSectors.length) {
    lines.push(
      '重点板块：' +
        plan.focusSectors.map((s) => `${s.name}(${s.strength})`).join('、'),
    );
  }
  if (plan.externalContext) lines.push(`外围：${plan.externalContext}`);
  lines.push(`标的 ${items.length} 只：`);
  for (const it of items) {
    const trg =
      fmtTrigger('买', it.buyTrigger) +
      fmtTrigger('卖', it.sellTrigger) +
      fmtTrigger('损', it.stopLoss) +
      fmtTrigger('盈', it.takeProfit);
    const typeLabel = it.assetType === 'etf' ? 'ETF' : '个股';
    const confirm = it.confirmConditions.length ? ` 确认:${it.confirmConditions.join('/')}` : '';
    const invalid = it.invalidConditions.length ? ` 失效:${it.invalidConditions.join('/')}` : '';
    const conf = it.confidence != null ? ` 置信度${it.confidence}` : '';
    lines.push(
      `- [${typeLabel}] ${it.name}(${it.code}) [${DIR_LABEL[it.direction]}/${STATUS_LABEL[it.status]}/${it.source}]` +
        `${conf}${trg}${it.positionHint ? ` 仓位${it.positionHint}` : ''}` +
        `${it.thesis ? ` 逻辑:${it.thesis}` : ''}${confirm}${invalid}` +
        `${it.lastNote ? ` 备注:${it.lastNote}` : ''}`,
    );
  }
  return lines.join('\n');
}
