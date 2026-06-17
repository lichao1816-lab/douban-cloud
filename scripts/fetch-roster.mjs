// ============================================================
// fetch-roster.mjs — 每日增量新片。
// 对 2026 / 2027,各国按 sort=R(近期热度)拉前若干页,
// 与库内已有 id 去重,新 id 逐条做 subject_abstract 类型过滤
// (剔剧集/综艺/≤60min短片,留电影/纪录/演唱会),写入 douban_films(待筛)。
// 节流 + 哨兵 + 被限速即停并记 douban_runs(blocked=true)。
// 用法: node scripts/fetch-roster.mjs
// ============================================================

import {
  doubanGet, parseRoster, classifyAbstract,
  selectFilms, upsertFilms, insertRun, sentinelOk, pace, sleep,
} from './lib.mjs';

// ---------- 配置(与项目口径一致;在此调整即可)----------
const YEARS = [2026, 2027];

// ★全口径(李超 06-16 定):覆盖所有有进口片的国家,一个不漏。
// 注:豆瓣 countries 参数用中文国名。中国大陆/香港/台湾全部收录(06-11)。
//
// 策略:核心产地每天都扫;长尾小国按 dayOfYear 分 ROTATION_DAYS 批轮换,
// 每天只扫其中一批 —— 全库去重保证延迟几天入库也不会漏,只是稍晚出现在"待筛"。
const CORE_COUNTRIES = [
  '美国', '中国大陆', '中国香港', '中国台湾', '日本', '韩国',
  '英国', '法国', '德国', '意大利', '西班牙', '印度',
  '加拿大', '澳大利亚', '巴西', '泰国', '俄罗斯', '墨西哥', '阿根廷',
];

const ROTATION_COUNTRIES = [
  '瑞典', '丹麦', '挪威', '芬兰', '冰岛', '荷兰', '比利时', '瑞士', '奥地利', '葡萄牙',
  '希腊', '波兰', '捷克', '匈牙利', '罗马尼亚', '爱尔兰', '乌克兰', '塞尔维亚', '克罗地亚', '保加利亚',
  '斯洛伐克', '爱沙尼亚', '拉脱维亚', '立陶宛', '格鲁吉亚', '印度尼西亚', '菲律宾', '越南', '马来西亚', '新加坡',
  '柬埔寨', '以色列', '伊朗', '土耳其', '沙特阿拉伯', '埃及', '摩洛哥', '阿联酋', '黎巴嫩', '南非',
  '尼日利亚', '塞内加尔', '突尼斯', '智利', '哥伦比亚', '秘鲁', '乌拉圭', '哈萨克斯坦', '蒙古', '孟加拉国',
  '巴基斯坦', '斯里兰卡', '尼泊尔',
];

const ROTATION_DAYS = 4;   // 长尾分 4 批,每个小国约每 4 天扫一次

function dayOfYear(d = new Date()) {
  const start = Date.UTC(d.getFullYear(), 0, 0);
  const now = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.floor((now - start) / 86400000);
}

// 当天实际要扫的国家 = 全部核心 + 当天轮到的那批长尾
const rotationBatch = ROTATION_COUNTRIES.filter(
  (_, i) => i % ROTATION_DAYS === dayOfYear() % ROTATION_DAYS,
);
const COUNTRIES = [...CORE_COUNTRIES, ...rotationBatch];

const PAGES_PER = 3;       // 每个 (国家,年份) 拉的页数
const PAGE_SIZE = 20;      // 豆瓣每页 20 条
const ROSTER_PACE = [600, 900];      // 片单请求节流
const ABSTRACT_PACE = [700, 1100];   // 详情过滤请求节流

// 搜索 API:按国家+年份+热度排序拉片单
function rosterUrl(country, year, start) {
  const c = encodeURIComponent(country);
  return (
    'https://movie.douban.com/j/new_search_subjects?' +
    `sort=R&range=0,10&tags=&start=${start}&genres=&countries=${c}` +
    `&year_range=${year},${year}`
  );
}

