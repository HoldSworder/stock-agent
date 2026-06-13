// 自选股面板（爱盯盘式）：分组顶部 Tab + 精简行情列表 + 编辑模式管理 + 点行看分时/K线。
// 数据全部走自有后端开放接口（无需 bridge 密钥）；图表复用 vendored klinecharts。
import { apiFetch } from './bridge.js';
import { renderKline, renderTrends, destroy as destroyChart } from './chart.js';

const SELF_TAG = '我的自选';

// ===== 后端接口包装 =====
const listWatchlist = () => apiFetch('/api/watchlist');
const addWatch = (code, tags) =>
  apiFetch('/api/watchlist', { method: 'POST', body: JSON.stringify({ code, tags }) });
const bulkAdd = (codes, tags) =>
  apiFetch('/api/watchlist/bulk', { method: 'POST', body: JSON.stringify({ codes, tags }) });
const removeWatch = (code) => apiFetch(`/api/watchlist/${code}`, { method: 'DELETE' });
const updateTags = (code, tags) =>
  apiFetch(`/api/watchlist/${code}`, { method: 'PUT', body: JSON.stringify({ tags }) });
const deleteGroupApi = (name) =>
  apiFetch(`/api/watchlist/group/${encodeURIComponent(name)}`, { method: 'DELETE' });
const searchSuggest = (q) => apiFetch(`/api/search/suggest?q=${encodeURIComponent(q)}`);
const getKline = (code, period) =>
  apiFetch(`/api/kline?code=${code}&period=${period}&limit=250`);
const getTrends = (code) => apiFetch(`/api/trends?code=${code}`);

// ===== A股 红涨绿跌 =====
const dirClass = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const fmtPct = (v) => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
const fmtPrice = (v) => v.toFixed(2);

// ===== DOM 助手 =====
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

// ===== 模块状态 =====
let root = null;
let listTimer = null;
let detailTimer = null;
let trendTimer = null;
let suggestTimer = null;
let items = [];
let activeGroup = '';
let editMode = false;
let mode = 'list'; // 'list' | 'detail'
let detail = { code: '', name: '', period: 'trend' };
let refs = {};

function groupsOf() {
  const set = new Set();
  for (const i of items) {
    for (const t of (i.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean)) set.add(t);
  }
  return Array.from(set);
}

function filtered() {
  if (!activeGroup) return items;
  return items.filter((i) =>
    (i.tags ?? '').split(',').map((s) => s.trim()).includes(activeGroup),
  );
}

function rowOf(code) {
  return items.find((i) => i.code === code) ?? null;
}

function status(msg, kind = '') {
  if (!refs.status) return;
  refs.status.textContent = msg;
  refs.status.className = 'wl-status' + (kind ? ' ' + kind : '');
}

// ===================== 列表态 =====================
function renderListShell() {
  root.textContent = '';

  // 头：标题 + 编辑开关
  const editBtn = el('button', {
    class: 'wl-edit' + (editMode ? ' active' : ''),
    text: editMode ? '完成' : '编辑',
    onclick: () => {
      editMode = !editMode;
      renderListShell();
    },
  });
  const head = el('div', { class: 'wl-head' }, [el('span', { class: 'wl-head-t', text: '自选股' }), editBtn]);

  // 添加栏（仅编辑态）
  let addBar = null;
  if (editMode) {
    refs.search = el('input', {
      type: 'text',
      class: 'wl-search',
      placeholder: '搜索名称/代码，点候选加入当前分组',
      oninput: onSearchInput,
    });
    refs.suggest = el('div', { class: 'wl-suggest hidden' });
    const bulkBtn = el('button', {
      class: 'wl-btn',
      text: '批量',
      onclick: () => refs.bulk.classList.toggle('hidden'),
    });
    const searchBox = el('div', { class: 'wl-searchbox' }, [refs.search, refs.suggest]);
    const bar = el('div', { class: 'wl-addbar' }, [searchBox, bulkBtn]);

    refs.bulkCodes = el('textarea', {
      class: 'wl-textarea',
      rows: '3',
      placeholder: '粘贴 6 位代码，逗号/空格/换行分隔，如 600519 002472',
    });
    refs.bulkTags = el('input', { type: 'text', class: 'wl-search', placeholder: '目标分组（可选，逗号分隔）' });
    const bulkSubmit = el('button', { class: 'wl-btn primary', text: '添加', onclick: submitBulk });
    refs.bulk = el('div', { class: 'wl-bulk hidden' }, [refs.bulkCodes, refs.bulkTags, bulkSubmit]);

    addBar = el('div', {}, [bar, refs.bulk]);
  }

  refs.groups = el('div', { class: 'wl-tabs' });
  refs.table = el('div', { class: 'wl-tablewrap' });
  refs.status = el('div', { class: 'wl-status' });

  root.append(head, ...(addBar ? [addBar] : []), refs.groups, refs.table, refs.status);
  renderGroups();
  renderTable();

  // 点击空白收起联想
  if (editMode) {
    document.addEventListener('click', onDocClick);
  } else {
    document.removeEventListener('click', onDocClick);
  }
}

