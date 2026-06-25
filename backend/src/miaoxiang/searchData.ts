// 妙想新门户 searchData 响应解析：把嵌套表结构（dataTableDTOList）拍平成精简文本表，
// 供 Agent / 单步 LLM 直接阅读。逻辑移植自已验证可用的 mx-finance-data skill 的 get_data.py
// （_extract_data_table_dto_list / _check_business_status / _extract_preferred_message / _table_to_rows），
// 仅去掉 Excel 落盘，改为文本输出。

type Json = Record<string, unknown>;

const SUCCESS_VALUES = new Set<unknown>([null, undefined, 0, 200, '0', '200']);

/** 任意值规范为字符串：dict/list 用 JSON，空值转空串 */
function flatten(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 从接口返回中提取 dataTableDTOList（兼容新旧三种结构） */
export function extractDataTableDTOList(json: unknown): unknown[] | null {
  if (!isObject(json)) return null;
  if (Array.isArray(json.dataTableDTOList)) return json.dataTableDTOList;
  const data = json.data;
  if (isObject(data)) {
    const sr = data.searchDataResultDTO;
    if (isObject(sr) && Array.isArray(sr.dataTableDTOList)) return sr.dataTableDTOList;
    if (Array.isArray(data.dataTableDTOList)) return data.dataTableDTOList;
  }
  return null;
}

/**
 * 判断错误/响应文案是否为妙想日配额耗尽（新门户 code=403「使用次数已达上限」）。
 * 供调用方做「当日熔断」与工具层「优雅降级」识别，区别于普通网络抖动错误。
 */
export function isQuotaExhaustedMessage(message: string): boolean {
  if (!message) return false;
  return (
    /code=403\b/.test(message) ||
    message.includes('使用次数已达上限') ||
    message.includes('已达上限') ||
    message.includes('次数已用完')
  );
}

/** 校验业务状态：code/status 命中成功集合视为通过，否则返回错误信息 */
export function checkBusinessStatus(json: unknown): string | null {
  if (!isObject(json)) return '接口返回不是 JSON 对象';
  const { code, status } = json;
  if (!SUCCESS_VALUES.has(code) || !SUCCESS_VALUES.has(status)) {
    const message = flatten(json.message) || '业务状态非成功';
    return `妙想 searchData 业务错误: code=${flatten(code)}, status=${flatten(status)}, message=${message}`;
  }
  return null;
}

/** 提取接口 data.message（含数据截断/3 年范围限制等提示），无则返回 null */
export function extractPreferredMessage(json: unknown): string | null {
  if (!isObject(json)) return null;
  const data = json.data;
  if (!isObject(data)) return null;
  const msg = data.message;
  if (typeof msg !== 'string' || !msg.trim()) return null;
  let message = msg.trim();
  if (message.includes('检测到您的数据范围较大，由于系统限制，现为您返回的是精简后的部分数据')) {
    message += '\n免费用户仅支持查询 3 年范围的数据，系统已自动将查询范围调整为 3 年。';
  } else {
    message += '\n您的请求数据量已达到上限。';
  }
  return message;
}

/** 提取指标代码映射表（兼容 returnCodeMap/returnCodeNameMap/codeMap） */
function returnCodeMap(block: Json): Record<string, string> {
  for (const key of ['returnCodeMap', 'returnCodeNameMap', 'codeMap']) {
    const data = block[key];
    if (isObject(data)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(data)) out[String(k)] = flatten(v);
      return out;
    }
  }
  return {};
}

/** 生成指标键的展示名：优先 nameMap，其次 codeMap，最后回退原 key（纯数字无映射则空） */
function indicatorLabel(key: string, nameMap: Record<string, unknown>, codeMap: Record<string, string>): string {
  let mapped = nameMap[key];
  if (mapped == null && /^\d+$/.test(key)) mapped = nameMap[Number(key)];
  if (mapped != null && mapped !== '') return flatten(mapped);
  const byCode = codeMap[key];
  if (byCode != null && byCode !== '') return flatten(byCode);
  if (/^\d+$/.test(key)) return '';
  return key;
}

