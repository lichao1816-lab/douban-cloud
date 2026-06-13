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

// 自动同步代码:每天抓取前先 git pull --ff-only,让 mini 用上最新脚本。
// 带 120s 超时,失败/超时只跳过(不阻塞当天抓取)。注意:本次拉到的新版
// run-daily.mjs 要到"下一次"运行才生效(当前进程已载入内存)。
function gitPull() {
  const root = join(__dirname, '..');
  return new Promise((resolve) => {
    console.log('\n========== 同步代码 (git pull) ==========');
    let done = false;
    const child = spawn('git', ['-C', root, 'pull', '--ff-only'], { stdio: 'inherit' });
    const timer = setTimeout(() => {
      if (!done) { console.warn('[git] pull 超时(120s),跳过,用现有代码继续'); child.kill('SIGKILL'); }
    }, 120000);
    child.on('exit', (code) => {
      done = true; clearTimeout(timer);
      console.log(code === 0 ? '[git] 代码已是最新/已同步 ✅' : `[git] pull 未成功(code ${code}),跳过,用现有代码继续`);
      resolve();
    });
    child.on('error', (e) => {
      done = true; clearTimeout(timer);
      console.warn(`[git] 无法执行 git(${String(e).slice(0, 60)}),跳过`);
      resolve();
    });
  });
}

async function main() {
  const startedAt = new Date().toISOString();

  await gitPull();

  const roster = await run('fetch-roster.mjs');
  const ratings = await run('fetch-ratings.mjs');
  const enrich = await run('enrich-details.mjs');
  const festfilms = await run('seed-festival-films.mjs');     // 节展片单:把 data/festival_films_2026.json 灌入(在线,不碰豆瓣)
  const festmatch = await run('match-festival-douban.mjs');   // 节展片豆瓣匹配(走豆瓣,故放在 mini 的豆瓣步骤组里)
  const boxoffice = await run('fetch-boxoffice.mjs');
  const bofilms = await run('enrich-bofilms.mjs');
  const news = await run('fetch-news.mjs');

  const blocked = roster.blocked || ratings.blocked || enrich.blocked || bofilms.blocked || festmatch.blocked;
  const hadError =
    (roster.code !== 0 && !roster.blocked) || (ratings.code !== 0 && !ratings.blocked) ||
    (enrich.code !== 0 && !enrich.blocked) || boxoffice.code !== 0 ||
    (bofilms.code !== 0 && !bofilms.blocked) || news.code !== 0 ||
    festfilms.code !== 0 || (festmatch.code !== 0 && !festmatch.blocked);

  const st = (r) => (r.code === 0 ? 'ok' : r.blocked ? 'blocked' : 'error');
  const summary =
    `roster=${st(roster)}, ratings=${st(ratings)}, enrich=${st(enrich)}, ` +
    `festfilms=${st(festfilms)}, festmatch=${st(festmatch)}, ` +
    `boxoffice=${st(boxoffice)}, bofilms=${st(bofilms)}, news=${st(news)}`;

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
  console.log('详情增强(enrich):', enrich.code === 0 ? '完成' : enrich.blocked ? '被限速' : '出错');
  console.log('节展片单(festfilms):', festfilms.code === 0 ? '完成' : '出错');
  console.log('节展豆瓣匹配(festmatch):', festmatch.code === 0 ? '完成' : festmatch.blocked ? '被限速' : '出错');
  console.log('全球票房(boxoffice):', boxoffice.code === 0 ? '完成' : '出错');
  console.log('票房片详情(bofilms):', bofilms.code === 0 ? '完成' : bofilms.blocked ? '被限速' : '出错');
  console.log('媒体资讯(news):', news.code === 0 ? '完成' : '出错');
  console.log('是否被豆瓣限速:', blocked ? '是 ⚠️(建议检查 cookie / 换住宅IP / 配代理)' : '否');
  console.log('================================');

  process.exit(blocked ? 2 : hadError ? 1 : 0);
}

main().catch((e) => {
  console.error('[daily] 编排异常:', e);
  process.exit(1);
});
