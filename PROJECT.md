# PROJECT.md · 阿尔戈斯计划 技术总览

> 最后更新：2026-06-13。本文件面向接手开发/维护者，描述系统架构、已/未完成功能、数据库结构与未来计划。
> 配套文档：`README.md`(用法)、`PRD.md`(产品视角)、`mac-mini保姆级步骤.md`(部署)。

---

## 1. 系统架构

三层解耦，数据库为唯一真相源：

- **抓取层（Mac mini，住宅 IP）**：Node 22+，零第三方依赖。launchd 每天定时触发 `scripts/run-daily.mjs`，串行跑各抓取脚本，用 service_role key 写 Supabase。住宅 IP 是规避豆瓣反爬的关键。
- **数据层（Supabase / Postgres）**：6 张表（见 §4）。开启 RLS：anon 只读 + 仅可改 `douban_films.status/note`；service_role 绕过 RLS 全权写入。
- **展示层（GitHub Pages 静态站）**：`index.html + app.js + styles.css + config.js`，纯原生 JS 无框架无构建。用 anon key 直连 Supabase REST 读数据；点"保留/淘汰"用受限写回写状态。

**数据流**：mini 抓取 → 写 Supabase → 查看端按需读取渲染。两端互不依赖，任一端离线另一端照常工作。

**反爬与稳健性设计**：
- `lib.mjs` 的 `sentinelOk()` 哨兵：每个豆瓣脚本开工前先探测一次，被限速立即以退出码 2 退出，`run-daily` 标记 `blocked`。
- 带抖动的节流 `pace()`，仿浏览器请求头 + cookie。
- 评分抓取按 `sid % 5` 分 5 组轮动（`fetch-ratings`），每天只抓 1/5，5 天覆盖全库，降低单日请求量。
- 所有写库走 Supabase REST + `on_conflict` upsert，幂等可重跑。

---

## 2. 已完成功能

**抓取端**
- ✅ 豆瓣新片片单抓取（`fetch-roster`）：2026/2027，大陆/港/台全口径，类型过滤（剔剧集/综艺/短片）。
- ✅ 评分轮动追踪（`fetch-ratings`）：评分/各档星级人数/短评数，记录逐日增量 `d_*`。
- ✅ 豆瓣详情增强（`enrich-details`）：原名/全部国家/类型/导演/主演/片长/IMDb id 及评分。
- ✅ 全球票房（`fetch-boxoffice`）：BOM 80+ 市场最新周末 Top3，匹配豆瓣条目。
- ✅ 票房片详情缓存（`enrich-bofilms`，独立表 `bo_films`，不污染筛片库）：补豆瓣/IMDb/类型/主创。
- ✅ 媒体资讯（`fetch-news`）：8 个外媒 RSS + 界面/时光网 HTML 解析（RSS 接口已下线，改抓页面）；**英文标题/摘要机器翻译**（微软 Edge 主 + Google 备，增量补译）。
- ✅ 电影节底库（30 个）+ 入围/获奖片单回填（戛纳79届75部、柏林76届87部、奥斯卡98届35部，共197条）。
- ✅ 每日编排（`run-daily`）+ Mac mini 一键部署（`setup-macmini.sh`，支持自定义时间、自动算唤醒时间）。

**查看端**
- ✅ 四板块（豆瓣/票房/资讯/电影节）切换、各自筛选与搜索。
- ✅ 豆瓣板块状态流转（待筛↔重点关注↔保留↔淘汰）实时写回；年份/国家/排序/搜索；状态计数。
- ✅ 票房卡片对齐豆瓣卡片信息量（评分/IMDb/时长/类型/主创）。
- ✅ 资讯中文优先显示 + 🎯节展雷达过滤。
- ✅ 电影节 📡情报雷达（按 lineup_announce 列出"接下来要盯的片单节点"）。

---

## 3. 未完成 / 待办

