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
  let BO_FILMS = new Map();     // 票房片详情缓存(bo_films 表, sid -> row)
  let NEWS = [];
  let NEWS_FILM_INDEX = null;    // 资讯↔影片匹配索引(ALL 变动时置空重建)
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
  const FILM_SELECT = 'douban_films?select=id,name,orig_name,country,countries,year,score,imdb_rating,poster_url,' +
    'genres,directors,actors,duration,status,douban_url,star5,d_star5,comments,d_comments';
  let loadedAll = false;
  const loadedYears = new Set();

  // 提速:不再一次性拉全库,按年份分段加载(首屏只拉当前年,几秒出);切到其它年/全部时再补拉。
  async function loadFilms(year) {
    const q = (year && year !== 'all')
      ? FILM_SELECT + '&year=eq.' + encodeURIComponent(year) + '&order=id.asc'
      : FILM_SELECT + '&order=year.desc,id.asc';
    const rows = await fetchAll(q);
    for (const f of rows) {
      if (!FILM_BY_ID.has(f.id)) { ALL.push(f); FILM_BY_ID.set(f.id, f); }
    }
    if (!year || year === 'all') { loadedAll = true; rows.forEach((f) => loadedYears.add(String(f.year))); }
    else loadedYears.add(String(year));
    NEWS_FILM_INDEX = null; // 片库变动,资讯匹配索引重建
  }

  async function ensureYearLoaded(year) {
    if (loadedAll) return;
    if (year === 'all') { listEl.innerHTML = '<div class="empty">加载全部年份中…</div>'; await loadFilms('all'); return; }
    if (loadedYears.has(String(year))) return;
    listEl.innerHTML = '<div class="empty">加载 ' + year + ' 年中…</div>';
    await loadFilms(year);
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

  // 从豆瓣链接里抠 subject id
  function sidFromUrl(u) {
    const m = String(u || '').match(/subject\/(\d+)/) || String(u || '').match(/(\d{6,})/);
    return m ? m[1] : null;
  }

  // 加入监测:库里已有→直接改状态;否则写 watchlist,由 mini 次日并入并开始追踪
  async function addToWatchlist(sid, doubanUrl, desiredStatus, source) {
    if (!sid) { toast('没找到豆瓣ID'); return; }
    const inLib = FILM_BY_ID.get(sid);
    if (inLib) {
      await setStatus(sid, desiredStatus);
      inLib.status = desiredStatus;
      toast('已设为' + (desiredStatus === '重点关注' ? '⭐重点关注' : desiredStatus));
      renderCurrent();
      return;
    }
    const res = await fetch(REST + '/watchlist', {
      method: 'POST',
      headers: { ...HEADERS, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        sid, douban_url: doubanUrl || ('https://movie.douban.com/subject/' + sid + '/'),
        desired_status: desiredStatus, source: source || 'manual', ingested: false,
      }),
    });
    if (!res.ok) { toast('加入失败 ' + res.status); return; }
    toast('已加入监测，明天起自动追踪 ✅');
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
  // 票房字符串→数值(用于市场排序;忽略币种,统一名义值)
  function parseGross(s) {
    if (!s) return 0;
    s = String(s).replace(/[,，\s]/g, '');
    const m = s.match(/([\d.]+)\s*([KMB億万萬])?/i);
    if (!m) return 0;
    let n = parseFloat(m[1]) || 0;
    const u = (m[2] || '').toUpperCase();
    if (u === 'K') n *= 1e3; else if (u === 'M') n *= 1e6; else if (u === 'B') n *= 1e9;
    else if (u === '億') n *= 1e8; else if (u === '万' || u === '萬') n *= 1e4;
    return n;
  }
  function delta(d) {
    if (d == null) return '';
    if (d > 0) return ` <em class="up">+${num(d)}</em>`;
    return ` <em class="flat">+0</em>`;
  }

  // 海报:懒加载,失败回退为首字占位块(no-referrer 已在 <meta> 全局设置防盗链)
  window.__argosPosterFail = function (img) {
    const d = document.createElement('div');
    d.className = 'poster ph';
    d.textContent = img.getAttribute('data-nm') || '?';
    img.replaceWith(d);
  };
  function posterHtml(obj, fallbackName) {
    const url = obj && obj.poster_url;
    const nm = String((obj && obj.name) || fallbackName || '?').slice(0, 1);
    if (url) return `<img class="poster" loading="lazy" referrerpolicy="no-referrer" src="${escapeHtml(url)}" alt="" data-nm="${escapeHtml(nm)}" onerror="__argosPosterFail(this)" />`;
    return `<div class="poster ph">${escapeHtml(nm)}</div>`;
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
          ${posterHtml(r)}
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
    // 票房片详情缓存(表可能尚未创建,失败不影响主流程)
    try {
      const bf = await fetchAll('bo_films?select=*', 1000, 3000);
      BO_FILMS = new Map(bf.map((x) => [x.sid, x]));
    } catch { BO_FILMS = new Map(); }
  }

  function rebuildBoMarkets() {
    const ms = [...new Set(BO.map((r) => r.market))].sort((a, b) => a.localeCompare(b, 'zh'));
    $('#boMarketSel').innerHTML = '<option value="">全部市场 (' + ms.length + ')</option>' +
      ms.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
  }

  function boCardHtml(r) {
    const film = r.douban_sid ? FILM_BY_ID.get(r.douban_sid) : null;
    const bf = !film && r.douban_sid ? BO_FILMS.get(r.douban_sid) : null;
    const d = film || bf; // 详情来源:筛片库优先,其次票房片缓存
    const link = r.douban_url
      ? `<a class="btn-douban" href="${r.douban_url}" target="_blank" rel="noopener">豆瓣↗</a>`
      : `<a class="btn-douban dim" href="https://www.douban.com/search?cat=1002&q=${encodeURIComponent(r.title)}" target="_blank" rel="noopener">搜豆瓣↗</a>`;
    const btns = film ? actionBtns(film) : '';
    const badge = film ? `<span class="badge s-${film.status}">${film.status === '重点关注' ? '⭐重点关注' : film.status}</span>` : '';
    const cnName = d && d.name && d.name !== r.title ? `<p class="film-orig">${escapeHtml(d.name)}</p>` : '';
    const detailMeta = d ? [
      d.countries ? escapeHtml(d.countries) : null,
      d.duration ? escapeHtml(d.duration) : null,
      d.genres ? escapeHtml(d.genres) : null,
    ].filter(Boolean).join(' · ') : '';
    const crew = d && (d.directors || d.actors)
      ? `<div class="film-crew">${d.directors ? '导演: ' + escapeHtml(d.directors) : ''}${d.directors && d.actors ? ' ｜ ' : ''}${d.actors ? '主演: ' + escapeHtml(d.actors) : ''}</div>`
      : '';
    const scoreHtml = d && d.score != null ? `<div class="score">${d.score}</div>` : '';
    const imdbHtml = d && d.imdb_rating != null ? `<div class="imdb">IMDb ${d.imdb_rating}</div>` : '';
    return `
      <div class="card bo-card" data-id="${film ? film.id : ''}">
        <div class="card-head">
          ${posterHtml(d, r.title)}
          <div class="card-titles">
            <p class="film-name"><span class="bo-rank">#${r.rank}</span>${escapeHtml(r.title)}${badge}</p>
            ${cnName}
            <div class="film-meta">${escapeHtml(r.market)} · ${escapeHtml(r.period)}${r.weeks ? ' · 第' + r.weeks + '周' : ''}</div>
            ${detailMeta ? `<div class="film-meta">${detailMeta}</div>` : ''}
            ${crew}
          </div>
          <div class="card-scores">
            ${scoreHtml}${imdbHtml}
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
    // 按市场分组,市场按"该市场榜单累计票房之和"从高到低排
    const byMarket = new Map();
    for (const r of rows) {
      if (!byMarket.has(r.market)) byMarket.set(r.market, []);
      byMarket.get(r.market).push(r);
    }
    const groups = [...byMarket.entries()].map(([mk, list]) => {
      list.sort((a, b) => a.rank - b.rank);
      const total = list.reduce((s, r) => s + parseGross(r.total_gross || r.weekend_gross), 0);
      return { mk, list, total };
    }).sort((a, b) => b.total - a.total);
    let html = '';
    for (const g of groups) {
      html += `<h3 class="group-title">${escapeHtml(g.mk)} <small>${escapeHtml(g.list[0].period)}</small></h3>`;
      html += g.list.map(boCardHtml).join('');
    }
    el.innerHTML = html;
  }

  // ============================================================
  // 板块3:媒体资讯
  // ============================================================
  async function loadNews() {
    // select=* 以兼容 title_cn/summary_cn 列尚未创建的情况
    NEWS = await fetchAll(
      'news_items?select=*&order=published_at.desc.nullslast&limit=500',
      500, 500);
  }

  // 节展片单情报关键词(标题命中即认为是"入围/片单/获奖"类消息)
  const FEST_NEWS_RE = /lineup|line-up|selection|in competition|competition titles|slate|unveil|announce[sd]? .*(film|title)|world premiere|festival .*(add|reveal)|入围|片单|主竞赛|展映|公布.*名单|venice|toronto|busan|locarno|san sebasti|karlovy|tokyo film|sitges|tallinn|金马|釜山|威尼斯|多伦多|洛迦诺|东京电影节|圣塞巴斯蒂安|卡罗维发利/i;

  function isFestNews(n) {
    return FEST_NEWS_RE.test(n.title || '') || FEST_NEWS_RE.test(n.title_cn || '');
  }

  function rebuildNewsSources() {
    const ss = [...new Set(NEWS.map((n) => n.source))];
    $('#newsSourceSeg').innerHTML =
      `<button data-source="" class="${state.newsSource ? '' : 'active'}">全部</button>` +
      `<button data-source="__fest__" class="${state.newsSource === '__fest__' ? 'active' : ''}">🎯节展雷达</button>` +
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

  // 资讯↔影片匹配:用片库的中文名/原名在新闻标题里找最长命中
  function buildNewsFilmIndex() {
    const arr = [];
    for (const f of ALL) {
      if (f.name && f.name.length >= 3) arr.push({ k: f.name.toLowerCase(), f });
      if (f.orig_name && f.orig_name.length >= 5) arr.push({ k: f.orig_name.toLowerCase(), f });
    }
    arr.sort((a, b) => b.k.length - a.k.length);
    return arr;
  }
  function matchNewsFilm(n) {
    const idx = NEWS_FILM_INDEX || (NEWS_FILM_INDEX = buildNewsFilmIndex());
    const hay = ((n.title_cn || '') + ' ' + (n.title || '')).toLowerCase();
    if (!hay.trim()) return null;
    for (const e of idx) if (hay.includes(e.k)) return e.f;
    return null;
  }

  function newsItemHtml(n) {
    const fest = isFestNews(n);
    const mainTitle = n.title_cn || n.title;
    const subTitle = n.title_cn ? n.title : '';
    const summary = n.summary_cn || n.summary;

    // 命中片库 → 渲染成"影片卡"(豆瓣标签+按钮 + 新闻简述/原文)
    const film = matchNewsFilm(n);
    if (film) {
      const badge = `<span class="badge s-${film.status}">${film.status === '重点关注' ? '⭐重点关注' : film.status}</span>`;
      const scoreHtml = film.score != null ? `<div class="score">${film.score}</div>` : `<div class="score none">未开分</div>`;
      const imdbHtml = film.imdb_rating != null ? `<div class="imdb">IMDb ${film.imdb_rating}</div>` : '';
      const meta = [escapeHtml(film.countries || film.country || '—'), film.year ?? ''].filter(Boolean).join(' · ');
      return `
        <div class="card news-card" data-id="${film.id}">
          <div class="card-head">
            ${posterHtml(film)}
            <div class="card-titles">
              <p class="film-name">${escapeHtml(film.name)}${badge}</p>
              <div class="film-meta">${meta}</div>
            </div>
            <div class="card-scores">${scoreHtml}${imdbHtml}</div>
          </div>
          <div class="actions">
            <a class="btn-douban" href="${film.douban_url || '#'}" target="_blank" rel="noopener">豆瓣↗</a>
            ${actionBtns(film)}
          </div>
          <div class="news-attach${fest ? ' news-fest' : ''}">
            <div class="news-top"><span class="news-src">${escapeHtml(n.source)}</span>${fest ? '<span class="news-fest-tag">🎯节展</span>' : ''}<span class="news-time">${timeAgo(n.published_at)}</span></div>
            <p class="news-title">${escapeHtml(mainTitle)}</p>
            ${summary ? `<p class="news-summary">${escapeHtml(summary)}</p>` : ''}
            <a class="news-orig" href="${n.url}" target="_blank" rel="noopener">阅读原文 ↗</a>
          </div>
        </div>`;
    }

    // 未命中片库 → 普通资讯条
    return `
      <a class="news-item${fest ? ' news-fest' : ''}" href="${n.url}" target="_blank" rel="noopener">
        <div class="news-top"><span class="news-src">${escapeHtml(n.source)}</span>${fest ? '<span class="news-fest-tag">🎯节展</span>' : ''}<span class="news-time">${timeAgo(n.published_at)}</span></div>
        <p class="news-title">${escapeHtml(mainTitle)}</p>
        ${subTitle ? `<p class="news-title-en">${escapeHtml(subTitle)}</p>` : ''}
        ${summary ? `<p class="news-summary">${escapeHtml(summary)}</p>` : ''}
      </a>`;
  }

  function renderNews() {
    let rows = NEWS;
    if (state.newsSource === '__fest__') rows = rows.filter(isFestNews);
    else if (state.newsSource) rows = rows.filter((n) => n.source === state.newsSource);
    if (state.newsQ) {
      const q = state.newsQ.toLowerCase();
      rows = rows.filter((n) =>
        (n.title || '').toLowerCase().includes(q) ||
        (n.title_cn || '').toLowerCase().includes(q) ||
        (n.summary || '').toLowerCase().includes(q) ||
        (n.summary_cn || '').toLowerCase().includes(q));
    }
    $('#newsCount').textContent = rows.length ? rows.length + ' 条' : '';
    const el = $('#newsList');
    if (!rows.length) { el.innerHTML = '<div class="empty">暂无资讯(等每日抓取首跑后出现)</div>'; return; }
    const tip = NEWS.length && !NEWS.some((n) => n.title_cn)
      ? '<div class="empty" style="padding:8px">💡 中文翻译列未启用:请先在 Supabase 跑 upgrade-v3.sql,再跑一次 npm run news</div>' : '';
    el.innerHTML = tip + rows.slice(0, 300).map(newsItemHtml).join('');
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
    const ffRow = (x) => {
      const sc = x.douban_score != null ? `<span class="ff-score">豆 ${x.douban_score}</span>` : '';
      const im = x.imdb_rating != null ? `<span class="ff-imdb">IMDb ${x.imdb_rating}</span>` : '';
      const link = x.douban_url
        ? `<a class="ff-act btn-douban" href="${x.douban_url}" target="_blank" rel="noopener">豆瓣↗</a>`
        : `<a class="ff-act btn-douban dim" href="https://www.douban.com/search?cat=1002&q=${encodeURIComponent(x.title)}" target="_blank" rel="noopener">搜豆瓣↗</a>`;
      const watch = x.douban_sid
        ? `<button class="ff-act btn-focus" data-watch="重点关注" data-sid="${escapeHtml(x.douban_sid)}" data-url="${escapeHtml(x.douban_url || '')}">⭐重点</button>` +
          `<button class="ff-act btn-keep" data-watch="保留" data-sid="${escapeHtml(x.douban_sid)}" data-url="${escapeHtml(x.douban_url || '')}">保留</button>`
        : '';
      return `
        <div class="fest-film">
          <div class="ff-line">
            <span class="ff-section">${escapeHtml(x.section || '')}</span>
            <span class="ff-title">${escapeHtml(x.title)}${x.prize ? ' 🏅' + escapeHtml(x.prize) : ''}</span>
            ${sc}${im}
          </div>
          <div class="ff-acts">${link}${watch}</div>
        </div>`;
    };
    const filmsHtml = films.length
      ? `<details class="fest-films"><summary>入围/获奖片单 (${films.length})</summary>` +
        films.map(ffRow).join('') + '</details>'
      : '';
    return `
      <div class="card fest-card">
        <div class="card-head">
          <div class="card-titles">
            <p class="film-name"><span class="tier tier-${f.tier}">${f.tier}</span>${escapeHtml(f.name_cn)}<span class="fest-kind">${kindCn}</span></p>
            <p class="film-orig">${escapeHtml(f.name)}</p>
            <div class="film-meta">${escapeHtml([f.country, f.city].filter(Boolean).join(' · '))} · 常规档期: ${escapeHtml(f.month_window || '—')}</div>
            <div class="film-meta">2026届: ${escapeHtml(f.edition_2026 || '待公布')}</div>
            ${f.lineup_announce ? `<div class="film-meta la">📅 片单节点: ${escapeHtml(f.lineup_announce)}</div>` : ''}
            ${f.notes ? `<div class="fest-notes">${escapeHtml(f.notes)}</div>` : ''}
          </div>
          <div class="card-scores"><div class="lineup ${lineupCls}">片单${escapeHtml(f.lineup_status)}</div></div>
        </div>
        ${filmsHtml}
        ${f.official_url ? `<div class="actions"><a class="btn-douban" href="${f.official_url}" target="_blank" rel="noopener">官网↗</a></div>` : ''}
      </div>`;
  }

  // 📡 雷达:接下来要盯的片单公布节点(lineup_announce 以★开头的条目)
  function radarHtml() {
    const watch = FESTS.filter((f) => (f.lineup_announce || '').startsWith('★'));
    if (!watch.length) return '';
    const items = watch.map((f) =>
      `<div class="radar-item"><span class="tier tier-${f.tier}">${f.tier}</span><strong>${escapeHtml(f.name_cn)}</strong> — ${escapeHtml(f.lineup_announce.slice(1))}</div>`
    ).join('');
    return `<div class="radar"><div class="radar-head">📡 情报雷达 · 接下来要第一时间盯的片单节点</div>${items}
      <div class="radar-tip">片单一公布,资讯板块的"🎯节展雷达"筛选会第一时间出现相关报道;同时让 Claude 当天回填入围名单。</div></div>`;
  }

  // 国际分类(FIAPF口径);底库未回填 class_intl 时按旧 tier 兜底
  function classOf(f) {
    return f.class_intl || ({ S: '国际A类', A: '国际A类', B: '重要展映' }[f.tier]) || '重要展映';
  }
  const FEST_CLASS_ORDER = ['国际A类', '专门竞赛', '重要展映', '电影奖项', '交易市场'];

  function renderFestivals() {
    let rows = FESTS;
    if (state.festTier !== 'all') rows = rows.filter((f) => classOf(f) === state.festTier);
    const el = $('#festList');
    if (!rows.length) { el.innerHTML = '<div class="empty">暂无电影节数据(先运行 npm run festivals 灌入底库)</div>'; return; }
    let html = state.festTier === 'all' ? radarHtml() : '';
    for (const cls of FEST_CLASS_ORDER) {
      const group = rows.filter((f) => classOf(f) === cls);
      if (!group.length) continue;
      html += `<h3 class="group-title">${cls} <small>${group.length} 个</small></h3>`;
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

    // 豆瓣板块:年份切换需先按需加载该年数据再渲染
    document.getElementById('yearSeg').addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      [...e.currentTarget.children].forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.year = btn.dataset.year;
      try { await ensureYearLoaded(state.year); } catch (err) { toast('加载失败: ' + err.message); }
      rebuildCountryOptions();
      renderDouban();
    });
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

    // 操作按钮(全局委托):data-act=改库内状态;data-watch=加入监测(节展片/资讯片)
    document.body.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (btn) { handleAction(btn); return; }
      const w = e.target.closest('button[data-watch]');
      if (w) {
        e.preventDefault();
        w.disabled = true;
        addToWatchlist(w.dataset.sid, w.dataset.url, w.dataset.watch, 'festival')
          .catch((err) => toast('失败: ' + err.message))
          .finally(() => { w.disabled = false; });
      }
    });

    // 添加监测(重点关注板块的自助添加)
    const awBtn = $('#addWatchBtn'), awForm = $('#addWatchForm');
    if (awBtn) awBtn.addEventListener('click', () => { awForm.hidden = !awForm.hidden; if (!awForm.hidden) $('#addWatchUrl').focus(); });
    if ($('#addWatchSubmit')) $('#addWatchSubmit').addEventListener('click', async () => {
      const url = $('#addWatchUrl').value.trim();
      const sid = sidFromUrl(url);
      if (!sid) { toast('请粘贴有效的豆瓣链接'); return; }
      const status = $('#addWatchStatus').value;
      try {
        await addToWatchlist(sid, url.startsWith('http') ? url : '', status, 'manual');
        $('#addWatchUrl').value = ''; awForm.hidden = true;
      } catch (err) { toast('失败: ' + err.message); }
    });
  }

  // ---------- 启动 ----------
  async function init() {
    bindEvents();
    listEl.innerHTML = '<div class="empty">加载中…(首次约几秒)</div>';
    try {
      await Promise.all([loadFilms(state.year), loadLastRun()]);
      loaded.douban = true;
      rebuildCountryOptions();
      renderDouban();
    } catch (e) {
      listEl.innerHTML = '<div class="empty">加载失败: ' + escapeHtml(e.message) + '</div>';
    }
  }

  init();
})();