function onDocClick(e) {
  if (refs.suggest && !refs.suggest.contains(e.target) && e.target !== refs.search) clearSuggest();
}

// 分组下划线 Tab
function renderGroups() {
  if (!refs.groups) return;
  const bar = refs.groups;
  bar.textContent = '';
  const gs = groupsOf();
  if (gs.length && !gs.includes(activeGroup)) activeGroup = gs[0];

  for (const g of gs) {
    const tab = el('button', {
      class: 'wl-tab' + (g === activeGroup ? ' active' : ''),
      text: g,
      onclick: () => {
        activeGroup = g;
        renderGroups();
        renderTable();
      },
    });
    bar.appendChild(tab);
  }
  // 编辑态：删除当前分组
  if (editMode && activeGroup) {
    bar.appendChild(
      el('button', {
        class: 'wl-tab danger',
        text: '删除组',
        title: `删除分组「${activeGroup}」`,
        onclick: async () => {
          if (!confirm(`删除分组「${activeGroup}」？将从所有标的移除该分组（标的保留），并同步删除同花顺对应分组。`))
            return;
          try {
            const g = activeGroup;
            activeGroup = '';
            await deleteGroupApi(g);
            await load();
          } catch (err) {
            status(err instanceof Error ? err.message : String(err), 'err');
          }
        },
      }),
    );
  }
}

// 行情列表
function renderTable() {
  if (!refs.table) return;
  const wrap = refs.table;
  wrap.textContent = '';
  const rows = filtered();
  if (!rows.length) {
    wrap.appendChild(
      el('div', {
        class: 'wl-empty',
        text: items.length ? `分组「${activeGroup}」下暂无标的` : '还没有自选股，点「编辑」搜索添加',
      }),
    );
    return;
  }
  for (const r of rows) {
    const q = r.quote;
    const cls = q ? dirClass(q.pct) : '';
    const left = el('div', { class: 'wl-r-name' }, [
      el('span', { class: 'wl-r-nm', text: r.name || r.code }),
      el('span', { class: 'wl-r-cd num', text: r.code }),
    ]);
    const mid = el('span', { class: 'wl-r-price num ' + cls, text: q ? fmtPrice(q.price) : '-' });
    const right = el('span', { class: 'wl-r-pct num ' + cls, text: q ? fmtPct(q.pct) : '-' });

    const children = [left, mid, right];
    if (editMode) {
      children.push(
        el('div', { class: 'wl-r-ops' }, [
          el('button', {
            class: 'wl-link',
            text: '改组',
            onclick: async (e) => {
              e.stopPropagation();
              const next = prompt(`修改 ${r.name}(${r.code}) 的分组（逗号分隔）`, r.tags ?? '');
              if (next === null) return;
              try {
                await updateTags(r.code, next.trim());
                await load();
              } catch (err) {
                status(err instanceof Error ? err.message : String(err), 'err');
              }
            },
          }),
          el('button', {
            class: 'wl-link danger',
            text: '删除',
            onclick: async (e) => {
              e.stopPropagation();
              if (!confirm(`移除 ${r.name}(${r.code})？`)) return;
              try {
                await removeWatch(r.code);
                await load();
              } catch (err) {
                status(err instanceof Error ? err.message : String(err), 'err');
              }
            },
          }),
        ]),
      );
    }
    const rowEl = el(
      'div',
      {
        class: 'wl-row' + (editMode ? ' editing' : ''),
        ...(editMode ? {} : { onclick: () => enterDetail(r.code, r.name) }),
      },
      children,
    );
    wrap.appendChild(rowEl);
  }
}

