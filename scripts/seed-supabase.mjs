// ============================================================
// seed-supabase.mjs — 把 data/seed.json 灌入 Supabase douban_films。
// 幂等:已存在的影片不覆盖 status / note,只补 null 缺字段。
// 用法: node scripts/seed-supabase.mjs
// ============================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { selectFilms, upsertFilms, sb } from './lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(__dirname, '..', 'data', 'seed.json');
const TODAY = new Date().toISOString().slice(0, 10);
const BATCH = 500; // 每批 upsert 数量,避免单次请求过大

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function main() {
  const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
  console.log(`[seed] 读取 ${seed.length} 条`);

  // 取库里已存在的 id 集合,用于幂等(不覆盖已存在记录的 status/note)
  const existing = await selectFilms('select=id');
  const existingIds = new Set(existing.map((x) => x.id));
  console.log(`[seed] 库中已有 ${existingIds.size} 条`);

  const toInsert = []; // 全新影片
  for (const f of seed) {
    if (existingIds.has(String(f.sid))) continue; // 已存在 → 跳过,保护人工状态
    toInsert.push({
      id: String(f.sid),
      name: f.name,
      country: f.country ?? null,
      year: f.year ?? null,
      score: f.score ?? null,
      douban_url: f.link ?? `https://movie.douban.com/subject/${f.sid}/`,
      notion_page_id: f.page_id ?? null,
      status: f.status ?? '待筛',
      first_seen: TODAY,
    });
  }

  console.log(`[seed] 新增 ${toInsert.length} 条,跳过 ${seed.length - toInsert.length} 条已存在`);

  let inserted = 0;
  for (const part of chunk(toInsert, BATCH)) {
    // ignore-duplicates:并发场景下也安全,已存在不报错
    await upsertFilms(part, true);
    inserted += part.length;
    console.log(`[seed] 已写入 ${inserted}/${toInsert.length}`);
  }

  await sb('POST', 'douban_runs', {
    kind: 'seed',
    status: 'ok',
    new_films: inserted,
    finished_at: new Date().toISOString(),
    summary: `seed 导入完成,新增 ${inserted} 条`,
  });

  console.log('[seed] 完成 ✅');
}

main().catch((e) => {
  console.error('[seed] 失败:', e);
  process.exit(1);
});
