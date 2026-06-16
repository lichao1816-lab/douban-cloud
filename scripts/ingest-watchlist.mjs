// ============================================================
// ingest-watchlist.mjs — 把网页端自助添加的监测片(watchlist 表)并入 douban_films。
// 对每条 ingested=false:
//   · 库里已有该 sid → 直接把状态改成 desired_status(重点关注/保留)
//   · 库里没有 → 抓豆瓣详情页,补全 name/原名/国家/年份/豆瓣分/IMDb/海报 后入库
// 然后标记 watchlist.ingested=true。入库后 fetch-ratings 次日起自动追踪。
// 需先在 Supabase 跑 supabase/upgrade-v5.sql。并入 run-daily(在 ratings 之前)。
// 用法: node scripts/ingest-watchlist.mjs
// ============================================================

import {
  doubanSubjectHtml, parseSubjectDetail, parseSubjectRatings, parsePoster, parseYear,
  fetchImdbRating, sb, insertRun, sentinelOk, pace,
} from './lib.mjs';

async function main() {
  const startedAt = new Date().toISOString();
  let pending;
  try {
    pending = await sb('GET', 'watchlist?ingested=eq.false&select=sid,douban_url,desired_status,note,source');
  } catch (e) {
    console.error('[watchlist] 读取失败(表不存在?请先跑 supabase/upgrade-v5.sql)'); throw e;
  }
  if (!pending || !pending.length) { console.log('[watchlist] 无待并入项'); return; }
  console.log(`[watchlist] 待并入 ${pending.length} 条`);

  if (!(await sentinelOk())) { console.warn('[watchlist] 哨兵未过,跳过本次'); process.exit(2); }

  const TODAY = new Date().toISOString().slice(0, 10);
  let added = 0, switched = 0;
  for (const w of pending) {
    const sid = String(w.sid).trim();
    if (!/^\d+$/.test(sid)) { await mark(sid); continue; }
    const status = w.desired_status === '保留' ? '保留' : '重点关注';
    try {
      const exist = await sb('GET', `douban_films?id=eq.${sid}&select=id`);
      if (exist && exist.length) {
        await sb('PATCH', `douban_films?id=eq.${sid}`, { status }, { Prefer: 'return=minimal' });
        switched++; await mark(sid); continue;
      }
      const html = await doubanSubjectHtml(sid);
      await pace(900, 1300);
      if (!html) { console.warn(`[watchlist] ${sid} 抓取失败,留待下次`); continue; }
      const det = parseSubjectDetail(html) || {};
      const rat = parseSubjectRatings(html) || {};
      const nameM = html.match(/property="v:itemreviewed"[^>]*>([^<]+)</);
      const name = (nameM ? nameM[1].trim().split(' ')[0] : null) || ('豆瓣' + sid);
      let imdbRating = null;
      if (det.imdb_id) { imdbRating = await fetchImdbRating(det.imdb_id).catch(() => null); await pace(400, 700); }
      const row = {
        id: sid, name,
        orig_name: det.orig_name,
        country: (det.countries || '').split(' / ')[0] || null,
        countries: det.countries, year: parseYear(html),
        score: rat.ratingNum ?? det.score ?? null,
        genres: det.genres, directors: det.directors, actors: det.actors,
        duration: det.duration, imdb_id: det.imdb_id, imdb_rating: imdbRating,
        poster_url: parsePoster(html),
        status, note: w.note || null,
        douban_url: `https://movie.douban.com/subject/${sid}/`,
        first_seen: TODAY, detail_updated_at: new Date().toISOString(),
      };
      await sb('POST', 'douban_films?on_conflict=id', [row],
        { Prefer: 'resolution=merge-duplicates,return=minimal' });
      added++; await mark(sid);
      console.log(`[watchlist] +${name} (${status})`);
    } catch (e) {
      console.warn(`[watchlist] ${sid} 处理失败:`, String(e).slice(0, 90));
    }
  }

  await insertRun({
    kind: 'watchlist', status: 'ok', new_films: added,
    started_at: startedAt, finished_at: new Date().toISOString(),
    summary: `自助监测:新增入库 ${added},已有改状态 ${switched}`,
  });
  console.log(`[watchlist] 完成 ✅ 新增 ${added},改状态 ${switched}`);
}

async function mark(sid) {
  try { await sb('PATCH', `watchlist?sid=eq.${encodeURIComponent(sid)}`, { ingested: true }, { Prefer: 'return=minimal' }); } catch {}
}

main().catch(async (e) => {
  console.error('[watchlist] 异常:', e);
  try { await insertRun({ kind: 'watchlist', status: 'error', summary: String(e).slice(0, 500), finished_at: new Date().toISOString() }); } catch {}
  process.exit(1);
});
