import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { config } from '../config';
import * as schema from './schema';

// 相对的 DATABASE_PATH 必须锚定到 backend 包根目录，而非 process.cwd()。
// 否则从不同工作目录启动（如仓库根 vs backend/）会打开不同的 sqlite 文件，
// 表现为“重启后配置全部丢失”。绝对路径（Docker 用 /app/data/...）保持原样。
const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dbPath = isAbsolute(config.databasePath)
  ? config.databasePath
  : resolve(backendRoot, config.databasePath);
const dir = dirname(dbPath);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

export const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

// 优雅关闭：进程退出前 checkpoint 并关闭，确保刚写入的配置从 WAL 落入主库，
// 避免“写完配置后被 kill / docker stop，WAL 未合并”导致的数据丢失窗口。
let closed = false;
function closeDb(): void {
  if (closed) return;
  closed = true;
  try {
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
    sqlite.close();
  } catch {
    // 关闭期异常忽略：进程即将退出，不阻断退出流程
  }
}
process.once('exit', closeDb);
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    closeDb();
    process.exit(0);
  });
}

export const db = drizzle(sqlite, { schema });
export { schema };
