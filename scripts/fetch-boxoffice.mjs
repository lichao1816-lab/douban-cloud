// ============================================================
// fetch-boxoffice.mjs — 全球票房:Box Office Mojo 各市场最新周末 Top3。
// 流程:/intl/ 列出 ~86 个市场的最新周末 → 逐市场抓周末榜取前3
//      → 片名搜豆瓣匹配链接 → upsert boxoffice_entries。
// BOM 是公开站(Amazon),节流温和即可;豆瓣匹配走 cookie 接口,节流照旧。
// 用法: node scripts/fetch-boxoffice.mjs
// ============================================================

import {
  fetchText, parseBomIntl, parseBomWeekendChart, doubanSuggest,
  sb, insertRun, pace,
} from './lib.mjs';

const BOM = 'https://www.boxofficemojo.com';
const BOM_PACE = [500, 800];
const MATCH_PACE = [900, 1300];

// BOM 市场英文名 → 中文
const MARKET_CN = {
  'Argentina':'阿根廷','Australia':'澳大利亚','Austria':'奥地利','Bahrain':'巴林','Bangladesh':'孟加拉国','Belgium':'比利时','Bolivia':'玻利维亚','Bosnia and Herzegovina':'波黑','Brazil':'巴西','Bulgaria':'保加利亚','Cambodia':'柬埔寨','Canada':'加拿大','Central America':'中美洲','Chile':'智利','China':'中国大陆','Colombia':'哥伦比亚','Costa Rica':'哥斯达黎加','Croatia':'克罗地亚','Cyprus':'塞浦路斯','Czech Republic':'捷克','Denmark':'丹麦','Dominican Republic':'多米尼加','Ecuador':'厄瓜多尔','Egypt':'埃及','El Salvador':'萨尔瓦多','Estonia':'爱沙尼亚','Finland':'芬兰','France':'法国','Germany':'德国','Ghana':'加纳','Greece':'希腊','Guatemala':'危地马拉','Honduras':'洪都拉斯','Hong Kong':'中国香港','Hungary':'匈牙利','Iceland':'冰岛','India':'印度','Indonesia':'印度尼西亚','Iraq':'伊拉克','Ireland':'爱尔兰','Israel':'以色列','Italy':'意大利','Jamaica':'牙买加','Japan':'日本','Jordan':'约旦','Kenya':'肯尼亚','Kuwait':'科威特','Laos':'老挝','Latvia':'拉脱维亚','Lebanon':'黎巴嫩','Lithuania':'立陶宛','Malaysia':'马来西亚','Mauritius':'毛里求斯','Mexico':'墨西哥','Middle East Other':'中东其他','Mongolia':'蒙古','Netherlands':'荷兰','New Zealand':'新西兰','Nicaragua':'尼加拉瓜','Nigeria':'尼日利亚','North Macedonia':'北马其顿','Norway':'挪威','Oman':'阿曼','Pakistan':'巴基斯坦','Palestine':'巴勒斯坦','Panama':'巴拿马','Paraguay':'巴拉圭','Peru':'秘鲁','Philippines':'菲律宾','Poland':'波兰','Portugal':'葡萄牙','Puerto Rico':'波多黎各','Qatar':'卡塔尔','Romania':'罗马尼亚','Russia/CIS':'俄罗斯/独联体','Russia':'俄罗斯','Saudi Arabia':'沙特阿拉伯','Serbia and Montenegro':'塞尔维亚和黑山','Singapore':'新加坡','Slovakia':'斯洛伐克','Slovenia':'斯洛文尼亚','South Africa':'南非','South Korea':'韩国','Spain':'西班牙','Sri Lanka':'斯里兰卡','Sweden':'瑞典','Switzerland':'瑞士','Taiwan':'中国台湾','Thailand':'泰国','Trinidad & Tobago':'特立尼达和多巴哥','Türkiye':'土耳其','Ukraine':'乌克兰','United Arab Emirates':'阿联酋','United Kingdom':'英国','Uruguay':'乌拉圭','Venezuela':'委内瑞拉','Vietnam':'越南',
};

async function main() {
  const startedAt = new Date().toISOString();
  console.log('[boxoffice] 抓取 BOM 市场列表...');
  const intlHtml = await fetchText(`${BOM}/intl/`);
  const markets = parseBomIntl(intlHtml);
  if (!markets.length) {
    console.error('[boxoffice] /intl/ 解析为空(BOM 可能改版)');
    await insertRun({ kind: 'boxoffice', status: 'error', finished_at: new Date().toISOString(), summary: 'BOM /intl/ 解析为空' });
    process.exit(1);
  }
  console.log(`[boxoffice] 共 ${markets.length} 个市场`);

  // 标题→豆瓣 的会话内缓存(同一片在多国上榜只搜一次)
  const matchCache = new Map();
  let rows = 0, marketsDone = 0;

  for (const mk of markets) {
    const marketCn = MARKET_CN[mk.market] || mk.market;
    const chartHtml = await fetchText(`${BOM}/weekend/${mk.week}/?area=${mk.code}`);
    await pace(...BOM_PACE);
    const top = parseBomWeekendChart(chartHtml, 3);
    if (!top.length) continue;

    const entries = [];
    for (const t of top) {
      let match = matchCache.get(t.title);
      if (match === undefined) {
        // 云端(GitHub Actions)跑时跳过豆瓣匹配(机房IP会被挡),由 mini 跑时补全
        match = process.env.SKIP_DOUBAN_MATCH === '1' ? null : await doubanSuggest(t.title);
        if (process.env.SKIP_DOUBAN_MATCH !== '1') await pace(...MATCH_PACE);
        matchCache.set(t.title, match);
      }
      const row = {
        market: marketCn, market_code: mk.code,
        period: mk.weekendLabel, rank: t.rank, title: t.title,
        weekend_gross: t.weekend_gross, total_gross: t.total_gross, weeks: t.weeks,
        fetched_at: new Date().toISOString(),
      };
      // 只有真正做了匹配才写 douban 字段;SKIP 模式下不带这两列,
      // 避免 upsert 把 mini 之前补好的匹配覆盖成空。
      if (process.env.SKIP_DOUBAN_MATCH !== '1') {
        row.douban_sid = match ? match.sid : null;
        row.douban_url = match ? match.url : null;
      }
      entries.push(row);
    }
    // upsert(market,period,rank 冲突则覆盖)
    await sb('POST', 'boxoffice_entries?on_conflict=market,period,rank', entries,
      { Prefer: 'resolution=merge-duplicates,return=minimal' });
    rows += entries.length;
    marketsDone++;
    if (marketsDone % 10 === 0) console.log(`[boxoffice] 已完成 ${marketsDone}/${markets.length} 市场`);
  }

  await insertRun({
    kind: 'boxoffice', status: 'ok',
    new_films: rows, started_at: startedAt, finished_at: new Date().toISOString(),
    summary: `市场 ${marketsDone},写入条目 ${rows}`,
  });
  console.log(`[boxoffice] 完成 ✅ ${marketsDone} 市场 ${rows} 条`);
}

main().catch(async (e) => {
  console.error('[boxoffice] 异常:', e);
  try { await insertRun({ kind: 'boxoffice', status: 'error', summary: String(e).slice(0, 500), finished_at: new Date().toISOString() }); } catch {}
  process.exit(1);
});
