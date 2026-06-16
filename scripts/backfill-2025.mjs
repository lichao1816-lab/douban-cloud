// ============================================================
// backfill-2025.mjs — 2025 全年存量补扫(国产+进口),后台慢扫、断点续传。
// 用进度表 backfill_2025(每地区一行)记录 pending/done,每次只扫几个地区,
// 挂在 run-daily 最后(最低优先级);被限速即停,pending 地区下次续扫。
// 每地区: 2025 年 × sort=S/R/T 并集 → 与库去重 → subject_abstract 类型过滤
//        → 写入 douban_films(待筛, year=2025)。
// 需先在 Supabase 跑 supabase/upgrade-v5.sql。
// 用法: node scripts/backfill-2025.mjs [本次扫几个地区,默认4]
// ============================================================

import {
  doubanGet, parseRoster, classifyAbstract,
  selectFilms, upsertFilms, sb, insertRun, sentinelOk, pace,
} from './lib.mjs';

// 地区清单(产量/重要度靠前在前,优先扫到高价值):国产 + 主要进口产地
const REGIONS = [
  '美国', '中国大陆', '中国香港', '中国台湾', '日本', '韩国', '英国', '法国',
  '德国', '意大利', '西班牙', '印度', '加拿大', '澳大利亚', '俄罗斯', '泰国',
  '巴西', '墨西哥', '阿根廷', '土耳其', '伊朗', '波兰', '瑞典', '丹麦',
  '挪威', '芬兰', '荷兰', '比利时', '瑞士', '奥地利', '葡萄牙', '希腊',
  '爱尔兰', '捷克', '匈牙利', '罗马尼亚', '乌克兰', '以色列', '埃及',
  '印度尼西亚', '菲律宾', '越南', '马来西亚', '新加坡', '哥伦比亚', '智利',
  '南非',
];
const REGIONS_PER_RUN = parseInt(process.argv[2], 10) || 4;
const YEAR = 2025;
const SORTS = ['S', 'R', 'T'];
const MAX_START = 280, PAGE_SIZE = 20;
const ROSTER_PACE = [700, 1000], ABSTRACT_PACE = [700, 1100];

function url(region, sort, start) {
  return 'https://movie.douban.com/j/new_search_subjects?' +
    `sort=${sort}&range=0,10&tags=&start=${start}&genres=&countries=${encodeURIComponent(region)}` +
    `&year_range=${YEAR},${YEAR}`;
}

async function ensureSeed() {
  const rows = REGIONS.map((r) => ({ region: r }));
  // ignore-duplicates: 已有(含 done)的地区不被重置
  await sb('POST', 'backfill_2025?on_conflict=region', rows,
    { Prefer: 'resolution=ignore-duplicates,return=minimal' });
}

async function main() {
  const startedAt = new Date().toISOString();
  await ensureSeed();
  const todo = await sb('GET',
    `backfill_2025?status=eq.pending&select=region&order=region&limit=${REGIONS_PER_RUN}`);
  if (!todo || !todo.length) { console.log('[bf2025] 全部地区已扫完 ✅'); return; }
  console.log(`[bf2025] 本次扫: ${todo.map((x) => x.region).join(' / ')}`);

  if (!(await sentinelOk())) { console.warn('[bf2025] 哨兵未过,跳过本次'); process.exit(2); }

  const existing = await selectFilms('select=id');
  const existingIds = new Set(existing.map((x) => x.id));
  const TODAY = new Date().toISOString().slice(0, 10);
  let blocked = false, totalAdded = 0;

  for (const { region } of todo) {
    if (blocked) break;
    const found = new Map();
    region_scan:
    for (const sort of SORTS) {
      for (let start = 0; start <= MAX_START; start += PAGE_SIZE) {
        const json = await doubanGet(url(region, sort, start), { json: true });
        await pace(...ROSTER_PACE);
        if (json == null) {
          if (!(await sentinelOk())) { blocked = true; console.warn(`[bf2025] ${region} 被限速,停止`); break region_scan; }
          continue;
        }
        const list = parseRoster(json);
        if (!list.length) break;
        for (const it of list) {
          if (existingIds.has(it.sid) || found.has(it.sid)) continue;
          found.set(it.sid, { sid: it.sid, title: it.title });
        }
      }
    }
    if (blocked) break;

    const rows = [];
    for (const it of found.values()) {
      if (blocked) break;
      const aj = await doubanGet(`https://movie.douban.com/j/subject_abstract?subject_id=${it.sid}`, { json: true });
      await pace(...ABSTRACT_PACE);
      if (aj) { const r = classifyAbstract(aj); if (!r.isMovie) continue; }
      rows.push({
        id: it.sid, name: it.title, country: region, year: YEAR, status: '待筛',
        douban_url: `https://movie.douban.com/subject/${it.sid}/`, first_seen: TODAY,
      });
      existingIds.add(it.sid);
    }
    for (let i = 0; i < rows.length; i += 200) await upsertFilms(rows.slice(i, i + 200), true);
    totalAdded += rows.length;
    if (!blocked) {
      await sb('PATCH', `backfill_2025?region=eq.${encodeURIComponent(region)}`,
        { status: 'done', found: found.size, inserted: rows.length, updated_at: new Date().toISOString() },
        { Prefer: 'return=minimal' });
      console.log(`[bf2025] ${region} 完成: 候选 ${found.size},入库 ${rows.length}`);
    }
  }

  const left = await sb('GET', 'backfill_2025?status=eq.pending&select=region');
  await insertRun({
    kind: 'backfill2025', status: blocked ? 'blocked' : 'ok', blocked,
    new_films: totalAdded, started_at: startedAt, finished_at: new Date().toISOString(),
    summary: `2025补扫 本次入库 ${totalAdded},剩余地区 ${left ? left.length : '?'}${blocked ? '(被限速,下次续)' : ''}`,
  });
  console.log(`[bf2025] 本次完成 ✅ 入库 ${totalAdded},剩余地区 ${left ? left.length : '?'}`);
  if (blocked) process.exit(2);
}

main().catch(async (e) => {
  console.error('[bf2025] 异常:', e);
  try { await insertRun({ kind: 'backfill2025', status: 'error', summary: String(e).slice(0, 500), finished_at: new Date().toISOString() }); } catch {}
  process.exit(1);
});
