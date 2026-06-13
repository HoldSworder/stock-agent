#!/usr/bin/env node
// 一次性本机脚本：从本机 Chrome 的爱盯盘扩展 LevelDB 中只读提取登录 token，
// 推送到（可能远程的）后端设置。后端用该 token 调用爱盯盘云 API 做单向镜像。
//
// 用法：
//   node scripts/harvest-idp-token.mjs            # 提取并 PUT 到 BACKEND_URL/api/settings
//   node scripts/harvest-idp-token.mjs --print    # 仅打印 token（不写后端，便于排查）
//
// 环境变量：
//   BACKEND_URL   后端地址，默认 http://localhost:8787
//   CHROME_STORE  覆盖 LevelDB 目录（默认 Chrome Default 配置下的爱盯盘扩展存储）
//
// 注意：Chrome 运行中 LevelDB 仅可只读；本脚本不写 LevelDB，安全。

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const EXT_ID = 'hmkhfephfjheodabgomnanpbmbjbepni'; // 爱盯盘-股票盯盘-基金助手
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:8787';

function defaultStoreDir() {
  return join(
    homedir(),
    'Library/Application Support/Google/Chrome/Default/Local Extension Settings',
    EXT_ID,
  );
}

/** 扫描 LevelDB 文件，正则提取最长的 Iron token（Fe26.2** 开头） */
function extractToken(dir) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.log') || f.endsWith('.ldb'));
  } catch (e) {
    throw new Error(`无法读取爱盯盘扩展存储目录：${dir}\n${e instanceof Error ? e.message : e}`);
  }
  const re = /Fe26\.2\*\*[A-Za-z0-9\-_*]{200,}/g;
  const found = [];
  for (const f of files) {
    const buf = readFileSync(join(dir, f), 'latin1');
    for (const m of buf.matchAll(re)) found.push(m[0]);
  }
  if (found.length === 0) {
    throw new Error('未在扩展存储中找到 token（请确认已登录爱盯盘，且 Chrome 用的是 Default 配置）');
  }
  // append-only 日志中后写的更新；同长取最后一次出现，整体取最长（完整串）
  found.sort((a, b) => (a.length === b.length ? 0 : a.length - b.length));
  return found[found.length - 1];
}

async function main() {
  const printOnly = process.argv.includes('--print');
  const dir = process.env.CHROME_STORE ?? defaultStoreDir();
  const token = extractToken(dir);
  console.log(`[harvest] 提取到 token，长度 ${token.length}`);
  if (printOnly) {
    console.log(token);
    return;
  }
  const url = `${BACKEND_URL}/api/settings`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idpToken: token }),
  });
  if (!res.ok) {
    throw new Error(`PUT ${url} 失败：[${res.status}] ${await res.text()}`);
  }
  console.log(`[harvest] 已推送到后端 ${url}，爱盯盘 token 配置完成`);
}

main().catch((e) => {
  console.error('[harvest] 失败：', e instanceof Error ? e.message : e);
  process.exit(1);
});