// 条目类型过滤:用 subject_abstract 接口(轻量 JSON)
async function isMovie(sid) {
  const url = `https://movie.douban.com/j/subject_abstract?subject_id=${sid}`;
  const json = await doubanGet(url, { json: true });
  if (!json) return { ok: true, reason: 'abstract-fail-keep' }; // 拿不到摘要时保守保留
  const r = classifyAbstract(json);
  return { ok: r.isMovie, reason: r.reason };
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`[roster] 开始(全口径轮换):核心 ${CORE_COUNTRIES.length} 国 + 今日长尾批 ${rotationBatch.length} 国 = ${COUNTRIES.length} 国`);
  console.log(`[roster] 今日长尾批: ${rotationBatch.join('、') || '(无)'}`);
  console.log('[roster] 哨兵检测...');
  if (!(await sentinelOk())) {
    await insertRun({
      kind: 'roster', status: 'blocked', blocked: true,
      finished_at: new Date().toISOString(), summary: '开跑前哨兵未通过,疑似被限速',
    });
    console.error('[roster] 被限速,停止');
    process.exit(2);
  }

  // 库内现有 id 集合(去重)
  const existing = await selectFilms('select=id');
  const existingIds = new Set(existing.map((x) => x.id));
  console.log(`[roster] 库中已有 ${existingIds.size} 条`);

  const TODAY = new Date().toISOString().slice(0, 10);
  const found = new Map();   // sid -> {sid,title,country,year}
  let blocked = false;

  outer:
  for (const year of YEARS) {
    for (const country of COUNTRIES) {
      for (let p = 0; p < PAGES_PER; p++) {
        const json = await doubanGet(rosterUrl(country, year, p * PAGE_SIZE), { json: true });
        await pace(...ROSTER_PACE);

        if (json == null) {
          // 一次失败 → 复查哨兵,确认是否被封
          if (!(await sentinelOk())) {
            blocked = true;
            console.warn(`[roster] ${country}/${year} 失败且哨兵未过 → 被限速,停止`);
            break outer;
          }
          continue; // 偶发失败,跳过本页
        }
        const list = parseRoster(json);
        if (!list.length) break; // 该国该年没有更多
        for (const it of list) {
          if (existingIds.has(it.sid) || found.has(it.sid)) continue;
          found.set(it.sid, { sid: it.sid, title: it.title, country, year });
        }
      }
    }
  }

  console.log(`[roster] 候选新片 ${found.size} 条,开始类型过滤...`);

  // 逐条过滤类型(剧集/综艺/短片剔除)
  const rows = [];
  let checked = 0;
  for (const it of found.values()) {
    if (blocked) break;
    const verdict = await isMovie(it.sid);
    await pace(...ABSTRACT_PACE);
    checked++;
    if (checked % 20 === 0) console.log(`[roster] 已过滤 ${checked}/${found.size}`);

    if (!verdict.ok) continue; // 非电影,剔除
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

  // 写入(已存在则忽略)
  let inserted = 0;
  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    await upsertFilms(rows.slice(i, i + BATCH), true);
    inserted += Math.min(BATCH, rows.length - i);
  }

  await insertRun({
    kind: 'roster',
    status: blocked ? 'blocked' : 'ok',
    blocked,
    new_films: inserted,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    summary: `候选 ${found.size},入库新片 ${inserted}${blocked ? '(中途被限速)' : ''}`,
  });

  console.log(`[roster] 完成 ✅ 新增 ${inserted} 条${blocked ? '(被限速提前结束)' : ''}`);
  if (blocked) process.exit(2);
}

main().catch(async (e) => {
  console.error('[roster] 异常:', e);
  try {
    await insertRun({ kind: 'roster', status: 'error', summary: String(e).slice(0, 500), finished_at: new Date().toISOString() });
  } catch {}
  process.exit(1);
});