// ===== 搜索联想 =====
function clearSuggest() {
  if (!refs.suggest) return;
  refs.suggest.textContent = '';
  refs.suggest.classList.add('hidden');
}

function onSearchInput() {
  const kw = refs.search.value.trim();
  if (suggestTimer) clearTimeout(suggestTimer);
  if (!kw) {
    clearSuggest();
    return;
  }
  suggestTimer = setTimeout(async () => {
    try {
      const list = await searchSuggest(kw);
      refs.suggest.textContent = '';
      if (!list || !list.length) {
        clearSuggest();
        return;
      }
      for (const s of list.slice(0, 12)) {
        refs.suggest.appendChild(
          el(
            'div',
            { class: 'wl-sug', onclick: () => pickSuggest(s.code, s.name) },
            [el('span', { text: s.name }), el('span', { class: 'num muted', text: s.code })],
          ),
        );
      }
      refs.suggest.classList.remove('hidden');
    } catch {
      clearSuggest();
    }
  }, 250);
}

async function pickSuggest(code, name) {
  const tag = activeGroup || SELF_TAG;
  refs.search.value = '';
  clearSuggest();
  try {
    await addWatch(code, tag);
    if (!activeGroup) activeGroup = tag;
    status(`已将 ${name}(${code}) 加入「${tag}」`, 'ok');
    await load();
  } catch (err) {
    status(err instanceof Error ? err.message : String(err), 'err');
  }
}

async function submitBulk() {
  const codes = refs.bulkCodes.value.trim();
  if (!codes) {
    status('请粘贴股票代码', 'err');
    return;
  }
  try {
    const r = await bulkAdd(codes, refs.bulkTags.value.trim() || undefined);
    const msg = `成功添加 ${r.added.length} 只` + (r.invalid.length ? `，无效 ${r.invalid.length} 只` : '');
    status(msg, 'ok');
    refs.bulkCodes.value = '';
    refs.bulkTags.value = '';
    refs.bulk.classList.add('hidden');
    await load();
  } catch (err) {
    status(err instanceof Error ? err.message : String(err), 'err');
  }
}

// 列表轮询：仅刷新分组与表格，保留添加栏/输入焦点
async function load() {
  try {
    items = await listWatchlist();
    if (mode !== 'list') return;
    status('');
    renderGroups();
    renderTable();
  } catch (err) {
    if (mode === 'list') status(err instanceof Error ? err.message : String(err), 'err');
  }
}

// ===================== 详情态 =====================
const PERIODS = [
  { k: 'trend', label: '分时' },
  { k: 'day', label: '日K' },
  { k: 'week', label: '周K' },
  { k: 'month', label: '月K' },
];

function enterDetail(code, name) {
  mode = 'detail';
  detail = { code, name, period: 'trend' };
  stopListTimer();
  renderDetailShell();
  loadChart();
  // 报价头 3s 刷新（复用 watchlist）；分时图 5s 刷新
  detailTimer = setInterval(refreshDetailQuote, 3000);
  startTrendTimer();
}

function exitDetail() {
  stopDetailTimers();
  destroyChart();
  mode = 'list';
  renderListShell();
  startListTimer();
  void load();
}

