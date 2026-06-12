// ============================================================
// seed-festivals.mjs — 把 data/festivals.json 灌入/更新 festivals 表(幂等)。
// 用法: node scripts/seed-festivals.mjs
// 入围片单(festival_films)由后续会话核实后另行写入。
// ============================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sb } from './lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const list = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'festivals.json'), 'utf8'));

const rows = list.map((f) => ({ ...f, updated_at: new Date().toISOString() }));
await sb('POST', 'festivals?on_conflict=id', rows,
  { Prefer: 'resolution=merge-duplicates,return=minimal' });
console.log(`[festivals] 已灌入/更新 ${rows.length} 个电影节/奖项/市场 ✅`);