- ⏳ **节展片单实时回填**：当前已闭幕的戛纳/柏林/奥斯卡已回填；进行中/临近的（上影节06-21、昂西06-27、翠贝卡06-14、卡罗维发利07-03、Fantasia、洛迦诺等）闭幕或公布后需逐个回填。这是产品最高价值点（版权买家要第一手），目前靠人工触发 Claude 回填，**未自动化**。
- ⏳ **festival_films 关联豆瓣条目**：入围片大多没 `douban_sid`，前端无法直接跳豆瓣/带评分。需做片名→豆瓣匹配（类似票房的 `doubanSuggest`）。
- ⏳ **资讯→节展雷达** 目前是前端关键词正则匹配，召回有限；可考虑抓取节展官网/专门栏目提升"片单公布"命中率。
- ⏳ **ScreenDaily RSS** 新地址未在沙盒验证成功（多端点疑似关闭），需看 mini 首次 daily 日志确认，必要时换源。
- ⏳ **国家标签** 增量片按"查询国"而非严格"第一出品国"（详情增强已纠正大部分；roster 阶段仍为查询国）。
- ⏳ **查看端写权限** 为自用简化方案（anon 可改 status/note）。若多人/公开访问需加 Supabase Auth 或 Edge Function。
- ⏳ **cookie 自动续期** 无方案，过期需人工重取（几周~几月一次）。

---

## 4. 数据库结构（Supabase / Postgres）

建表顺序：`schema.sql` → `schema2.sql` → `upgrade-v3.sql`（新库一次性跑完，幂等）。

**douban_films（筛片主库）** — 主键 `id`(豆瓣sid)
- 基础：`name, orig_name, country, countries, year, score, douban_url, status, note`
- 详情：`genres, directors, actors, duration, imdb_id, imdb_rating, detail_updated_at`
- 追踪：`star1..5` 当前各档星级人数、`prev_star1..5` 上次、`d_star1..5` 今日新增；`comments/prev_comments/d_comments`；`last_rating_update`
- 状态取值：`待筛 / 重点关注 / 保留 / 淘汰`
- RLS：anon 只读 + 仅可 UPDATE `status,note`

**douban_runs（运行日志）** — `kind`(roster/ratings/daily/news/boxoffice/bofilms/festivals)、`status`(ok/blocked/error)、`new_films/rated_films/summary/blocked/started_at/finished_at`。查看端读最新 daily 显示"更新于…"。

**boxoffice_entries（全球票房）** — 唯一键 `(market, period, rank)`；`market/market_code/period/rank/title/weekend_gross/total_gross/weeks/douban_sid/douban_url`。

**news_items（媒体资讯）** — 唯一键 `url`；`source/title/url/summary/published_at/fetched_at` + v3 增 `title_cn/summary_cn`(机翻)。保留近 30 天。

**festivals（电影节底库）** — 主键 `id`(slug)；`name/name_cn/tier(S/A/B)/kind(festival/award/market)/country/city/month_window/edition_2026/lineup_status/official_url/notes` + v3 增 `lineup_announce`(片单公布前瞻，★前缀=近期重点)。

**festival_films（入围/获奖片单）** — 唯一键 `(festival_id, edition, title)`；`festival_id/edition/section/title/orig_title/country/prize/douban_sid/douban_url` + v3 增 `director`。

**bo_films（票房片详情缓存，v3 新增）** — 主键 `sid`；`name/score/rating_people/imdb_id/imdb_rating/countries/genres/directors/actors/duration/douban_url/updated_at`。独立于筛片库，避免票房榜杂片污染筛选流。

所有新表 anon 只读；service_role 全权。

---

## 5. 未来计划（按价值排序）

1. **节展片单抓取自动化**：把"片单公布→入库"从人工触发变为 mini 每日自动巡检官网/媒体（这是版权买家最痛的点）。
2. **入围片豆瓣匹配 + 评分回填**：festival_films 补 douban_sid，前端可跳转、可带分。
3. **重点关注/保留清单的推送**：新片或评分异动时主动提醒（邮件/IM），而非每天上网页看。
4. **资讯雷达精准化**：针对各大节展建专门抓取源与关键词模型，提高"片单公布"召回。
5. **多人协作**：若引入团队筛片，加登录与权限，写操作收敛到 Edge Function。

---

## 6. 关键约束与坑（务必知晓）

- **豆瓣抓取只能在住宅 IP**（mini），机房 IP / GitHub Actions 会被封。
- **同一时间只让一台机器抓**，否则更易被限速。
- **沙盒/某些网络封 supabase.co 直连**：历史上用浏览器扩展导航到自己的 GitHub Pages 页、在页面内用 fetch + service key 分块写库绕过（仅维护时用）。
- **cookie 内含双引号/分号**：注入 plist 时是 XML 文本内容，安全；但手填 .env 时不要加引号。
- **查看端无构建**：改 app.js 直接生效，但依赖 config.js（由 `.env` 经 `build:config` 生成，已提交进仓库，只含 anon key，公开安全）。
