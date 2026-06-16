// ============================================================
// enrich-details.mjs — 单片详情增强(只针对 重点关注/保留)。
// 对 detail_updated_at 为空的片:抓豆瓣详情页 → 解析
// 原名/全部国家/类型/导演/主演/片长/IMDb id → 再抓 IMDb 评分。
// 每天增量(你新筛一部,次日自动补全一部);单次上限防限速。
// 用法: node scripts/enrich-details.mjs
// ============================================================

import {
  doubanSubjectHtml, parseSubjectDetail, fetchImdbRating, parsePoster,
  selectFilms, updateFilm, insertRun, sentinelOk, pace,
} from './lib.mjs';

const DETAIL_PACE = [1300, 1800];
const MAX_PER_RUN = 60;   // 单次最多补多少片(防限速;积压会在后续天消化)

async function main() {
  const startedAt = new Date().toISOString();
  console.log('[enrich] 开始,哨兵检测...');
  if (!(await sentinelOk())) {
    await insertRun({ kind: 'enrich', status: 'blocked', blocked: true,
      finished_at: new Date().toISOString(), summary: '开跑前哨兵未通过' });
    process.exit(2);
  }

  const pending = await selectFilms(
    'status=in.(' + encodeURIComponent('重点关注,保留') + ')' +
    '&detail_updated_at=is.null&select=id,name,status'
  );
  // 重点关注优先
  pending.sort((a, b) => (a.status === '重点关注' ? -1 : 1) - (b.status === '重点关注' ? -1 : 1));
  const batch = pending.slice(0, MAX_PER_RUN);
  console.log(`[enrich] 待增强 ${pending.length} 片,本次处理 ${batch.length}`);

  let done = 0, blocked = false;
  for (const f of batch) {
    try {
      const html = await doubanSubjectHtml(f.id);
      await pace(...DETAIL_PACE);
      if (html == null) {
        if (!(await sentinelOk())) { blocked = true; console.warn('[enrich] 被限速,停止'); break; }
        continue;
      }
      const d = parseSubjectDetail(html, f.name);
      if (!d) continue;

      const patch = {
        orig_name: d.orig_name, countries: d.countries, genres: d.genres,
        directors: d.directors, actors: d.actors, duration: d.duration,
        imdb_id: d.imdb_id, poster_url: parsePoster(html),
        detail_updated_at: new Date().toISOString(),
      };
      if (d.score != null) patch.score = d.score;
      if (d.countries) patch.country = d.countries.split(' / ')[0]; // 顺手把第一出品国标准化

      if (d.imdb_id) {
        const ir = await fetchImdbRating(d.imdb_id).catch(() => null);
        await pace(600, 900);
        if (ir != null) patch.imdb_rating = ir;
      }

      await updateFilm(f.id, patch);
      done++;
      if (done % 10 === 0) console.log(`[enrich] 已增强 ${done}/${batch.length}`);
    } catch (e) {
      // 单部出错(网络抖动/解析异常)只跳过,不拖垮整步
      console.warn(`[enrich] ${f.id} 跳过(出错): ${String(e).slice(0, 80)}`);
    }
  }

  await insertRun({
    kind: 'enrich', status: blocked ? 'blocked' : 'ok', blocked,
    rated_films: done, started_at: startedAt, finished_at: new Date().toISOString(),
    summary: `待增强 ${pending.length},本次完成 ${done}${blocked ? '(中途被限速)' : ''}`,
  });
  console.log(`[enrich] 完成 ✅ 增强 ${done} 片,剩余积压 ${pending.length - done}`);
  if (blocked) process.exit(2);
}

main().catch(async (e) => {
  console.error('[enrich] 异常:', e);
  try { await insertRun({ kind: 'enrich', status: 'error', summary: String(e).slice(0, 500), finished_at: new Date().toISOString() }); } catch {}
  process.exit(1);
});
