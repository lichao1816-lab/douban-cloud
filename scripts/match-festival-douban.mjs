// ============================================================
// match-festival-douban.mjs — 给 festival_films 入围/获奖片匹配豆瓣条目+评分。
// 对 douban_sid 为空的行:用片名(优先 orig_title,其次 title)搜豆瓣 suggest,
// 取候选后抓详情页校验【年份近(2024-2027)或导演名片段命中或原名包含】才落库,
// 防止同名老片误匹配。命中则写 douban_sid/douban_url/douban_score/douban_rating_people
// /imdb_rating/douban_matched_at;未命中只记 douban_matched_at(占位,下次不重复死磕)。
// 增量:douban_matched_at 为空者优先;已匹配到 sid 的不再动。
// 需先在 Supabase 跑 supabase/upgrade-v4.sql(加评分列)。
// 用法: node scripts/match-festival-douban.mjs [上限]   例: node scripts/match-festival-douban.mjs 80
// ============================================================

import {
  doubanSuggest, doubanSubjectHtml, parseSubjectDetail, parseSubjectRatings,
  fetchImdbRating, sentinelOk, sb, insertRun, pace,
} from './lib.mjs';

const MAX_PER_RUN = parseInt(process.argv[2], 10) || 60; // 每次最多匹配多少部
const RECENT_YEARS = new Set(['2024', '2025', '2026', '2027']);

// 从详情页 HTML 取上映/制作年份(标题旁 <span class="year">(2026)</span>)
function yearOf(html) {
  if (!html) return null;
  const m = html.match(/<span class="year">\((\d{4})\)<\/span>/);
  return m ? m[1] : null;
}

// 把导演串拆成可比对的名字片段(按 / , & 空格分),保留长度≥2的拉丁/中文片段
function nameTokens(s) {
  if (!s) return [];
  return s.split(/[\/,&]| and /i)
    .map((x) => x.trim().toLowerCase())
    .flatMap((x) => x.split(/\s+/))
    .filter((x) => x.length >= 2);
}

// 校验候选是否可信:年份近 OR 导演片段命中 OR 原名/详情里出现我方英文名
function isPlausible({ html, detail, wantTitle, wantOrig, wantDirector }) {
  const y = yearOf(html);
  if (y && RECENT_YEARS.has(y)) return true;
  const dDir = (detail.directors || '').toLowerCase();
  const wantTok = nameTokens(wantDirector);
  if (wantTok.some((t) => dDir.includes(t))) return true;
  const hay = ((detail.orig_name || '') + ' ' + (html.match(/property="v:itemreviewed"[^>]*>([^<]+)</)?.[1] || '')).toLowerCase();
  for (const cand of [wantOrig, wantTitle]) {
    if (cand && cand.length >= 4 && hay.includes(cand.toLowerCase())) return true;
  }
  return false; // 年份是老片且导演/原名都对不上 → 判为同名误匹配,弃
}

async function main() {
  const startedAt = new Date().toISOString();

  // 优先没匹配过的(douban_matched_at is null),其次留给重试
  const rows = await sb('GET',
    'festival_films?douban_sid=is.null&douban_matched_at=is.null' +
    '&select=id,title,orig_title,director,country,edition&order=id&limit=' + MAX_PER_RUN);
  if (!rows || !rows.length) { console.log('[festmatch] 没有待匹配的行(全部已尝试或已匹配)'); return; }
  console.log(`[festmatch] 本次尝试 ${rows.length} 部`);

  if (!(await sentinelOk())) { console.warn('[festmatch] 哨兵未过(被限速?),跳过本次'); process.exit(2); }

  let matched = 0, attempted = 0;
  for (const r of rows) {
    attempted++;
    const queries = [...new Set([r.orig_title, r.title].filter(Boolean))];
    let hit = null;
    for (const q of queries) {
      const cand = await doubanSuggest(q).catch(() => null);
      await pace(700, 1100);
      if (!cand) continue;
      const html = await doubanSubjectHtml(cand.sid);
      await pace(900, 1300);
      if (!html) continue;
      const detail = parseSubjectDetail(html) || {};
      const ratings = parseSubjectRatings(html) || {};
      if (!isPlausible({ html, detail, wantTitle: r.title, wantOrig: r.orig_title, wantDirector: r.director })) continue;
      let imdbRating = null;
      if (detail.imdb_id) { imdbRating = await fetchImdbRating(detail.imdb_id).catch(() => null); await pace(400, 700); }
      hit = {
        douban_sid: cand.sid,
        douban_url: cand.url,
        douban_score: ratings.ratingNum ?? detail.score ?? null,
        douban_rating_people: ratings.ratingPeople ?? null,
        imdb_rating: imdbRating,
        douban_matched_at: new Date().toISOString(),
      };
      break;
    }
    const patch = hit || { douban_matched_at: new Date().toISOString() };
    await sb('PATCH', `festival_films?id=eq.${r.id}`, patch, { Prefer: 'return=minimal' })
      .then(() => { if (hit) matched++; })
      .catch((e) => console.warn(`[festmatch] id=${r.id} 写入失败:`, e.message.slice(0, 100)));
    if (attempted % 10 === 0) console.log(`[festmatch] 进度 ${attempted}/${rows.length},已命中 ${matched}`);
  }

  await insertRun({
    kind: 'festmatch', status: 'ok', new_films: matched,
    started_at: startedAt, finished_at: new Date().toISOString(),
    summary: `节展片豆瓣匹配:尝试 ${attempted},命中 ${matched}`,
  });
  console.log(`[festmatch] 完成 ✅ 尝试 ${attempted},命中 ${matched}`);
}

main().catch(async (e) => {
  console.error('[festmatch] 异常:', e);
  try { await insertRun({ kind: 'festmatch', status: 'error', summary: String(e).slice(0, 500), finished_at: new Date().toISOString() }); } catch {}
  process.exit(1);
});
