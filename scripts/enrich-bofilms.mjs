// ============================================================
// enrich-bofilms.mjs — 票房榜影片详情缓存。
// 全球票房榜匹配到的 douban_sid,多数不在筛片库(douban_films)里,
// 前端卡片因此没有评分/类型/主创。本脚本把这些 sid 的豆瓣详情
// 抓一份存到独立的 bo_films 表(不污染筛片库),前端关联展示。
// 需先在 Supabase 跑 supabase/upgrade-v3.sql 建表。
// 增量:已有且 7 天内更新过的 sid 跳过;在 douban_films 里的也跳过。
// 用法: node scripts/enrich-bofilms.mjs   (已并入 npm run daily)
// ============================================================

import {
  doubanSubjectHtml, parseSubjectDetail, parseSubjectRatings,
  fetchImdbRating, sentinelOk, sb, insertRun, pace,
} from './lib.mjs';

const FRESH_DAYS = 7;
const MAX_PER_RUN = 60; // 每次最多抓多少部,防止首跑过久

async function main() {
  const startedAt = new Date().toISOString();

  // 1. 最新票房条目里的全部 douban_sid
  const entries = await sb('GET',
    'boxoffice_entries?douban_sid=not.is.null&select=douban_sid,title,fetched_at&order=fetched_at.desc&limit=2000');
  const sids = [...new Set((entries || []).map((e) => e.douban_sid))];
  if (!sids.length) { console.log('[bofilms] 票房表暂无已匹配的 douban_sid'); return; }

  // 2. 排除:筛片库已有的 + bo_films 里 7 天内新鲜的
  const inLib = new Set();
  for (let i = 0; i < sids.length; i += 100) {
    const part = sids.slice(i, i + 100);
    const rows = await sb('GET', `douban_films?id=in.(${part.join(',')})&select=id`);
    (rows || []).forEach((r) => inLib.add(r.id));
  }
  let fresh = new Set();
  try {
    const cutoff = new Date(Date.now() - FRESH_DAYS * 86400000).toISOString();
    const rows = await sb('GET', `bo_films?updated_at=gt.${cutoff}&select=sid`);
    fresh = new Set((rows || []).map((r) => r.sid));
  } catch (e) {
    console.error('[bofilms] 读取 bo_films 失败(表不存在?请先跑 supabase/upgrade-v3.sql)');
    throw e;
  }
  const todo = sids.filter((s) => !inLib.has(s) && !fresh.has(s)).slice(0, MAX_PER_RUN);
  console.log(`[bofilms] sid 共 ${sids.length},筛片库已有 ${inLib.size},新鲜 ${fresh.size},本次抓 ${todo.length}`);
  if (!todo.length) return;

  // 3. 哨兵检测,被限速则不开工
  if (!(await sentinelOk())) { console.warn('[bofilms] 哨兵未过,跳过本次'); process.exit(2); }

  let done = 0;
  for (const sid of todo) {
    const html = await doubanSubjectHtml(sid);
    await pace(900, 1300);
    if (!html) continue;
    const d = parseSubjectDetail(html) || {};
    const r = parseSubjectRatings(html) || {};
    const nameM = html.match(/property="v:itemreviewed"[^>]*>([^<]+)</);
    let imdbRating = null;
    if (d.imdb_id) {
      imdbRating = await fetchImdbRating(d.imdb_id).catch(() => null);
      await pace(400, 700);
    }
    const row = {
      sid,
      name: nameM ? nameM[1].trim() : null,
      score: r.ratingNum ?? d.score ?? null,
      rating_people: r.ratingPeople ?? null,
      imdb_id: d.imdb_id, imdb_rating: imdbRating,
      countries: d.countries, genres: d.genres,
      directors: d.directors, actors: d.actors, duration: d.duration,
      douban_url: `https://movie.douban.com/subject/${sid}/`,
      updated_at: new Date().toISOString(),
    };
    await sb('POST', 'bo_films?on_conflict=sid', [row],
      { Prefer: 'resolution=merge-duplicates,return=minimal' })
      .then(() => done++)
      .catch((e) => console.warn(`[bofilms] ${sid} 写入失败:`, e.message.slice(0, 100)));
    if (done % 10 === 0 && done) console.log(`[bofilms] 已完成 ${done}/${todo.length}`);
  }

  await insertRun({
    kind: 'bofilms', status: 'ok', new_films: done,
    started_at: startedAt, finished_at: new Date().toISOString(),
    summary: `票房片详情:本次补 ${done}/${todo.length}`,
  });
  console.log(`[bofilms] 完成 ✅ ${done} 部`);
}

main().catch(async (e) => {
  console.error('[bofilms] 异常:', e);
  try { await insertRun({ kind: 'bofilms', status: 'error', summary: String(e).slice(0, 500), finished_at: new Date().toISOString() }); } catch {}
  process.exit(1);
});
