// ============================================================
// generate-config.mjs — 从 .env 生成前端用的 config.js。
// 只写 SUPABASE_URL 和 SUPABASE_ANON_KEY,【绝不】写 service_role。
// 用法: node scripts/generate-config.mjs
// ============================================================

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ENV_PATH = join(ROOT, '.env');
const OUT_PATH = join(ROOT, 'config.js');

// 极简 .env 解析(支持 KEY=VALUE,忽略注释/空行,去引号)
function parseEnv(text) {
  const env = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[k] = v;
  }
  return env;
}

// 优先 .env 文件,其次进程环境变量(CI 里没有 .env)
let env = {};
if (existsSync(ENV_PATH)) env = parseEnv(readFileSync(ENV_PATH, 'utf8'));
const URL = env.SUPABASE_URL || process.env.SUPABASE_URL || '';
const ANON = env.SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

if (!URL || !ANON) {
  console.error('[config] 缺少 SUPABASE_URL 或 SUPABASE_ANON_KEY(检查 .env)');
  process.exit(1);
}

const out =
`// 自动生成,请勿手改。由 scripts/generate-config.mjs 从 .env 产出。
// 仅含前端只读/受限写所需的 anon key,绝不含 service_role。
window.ARGOS_CONFIG = {
  SUPABASE_URL: ${JSON.stringify(URL)},
  SUPABASE_ANON_KEY: ${JSON.stringify(ANON)}
};
`;

writeFileSync(OUT_PATH, out, 'utf8');
console.log('[config] 已生成 config.js ✅');
