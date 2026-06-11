// ============================================================
// run-daily.mjs — 每日编排:先 fetch-roster,再 fetch-ratings,
// 最后汇总写一条 douban_runs(kind='daily')。
// 供 launchd / GitHub Actions 调用。
// 子脚本被限速会以退出码 2 退出,这里捕获但继续后续步骤并标记 blocked。
// 用法: node scripts/run-daily.mjs
// ============================================================

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { insertRun } from './lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 运行一个子脚本,返回 {code, blocked}
function run(script) {
  return new Promise((resolve) => {
    console.log(`\n========== 运行 ${script} ==========`);
    const child = spawn(process.execPath, [join(__dirname, script)], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => resolve({ code: code ?? 1, blocked: code === 2 }));
  });
}

async function main() {
  const startedAt = new Date().toISOString();

  const roster = await run('fetch-roster.mjs');
  const ratings = await run('fetch-ratings.mjs');

  const blocked = roster.blocked || ratings.blocked;
  const hadError =
    (roster.code !== 0 && !roster.blocked) || (ratings.code !== 0 && !ratings.blocked);

  const summary =
    `roster=${roster.code === 0 ? 'ok' : roster.blocked ? 'blocked' : 'error'}, ` +
    `ratings=${ratings.code === 0 ? 'ok' : ratings.blocked ? 'blocked' : 'error'}`;

  await insertRun({
    kind: 'daily',
    status: blocked ? 'blocked' : hadError ? 'error' : 'ok',
    blocked,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    summary,
  });

  console.log('\n========== 今日汇总 ==========');
  console.log('片单(roster):', roster.code === 0 ? '完成' : roster.blocked ? '被限速' : '出错');
  console.log('评分(ratings):', ratings.code === 0 ? '完成' : ratings.blocked ? '被限速' : '出错');
  console.log('是否被豆瓣限速:', blocked ? '是 ⚠️(建议检查 cookie / 换住宅IP / 配代理)' : '否');
  console.log('================================');

  process.exit(blocked ? 2 : hadError ? 1 : 0);
}

main().catch((e) => {
  console.error('[daily] 编排异常:', e);
  process.exit(1);
});
