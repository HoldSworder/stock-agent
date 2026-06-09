import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

// 优先加载项目根目录 .env，其次 backend/.env
loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), '../.env') });

function env(key: string, fallback = ''): string {
  return process.env[key]?.trim() || fallback;
}

export const config = {
  port: Number(env('PORT', '8787')),
  databasePath: env('DATABASE_PATH', './data/stock-agent.sqlite'),
  tz: env('TZ', 'Asia/Shanghai'),

  // 任意 OpenAI 兼容模型服务（DEEPSEEK_* 作为旧变量名兜底）
  llm: {
    baseUrl: env('OPENAI_BASE_URL', env('DEEPSEEK_BASE_URL', 'https://api.openai.com/v1')),
    apiKey: env('OPENAI_API_KEY', env('DEEPSEEK_API_KEY')),
    model: env('OPENAI_MODEL', env('DEEPSEEK_MODEL', 'gpt-4o-mini')),
  },

  miaoxiang: {
    emApiKey: env('EM_API_KEY'),
    mxApiKey: env('MX_APIKEY'),
  },

  telegram: {
    botToken: env('TELEGRAM_BOT_TOKEN'),
    chatId: env('TELEGRAM_CHAT_ID'),
    threadId: env('TELEGRAM_THREAD_ID'),
  },

  // 真实持仓数据源：复用 LXC portfolio-sync 写入 OpenViking 的快照
  openviking: {
    baseUrl: env('OPENVIKING_BASE_URL', 'http://192.168.31.144:9109'),
    apiKey: env('OPENVIKING_API_KEY'),
    account: env('OPENVIKING_ACCOUNT', 'user'),
    user: env('OPENVIKING_USER', 'default'),
    // 快照 URI 前缀，实际文件为 <prefix>/YYYY/MM/DD/portfolio_snapshot.md
    eventsPrefix: env('OPENVIKING_EVENTS_PREFIX', 'viking://user/default/memories/events'),
  },
};

export type AppConfig = typeof config;
