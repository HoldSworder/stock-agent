import type { FastifyInstance } from 'fastify';
import type { Scorecard } from '@stock-agent/shared';
import { scoreSignals } from './score';
import { findSource, poolFor, SIGNAL_SOURCES } from './sources';

// 判卷机的对外接口。
//
// 纯只读、纯本地计算，不联网、不调模型、不写库，所以没有定时任务——
// 想看就算一遍。判分依赖的是已经落库的信号与本地日线，
// 同样的输入永远得出同样的分数，这是它能当证据用的前提。

// 对照池不跨来源合并。
//
// 曾经用「全部来源涉及标的的并集」做统一池，想的是别让各来源自己挑对自己有利的池子。
// 但那样 ETF 盯盘的「同日全池」对照会混进波段扫描覆盖的几百只个股，
// 池子从 56 只涨到 168 只，基准就不是同类了——拿 ETF 跟个股比涨跌说明不了任何事。
//
// 正确的做法是池子由该来源自己的信号机械推导（scoreSignals 在 pool 为空时的默认行为）：
// 既是同类可比的范围，又不存在人为挑选的空间。

export function registerScorecardModule(app: FastifyInstance): void {
  // 名册：有哪些来源可以被判分，各自的产生方式
  app.get('/api/scorecard/sources', () => ({
    ok: true,
    data: SIGNAL_SOURCES.map((s) => ({
      id: s.id,
      label: s.label,
      side: s.side,
      origin: s.origin,
    })),
  }));

  // 全部来源的成绩单。一次算完，便于横向比较——分开取容易只看自己想看的那个
  app.get<{ Querystring: { horizons?: string } }>('/api/scorecard', (req) => {
    const horizons = parseHorizons(req.query.horizons);
    const data: Scorecard[] = SIGNAL_SOURCES.map((s) =>
      scoreSignals({
        source: s.id,
        label: s.label,
        signals: s.load(),
        side: s.side,
        horizons,
        pool: poolFor(s),
      }),
    );
    return { ok: true, data };
  });

  // 单个来源
  app.get<{ Params: { id: string }; Querystring: { horizons?: string } }>(
    '/api/scorecard/:id',
    (req, reply) => {
      const src = findSource(req.params.id);
      if (!src) return reply.code(404).send({ ok: false, error: '没有这个信号来源' });
      return {
        ok: true,
        data: scoreSignals({
          source: src.id,
          label: src.label,
          signals: src.load(),
          side: src.side,
          horizons: parseHorizons(req.query.horizons),
          pool: poolFor(src),
        }),
      };
    },
  );
}

/** 解析 ?horizons=5,10,20；非法值忽略，空则用默认 */
function parseHorizons(raw?: string): number[] | undefined {
  if (!raw) return undefined;
  const xs = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 250);
  return xs.length ? xs : undefined;
}
