// ============================================================
// 阿尔戈斯 · 豆瓣电影情报 查看端逻辑(纯原生 JS,无框架)
// 用 Supabase REST(anon key)读 + 受限写(status/note)。
// ============================================================

(function () {
  'use strict';

  const cfg = window.ARGOS_CONFIG || {};
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
    document.getElementById('list').innerHTML =
      '<div class="empty">缺少 config.js(请先用 .env 运行 npm run build:config)</div>';
    return;
  }
  const REST = cfg.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1';
  const HEADERS = {
    apikey: cfg.SUPABASE_ANON_KEY,
    Authorization: 'Bearer ' + cfg.SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
  };

  // ---------- 状态 ----------
  let ALL = [];            // 全量影片(本地缓存,前端过滤)
  const state = {
    year: '2026',
    status: '待筛',
    country: '',
    sort: 'default',
    q: '',
  };

  // ---------- DOM ----------
  const $ = (s) => document.querySelector(s);
  const listEl = $('#list');
  const countEl = $('#resultCount');
  const updatedEl = $('#updatedAt');
  const toastEl = $('#toast');

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove('show'), 1600);
  }

  // ---------- 数据拉取 ----------
  async function loadFilms() {
    // PostgREST 单次最多返回 1000 行 → 用 Range 头翻页拉全量
    const base = REST + '/douban_films?select=id,name,country,year,score,status,note,' +
      'douban_url,star5,d_star5,comments,d_comments&order=year.desc,id.asc';
    const PAGE = 1000;
    const out = [];
    for (let from = 0; ; from += PAGE) {
      const res = await fetch(base, {
        headers: { ...HEADERS, 'Range-Unit': 'items', Range: from + '-' + (from + PAGE - 1) },
      });
      if (!res.ok) throw new Error('读取影片失败 ' + res.status);
      const batch = await res.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      out.push(...batch);
      if (batch.length < PAGE) break;
    }
    ALL = out;
  }

  async function loadLastRun() {
    try {
      const res = await fetch(
        REST + '/douban_runs?select=run_date,finished_at,kind,summary,blocked&order=finished_at.desc&limit=1',
        { headers: HEADERS }
      );
      const rows = await res.json();
      if (rows && rows[0]) {
        const r = rows[0];
        const t = r.finished_at ? new Date(r.finished_at).toLocaleString('zh-CN', { hour12: false }) : r.run_date;
        updatedEl.textContent = '更新于 ' + t + (r.blocked ? ' ⚠️被限速' : '');
      } else {
        updatedEl.textContent = '尚无运行记录';
      }
    } catch {
      updatedEl.textContent = '';
    }
  }

  // ---------- 受限写:更新状态 ----------
  async function setStatus(id, status) {
    const res = await fetch(REST + '/douban_films?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { ...HEADERS, Prefer: 'return=minimal' },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) throw new Error('写入失败 ' + res.status);
  }

  // ---------- 过滤 + 排序 ----------
  function applyFilters() {
    let rows = ALL;
    if (state.year !== 'all') rows = rows.filter((r) => String(r.year) === state.year);
    // 状态计数(在当前年份范围内统计)
    updateStatusCounts(rows);

    if (state.status !== 'all') rows = rows.filter((r) => r.status === state.status);
    if (state.country) rows = rows.filter((r) => r.country === state.country);
    if (state.q) {
      const q = state.q.toLowerCase();
      rows = rows.filter((r) => (r.name || '').toLowerCase().includes(q));
    }

    rows = rows.slice();
    switch (state.sort) {
      case 'score_desc':
        rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1)); break;
      case 'has_score':
        rows.sort((a, b) => (b.score != null) - (a.score != null) || (b.score ?? 0) - (a.score ?? 0)); break;
      case 'd_star5_desc':
        rows.sort((a, b) => (b.d_star5 ?? -1) - (a.d_star5 ?? -1)); break;
      default: break;
    }
    return rows;
  }

  function updateStatusCounts(yearRows) {
    const c = { 待筛: 0, 保留: 0, 淘汰: 0, all: yearRows.length };
    for (const r of yearRows) if (c[r.status] != null) c[r.status]++;
    for (const k of ['待筛', '保留', '淘汰', 'all']) {
      const el = document.getElementById('c-' + k);
      if (el) el.textContent = c[k];
    }
  }

  function rebuildCountryOptions() {
    // 按当前年份内国家数量降序
    let rows = ALL;
    if (state.year !== 'all') rows = rows.filter((r) => String(r.year) === state.year);
    const m = new Map();
    for (const r of rows) if (r.country) m.set(r.country, (m.get(r.country) || 0) + 1);
    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const sel = $('#countrySel');
    const cur = sel.value;
    sel.innerHTML = '<option value="">全部国家</option>' +
      sorted.map(([c, n]) => `<option value="${c}">${c} (${n})</option>`).join('');
    if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
  }

  // ---------- 渲染 ----------
  function trendCell(label, d) {
    if (d == null) return `<span class="flat">${label} —</span>`;
    if (d > 0) return `<span class="up">${label} +${d}</span>`;
    return `<span class="flat">${label} ${d}</span>`;
  }

  function render() {
    const rows = applyFilters();
    countEl.textContent = rows.length + ' 部';
    if (!rows.length) {
      listEl.innerHTML = '<div class="empty">没有符合条件的影片</div>';
      return;
    }
    const MAX = 600; // 防止一次渲染过多卡顿
    const html = rows.slice(0, MAX).map(cardHtml).join('');
    listEl.innerHTML = html + (rows.length > MAX
      ? `<div class="empty">仅显示前 ${MAX} 部,请用搜索/筛选缩小范围</div>` : '');
  }

  function cardHtml(r) {
    const score = r.score != null
      ? `<div class="score">${r.score}</div>`
      : `<div class="score none">未开分</div>`;
    const keepOn = r.status === '保留' ? 'on' : '';
    const dropOn = r.status === '淘汰' ? 'on' : '';
    const badge = `<span class="badge ${r.status}">${r.status}</span>`;
    return `
      <div class="card" data-id="${r.id}">
        <div class="card-head">
          <div>
            <p class="film-name">${escapeHtml(r.name)}${badge}</p>
            <div class="film-meta">${escapeHtml(r.country || '—')} · ${r.year ?? ''}</div>
          </div>
          ${score}
        </div>
        <div class="trend">
          ${trendCell('★5新增', r.d_star5)}
          ${trendCell('短评新增', r.d_comments)}
          <span class="flat">短评 ${r.comments ?? '—'}</span>
        </div>
        <div class="actions">
          <a class="btn-douban" href="${r.douban_url || '#'}" target="_blank" rel="noopener">看豆瓣↗</a>
          <button class="btn-keep ${keepOn}" data-act="keep">${keepOn ? '已保留' : '保留'}</button>
          <button class="btn-drop ${dropOn}" data-act="drop">${dropOn ? '已淘汰' : '淘汰'}</button>
        </div>
      </div>`;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- 事件 ----------
  function bindSeg(id, key, onChange) {
    document.getElementById(id).addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      [...e.currentTarget.children].forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state[key] = btn.dataset[key];
      onChange && onChange();
      render();
    });
  }

  function bindEvents() {
    bindSeg('yearSeg', 'year', () => rebuildCountryOptions());
    bindSeg('statusSeg', 'status');

    $('#countrySel').addEventListener('change', (e) => { state.country = e.target.value; render(); });
    $('#sortSel').addEventListener('change', (e) => { state.sort = e.target.value; render(); });

    let qt;
    $('#searchBox').addEventListener('input', (e) => {
      clearTimeout(qt);
      qt = setTimeout(() => { state.q = e.target.value.trim(); render(); }, 200);
    });

    // 卡片内的保留/淘汰(事件委托)
    listEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const card = btn.closest('.card');
      const id = card.dataset.id;
      const film = ALL.find((r) => r.id === id);
      if (!film) return;

      // 切换逻辑:再次点击当前状态 → 恢复待筛
      let next;
      if (btn.dataset.act === 'keep') next = film.status === '保留' ? '待筛' : '保留';
      else next = film.status === '淘汰' ? '待筛' : '淘汰';

      btn.disabled = true;
      try {
        await setStatus(id, next);
        film.status = next; // 本地同步
        toast(next === '待筛' ? '已恢复待筛' : '已' + next);
        render();
      } catch (err) {
        toast('写入失败:' + err.message);
        btn.disabled = false;
      }
    });
  }

  // ---------- 启动 ----------
  async function init() {
    bindEvents();
    try {
      await Promise.all([loadFilms(), loadLastRun()]);
      rebuildCountryOptions();
      render();
    } catch (e) {
      listEl.innerHTML = '<div class="empty">加载失败:' + escapeHtml(e.message) + '</div>';
    }
  }

  init();
})();
