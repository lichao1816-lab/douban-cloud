// ============================================================
// fetch-news.mjs — 全球电影媒体资讯:一线行业媒体 RSS / HTML。
// 每天抓固定源的最新文章(标题/链接/摘要/时间),按 url 去重入库。
// 源挂掉只警告不中断。可按需在 SOURCES 增删。
// 2026-06-12 修复:
//  - Cineuropa 旧 rdf.aspx 已 404 → 换 /en/rss/
//  - ScreenDaily /rss/news 已失效 → 依次尝试 full-rss / 45202.rss
//  - Deadline 加备用全站 feed(category feed 偶发被 CDN 拦)
//  - 界面文娱 a.jiemian.com lists RSS 接口整体下线 → 改抓
//    文娱频道列表页 HTML(lists/63)解析
//  - Mtime时光网 feed.mtime.com 已死 → 改抓 news.mtime.com HTML
//    (该站更新频率已很低,抓到多少算多少)
// 用法: node scripts/fetch-news.mjs
// ============================================================

import { fetchText, parseRss, sb, insertRun, pace } from './lib.mjs';

// type: 'rss' = 标准 RSS/Atom; 'html' = 列表页 HTML,用 parse 函数解析。
// urls: 依次尝试,取第一个能解析出条目的地址。
const SOURCES = [
  { name: 'Variety',       type: 'rss', urls: ['https://variety.com/v/film/feed/'] },
  { name: 'Deadline',      type: 'rss', urls: [
      'https://deadline.com/category/film/feed/',
      'https://deadline.com/feed/',
  ] },
  { name: 'THR',           type: 'rss', urls: ['https://www.hollywoodreporter.com/topic/movies/feed/'] },
  { name: 'IndieWire',     type: 'rss', urls: ['https://www.indiewire.com/c/film/feed/'] },
  { name: 'TheWrap',       type: 'rss', urls: ['https://www.thewrap.com/category/movies/feed/'] },
  { name: 'ScreenDaily',   type: 'rss', urls: [
      'https://www.screendaily.com/full-rss',
      'https://www.screendaily.com/45202.rss',
      'https://www.screendaily.com/rss/news',
  ] },
  { name: 'Cineuropa',     type: 'rss', urls: ['https://cineuropa.org/en/rss/'] },
  { name: 'FilmNewEurope', type: 'rss', urls: ['https://www.filmneweurope.com/news?format=feed&type=rss'] },
  { name: '界面文娱',       type: 'html', urls: ['https://www.jiemian.com/lists/63.html'], parse: parseJiemianList },
  { name: 'Mtime时光网',    type: 'html', urls: ['https://news.mtime.com/'], parse: parseMtimeNews },
];

// ---------- HTML 解析器 ----------

const TITLE_MIN = 6; // 过滤导航类短链接文本

function htmlDecode(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 界面新闻 文娱频道列表页: <a href="https://www.jiemian.com/article/123.html">标题</a> */
function parseJiemianList(html) {
  if (!html) return [];
  const seen = new Set();
  const out = [];
  const re = /<a[^>]+href="(https?:\/\/www\.jiemian\.com\/article\/\d+\.html)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const url = m[1];
    const title = htmlDecode(m[2]);
    if (!title || title.length < TITLE_MIN || seen.has(url)) continue;
    seen.add(url);
    out.push({ title, url, summary: null, published_at: null });
  }
  return out;
}

/** 时光网新闻首页: <a href="https://content.mtime.com/article/123" title="标题 摘要"> */
function parseMtimeNews(html) {
  if (!html) return [];
  const seen = new Set();
  const out = [];
  // 链接形如 content.mtime.com/article/229493656,标题在同块的 <h4>/<a> 文本或 title 属性里
  const re = /<a[^>]+href="(https?:\/\/content\.mtime\.com\/article\/\d+)\/?"[^>]*(?:title="([^"]*)")?[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const url = m[1];
    if (seen.has(url)) continue;
    const title = htmlDecode(m[3]) || htmlDecode(m[2] || '');
    if (!title || title.length < TITLE_MIN) continue; // 图片链接等留给后续同 url 文本链接
    seen.add(url);
    out.push({ title: title.slice(0, 120), url, summary: null, published_at: null });
  }
  return out;
}

// ---------- 标题/摘要机器翻译(英→中) ----------
// 主通道:微软 Edge 翻译(免key,国内可达);备用:Google gtx 接口。
// 失败不影响主流程,下次运行继续补译(按 title_cn is null 增量)。

const CN_SOURCES = new Set(['界面文娱', 'Mtime时光网']);
let _msToken = null;

async function msAuth() {
  if (_msToken) return _msToken;
  const r = await fetch('https://edge.microsoft.com/translate/auth');
  if (!r.ok) throw new Error('ms auth ' + r.status);
  _msToken = await r.text();
  return _msToken;
}

/** 微软批量翻译:texts[] → 中文[] */
async function msTranslate(texts) {
  const token = await msAuth();
  const r = await fetch(
    'https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&to=zh-Hans',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(texts.map((t) => ({ Text: t.slice(0, 500) }))),
    });
  if (!r.ok) throw new Error('ms translate ' + r.status);
  const j = await r.json();
  return j.map((x) => x?.translations?.[0]?.text || null);
}

