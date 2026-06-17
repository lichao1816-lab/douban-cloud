// ============================================================
// backfill-posters.mjs — 一次性:给【重点关注 / 保留】里还没海报的片补海报。
// 背景:存量片 detail_updated_at 已非空,日常 enrich 不会重抓;海报跟着评分轮动
//   才会补(重点次日、保留2天)。本脚本一次性把这两个列表的缺海报片立刻抓全,
//   顺手补 imdb_id / imdb_rating(若缺)。
// 只抓 poster_url 为空的片;节流 + 哨兵 + 被限速即停。
// 用法: node scripts/backfill-posters.mjs            (重点关注+保留)
//       node scripts/backfill-posters.mjs 重点关注    (只跑某个状态)
// ============================================================

import {
  doubanGet, parseSubjectDetail, parsePoster, fetchImdbRating,
  selectFilms, updateFilm, insertRun, sentinelOk, pace,
} from './lib.mjs';

const PACE = [1100, 1500];
const statusArg = process.argv[2];
const STATUSES = statusArg ? [statusArg] : ['重点关注', '保留'];

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`[posters] 开始,目标状态: ${STATUSES.join('、')}`);
  if (!(await sentinelOk())) {
    console.error('[posters] 哨兵未过(被限速?),停止'); process.exit(2);
  }

  const inList = '(' + encodeURIComponent(STATUSES.join(',')) + ')';
  // 只取没海报的(poster_url is null)
  const films = await selectFilms(
    `status=in.${inList}&poster_url=is.null&select=id,name,status,imdb_id,imdb_rating`,
  );
  console.log(`[posters] 缺海报待补 ${films.length} 片`);
  if (!films.length) { console.log('[posters] 无需补,结束 ✅'); return; }

  let done = 0, gotPoster = 0, blocked = false;
  for (const f of films) {
    const html = await doubanGet(`https://movie.douban.com/subject/${f.id}/`);
    await pace(...PACE);
    if (html == null) {
      if (!(await sentinelOk())) { blocked = true; console.warn('[posters] 被限速,停止'); break; }
      continue;
    }

    const patch = {};
    const poster = parsePoster(html);
    if (poster) { patch.poster_url = poster; gotPoster++; }

    const det = parseSubjectDetail(html) || {};
    if (det.imdb_id && !f.imdb_id) {
      patch.imdb_id = det.imdb_id;
      if (f.imdb_rating == null) {
        const ir = await fetchImdbRating(det.imdb_id).catch(() => null);
        await pace(400, 700);
        if (ir != null) patch.imdb_rating = ir;
      }
    }

    if (Object.keys(patch).length) await updateFilm(f.id, patch);
    done++;
    if (done % 20 === 0) console.log(`[posters] 进度 ${done}/${films.length},已补海报 ${gotPoster}`);
  }

  await insertRun({
    kind: 'posters', status: blocked ? 'blocked' : 'ok', blocked,
    new_films: gotPoster, started_at: startedAt, finished_at: new Date().toISOString(),
    summary: `补海报:处理 ${done}/${films.length},补到海报 ${gotPoster}${blocked ? '(中途被限速)' : ''}`,
  });
  console.log(`[posters] 完成 ✅ 处理 ${done},补到海报 ${gotPoster}${blocked ? '(被限速提前结束,可再跑一次续上)' : ''}`);
  if (blocked) process.exit(2);
}

main().catch(async (e) => {
  console.error('[posters] 异常:', e);
  try { await insertRun({ kind: 'posters', status: 'error', summary: String(e).slice(0, 500), finished_at: new Date().toISOString() }); } catch {}
  process.exit(1);
});
