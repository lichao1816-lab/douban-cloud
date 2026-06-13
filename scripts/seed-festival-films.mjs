// ============================================================
// seed-festival-films.mjs — 把 data/festival_films_2026.json 灌入/更新
// festival_films 表(幂等,冲突键 festival_id+edition+title 合并)。
// 需先在 Supabase 执行过 supabase/backfill-festivals-2026.sql 顶部的
// alter(director 列)。用法: node scripts/seed-festival-films.mjs
// ============================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sb } from './lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const list = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'festival_films_2026.json'), 'utf8'));

const rows = list.map((r) => ({
  festival_id: r.festival_id, edition: r.edition, section: r.section,
  title: r.title, orig_title: r.orig_title, country: r.country,
  director: r.director ?? null, prize: r.prize,
  douban_sid: r.douban_sid ?? null, douban_url: r.douban_url ?? null,
}));

// 分批 100 条,避免单请求过大
for (let i = 0; i < rows.length; i += 100) {
  await sb('POST', 'festival_films?on_conflict=festival_id,edition,title', rows.slice(i, i + 100),
    { Prefer: 'resolution=merge-duplicates,return=minimal' });
  console.log(`[festfilms] ${Math.min(i + 100, rows.length)}/${rows.length}`);
}
console.log(`[festfilms] 已灌入/更新 ${rows.length} 条入围/获奖记录 ✅`);