/** 按 indicatorOrder 生成指标键输出顺序，再补未覆盖的数据键 */
function orderedKeys(table: Json, indicatorOrder: unknown[]): string[] {
  const dataKeys = Object.keys(table).filter((k) => k !== 'headName');
  const seen = new Set<string>();
  const preferred: string[] = [];
  for (const key of indicatorOrder) {
    const ks = String(key);
    if (dataKeys.includes(ks) && !seen.has(ks)) {
      preferred.push(ks);
      seen.add(ks);
    }
  }
  for (const ks of dataKeys) {
    if (!seen.has(ks)) {
      preferred.push(ks);
      seen.add(ks);
    }
  }
  return preferred;
}

/** 规范化一行指标值长度（补空/截断） */
function normalizeValues(raw: unknown[], expectedLen: number): string[] {
  const values = raw.map(flatten);
  while (values.length < expectedLen) values.push('');
  return values.slice(0, expectedLen);
}

/** 把单个 dataTableDTO 渲染为「字段行 + 指标行」的文本表 */
function renderBlock(block: Json): string {
  const table = block.table;
  const entityName = flatten(block.entityName) || '指标';
  let nameMap: Record<string, unknown> = {};
  const rawNameMap = block.nameMap;
  if (Array.isArray(rawNameMap)) {
    rawNameMap.forEach((v, i) => (nameMap[String(i)] = v));
  } else if (isObject(rawNameMap)) {
    nameMap = rawNameMap;
  }

  if (!isObject(table)) return '';

  const headers = Array.isArray(table.headName) ? table.headName : [];
  const order = orderedKeys(table, Array.isArray(block.indicatorOrder) ? block.indicatorOrder : []);
  const codeMap = returnCodeMap(block);
  const dataKeyCount = Object.keys(table).filter((k) => k !== 'headName').length;

  const lines: string[] = [];

  if (headers.length >= 1 && dataKeyCount >= 1) {
    const headerLabels = headers.map(flatten);
    lines.push([entityName, ...headerLabels].join(' | '));
    for (const key of order) {
      const rawValues = Array.isArray(table[key]) ? (table[key] as unknown[]) : [table[key]];
      const values = normalizeValues(rawValues, headers.length);
      const label = indicatorLabel(key, nameMap, codeMap);
      lines.push([label, ...values].join(' | '));
    }
    return lines.join('\n');
  }

  // 回退：把 table 的键值直接平铺
  for (const [k, v] of Object.entries(table)) {
    if (k === 'headName') continue;
    lines.push(`${nameMap[k] != null ? flatten(nameMap[k]) : k}: ${flatten(v)}`);
  }
  return lines.join('\n');
}

/**
 * 把 searchData 返回拍平为精简文本（多表用标题分隔，附 condition 与 data.message 提示）。
 * 调用前应先用 checkBusinessStatus 校验成功。
 */
export function formatSearchData(json: unknown): string {
  const dtoList = extractDataTableDTOList(json);
  if (!dtoList || dtoList.length === 0) return '妙想 searchData 未返回结构化数据';

  const segments: string[] = [];
  for (let i = 0; i < dtoList.length; i += 1) {
    const dto = dtoList[i];
    if (!isObject(dto)) continue;
    const title = flatten(dto.title || dto.inputTitle || dto.entityName || `表${i + 1}`);
    const body = renderBlock(dto);
    if (!body) continue;
    const condition = dto.condition != null && dto.condition !== '' ? `（${flatten(dto.condition)}）` : '';
    segments.push(`【${title}】${condition}\n${body}`);
  }

  if (segments.length === 0) return '妙想 searchData 未解析到有效表数据';

  const message = extractPreferredMessage(json);
  return message ? `${segments.join('\n\n')}\n\n提示：${message}` : segments.join('\n\n');
}
