// 研究基准标的池：mode/ 下 python 研究脚本写死的内置池（POOL_FALLBACK），
// 与数据库 ETF 跟踪池是两份东西——跟踪池会随用户增删而漂移，而回测留档永远对应研究那一刻的池子。
// 自检 B 段拿它验证「因子链与回放逻辑的移植正确性」，不能用生产池，否则池差异会伪装成移植错误。
// 生产跟踪路径不读它，只在协议标记里用来判断「站内跟踪是否与回测留档同源」。

/** mode/etf-mainline-factor-sweep/etf-mainline-factor-sweep-research.py 的 POOL_FALLBACK（55 只） */
export const RESEARCH_POOL_FALLBACK: ReadonlyArray<{ code: string; name: string }> = [
  { code: '159851', name: '金融科技' },
  { code: '588000', name: '科创50' },
  { code: '562500', name: '机器人' },
  { code: '160644', name: '港美互联网' },
  { code: '159516', name: '半导体设备' },
  { code: '515880', name: '通信' },
  { code: '588200', name: '科创芯片' },
  { code: '515220', name: '煤炭' },
  { code: '159566', name: '储能电池' },
  { code: '159326', name: '电网设备' },
  { code: '159206', name: '卫星' },
  { code: '159740', name: '恒生科技' },
  { code: '159611', name: '电力' },
  { code: '560980', name: '光伏龙头' },
  { code: '516020', name: '化工' },
  { code: '513310', name: '中韩半导体' },
  { code: '513920', name: '港股通央企红利' },
  { code: '159780', name: '科创创业50' },
  { code: '161128', name: '标普信息科技' },
  { code: '159509', name: '纳指科技' },
  { code: '159819', name: '人工智能' },
  { code: '513090', name: '香港证券' },
  { code: '159567', name: '港股创新药' },
  { code: '159805', name: '传媒' },
  { code: '159695', name: '通信(嘉实)' },
  { code: '159251', name: '港股通科技' },
  { code: '159632', name: '纳斯达克' },
  { code: '159995', name: '芯片' },
  { code: '159699', name: '恒生消费' },
  { code: '159537', name: '信创' },
  { code: '159915', name: '创业板' },
  { code: '588050', name: '科创50(工银)' },
  { code: '518880', name: '黄金' },
  { code: '501225', name: '全球芯片' },
  { code: '561910', name: '电池' },
  { code: '515980', name: '人工智能(华富)' },
  { code: '562950', name: '消费电子' },
  { code: '159363', name: '创业板人工智能' },
  { code: '159928', name: '消费' },
  { code: '561360', name: '石油' },
  { code: '516120', name: '化工(富国)' },
  { code: '512880', name: '证券' },
  { code: '159267', name: '航天' },
  { code: '512980', name: '传媒(广发)' },
  { code: '512400', name: '有色金属' },
  { code: '159107', name: '创业板软件' },
  { code: '561380', name: '电网设备(国泰)' },
  { code: '512710', name: '军工龙头' },
  { code: '159755', name: '电池(广发)' },
  { code: '159869', name: '游戏' },
  { code: '159887', name: '银行' },
  { code: '560850', name: '信创(汇添富)' },
  { code: '513120', name: '港股创新药(广发)' },
  { code: '516860', name: '金融科技(博时)' },
  { code: '510720', name: '红利国企' },
];

/**
 * 某模式回测留档所用的研究基准池。目前 mode/ 下几只 ETF 主线模式共用同一份 POOL_FALLBACK；
 * 将来若有模式换池，在此按 modeId 分流即可，调用方无需改动。
 */
export function researchPoolFor(_modeId: string): ReadonlyArray<{ code: string; name: string }> {
  return RESEARCH_POOL_FALLBACK;
}