/** Google gtx 单条翻译(备用) */
async function gTranslate(text) {
  const u = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q='
    + encodeURIComponent(text.slice(0, 500));
  const r = await fetch(u);
  if (!r.ok) return null;
  const j = await r.json();
  return Array.isArray(j?.[0]) ? j[0].map((seg) => seg[0]).join('') : null;
}

async function translateBatch(texts) {
  try { return await msTranslate(texts); }
  catch (e) {
    console.warn('[news] 微软翻译失败,改用Google逐条:', e.message);
    const out = [];
    for (const t of texts) {
      out.push(await gTranslate(t).catch(() => null));
      await pace(200, 400);
    }
    return out;
  }
}

/** 补译库中未翻译的外文资讯(每次最多 maxItems 条,增量进行) */
async function translateNews(maxItems = 120) {
  let items;
  try {
    items = await sb('GET',
      `news_items?title_cn=is.null&select=id,source,title,summary&order=fetched_at.desc&limit=${maxItems}`);
  } catch (e) {
    console.warn('[news] 跳过翻译(title_cn 列不存在?请先在 Supabase 跑 supabase/upgrade-v3.sql):', e.message.slice(0, 120));
    return 0;
  }
  items = (items || []).filter((it) => !CN_SOURCES.has(it.source));
  if (!items.length) { console.log('[news] 无待翻译条目'); return 0; }

  let done = 0;
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25);
    const titles = await translateBatch(batch.map((x) => x.title));
    const sums = await translateBatch(batch.map((x) => x.summary || ''));
    for (let k = 0; k < batch.length; k++) {
      const patch = {};
      if (titles[k]) patch.title_cn = titles[k];
      if (sums[k] && batch[k].summary) patch.summary_cn = sums[k];
      if (!Object.keys(patch).length) continue;
      await sb('PATCH', `news_items?id=eq.${batch[k].id}`, patch, { Prefer: 'return=minimal' })
        .then(() => done++)
        .catch((e) => console.warn('[news] 译文写入失败:', e.message.slice(0, 100)));
    }
    await pace(300, 600);
  }
  console.log(`[news] 已翻译 ${done} 条`);
  return done;
}

// ---------- 主流程 ----------

async function fetchSource(s) {
  for (const url of s.urls) {
    const text = await fetchText(url, {
      Accept: s.type === 'rss'
        ? 'application/rss+xml, application/xml, text/xml, */*'
        : 'text/html,application/xhtml+xml,*/*',
    });
    await pace(300, 600);
    const items = s.type === 'rss' ? parseRss(text) : s.parse(text);
    if (items.length) {
      if (url !== s.urls[0]) console.log(`[news] ${s.name}: 备用地址生效 ${url}`);
      return items;
    }
  }
  return [];
}

async function main() {
  const startedAt = new Date().toISOString();
  let inserted = 0, okSources = 0;
  const dead = [];

  for (const s of SOURCES) {
    const items = await fetchSource(s);
    if (!items.length) { console.warn(`[news] ${s.name} 无内容/抓取失败`); dead.push(s.name); continue; }
    okSources++;

    const rows = items.slice(0, 30).map((it) => ({
      source: s.name, title: it.title, url: it.url,
      summary: it.summary, published_at: it.published_at,
    }));
    // url 冲突忽略(已抓过的不重复)
    await sb('POST', 'news_items?on_conflict=url', rows,
      { Prefer: 'resolution=ignore-duplicates,return=representation' })
      .then((r) => { inserted += Array.isArray(r) ? r.length : 0; })
      .catch((e) => console.warn(`[news] ${s.name} 写入失败:`, e.message));
    console.log(`[news] ${s.name}: 拉到 ${items.length} 条`);
  }

  // 机器翻译外文标题/摘要(增量,失败不阻塞)
  let translated = 0;
  try { translated = await translateNews(); } catch (e) { console.warn('[news] 翻译步骤异常:', e.message); }

  // 清理 30 天前的旧资讯,防表膨胀
  try {
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    await sb('DELETE', `news_items?fetched_at=lt.${cutoff}`, undefined, { Prefer: 'return=minimal' });
  } catch {}

  await insertRun({
    kind: 'news', status: okSources ? 'ok' : 'error',
    new_films: inserted, started_at: startedAt, finished_at: new Date().toISOString(),
    summary: `源 ${okSources}/${SOURCES.length} 正常${dead.length ? `(失败: ${dead.join('/')})` : ''},新入库 ${inserted} 条,翻译 ${translated} 条`,
  });
  console.log(`[news] 完成 ✅ ${okSources}/${SOURCES.length} 源,新增 ${inserted} 条`);
}

main().catch(async (e) => {
  console.error('[news] 异常:', e);
  try { await insertRun({ kind: 'news', status: 'error', summary: String(e).slice(0, 500), finished_at: new Date().toISOString() }); } catch {}
  process.exit(1);
});
