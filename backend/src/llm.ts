import OpenAI from 'openai';
import { getValue } from './settings';

/** 基于当前设置构造 OpenAI 兼容客户端（模型不限于 DeepSeek） */
export function getLLM(): { client: OpenAI; model: string } {
  const apiKey = getValue('llmApiKey');
  const baseURL = getValue('llmBaseUrl');
  const model = getValue('llmModel');
  if (!apiKey) throw new Error('模型 API Key 未配置，请到设置页填写');
  const client = new OpenAI({ apiKey, baseURL });
  return { client, model };
}

/** 连通性自检：发一个极小的请求验证 key/baseUrl/model */
export async function testLLM(): Promise<{ ok: boolean; message: string }> {
  try {
    const { client, model } = getLLM();
    const res = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
    });
    return { ok: true, message: `连通正常，模型 ${res.model}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
