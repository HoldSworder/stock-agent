# stock-agent research archive (2026-10-16)

**Status**: research docs + primary-observation rerun entry. **Not** live trading signals. Prod schedulers must NOT import these.

> **非现网信号**：本目录仅供研究复盘与可复跑入口；不得挂入现网调度，不得当作实盘买卖依据。

## Primary observations (scratch-era)
- **Loop24** — 收益·稳健（jq11 Top2 EW）— runnable: `backend/src/scripts/research/mainline.loop24.jq11Top2Ew.ts`
- **Loop11** — 收益·进取（jq slope×R² Top1）— protocol/SUMMARY under `primary/loop-20261015-jq-slope25-r2-top1/` (script not recovered as standalone `mainline.loop11.*`; reconstruct from protocol if needed)
- **Loop18** — 回撤（MA120>MA250）— protocol/SUMMARY under `primary/loop-20261015-hs300-ma120-250-only/`

## Batch wraps
- `BATCH-LOOP11-21-WRAP.md`, `BATCH-LOOP22-31-WRAP.md`, `BATCH-LOOP32-33-WRAP.md`, `BATCH-THEME-LOOP34-37-WRAP.md`
- `SERIES-PAUSE-RETRO.md` — stopped families / isomorphism debt
- `SHADOW-LOOP24-RULES.md` — shadow bookkeeping (outputs stay local `.scratch/shadow-loop24/`)
- `THEME-POOL-FROZEN.md` — theme ETF pool gates (theme batch paused)

## Hard rules
- Do not wire FAIL knives into schedulers.
- Do not retune stopped families.
- Shadow Loop24 only; wide-base mining stopped; theme batch knife-5 stopped pending non-isomorphic hypothesis.
