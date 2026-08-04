import type { FastifyInstance, FastifyReply } from 'fastify';
import type { KolPlatform } from '@stock-agent/shared';
import * as svc from './service';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';

// 挂载大V观点模块：注册 /api/kol/*。
// server.ts 仅需 registerKolModule(app) 一行接入，删除即整模块下线。
// 数据源两个：微博移动端（m.weibo.cn）免登录访客态直连，见 weibo.ts 的三步握手说明；
// 小红书 SSR 页解析，见 xiaohongshu.ts（需 Cookie 才有正文，否则降级为仅标题）。

export function registerKolModule(app: FastifyInstance): void {
  const fail = (reply: FastifyReply, e: unknown) =>
    reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });

  // 首次启动播种默认大V名单（表非空则跳过）
  svc.seedAccounts();

  // 模块内定时：微博盘中高频跟进发声，收盘后补一轮并清理过期；
  // 小红书风控严、逐篇拉正文请求量大，单独一个每小时的低频任务，不跟微博共用。
  defineModuleSchedules({
    app,
    module: 'kol',
    jobs: [
      {
        id: 'kol.intraday',
        label: '微博大V抓取·盘中（9-15 点每 10 分钟）',
        defaultCron: '*/10 9-15 * * 1-5',
        defaultEnabled: true,
        run: async () => {
          const r = await svc.refreshAll(undefined, 'weibo');
          console.log(`[kol] 微博盘中抓取完成：${r.accounts} 个大V，新增 ${r.inserted} 条`);
        },
      },
      {
        id: 'kol.evening',
        label: '微博大V抓取·盘后（18:00）+ 清理过期',
        defaultCron: '0 18 * * 1-5',
        defaultEnabled: true,
        run: async () => {
          const r = await svc.refreshAll(undefined, 'weibo');
          const pruned = svc.pruneOldPosts();
          // 配图与博文同一保留期，一并清掉，避免图片目录只涨不降
          const prunedImages = await svc.pruneCachedImages();
          console.log(
            `[kol] 微博盘后抓取完成：新增 ${r.inserted} 条，清理过期 ${pruned} 条、配图 ${prunedImages} 张`,
          );
        },
      },
      {
        id: 'kol.xhs',
        label: '小红书博主抓取（每小时整点）',
        defaultCron: '0 * * * *',
        defaultEnabled: true,
        run: async () => {
          const r = await svc.refreshAll(undefined, 'xiaohongshu');
          console.log(`[kol] 小红书抓取完成：${r.accounts} 个博主，新增 ${r.inserted} 条`);
        },
      },
    ],
  });

  // ===== 时间流 =====

  app.get<{ Querystring: { uid?: string; limit?: string; platform?: string } }>(
    '/api/kol/feed',
    (req, reply) => {
      try {
        const uid = req.query?.uid?.trim() || undefined;
        const limit = req.query?.limit ? Number(req.query.limit) || 50 : 50;
        const raw = req.query?.platform?.trim();
        const platform =
          raw === 'weibo' || raw === 'xiaohongshu' ? (raw as KolPlatform) : undefined;
        return { ok: true, data: svc.feed(uid, limit, platform) };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  // 手动刷新：现场抓取入库后返回概要（前端随后重取 feed）
  app.post('/api/kol/refresh', async (_req, reply) => {
    try {
      return { ok: true, data: await svc.refreshAll() };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // ===== 关注名单 =====

  app.get('/api/kol/accounts', (_req, reply) => {
    try {
      return { ok: true, data: svc.listAccounts() };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // 微博传搜索结果原样回来；小红书 uid 可传主页链接，服务端解析后现场抓资料回填
  app.post<{
    Body: {
      uid?: string;
      platform?: string;
      screenName?: string;
      avatar?: string;
      followersCount?: string;
      verifiedReason?: string;
    };
  }>('/api/kol/accounts', async (req, reply) => {
    const uid = (req.body?.uid ?? '').trim();
    const platform: KolPlatform = req.body?.platform === 'xiaohongshu' ? 'xiaohongshu' : 'weibo';
    if (!uid) {
      const what = platform === 'xiaohongshu' ? '小红书主页链接或用户 ID' : '微博 UID';
      return reply.code(400).send({ ok: false, error: `缺少${what}` });
    }
    try {
      return {
        ok: true,
        data: await svc.addAccount({
          uid,
          platform,
          screenName: (req.body?.screenName ?? '').trim(),
          avatar: (req.body?.avatar ?? '').trim(),
          followersCount: (req.body?.followersCount ?? '').trim(),
          verifiedReason: (req.body?.verifiedReason ?? '').trim(),
        }),
      };
    } catch (e) {
      // ID 格式错误、博主不存在均属参数问题
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.delete<{ Params: { uid: string } }>('/api/kol/accounts/:uid', (req, reply) => {
    try {
      if (!svc.removeAccount(req.params.uid)) {
        return reply.code(404).send({ ok: false, error: '该大V不在关注名单' });
      }
      return { ok: true, data: { uid: req.params.uid } };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post<{ Params: { uid: string }; Body: { enabled?: boolean } }>(
    '/api/kol/accounts/:uid/toggle',
    (req, reply) => {
      try {
        const enabled = req.body?.enabled !== false;
        if (!svc.toggleAccount(req.params.uid, enabled)) {
          return reply.code(404).send({ ok: false, error: '该大V不在关注名单' });
        }
        return { ok: true, data: { uid: req.params.uid, enabled } };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  // 按昵称搜微博用户，返回粉丝数/认证信息供辨别真身后一键添加
  app.get<{ Querystring: { q?: string } }>('/api/kol/search', async (req, reply) => {
    const q = (req.query?.q ?? '').trim();
    if (!q) return reply.code(400).send({ ok: false, error: '缺少搜索关键词' });
    try {
      return { ok: true, data: await svc.search(q) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // 小红书按昵称搜用户的接口需要签名，做不了；只能粘主页链接后预览资料确认是不是要找的人
  app.get<{ Querystring: { url?: string } }>('/api/kol/xhs/preview', async (req, reply) => {
    const input = (req.query?.url ?? '').trim();
    if (!input) {
      return reply.code(400).send({ ok: false, error: '请粘贴小红书博主主页链接或 24 位用户 ID' });
    }
    try {
      return { ok: true, data: await svc.previewXhsUser(input) };
    } catch (e) {
      return fail(reply, e);
    }
  });
}
