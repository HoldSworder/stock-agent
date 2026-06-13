import OpenAI from 'openai';
import { getValue } from './settings';
import * as gateway from './agent/gateway';

/**
 * 基于当前设置构造 OpenAI 兼容客户端（模型不限于 DeepSeek）。
 * 【内部专用】仅供统一门面 gateway 及其低层（agent/loop）使用，业务侧禁止直接调用——
 * 所有 LLM 调用一律走 gateway.call()，以统一接入运行管理与调用记录。
 */
export function getLLM(): { client: OpenAI; model: string } {
  const apiKey = getValue('llmApiKey');
  const baseURL = getValue('llmBaseUrl');
  const model = getValue('llmModel');
  if (!apiKey) throw new Error('模型 API Key 未配置，请到设置页填写');
  const client = new OpenAI({ apiKey, baseURL });
  return { client, model };
}

/** 连通性自检：经统一门面发一个极小请求验证 key/baseUrl/model（仅落调用记录，不建 run） */
export async function testLLM(): Promise<{ ok: boolean; message: string }> {
  const result = await gateway.call({
    mode: 'oneshot',
    recordRun: false,
    trigger: 'manual',
    purpose: 'connectivity',
    taskName: '连通测试',
    prompt: 'ping',
    maxTokens: 1,
  });
  if (result.status !== 'success') {
    return { ok: false, message: result.error || '连通失败' };
  }
  return { ok: true, message: `连通正常，模型 ${getValue('llmModel')}` };
}
