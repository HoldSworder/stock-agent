import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FactorCatalogResponse, FactorSnapshotResponse } from '@stock-agent/shared';
import { cached } from '../lib/ttlCache';

// 因子目录由离线脚本 mode/etf-mainline-factor-sweep/factor_export.py 预计算落盘，
// 后端只读这份 JSON（默认 backend/data/factor-catalog.json，可用 SA_FACTOR_CATALOG 覆盖）。
// 路径锚定 backend 包根，避免不同 cwd 启动指向不同文件（同 db/client.ts 约定）。
const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const envPath = process.env.SA_FACTOR_CATALOG?.trim();
const CATALOG_PATH = envPath
  ? isAbsolute(envPath)
    ? envPath
    : resolve(backendRoot, envPath)
  : resolve(backendRoot, 'data/factor-catalog.json');

interface RawArtifact {
  meta: FactorCatalogResponse['meta'];
  catalog: FactorCatalogResponse['catalog'];
  snapshot: FactorSnapshotResponse['items'];
}

function readArtifact(): RawArtifact {
  let raw: string;
  try {
    raw = readFileSync(CATALOG_PATH, 'utf8');
  } catch {
    throw new Error(
      `因子目录文件不存在：${CATALOG_PATH}。请先运行 pnpm factor:export 生成（需本地有 K 线缓存）。`,
    );
  }
  return JSON.parse(raw) as RawArtifact;
}

/** 因子目录 + IC + 元信息（不含快照，省带宽）。慢变，5 分钟响应级缓存。 */
export async function getFactorCatalog(): Promise<FactorCatalogResponse> {
  return cached('factor:catalog', 300_000, async () => {
    const a = readArtifact();
    return { meta: a.meta, catalog: a.catalog };
  });
}

/** 最新交易日全因子快照（供当前榜单 / 因子组合实验前端打分）。 */
export async function getFactorSnapshot(): Promise<FactorSnapshotResponse> {
  return cached('factor:snapshot', 300_000, async () => {
    const a = readArtifact();
    return { snapshotDate: a.meta.snapshotDate, generatedAt: a.meta.generatedAt, items: a.snapshot };
  });
}
