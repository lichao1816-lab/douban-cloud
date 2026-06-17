// ============================================================
// fetch-ratings.mjs — 5星轮动追踪。
// 从 douban_films 取 status='保留' 的集合,按 sid%5 == dayOfYear%5 选今日组,
// 逐片抓详情页,解析 star1..5 / comments / 总分;
// 把旧值写入 prev_*,算今日新增 d_*,更新 last_rating_update。
// 节流(1.2~1.6s)+ 哨兵 + 可中断(已更新过今天的跳过)+ 被限速即停记录。
// 用法: node scripts/fetch-ratings.mjs
// ============================================================

import {
  doubanGet, parseSubjectRatings, parseSubjectDetail, parsePoster, fetchImdbRating,
  selectFilms, updateFilm, insertRun, sentinelOk, pace, dayOfYear, sb,
} from './lib.mjs';

const RATING_PACE = [1200, 1600];

// 今日轮动组:把保留片按 sid 末位分 2 组,每天跑一组(约 1/2 全量,2天一整轮)
function isTodaysGroup(sid) {
  const n = parseInt(String(sid).replace(/\D/g, '').slice(-6) || '0', 10);
  return n % 2 === dayOfYear() % 2;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log('[ratings] 开始,哨兵检测...');
  if (!(await sentinelOk())) {
    await insertRun({
      kind: 'ratings', status: 'blocked', blocked: true,
      finished_at: new Date().toISOString(), summary: '开跑前哨兵未通过,疑似被限速',
    });
    console.error('[ratings] 被限速,停止');
    process.exit(2);
  }

  // 取追踪片:重点关注(每天必查,排前优先) + 保留(2天轮动)
  const keep = await selectFilms(
    'status=in.(' + encodeURIComponent('重点关注,保留') + ')' +
    '&select=id,name,status,star1,star2,star3,star4,star5,comments,last_rating_update'
  );
  const focus = keep.filter((f) => f.status === '重点关注');
  const kept  = keep.filter((f) => f.status === '保留' && isTodaysGroup(f.id));
  const today = [...focus, ...kept];
  console.log(`[ratings] 重点关注 ${focus.length} 片(每日) + 保留今日组 ${kept.length} 片`);

  let rated = 0, blocked = false, skipped = 0;
  const TODAY = todayStr();

  for (const f of today) {
    // 可中断:今天已更新过的跳过(脚本重跑不重复抓)
    if (f.last_rating_update && String(f.last_rating_update).slice(0, 10) === TODAY) {
      skipped++;
      continue;
    }

    const html = await doubanGet(`https://movie.douban.com/subject/${f.id}/`);
    await pace(...RATING_PACE);

    if (html == null) {
      if (!(await sentinelOk())) {
        blocked = true;
        console.warn(`[ratings] ${f.name} 失败且哨兵未过 → 被限速,停止`);
        break;
      }
      continue; // 偶发失败,跳过
    }

    const r = parseSubjectRatings(html);
    // 若整页都没解析出星级,跳过(未开分或页面异常)
    if (r.star5 == null && r.comments == null && r.ratingNum == null) {
      continue;
    }

    // 计算今日新增(旧值缺失时 d 记 null)
    const d = (cur, prev) => (cur != null && prev != null ? cur - prev : null);

    const patch = {
      // 把上一次的当前值搬到 prev_*
      prev_star1: f.star1 ?? null, prev_star2: f.star2 ?? null,
      prev_star3: f.star3 ?? null, prev_star4: f.star4 ?? null,
      prev_star5: f.star5 ?? null, prev_comments: f.comments ?? null,
      // 新的当前值
      star1: r.star1, star2: r.star2, star3: r.star3, star4: r.star4, star5: r.star5,
      comments: r.comments,
      // 今日新增
      d_star1: d(r.star1, f.star1), d_star2: d(r.star2, f.star2),
      d_star3: d(r.star3, f.star3), d_star4: d(r.star4, f.star4),
      d_star5: d(r.star5, f.star5), d_comments: d(r.comments, f.comments),
      last_rating_update: new Date().toISOString(),
    };
    if (r.ratingNum != null) patch.score = r.ratingNum;
    if (r.country) patch.country = r.country;

    // 同页顺手解析:IMDb 评分 + 海报(让保留/重点片的双评分与海报随追踪一起刷新)
    const det = parseSubjectDetail(html) || {};
    const poster = parsePoster(html);
    if (poster) patch.poster_url = poster;
    if (det.imdb_id) {
      patch.imdb_id = det.imdb_id;
      const ir = await fetchImdbRating(det.imdb_id).catch(() => null);
      await pace(400, 700);
      if (ir != null) patch.imdb_rating = ir;
    }

    await updateFilm(f.id, patch);

    // 每日快照:写一行进 rating_history(同 sid+同日 覆盖),供前端画多日五星走势曲线。
    // 失败不影响主流程(快照表可能还没建)。
    try {
      await sb(
        'POST',
        'rating_history?on_conflict=sid,snap_date',
        [{
          sid: String(f.id), snap_date: TODAY,
          star1: r.star1 ?? null, star2: r.star2 ?? null, star3: r.star3 ?? null,
          star4: r.star4 ?? null, star5: r.star5 ?? null,
          comments: r.comments ?? null, score: r.ratingNum ?? null,
        }],
        { Prefer: 'resolution=merge-duplicates,return=minimal' },
      );
    } catch (e) {
      if (rated === 0) console.warn('[ratings] 快照写入失败(rating_history 是否已建?):', String(e).slice(0, 120));
    }

    rated++;
    if (rated % 10 === 0) console.log(`[ratings] 已更新 ${rated} 片`);
  }

  await insertRun({
    kind: 'ratings',
    status: blocked ? 'blocked' : 'ok',
    blocked,
    rated_films: rated,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    summary: `今日组 ${today.length},更新 ${rated},跳过(已更新)${skipped}${blocked ? '(中途被限速)' : ''}`,
  });

  console.log(`[ratings] 完成 ✅ 更新 ${rated} 片${blocked ? '(被限速提前结束)' : ''}`);
  if (blocked) process.exit(2);
}

main().catch(async (e) => {
  console.error('[ratings] 异常:', e);
  try {
    await insertRun({ kind: 'ratings', status: 'error', summary: String(e).slice(0, 500), finished_at: new Date().toISOString() });
  } catch {}
  process.exit(1);
});
