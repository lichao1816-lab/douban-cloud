// ============================================================
// backfill.mjs — 一次性补扫指定国家/地区的 2026+2027 存量片。
// 用法: node scripts/backfill.mjs            (默认 大陆/香港/台湾)
//      node scripts/backfill.mjs 中国香港 中国台湾   (自定义地区)
// 策略: 每地区×年份按 sort=S/R/T 三序并集(各最多 300 条,start≤280),
//      与库内去重 → subject_abstract 类型过滤 → 写入(待筛)。
//      节流 + 哨兵,被限速即停(已写入的保留,重跑可断点续传——
//      因为写入用 ignore-duplicates,且去重基于库内全量)。
// ============================================================

import {
  doubanGet, parseRoster, classifyAbstract,
  selectFilms, upsertFilms, insertRun, sentinelOk, pace,
} from './lib.mjs';

const REGIONS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['中国大陆', '中国香港', '中国台湾'];
const YEARS = [2026, 2027];
const SORTS = ['S', 'R', 'T'];
const MAX_START = 280;           // 豆瓣单 sort 上限约 300(start≤280)
const PAGE_SIZE = 20;
const ROSTER_PACE = [700, 1000];
const ABSTRACT_PACE = [700, 1100];

function url(region, year, sort, start) {
  const c = encodeURIComponent(region);
  return (
    'https://movie.douban.com/j/new_search_subjects?' +
    `sort=${sort}&range=0,10&tags=&start=${start}&genres=&countries=${c}` +
    `&year_range=${year},${year}`
  );
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`[backfill] 地区: ${REGIONS.join(' / ')} × 年份: ${YEARS.join('/')}`);
  console.log('[backfill] 哨兵检测...');
  if (!(await sentinelOk())) {
    await insertRun({
      kind: 'backfill', status: 'blocked', blocked: true,
      finished_at: new Date().toISOString(), summary: '开跑前哨兵未通过',
    });
    process.exit(2);
  }

  const existing = await selectFilms('select=id');
  const existingIds = new Set(existing.map((x) => x.id));
  console.log(`[backfill] 库中已有 ${existingIds.size} 条`);

  const TODAY = new Date().toISOString().slice(0, 10);
  const found = new Map();
  let blocked = false;

  outer:
  for (const region of REGIONS) {
    for (const year of YEARS) {
      let regionYearNew = 0;
      for (const sort of SORTS) {
        for (let start = 0; start <= MAX_START; start += PAGE_SIZE) {
          const json = await doubanGet(url(region, year, sort, start), { json: true });
          await pace(...ROSTER_PACE);
          if (json == null) {
            if (!(await sentinelOk())) {
              blocked = true;
              console.warn(`[backfill] ${region}/${year}/${sort} 失败且哨兵未过 → 被限速,停止抓取`);
              break outer;
            }
            continue;
          }
          const list = parseRoster(json);
          if (!list.length) break; // 此 sort 无更多
          for (const it of list) {
            if (existingIds.has(it.sid) || found.has(it.sid)) continue;
            found.set(it.sid, { sid: it.sid, title: it.title, country: region, year });
            regionYearNew++;
          }
        }
      }
      console.log(`[backfill] ${region}/${year}: 累计候选新片 ${regionYearNew} 条`);
    }
  }

  console.log(`[backfill] 候选合计 ${found.size} 条,开始类型过滤(每条约1秒,请耐心)...`);

  const rows = [];
  let checked = 0;
  for (const it of found.values()) {
    if (blocked) break;
    const aurl = `https://movie.douban.com/j/subject_abstract?subject_id=${it.sid}`;
    const json = await doubanGet(aurl, { json: true });
    await pace(...ABSTRACT_PACE);
    checked++;
    if (checked % 20 === 0) console.log(`[backfill] 已过滤 ${checked}/${found.size},存活 ${rows.length}`);
    if (json) {
      const r = classifyAbstract(json);
      if (!r.isMovie) continue;
    } // 拿不到摘要时保守保留
    rows.push({
      id: it.sid,
      name: it.title,
      country: it.country,
      year: it.year,
      status: '待筛',
      douban_url: `https://movie.douban.com/subject/${it.sid}/`,
      first_seen: TODAY,
    });
  }

  let inserted = 0;
  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    await upsertFilms(rows.slice(i, i + BATCH), true);
    inserted += Math.min(BATCH, rows.length - i);
    console.log(`[backfill] 已写入 ${inserted}/${rows.length}`);
  }

  await insertRun({
    kind: 'backfill',
    status: blocked ? 'blocked' : 'ok',
    blocked,
    new_films: inserted,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    summary: `补扫 ${REGIONS.join('/')}: 候选 ${found.size},入库 ${inserted}${blocked ? '(中途被限速,可重跑续传)' : ''}`,
  });

  console.log(`[backfill] 完成 ✅ 新增 ${inserted} 条${blocked ? '(中途被限速,稍后重跑可续传)' : ''}`);
}

main().catch((e) => {
  console.error('[backfill] 失败:', e);
  process.exit(1);
});
