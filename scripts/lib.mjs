// ============================================================
// 阿尔戈斯计划 · 豆瓣抓取公共库 (Node 22, 原生 fetch)
// 提供:豆瓣请求、节流、哨兵限速检测、HTML/JSON 解析、Supabase REST 封装。
// 仅在「确需代理」时用到 undici 的 ProxyAgent(Node 22 内置 undici)。
// ============================================================

// ---------- 自动加载 .env(若存在;已导出的环境变量优先,不覆盖) ----------
import { readFileSync as __rf, existsSync as __ex } from 'node:fs';
import { dirname as __dn, join as __jn } from 'node:path';
import { fileURLToPath as __fp } from 'node:url';
const __envPath = __jn(__dn(__fp(import.meta.url)), '..', '.env');
if (__ex(__envPath)) {
  for (const __line of __rf(__envPath, 'utf8').split('\n')) {
    const __m = __line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (__m && !__m[1].startsWith('#') && process.env[__m[1]] === undefined) {
      process.env[__m[1]] = __m[2];
    }
  }
}

// ---------- 环境变量 ----------
const DOUBAN_COOKIE = process.env.DOUBAN_COOKIE || '';
const DOUBAN_PROXY  = process.env.DOUBAN_PROXY  || '';      // 例: http://user:pass@host:port
const SUPABASE_URL  = process.env.SUPABASE_URL  || '';
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// ---------- 代理(住宅代理 / 机房代理)----------
// 若设置了 DOUBAN_PROXY,用 undici 的 ProxyAgent 作为 fetch 的 dispatcher。
// Node 22 自带 undici,无需安装。代理不存在时为 undefined,fetch 直连。
let proxyDispatcher;
if (DOUBAN_PROXY) {
  try {
    const { ProxyAgent } = await import('undici');
    proxyDispatcher = new ProxyAgent(DOUBAN_PROXY);
    console.log('[lib] 已启用代理:', DOUBAN_PROXY.replace(/\/\/[^@]*@/, '//***@'));
  } catch (e) {
    console.warn('[lib] 代理初始化失败,将直连:', e.message);
  }
}

// 仿浏览器请求头(豆瓣对 UA / Referer 较敏感)
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Referer': 'https://movie.douban.com/',
  'X-Requested-With': 'XMLHttpRequest',
};

// ============================================================
// 基础工具
// ============================================================

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 带抖动的节流:默认 600~900ms,避免固定间隔被识别
export async function pace(min = 600, max = 900) {
  const ms = Math.floor(min + Math.random() * (max - min));
  await sleep(ms);
}

// 当天是一年中的第几天(用于 5 星轮动分组)
export function dayOfYear(d = new Date()) {
  const start = new Date(d.getFullYear(), 0, 0);
  const diff = d - start;
  return Math.floor(diff / 86400000);
}

// ============================================================
// 豆瓣请求
// ============================================================

/**
 * doubanGet — 请求豆瓣,带浏览器头 + cookie(+ 可选代理),20s 超时。
 * @param {string} url
 * @param {{json?:boolean}} opt  json=true 时尝试解析为 JSON,失败返回 null
 * @returns {Promise<string|object|null>} 文本 / JSON / null(失败)
 */
