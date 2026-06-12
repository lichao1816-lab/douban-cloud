// ============================================================
// fetch-news.mjs — 全球电影媒体资讯:一线行业媒体 RSS。
// 每天抓固定源的最新文章(标题/链接/摘要/时间),按 url 去重入库。
// 源挂掉只警告不中断。可按需在 SOURCES 增删。
// 用法: node scripts/fetch-news.mjs
// ============================================================

import { fetchText, parseRss, sb, insertRun, pace } from './lib.mjs';

const SOURCES = [
  { name: 'Variety',        url: 'https://variety.com/v/film/feed/' },
  { name: 'Deadline',       url: 'https://deadline.com/category/film/feed/' },
  { name: 'THR',            url: 'https://www.hollywoodreporter.com/topic/movies/feed/' },
  { name: 'IndieWire',      url: 'https://www.indiewire.com/c/film/feed/' },
  { name: 'TheWrap',        url: 'https://www.thewrap.com/category/movies/feed/' },
  { name: 'ScreenDaily',    url: 'https://www.screendaily.com/rss/news' },
  { name: 'Cineuropa',      url: 'https://cineuropa.org/rdf.aspx?lang=en' },
  { name: 'FilmNewEurope',  url: 'https://www.filmneweurope.com/news?format=feed&type=rss' },
  { name: '界面文娱',        url: 'https://a.jiemian.com/index.php?m=lists&a=rss&cid=4' },
  { name: 'Mtime时光网',     url: 'http://feed.mtime.com/news' },
];

async function main() {
  const startedAt = new Date().toISOString();
  let inserted = 0, okSources = 0;

  for (const s of SOURCES) {
    const xml = await fetchText(s.url, { Accept: 'application/rss+xml, application/xml, text/xml, */*' });
    await pace(300, 600);
    const items = parseRss(xml);
    if (!items.length) { console.warn(`[news] ${s.name} 无内容/抓取失败`); continue; }
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

  // 清理 30 天前的旧资讯,防表膨胀
  try {
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    await sb('DELETE', `news_items?fetched_at=lt.${cutoff}`, undefined, { Prefer: 'return=minimal' });
  } catch {}

  await insertRun({
    kind: 'news', status: okSources ? 'ok' : 'error',
    new_films: inserted, started_at: startedAt, finished_at: new Date().toISOString(),
    summary: `源 ${okSources}/${SOURCES.length} 正常,新入库 ${inserted} 条`,
  });
  console.log(`[news] 完成 ✅ ${okSources}/${SOURCES.length} 源,新增 ${inserted} 条`);
}

main().catch(async (e) => {
  console.error('[news] 异常:', e);
  try { await insertRun({ kind: 'news', status: 'error', summary: String(e).slice(0, 500), finished_at: new Date().toISOString() }); } catch {}
  process.exit(1);
});
