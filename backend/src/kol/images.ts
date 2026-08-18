import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { writeFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { KolImage } from '@stock-agent/shared';
import { config } from '../config';
import { record } from '../datasource/metrics';

// 大V配图的本地缓存。
//
// 为什么要落盘而不是直接存图床地址：小红书图片直链路径里嵌了分钟级时间戳
// （sns-webpic-qc.xhscdn.com/202607311527/...），是短时效签名地址，隔一段时间就会失效。
// 存 URL 等于存了一批迟早变 403 的死链，所以抓到当下就把字节拉回本地。
//
// 缓存目录跟随数据库同级（data/），docker-compose 已把 data/ 挂成卷，重建容器不丢图。

/** 单张图上限，超过则跳过（防止把整块盘写满） */
const MAX_BYTES = 5 * 1024 * 1024;
/** 单篇笔记最多缓存几张，多图笔记取前 N 张 */
const MAX_PER_POST = 9;
/** 下载超时 */
const TIMEOUT_MS = 20_000;
/** 对外访问前缀，由 server.ts 注册的静态目录承载 */
export const MEDIA_PREFIX = '/media/kol';

/** 缓存根目录：与 sqlite 同级的 data/kol-images */
export function cacheDir(): string {
  return resolve(dirname(config.databasePath), 'kol-images');
}

/** 从 content-type 推扩展名，未知按 jpg（图床返回的基本都是 jpeg/webp） */
function extOf(contentType: string | null): string {
  if (!contentType) return 'jpg';
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('gif')) return 'gif';
  return 'jpg';
}

/**
 * 本地文件名：优先用图床的 fileId（同一张图跨轮次稳定，天然幂等），
 * 没有 fileId 时退回 URL 去掉时效段后的哈希。
 */
function baseName(img: { url: string; fileId?: string }): string {
  if (img.fileId) return img.fileId.replace(/[^\w-]/g, '');
  // 去掉路径里的分钟级时间戳与签名段，避免同一张图每轮换个名字重复下载
  const stable = img.url.replace(/\/\d{12}\/[0-9a-f]{32}\//, '/');
  return createHash('sha1').update(stable).digest('hex').slice(0, 24);
}

/** 按年月分子目录，避免单目录堆几十万文件 */
function monthDir(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 找出已缓存的同名文件（扩展名未知，逐个候选试） */
function findCached(dir: string, base: string): string | null {
  for (const ext of ['jpg', 'webp', 'png', 'gif']) {
    const p = join(dir, `${base}.${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 带上限地读取响应体。
 *
 * 直接 arrayBuffer() 会先把整个响应读进内存，再比大小已经拦不住内存占用了——
 * 图床返回一个几百 MB 的错误体照样会把进程撑爆。这里先看 content-length 预检，
 * 没有该头就流式累计，一超限立即 cancel 掉底层流。
 */
async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    throw new Error(`超过单图上限 ${declared} 字节（content-length 预检）`);
  }
  if (!res.body) return Buffer.from(await res.arrayBuffer());

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`超过单图上限（已读 ${total} 字节，上限 ${maxBytes}）`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export interface SourceImage {
  url: string;
  fileId?: string;
  width?: number;
  height?: number;
}

/**
 * 允许下载的图床域名后缀白名单。
 *
 * img.url 直接来自上游 JSON（小红书 imageList.urlDefault 等），若不校验就 fetch，
 * 上游一改字段/被投毒就成了一条从外部响应直通的服务端请求面——落盘的结果还会以
 * /media/kol 对外暴露。新增抓取源时把对应图床后缀补进来，宁可少缓存一张图。
 */
const ALLOWED_HOST_SUFFIXES = [
  // 小红书图床（sns-webpic-qc / sns-img-* / ci 等子域均落在此后缀下）
  'xhscdn.com',
  'xiaohongshu.com',
  // 微博图床
  'sinaimg.cn',
];

/** 目标是否为白名单内的 https 图床地址 */
function isAllowedImageUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

/**
 * 下载并缓存一组图片，返回可直接给前端用的本地地址。
 *
 * 整体 best-effort：单张失败只 warn 并跳过，绝不让配图问题打断笔记入库
 * （文字才是主体，图缺了顶多少看一张）。已存在的文件直接复用，不重复下载。
 */
export async function cacheImages(
  images: SourceImage[],
  sourceId: string,
  signal?: AbortSignal,
): Promise<KolImage[]> {
  if (images.length === 0) return [];
  const month = monthDir();
  const dir = join(cacheDir(), month);
  mkdirSync(dir, { recursive: true });

  const out: KolImage[] = [];
  for (const img of images.slice(0, MAX_PER_POST)) {
    if (signal?.aborted) break;
    if (!isAllowedImageUrl(img.url)) {
      console.warn(`[kol] 跳过非白名单图床地址 ${img.url.slice(0, 80)}`);
      continue;
    }
    const base = baseName(img);
    const hit = findCached(dir, base);
    if (hit) {
      out.push({
        src: `${MEDIA_PREFIX}/${month}/${hit.slice(hit.lastIndexOf('/') + 1)}`,
        width: img.width ?? 0,
        height: img.height ?? 0,
      });
      continue;
    }

    const startedAt = Date.now();
    try {
      // 外部取消与下载超时必须同时生效：二选一会让调用方传了 signal 时超时彻底失效
      const res = await fetch(img.url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/*,*/*' },
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(TIMEOUT_MS)]),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await readCapped(res, MAX_BYTES);
      if (buf.byteLength === 0) throw new Error('空响应');
      const name = `${base}.${extOf(res.headers.get('content-type'))}`;
      await writeFile(join(dir, name), buf);
      record(sourceId, { ok: true, latencyMs: Date.now() - startedAt });
      out.push({
        src: `${MEDIA_PREFIX}/${month}/${name}`,
        width: img.width ?? 0,
        height: img.height ?? 0,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      record(sourceId, { ok: false, latencyMs: Date.now() - startedAt, error: `配图下载失败: ${message}` });
      console.warn(`[kol] 配图缓存失败 ${img.url.slice(0, 80)}: ${message}`);
    }
  }
  return out;
}

/**
 * 清理过期缓存：逐文件按文件 mtime 删，目录清空后再删目录。
 * 与 pruneOldPosts 的保留期对齐，博文没了图也不用留。
 *
 * 不按年月目录的 mtime 判定：目录内每写入一张新图都会刷新目录 mtime，
 * 结果恰好在最活跃的当月目录上完全失效——同月旧图永远等不到被回收。
 */
export async function pruneImages(keepDays = 30): Promise<number> {
  const root = cacheDir();
  if (!existsSync(root)) return 0;
  const cutoff = Date.now() - keepDays * 24 * 3600 * 1000;
  let removed = 0;
  for (const name of await readdir(root)) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      let left = 0;
      for (const file of await readdir(dir)) {
        const path = join(dir, file);
        const info = await stat(path);
        if (info.isFile() && info.mtimeMs < cutoff) {
          await rm(path, { force: true });
          removed += 1;
        } else {
          left += 1;
        }
      }
      if (left === 0) await rm(dir, { recursive: true, force: true });
    } catch (e) {
      console.warn(`[kol] 清理配图目录 ${name} 失败:`, e instanceof Error ? e.message : e);
    }
  }
  return removed;
}