export async function doubanGet(url, opt = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      headers: {
        ...BROWSER_HEADERS,
        ...(DOUBAN_COOKIE ? { Cookie: DOUBAN_COOKIE } : {}),
      },
      signal: controller.signal,
      ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
    });
    if (!res.ok) {
      console.warn(`[doubanGet] HTTP ${res.status} ${url}`);
      // 403 / 418 / 429 通常是被限速/封禁
      return null;
    }
    const text = await res.text();
    if (opt.json) {
      try {
        return JSON.parse(text);
      } catch {
        return null; // 返回的不是 JSON(常见于被拦截到验证页)
      }
    }
    return text;
  } catch (e) {
    console.warn(`[doubanGet] 失败 ${url}:`, e.name === 'AbortError' ? '超时' : e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * sentinelOk — 哨兵:抓一次「美国 tags=2026」搜索 JSON,判断是否还能正常拿数据。
 * 返回 true=正常;false=疑似被限速(空/非 JSON/超时)。
 * 用法:每跑一批前调用,被限速就立即停止当天任务。
 */
export async function sentinelOk() {
  const url =
    'https://movie.douban.com/j/new_search_subjects?' +
    'sort=R&range=0,10&tags=&start=0&genres=&countries=%E7%BE%8E%E5%9B%BD&year_range=2026,2026';
  const json = await doubanGet(url, { json: true });
  // 美国2026 必然有结果;返回空数组=被软限速(豆瓣常以空响应代替403)。原 length>=0 恒真是bug。
  const ok = !!(json && Array.isArray(json.data) && json.data.length > 0);
  if (!ok) console.warn('[sentinel] 哨兵未通过,疑似被限速/封禁(或 cookie 过期)');
  return ok;
}

// ============================================================
// 解析函数
// ============================================================

/**
 * parseRoster — 从 new_search_subjects 返回的 JSON 取片单。
 * 结构: { data: [ {id, title, rate, url, ...}, ... ] }
 * @returns {{sid:string,title:string,rate:string}[]}
 */
export function parseRoster(json) {
  if (!json || !Array.isArray(json.data)) return [];
  return json.data
    .filter((x) => x && x.id)
    .map((x) => ({
      sid: String(x.id),
      title: x.title || '',
      rate: x.rate || '',
    }));
}

// 小工具:从 HTML 里抓第一个匹配组,失败返回 null
function pick(html, re) {
  const m = html.match(re);
  return m ? m[1] : null;
}

/**
 * parseSubjectRatings — 解析豆瓣详情页 HTML 的评分信息。
 * 健壮处理:未开分 / 缺字段一律给 null,不抛错。
 * @param {string} html
 * @returns {{
 *   ratingNum:number|null, ratingPeople:number|null,
 *   perStar:{s5:number,s4:number,s3:number,s2:number,s1:number}|null,
 *   star1:number|null,...star5:number|null,
 *   comments:number|null, country:string|null
 * }}
 */
export function parseSubjectRatings(html) {
  const empty = {
    ratingNum: null, ratingPeople: null, perStar: null,
    star1: null, star2: null, star3: null, star4: null, star5: null,
    comments: null, country: null,
  };
  if (!html || typeof html !== 'string') return empty;

  // 总分: <strong ... property="v:average">7.8</strong>
  let ratingNum = pick(html, /property="v:average"[^>]*>\s*([\d.]+)\s*</);
  ratingNum = ratingNum && parseFloat(ratingNum) > 0 ? parseFloat(ratingNum) : null;

  // 评价人数: <span property="v:votes">12345</span>
  let ratingPeople = pick(html, /property="v:votes"[^>]*>\s*(\d+)\s*</);
  ratingPeople = ratingPeople ? parseInt(ratingPeople, 10) : null;

  // 5 档星级百分比: 多个 <span class="rating_per">61.2%</span>,顺序为 5星→1星
  const perMatches = [...html.matchAll(/class="rating_per"[^>]*>\s*([\d.]+)%/g)].map((m) =>
    parseFloat(m[1])
  );
  let perStar = null;
  if (perMatches.length >= 5) {
    perStar = {
      s5: perMatches[0], s4: perMatches[1], s3: perMatches[2],
      s2: perMatches[3], s1: perMatches[4],
    };
  }

  // 由百分比 × 总人数 → 各档绝对人数(四舍五入);缺任一则全 null
  let star1 = null, star2 = null, star3 = null, star4 = null, star5 = null;
  if (perStar && ratingPeople != null) {
    const tot = ratingPeople;
    star5 = Math.round((perStar.s5 / 100) * tot);
    star4 = Math.round((perStar.s4 / 100) * tot);
    star3 = Math.round((perStar.s3 / 100) * tot);
    star2 = Math.round((perStar.s2 / 100) * tot);
    star1 = Math.round((perStar.s1 / 100) * tot);
  }

  // 短评总数: 全部 <span>(12345)</span> 在 "看过XX的评论" 区,
  // 取 comments-tab / "全部 12345 条" 等多种写法。
  let comments =
    pick(html, /看过[^<]*的[\s\S]*?全部\s*(\d+)\s*条/) ||
    pick(html, /comments\?status=P[^>]*>\s*全部\s*(\d+)\s*条/) ||
    pick(html, /<a[^>]*comments[^>]*>\s*全部\s*(\d+)\s*条/) ||
    pick(html, /id="comments-section"[\s\S]*?全部\s*(\d+)\s*条/);
  comments = comments ? parseInt(comments, 10) : null;

  // 制片国家/地区(第一国): <span class="pl">制片国家/地区:</span> 美国 / 英国
  let country = pick(
    html,
    /制片国家\/地区:<\/span>\s*([^<\/]+?)\s*<br/
  );
  if (country) country = country.split('/')[0].trim() || null;

  return { ratingNum, ratingPeople, perStar, star1, star2, star3, star4, star5, comments, country };
}

/**
 * parseSubjectAbstract — 从 subject_abstract JSON 判断条目类型,用于过滤。
 * 返回 {type, durations, isMovie}
 * 剧集/综艺/≤60min 短片 → isMovie=false。
 */
export function classifyAbstract(json) {
  // 兼容两种来源:subject_abstract({subject:{...}}) 或详情页解析
  const subj = json && (json.subject || json);
  if (!subj) return { isMovie: false, reason: 'no-data' };

  const subtype = subj.subtype || '';        // 'movie' / 'tv'
  const genres = (subj.genres || []).join(' ');
  const durations = subj.durations || subj.duration || [];
  const durText = Array.isArray(durations) ? durations.join(' ') : String(durations);

  // 剧集
  if (subtype === 'tv' || /剧集|电视剧|连续剧|动画剧/.test(genres)) {
    return { isMovie: false, reason: 'tv' };
  }
  // 综艺/真人秀
  if (/真人秀|脱口秀|综艺|talk-show|reality/i.test(genres)) {
    return { isMovie: false, reason: 'variety' };
  }
  // 类型明确标了「短片」→ 不收(李超 06-12 规则,与片长规则相互独立)
  if (/短片/.test(genres)) {
    return { isMovie: false, reason: 'short-genre' };
  }
  // 片长 ≤ 60min 的短片(纪录/演唱会例外:含这些关键词则保留)
  const keep = /纪录|演唱会|音乐会|concert|documentary/i.test(genres);
  const minMatch = durText.match(/(\d+)\s*分钟/);
  if (!keep && minMatch && parseInt(minMatch[1], 10) <= 60) {
    return { isMovie: false, reason: 'short' };
  }
  return { isMovie: true, reason: 'ok' };
}

// ============================================================
// Supabase REST 封装 (service_role,绕过 RLS)
// ============================================================

/**
 * sb — 调用 Supabase REST (/rest/v1)。
 * @param {string} method GET/POST/PATCH/DELETE
 * @param {string} path   如 'douban_films?id=eq.123'
 * @param {object} [body]
 * @param {object} [extraHeaders] 如 { Prefer: 'resolution=merge-duplicates' }
 */
export async function sb(method, path, body, extraHeaders = {}) {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error('缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 环境变量');
  }
  const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase ${method} ${path} -> ${res.status}: ${text}`);
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

/**
 * upsertFilms — 批量 upsert 影片(冲突按主键合并)。
 * @param {object[]} rows
 * @param {boolean} ignoreDuplicates true=已存在则整行不动(用于 seed 幂等补字段时配合)
 */
export async function upsertFilms(rows, ignoreDuplicates = false) {
  if (!rows.length) return [];
  const prefer = ignoreDuplicates
    ? 'resolution=ignore-duplicates,return=representation'
    : 'resolution=merge-duplicates,return=representation';
  return sb('POST', 'douban_films', rows, { Prefer: prefer });
}

/**
 * selectFilms — 查询影片。
 * @param {string} query  PostgREST 查询串,如 "status=eq.保留&select=id,name"
 */
export async function selectFilms(query = 'select=*') {
  // PostgREST 默认单次最多返回 1000 行 → 用 Range 头自动翻页取全量。
  // 无 order 时补 order=id,保证分页稳定不漏不重。
  const q = /(^|&)order=/.test(query) ? query : `${query}&order=id`;
  const PAGE = 1000;
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const batch = await sb('GET', `douban_films?${q}`, undefined, {
      'Range-Unit': 'items',
      Range: `${from}-${from + PAGE - 1}`,
    });
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < PAGE) break;
  }
  return out;
}

/**
 * updateFilm — 更新单片(按 id)。
 */
export async function updateFilm(id, patch) {
  return sb('PATCH', `douban_films?id=eq.${encodeURIComponent(id)}`, patch);
}

/**
 * insertRun — 写一条运行日志。
 */
export async function insertRun(row) {
  return sb('POST', 'douban_runs', row);
}

// ============================================================
// v2 扩展:详情解析 / IMDb / RSS / Box Office Mojo / 豆瓣搜索
// ============================================================

/** 通用网页抓取(非豆瓣站点,不带豆瓣cookie) */
export async function fetchText(url, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_HEADERS['User-Agent'],
        'Accept-Language': 'en-US,en;q=0.8,zh-CN;q=0.6',
        ...extraHeaders,
      },
      signal: controller.signal,
      ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
    });
    if (!res.ok) { console.warn(`[fetchText] HTTP ${res.status} ${url}`); return null; }
    return await res.text();
  } catch (e) {
    console.warn(`[fetchText] ${e.message} ${url}`);
    return null;
  } finally { clearTimeout(timer); }
}

/** 抓豆瓣详情页 HTML(带cookie) */
export async function doubanSubjectHtml(sid) {
  return doubanGet(`https://movie.douban.com/subject/${sid}/`, { json: false });
}

/**
 * parseSubjectDetail — 从豆瓣详情页解析:原名/全部国家/类型/导演/主演/片长/IMDb id/分数
 */
export function parseSubjectDetail(html, knownName = '') {
  if (!html) return null;
  const all = (re) => { const out = []; let m; const r = new RegExp(re, 'g');
    while ((m = r.exec(html))) out.push(m[1].trim()); return out; };
  const one = (re) => { const m = html.match(re); return m ? m[1].trim() : null; };

  const itemreviewed = one(/property="v:itemreviewed"[^>]*>([^<]+)</);
  let orig = null;
  if (itemreviewed && knownName && itemreviewed.startsWith(knownName)) {
    orig = itemreviewed.slice(knownName.length).trim() || null;
  }
  if (!orig) {
    const aka = one(/又名:<\/span>\s*([^<]+)<br/);
    if (aka) orig = aka.split('/')[0].trim();
  }
  const countries = one(/制片国家\/地区:<\/span>\s*([^<]+)<br/);
  const genres = all(/property="v:genre">([^<]+)</).join(' / ') || null;
  const directors = all(/rel="v:directedBy"[^>]*>([^<]+)</).join(' / ') || null;
  const actors = all(/rel="v:starring"[^>]*>([^<]+)</).slice(0, 3).join(' / ') || null;
  const duration = one(/property="v:runtime"[^>]*>([^<]+)</) || one(/片长:<\/span>\s*([^<]+)<br/);
  const imdbId = one(/IMDb:<\/span>\s*(tt\d+)/);
  const scoreStr = one(/property="v:average">([\d.]+)</);
  return {
    orig_name: orig,
    countries: countries ? countries.split('/').map(s => s.trim()).join(' / ') : null,
    genres, directors, actors,
    duration: duration ? duration.trim() : null,
    imdb_id: imdbId || null,
    score: scoreStr ? parseFloat(scoreStr) : null,
  };
}

/** fetchImdbRating — 从 IMDb 页面 JSON-LD 取评分 */
export async function fetchImdbRating(imdbId) {
  const html = await fetchText(`https://www.imdb.com/title/${imdbId}/`, {
    Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9',
  });
  if (!html) return null;
  const m = html.match(/"aggregateRating"\s*:\s*\{[^}]*"ratingValue"\s*:\s*"?([\d.]+)"?/);
  return m ? parseFloat(m[1]) : null;
}

/** parseRss — 极简 RSS/Atom 解析(零依赖) */
export function parseRss(xml) {
  if (!xml) return [];
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/g) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/g) || [];
  const strip = (s) => s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&quot;/g, '"').replace(/&apos;|&#x27;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
  for (const b of blocks) {
    const tag = (t) => { const m = b.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`)); return m ? strip(m[1]) : null; };
    let link = tag('link');
    if (!link) { const m = b.match(/<link[^>]*href="([^"]+)"/); link = m ? m[1] : null; }
    const title = tag('title');
    if (!title || !link) continue;
    const pub = tag('pubDate') || tag('published') || tag('dc:date') || tag('updated');
    let summary = tag('description') || tag('summary') || tag('content:encoded') || '';
    if (summary.length > 280) summary = summary.slice(0, 277) + '…';
    items.push({ title, url: link, published_at: pub ? new Date(pub).toISOString() : null, summary: summary || null });
  }
  return items;
}

/** parseBomIntl — 解析 BOM /intl/ 列表:每市场最新周末的链接 */
export function parseBomIntl(html) {
  if (!html) return [];
  const out = [];
  const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(html))) {
    const row = m[1];
    const area = row.match(/href="\/weekend\/by-year\/\?area=([A-Z0-9]+)[^"]*"[^>]*>([^<]+)</);
    const wk = row.match(/href="\/weekend\/(\d{4}W\d{2})\/\?area=[A-Z0-9]+[^"]*"[^>]*>([^<]+)</);
    if (area && wk) out.push({ code: area[1], market: area[2].trim(), week: wk[1], weekendLabel: wk[2].trim() });
  }
  return out;
}

/** parseBomWeekendChart — 解析单市场周末榜,取前N名 */
export function parseBomWeekendChart(html, topN = 3) {
  if (!html) return [];
  const out = [];
  const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(html)) && out.length < topN) {
    const row = m[1];
    const title = row.match(/href="\/release\/[^"]+"[^>]*>([^<]+)</);
    if (!title) continue;
    const moneys = [...row.matchAll(/mojo-field-type-money[^>]*>([^<]+)</g)].map(x => x[1].trim());
    const weeks = row.match(/mojo-field-type-positive_integer[^>]*>(\d+)</g);
    const rankM = row.match(/^[\s\S]*?>(\d+)<\/td>/);
    out.push({
      rank: out.length + 1,
      title: title[1].trim(),
      weekend_gross: moneys[0] || null,
      total_gross: moneys[moneys.length - 1] || null,
      weeks: weeks ? parseInt((weeks[weeks.length-1].match(/(\d+)</) || [])[1], 10) || null : null,
    });
  }
  return out;
}

/** parsePoster — 从豆瓣详情页取海报图 URL(og:image 最稳;只存URL不存图本体) */
export function parsePoster(html) {
  if (!html) return null;
  let m = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/);
  if (m && m[1] && !/celebrity|default/.test(m[1])) return m[1];
  m = html.match(/id="mainpic"[\s\S]{0,200}?<img[^>]+src="([^"]+)"/);
  return m ? m[1] : null;
}

/** parseYear — 从豆瓣详情页标题旁取年份 (2026) */
export function parseYear(html) {
  if (!html) return null;
  const m = html.match(/<span class="year">\((\d{4})\)<\/span>/);
  return m ? parseInt(m[1], 10) : null;
}

/** doubanSuggest — 按片名搜豆瓣,返回最可能的匹配 {sid,url,title} */
export async function doubanSuggest(q) {
  const json = await doubanGet(
    `https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(q)}`,
    { json: true }
  );
  if (!Array.isArray(json)) return null;
  const cand = json.find((x) => x && x.id && x.type !== 'celebrity' && !x.episode);
  if (!cand) return null;
  return { sid: String(cand.id), url: `https://movie.douban.com/subject/${cand.id}/`, title: cand.title || q };
}