function renderDetailShell() {
  root.textContent = '';
  const back = el('button', { class: 'wl-back', text: '‹ 返回', onclick: exitDetail });
  refs.dPrice = el('span', { class: 'wl-d-price num' });
  refs.dPct = el('span', { class: 'wl-d-pct num' });
  const titleWrap = el('div', { class: 'wl-d-title' }, [
    el('span', { class: 'wl-d-nm', text: detail.name || detail.code }),
    el('span', { class: 'wl-d-cd num', text: detail.code }),
  ]);
  const head = el('div', { class: 'wl-d-head' }, [
    back,
    titleWrap,
    el('div', { class: 'wl-d-quote' }, [refs.dPrice, refs.dPct]),
  ]);

  refs.seg = el(
    'div',
    { class: 'wl-seg' },
    PERIODS.map((p) =>
      el('button', {
        class: 'wl-seg-btn' + (p.k === detail.period ? ' active' : ''),
        text: p.label,
        onclick: () => {
          if (detail.period === p.k) return;
          detail.period = p.k;
          renderSeg();
          startTrendTimer();
          loadChart();
        },
      }),
    ),
  );

  refs.chart = el('div', { class: 'wl-chart' });
  refs.chartMsg = el('div', { class: 'wl-chart-msg hidden' });
  const chartWrap = el('div', { class: 'wl-chartwrap' }, [refs.chart, refs.chartMsg]);
  refs.status = el('div', { class: 'wl-status' });

  root.append(head, refs.seg, chartWrap, refs.status);
  refreshDetailQuote();
}

function renderSeg() {
  if (!refs.seg) return;
  [...refs.seg.children].forEach((btn, i) => {
    btn.className = 'wl-seg-btn' + (PERIODS[i].k === detail.period ? ' active' : '');
  });
}

function refreshDetailQuote() {
  // 借列表数据刷新报价头
  if (mode === 'detail') {
    listWatchlist()
      .then((data) => {
        items = data;
        if (mode !== 'detail') return;
        const q = rowOf(detail.code)?.quote;
        if (!refs.dPrice) return;
        const cls = q ? dirClass(q.pct) : '';
        refs.dPrice.textContent = q ? fmtPrice(q.price) : '-';
        refs.dPrice.className = 'wl-d-price num ' + cls;
        refs.dPct.textContent = q ? fmtPct(q.pct) : '-';
        refs.dPct.className = 'wl-d-pct num ' + cls;
      })
      .catch(() => {});
  }
}

function chartMsg(msg) {
  if (!refs.chartMsg) return;
  if (msg) {
    refs.chartMsg.textContent = msg;
    refs.chartMsg.classList.remove('hidden');
  } else {
    refs.chartMsg.classList.add('hidden');
  }
}

async function loadChart() {
  const { code, period } = detail;
  chartMsg('加载中…');
  try {
    if (period === 'trend') {
      const result = await getTrends(code);
      if (mode !== 'detail' || detail.code !== code || detail.period !== period) return;
      renderTrends(refs.chart, result);
      chartMsg(result.points?.length ? '' : '暂无分时数据（非交易时段）');
    } else {
      const bars = await getKline(code, period);
      if (mode !== 'detail' || detail.code !== code || detail.period !== period) return;
      renderKline(refs.chart, bars);
      chartMsg(bars?.length ? '' : '暂无 K 线数据');
    }
  } catch (err) {
    chartMsg(err instanceof Error ? err.message : String(err));
  }
}

// ===== 定时器 =====
function startListTimer() {
  stopListTimer();
  listTimer = setInterval(load, 3000);
}
function stopListTimer() {
  if (listTimer) clearInterval(listTimer);
  listTimer = null;
}
function startTrendTimer() {
  if (trendTimer) clearInterval(trendTimer);
  trendTimer = null;
  if (mode === 'detail' && detail.period === 'trend') {
    trendTimer = setInterval(loadChart, 5000);
  }
}
function stopDetailTimers() {
  if (detailTimer) clearInterval(detailTimer);
  if (trendTimer) clearInterval(trendTimer);
  detailTimer = null;
  trendTimer = null;
}

// ===== 对外：激活/停用 =====
export const watchlist = {
  activate(container) {
    root = container;
    mode = 'list';
    renderListShell();
    void load();
    startListTimer();
  },
  deactivate() {
    stopListTimer();
    stopDetailTimers();
    destroyChart();
    document.removeEventListener('click', onDocClick);
  },
};
