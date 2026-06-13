import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

// 优先加载项目根目录 .env，其次 backend/.env
loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), '../.env') });

function env(key: string, fallback = ''): string {
  return process.env[key]?.trim() || fallback;
}

// 仅保留进程级基础设施配置（端口/时区/数据库路径）。
// 模型、妙想、Telegram、同花顺等业务配置一律存 SQLite，并在 WebUI 设置页维护。
export const config = {
  port: Number(env('PORT', '8787')),
  databasePath: env('DATABASE_PATH', './data/stock-agent.sqlite'),
  tz: env('TZ', 'Asia/Shanghai'),
  // 配套扩展推送凭据（idpToken/thsCookie）到 /api/credentials 时校验的共享密钥；
  // 未设置则该端点拒绝服务，避免公网裸奔。
  bridgeSecret: env('BRIDGE_SECRET', ''),
  // 生产 CORS 白名单（逗号分隔的来源）；留空则回退为反射任意来源（仅适合本地开发）。
  corsOrigins: env('CORS_ORIGINS', ''),
};

export type AppConfig = typeof config;
