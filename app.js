// ============================================================
// 阿尔戈斯 · 全球电影情报站 查看端(纯原生 JS,无框架)
// 四板块:豆瓣情报 / 全球票房 / 媒体资讯 / 电影节
// Supabase REST(anon key)读 + 受限写(douban_films.status/note)。
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
  let ALL = [];                 // 豆瓣片库(全量缓存)
  let FILM_BY_ID = new Map();
  let BO = [];                  // 票房条目
  let NEWS = [];
  let FESTS = [];
  let FEST_FILMS = [];
  const loaded = { douban: false, boxoffice: false, news: false, festivals: false };

  const state = {
    section: 'douban',
    year: '2026', status: '待筛', country: '', sort: 'default', q: '',
    boMarket: '', boQ: '',
    newsSource: '', newsQ: '',
    festTier: 'all',
  };

  // ---------- DOM ----------
  const $ = (s) => document.querySelector(s);
  const listEl = $('#list');
  const updatedEl = $('#updatedAt');
  const toastEl = $('#toast');

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove('show'), 1600);
  }
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- 通用:分页拉全量 ----------
  async function fetchAll(pathAndQuery, pageSize = 1000, maxRows = 30000) {
    const out = [];
    for (let from = 0; from < maxRows; from += pageSize) {
      const res = await fetch(REST + '/' + pathAndQuery, {
        headers: { ...HEADERS, 'Range-Unit': 'items', Range: from + '-' + (from + pageSize - 1) },
      });
      if (!res.ok) throw new Error('读取失败 ' + res.status);
      const batch = await res.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      out.push(...batch);
      if (batch.length < pageSize) break;
    }
    return out;
  }

  // ============================================================
  // 板块1:豆瓣情报
  // ============================================================
  async function loadFilms() {
    ALL = await fetchAll(
      'douban_films?select=id,name,orig_name,country,countries,year,score,imdb_rating,' +
      'genres,directors,actors,duration,status,douban_url,' +
      'star5,d_star5,comments,d_comments&order=year.desc,id.asc');
    FILM_BY_ID = new Map(ALL.map((f) => [f.id, f]));
  }

  async function loadLastRun() {
    try {
      const res = await fetch(
        REST + '/douban_runs?select=run_date,finished_at,kind,summary,blocked&kind=eq.daily&order=finished_at.desc&limit=1',
        { headers: HEADERS });
      const rows = await res.json();
      if (rows && rows[0]) {
        const r = rows[0];
        const t = r.finished_at ? new Date(r.finished_at).toLocaleString('zh-CN', { hour12: false }) : r.run_date;
        updatedEl.textContent = '更新于 ' + t + (r.blocked ? ' ⚠️被限速' : '');
      } else updatedEl.textContent = '尚无运行记录';
    } catch { updatedEl.textContent = ''; }
  }

  async function setStatus(id, status) {
    const res = await fetch(REST + '/douban_films?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { ...HEADERS, Prefer: 'return=minimal' },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) throw new Error('写入失败 ' + res.status);
  }

  function applyFilters() {
    let rows = ALL;
    if (state.year !== 'all') rows = rows.filter((r) => String(r.year) === state.year);
    updateStatusCounts(rows);
    if (state.status !== 'all') rows = rows.filter((r) => r.status === state.status);
    if (state.country) rows = rows.filter((r) => (r.countries || r.country || '').includes(state.country));
    if (state.q) {
      const q = state.q.toLowerCase();
      rows = rows.filter((r) =>
        (r.name || '').toLowerCase().includes(q) ||
        (r.orig_name || '').toLowerCase().includes(q) ||
        (r.directors || '').toLowerCase().includes(q));
    }
    rows = rows.slice();
    switch (state.sort) {
      case 'score_desc': rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1)); break;
      case 'imdb_desc': rows.sort((a, b) => (b.imdb_rating ?? -1) - (a.imdb_rating ?? -1)); break;
      case 'has_score': rows.sort((a, b) => (b.score != null) - (a.score != null) || (b.score ?? 0) - (a.score ?? 0)); break;
      case 'd_star5_desc': rows.sort((a, b) => (b.d_star5 ?? -1) - (a.d_star5 ?? -1)); break;
      case 'd_comments_desc': rows.sort((a, b) => (b.d_comments ?? -1) - (a.d_comments ?? -1)); break;
    }
    return rows;
  }

  function updateStatusCounts(yearRows) {
    const c = { '待筛': 0, '重点关注': 0, '保留': 0, '淘汰': 0, all: yearRows.length };
    for (const r of yearRows) if (c[r.status] != null) c[r.status]++;
    for (const k of ['待筛', '重点关注', '保留', '淘汰', 'all']) {
      const el = document.getElementById('c-' + k);
      if (el) el.textContent = c[k];
    }
  }

  function rebuildCountryOptions() {
    let rows = ALL;
    if (state.year !== 'all') rows = rows.filter((r) => String(r.year) === state.year);
    const m = new Map();
    for (const r of rows) {
      const first = (r.countries || r.country || '').split(' / ')[0];
      if (first) m.set(first, (m.get(first) || 0) + 1);
    }
    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const sel = $('#countrySel');
    const cur = sel.value;
    sel.innerHTML = '<option value="">全部国家</option>' +
      sorted.map(([c, n]) => `<option value="${escapeHtml(c)}">${escapeHtml(c)} (${n})</option>`).join('');
    if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
  }

  // 状态 → 卡片上显示哪些操作按钮
  function actionBtns(film) {
    const s = film.status;
    const b = [];
    const mk = (act, cls, label) => `<button class="${cls}" data-act="${act}" data-id="${film.id}">${label}</button>`;
    if (s === '待筛') {
      b.push(mk('focus', 'btn-focus', '⭐重点'), mk('keep', 'btn-keep', '保留'), mk('drop', 'btn-drop', '淘汰'));
    } else if (s === '重点关注') {
      b.push(mk('keep', 'btn-keep', '转保留'), mk('drop', 'btn-drop', '淘汰'));
    } else if (s === '保留') {
      b.push(mk('focus', 'btn-focus', '⭐转重点'), mk('drop', 'btn-drop', '淘汰'));
    } else { // 淘汰
      b.push(mk('reset', 'btn-keep', '恢复待筛'));
    }
    return b.join('');
  }

  function num(n) { return n == null ? '—' : n.toLocaleString('zh-CN'); }
  function delta(d) {
    if (d == null) return '';
    if (d > 0) return ` <em class="up">+${num(d)}</em>`;
    return ` <em class="flat">+0</em>`;
  }

  function cardHtml(r) {
    const scoreHtml = r.score != null
      ? `<div class="score">${r.score}</div>`
      : `<div class="score none">未开分</div>`;
    const imdbHtml = r.imdb_rating != null ? `<div class="imdb">IMDb ${r.imdb_rating}</div>` : '';
    const badge = `<span class="badge s-${r.status}">${r.status === '重点关注' ? '⭐重点关注' : r.status}</span>`;
    const orig = r.orig_name ? `<p class="film-orig">${escapeHtml(r.orig_name)}</p>` : '';
    const meta = [
      escapeHtml(r.countries || r.country || '—'),
      r.year ?? '',
      r.duration ? escapeHtml(r.duration) : null,
      r.genres ? escapeHtml(r.genres) : null,
    ].filter(Boolean).join(' · ');
    const crew = (r.directors || r.actors)
      ? `<div class="film-crew">${r.directors ? '导演: ' + escapeHtml(r.directors) : ''}${r.directors && r.actors ? ' ｜ ' : ''}${r.actors ? '主演: ' + escapeHtml(r.actors) : ''}</div>`
      : '';
    return `
      <div class="card" data-id="${r.id}">
        <div class="card-head">
          <div class="card-titles">
            <p class="film-name">${escapeHtml(r.name)}${badge}</p>
            ${orig}
            <div class="film-meta">${meta}</div>
            ${crew}
          </div>
          <div class="card-scores">${scoreHtml}${imdbHtml}</div>
        </div>
        <div class="trend">
          <span>★5 ${num(r.star5)}${delta(r.d_star5)}</span>
          <span>短评 ${num(r.comments)}${delta(r.d_comments)}</span>
        </div>
        <div class="actions">
          <a class="btn-douban" href="${r.douban_url || '#'}" target="_blank" rel="noopener">豆瓣↗</a>
          ${actionBtns(r)}
        </div>
      </div>`;
  }

  function renderDouban() {
    const rows = applyFilters();
    $('#resultCount').textContent = rows.length + ' 部';
    if (!rows.length) { listEl.innerHTML = '<div class="empty">没有符合条件的影片</div>'; return; }
    const MAX = 600;
    listEl.innerHTML = rows.slice(0, MAX).map(cardHtml).join('') +
      (rows.length > MAX ? `<div class="empty">仅显示前 ${MAX} 部,请用筛选缩小范围</div>` : '');
  }

  // ============================================================
  // 板块2:全球票房
  // ============================================================
  async function loadBoxoffice() {
    const rows = await fetchAll(
      'boxoffice_entries?select=market,market_code,period,rank,title,weekend_gross,total_gross,weeks,douban_sid,douban_url,fetched_at' +
      '&order=fetched_at.desc&limit=3000', 1000, 3000);
    // 每市场只留最新 period
    const latest = new Map(); // market -> period
    for (const r of rows) if (!latest.has(r.market)) latest.set(r.market, r.period);
    BO = rows.filter((r) => latest.get(r.market) === r.period);
  }

  function rebuildBoMarkets() {
    const ms = [...new Set(BO.map((r) => r.market))].sort((a, b) => a.localeCompare(b, 'zh'));
    $('#boMarketSel').innerHTML = '<option value="">全部市场 (' + ms.length + ')</option>' +
      ms.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
  }

  function boCardHtml(r) {
    const film = r.douban_sid ? FILM_BY_ID.get(r.douban_sid) : null;
    const link = r.douban_url
      ? `<a class="btn-douban" href="${r.douban_url}" target="_blank" rel="noopener">豆瓣↗</a>`
      : `<a class="btn-douban dim" href="https://www.douban.com/search?cat=1002&q=${encodeURIComponent(r.title)}" target="_blank" rel="noopener">搜豆瓣↗</a>`;
    const btns = film ? actionBtns(film) : '';
    const badge = film ? `<span class="badge s-${film.status}">${film.status === '重点关注' ? '⭐重点关注' : film.status}</span>` : '';
    return `
      <div class="card bo-card" data-id="${film ? film.id : ''}">
        <div class="card-head">
          <div class="card-titles">
            <p class="film-name"><span class="bo-rank">#${r.rank}</span>${escapeHtml(r.title)}${badge}</p>
            <div class="film-meta">${escapeHtml(r.market)} · ${escapeHtml(r.period)}${r.weeks ? ' · 第' + r.weeks + '周' : ''}</div>
          </div>
          <div class="card-scores">
            <div class="bo-gross">${escapeHtml(r.weekend_gross || '—')}</div>
            <div class="bo-total">累计 ${escapeHtml(r.total_gross || '—')}</div>
          </div>
        </div>
        <div class="actions">${link}${btns}</div>
      </div>`;
  }

  function renderBoxoffice() {
    let rows = BO;
    if (state.boMarket) rows = rows.filter((r) => r.market === state.boMarket);
    if (state.boQ) {
      const q = state.boQ.toLowerCase();
      rows = rows.filter((r) => r.title.toLowerCase().includes(q) || r.market.includes(state.boQ));
    }
    $('#boCount').textContent = rows.length ? `${new Set(rows.map(r=>r.market)).size} 个市场 · ${rows.length} 条` : '';
    const el = $('#boList');
    if (!rows.length) { el.innerHTML = '<div class="empty">暂无票房数据(等每日抓取首跑后出现)</div>'; return; }
    // 按市场分组展示
    const byMarket = new Map();
    for (const r of rows) {
      if (!byMarket.has(r.market)) byMarket.set(r.market, []);
      byMarket.get(r.market).push(r);
    }
    let html = '';
    for (const [mk, list] of byMarket) {
      list.sort((a, b) => a.rank - b.rank);
      html += `<h3 class="group-title">${escapeHtml(mk)} <small>${escapeHtml(list[0].period)}</small></h3>`;
      html += list.map(boCardHtml).join('');
    }
    el.innerHTML = html;
  }

  // ============================================================
  // 板块3:媒体资讯
  // ============================================================
  async function loadNews() {
    NEWS = await fetchAll(
      'news_items?select=source,title,url,summary,published_at,fetched_at&order=published_at.desc.nullslast&limit=500',
      500, 500);
  }

  function rebuildNewsSources() {
    const ss = [...new Set(NEWS.map((n) => n.source))];
    $('#newsSourceSeg').innerHTML =
      `<button data-source="" class="${state.newsSource ? '' : 'active'}">全部</button>` +
      ss.map((s) => `<button data-source="${escapeHtml(s)}" class="${state.newsSource === s ? 'active' : ''}">${escapeHtml(s)}</button>`).join('');
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    const h = Math.floor(diff / 3600000);
    if (h < 1) return '刚刚';
    if (h < 24) return h + ' 小时前';
    const d = Math.floor(h / 24);
    if (d <= 30) return d + ' 天前';
    return new Date(iso).toLocaleDateString('zh-CN');
  }

  function renderNews() {
    let rows = NEWS;
    if (state.newsSource) rows = rows.filter((n) => n.source === state.newsSource);
    if (state.newsQ) {
      const q = state.newsQ.toLowerCase();
      rows = rows.filter((n) => n.title.toLowerCase().includes(q) || (n.summary || '').toLowerCase().includes(q));
    }
    $('#newsCount').textContent = rows.length ? rows.length + ' 条' : '';
    const el = $('#newsList');
    if (!rows.length) { el.innerHTML = '<div class="empty">暂无资讯(等每日抓取首跑后出现)</div>'; return; }
    el.innerHTML = rows.slice(0, 300).map((n) => `
      <a class="news-item" href="${n.url}" target="_blank" rel="noopener">
        <div class="news-top"><span class="news-src">${escapeHtml(n.source)}</span><span class="news-time">${timeAgo(n.published_at)}</span></div>
        <p class="news-title">${escapeHtml(n.title)}</p>
        ${n.summary ? `<p class="news-summary">${escapeHtml(n.summary)}</p>` : ''}
      </a>`).join('');
  }

  // ============================================================
  // 板块4:电影节
  // ============================================================
  async function loadFestivals() {
    [FESTS, FEST_FILMS] = await Promise.all([
      fetchAll('festivals?select=*&order=tier.asc,name_cn.asc', 1000, 1000),
      fetchAll('festival_films?select=*&order=festival_id.asc,section.asc', 1000, 5000),
    ]);
  }

  function festCardHtml(f) {
    const films = FEST_FILMS.filter((x) => x.festival_id === f.id);
    const kindCn = { festival: '电影节', award: '奖项', market: '交易市场' }[f.kind] || '';
    const lineupCls = f.lineup_status === '已公布' ? 'ok' : f.lineup_status === '部分公布' ? 'part' : 'none';
    const filmsHtml = films.length
      ? `<details class="fest-films"><summary>入围/获奖片单 (${films.length})</summary>` +
        films.map((x) => `
          <div class="fest-film">
            <span class="ff-section">${escapeHtml(x.section || '')}</span>
            <span class="ff-title">${escapeHtml(x.title)}${x.prize ? ' 🏅' + escapeHtml(x.prize) : ''}</span>
            ${x.douban_url ? `<a href="${x.douban_url}" target="_blank" rel="noopener">豆瓣↗</a>` : ''}
          </div>`).join('') + '</details>'
      : '';
    return `
      <div class="card fest-card">
        <div class="card-head">
          <div class="card-titles">
            <p class="film-name"><span class="tier tier-${f.tier}">${f.tier}</span>${escapeHtml(f.name_cn)}<span class="fest-kind">${kindCn}</span></p>
            <p class="film-orig">${escapeHtml(f.name)}</p>
            <div class="film-meta">${escapeHtml([f.country, f.city].filter(Boolean).join(' · '))} · 常规档期: ${escapeHtml(f.month_window || '—')}</div>
            <div class="film-meta">2026届: ${escapeHtml(f.edition_2026 || '待公布')}</div>
            ${f.notes ? `<div class="fest-notes">${escapeHtml(f.notes)}</div>` : ''}
          </div>
          <div class="card-scores"><div class="lineup ${lineupCls}">片单${escapeHtml(f.lineup_status)}</div></div>
        </div>
        ${filmsHtml}
        ${f.official_url ? `<div class="actions"><a class="btn-douban" href="${f.official_url}" target="_blank" rel="noopener">官网↗</a></div>` : ''}
      </div>`;
  }

  function renderFestivals() {
    let rows = FESTS;
    if (state.festTier !== 'all') rows = rows.filter((f) => f.tier === state.festTier);
    const el = $('#festList');
    if (!rows.length) { el.innerHTML = '<div class="empty">暂无电影节数据(先运行 npm run festivals 灌入底库)</div>'; return; }
    let html = '';
    for (const tier of ['S', 'A', 'B']) {
      const group = rows.filter((f) => f.tier === tier);
      if (!group.length) continue;
      html += `<h3 class="group-title">${tier} 级 <small>${group.length} 个</small></h3>`;
      html += group.map(festCardHtml).join('');
    }
    el.innerHTML = html;
  }

  // ============================================================
  // 板块切换 + 事件
  // ============================================================
  async function showSection(name) {
    state.section = name;
    for (const s of ['douban', 'boxoffice', 'news', 'festivals']) {
      document.getElementById('sec-' + s).hidden = s !== name;
    }
    try {
      if (name === 'boxoffice' && !loaded.boxoffice) {
        $('#boList').innerHTML = '<div class="empty">加载中…</div>';
        await loadBoxoffice(); loaded.boxoffice = true; rebuildBoMarkets();
      }
      if (name === 'news' && !loaded.news) {
        $('#newsList').innerHTML = '<div class="empty">加载中…</div>';
        await loadNews(); loaded.news = true; rebuildNewsSources();
      }
      if (name === 'festivals' && !loaded.festivals) {
        $('#festList').innerHTML = '<div class="empty">加载中…</div>';
        await loadFestivals(); loaded.festivals = true;
      }
    } catch (e) { toast('加载失败: ' + e.message); }
    renderCurrent();
  }

  function renderCurrent() {
    if (state.section === 'douban') renderDouban();
    else if (state.section === 'boxoffice') renderBoxoffice();
    else if (state.section === 'news') renderNews();
    else renderFestivals();
  }

  function bindSeg(id, key, onChange) {
    document.getElementById(id).addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      [...e.currentTarget.children].forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state[key] = btn.dataset[Object.keys(btn.dataset)[0]];
      onChange && onChange();
      renderCurrent();
    });
  }

  // 状态按钮统一处理(豆瓣卡片 + 票房卡片共用)
  async function handleAction(btn) {
    const id = btn.dataset.id;
    const film = FILM_BY_ID.get(id);
    if (!film) return;
    const next = { focus: '重点关注', keep: '保留', drop: '淘汰', reset: '待筛' }[btn.dataset.act];
    btn.disabled = true;
    try {
      await setStatus(id, next);
      film.status = next;
      toast(next === '待筛' ? '已恢复待筛' : '已' + (next === '重点关注' ? '加入⭐重点关注' : next));
      renderCurrent();
    } catch (err) {
      toast('写入失败:' + err.message);
      btn.disabled = false;
    }
  }

  function bindEvents() {
    // 主导航
    document.getElementById('sectionSeg').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      [...e.currentTarget.children].forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      showSection(btn.dataset.section);
    });

    // 豆瓣板块
    bindSeg('yearSeg', 'year', rebuildCountryOptions);
    bindSeg('statusSeg', 'status');
    $('#countrySel').addEventListener('change', (e) => { state.country = e.target.value; renderDouban(); });
    $('#sortSel').addEventListener('change', (e) => { state.sort = e.target.value; renderDouban(); });
    let qt;
    $('#searchBox').addEventListener('input', (e) => {
      clearTimeout(qt); qt = setTimeout(() => { state.q = e.target.value.trim(); renderDouban(); }, 200);
    });

    // 票房板块
    $('#boMarketSel').addEventListener('change', (e) => { state.boMarket = e.target.value; renderBoxoffice(); });
    let bt;
    $('#boSearchBox').addEventListener('input', (e) => {
      clearTimeout(bt); bt = setTimeout(() => { state.boQ = e.target.value.trim(); renderBoxoffice(); }, 200);
    });

    // 资讯板块
    document.getElementById('newsSourceSeg').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      [...e.currentTarget.children].forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.newsSource = btn.dataset.source;
      renderNews();
    });
    let nt;
    $('#newsSearchBox').addEventListener('input', (e) => {
      clearTimeout(nt); nt = setTimeout(() => { state.newsQ = e.target.value.trim(); renderNews(); }, 200);
    });

    // 电影节板块
    bindSeg('festTierSeg', 'festTier');

    // 操作按钮(全局委托,豆瓣/票房卡片共用)
    document.body.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (btn) handleAction(btn);
    });
  }

  // ---------- 启动 ----------
  async function init() {
    bindEvents();
    listEl.innerHTML = '<div class="empty">加载中…(首次约几秒)</div>';
    try {
      await Promise.all([loadFilms(), loadLastRun()]);
      loaded.douban = true;
      rebuildCountryOptions();
      renderDouban();
    } catch (e) {
      listEl.innerHTML = '<div class="empty">加载失败: ' + escapeHtml(e.message) + '</div>';
    }
  }

  init();
})();
