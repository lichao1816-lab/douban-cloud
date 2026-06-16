// ============================================================
// backfill-2025-loop.mjs — 2025补扫"持续模式":反复跑 backfill-2025,
// 直到所有地区扫完。利用常开的 Mac mini 尽快扫完 2025。
// 自带退避:被豆瓣限速(子脚本退出码2)则等更久再续;正常则短间隔继续。
// 用法: npm run backfill2025:loop   (或 node scripts/backfill-2025-loop.mjs [每轮地区数])
// 一次性手动跑,开着终端让它自己滚;Ctrl+C 可随时停,进度已存表,下次接着来。
// ============================================================

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sb } from './lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BATCH = parseInt(process.argv[2], 10) || 6;
const SLEEP_OK = 15 * 60 * 1000;       // 正常:15分钟后续下一批
const SLEEP_BLOCKED = 45 * 60 * 1000;  // 被限速:等45分钟再试

function runOnce() {
  return new Promise((res) => {
    const c = spawn(process.execPath, [join(__dirname, 'backfill-2025.mjs'), String(BATCH)],
      { stdio: 'inherit', env: process.env });
    c.on('exit', (code) => res(code ?? 1));
  });
}

async function pendingCount() {
  try { const r = await sb('GET', 'backfill_2025?status=eq.pending&select=region'); return r ? r.length : -1; }
  catch { return -1; }
}

async function main() {
  console.log(`[bf2025-loop] 持续补扫启动,每轮 ${BATCH} 地区。开着别关,Ctrl+C 可随时停(进度已存,可续)。`);
  for (;;) {
    const code = await runOnce();
    const left = await pendingCount();
    if (left === 0) { console.log('[bf2025-loop] 🎉 2025 全部地区已扫完,退出。'); break; }
    const wait = code === 2 ? SLEEP_BLOCKED : SLEEP_OK;
    console.log(`[bf2025-loop] 剩余地区 ${left < 0 ? '?' : left},${Math.round(wait / 60000)} 分钟后继续…`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

main().catch((e) => { console.error('[bf2025-loop] 异常:', e); process.exit(1); });
