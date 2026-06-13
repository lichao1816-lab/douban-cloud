# 阿尔戈斯 · 全球电影情报站（douban-cloud）

面向**电影版权采购**的一站式情报系统：每天自动抓取全球电影数据，存进云端数据库，用一个网页随时随地查看。核心诉求是**第一时间拿到新片信息**（豆瓣新片、票房榜、行业资讯、电影节片单），而非事后做汇总报告。

- **查看端（手机/电脑随时看）**：https://lichao1816-lab.github.io/douban-cloud/
- **抓取端**：家里的 Mac mini 每天定时跑，住宅 IP 抓豆瓣不易被封。
- **数据库**：Supabase（云端 Postgres）。抓取端写入、查看端读取，互不依赖。

---

## 它能做什么（四大板块）

1. **🎬 豆瓣情报**：每日抓取豆瓣 2026/2027 新片，记录评分、5 星人数、短评数的逐日增量，支持按状态（待筛/⭐重点关注/保留/淘汰）、国家、评分筛选；保留/淘汰可在网页上直接点，实时写回云端。
2. **💰 全球票房**：抓 Box Office Mojo 约 80+ 个市场的最新周末票房 Top3，自动匹配豆瓣条目并补全豆瓣评分、IMDb 评分、片长、类型、导演主演。
3. **📰 媒体资讯**：抓一线行业媒体 RSS（Variety / Deadline / THR / IndieWire / TheWrap / ScreenDaily / Cineuropa / FilmNewEurope）+ 中文源（界面文娱 / 时光网），**英文自动机器翻译成中文**；带「🎯节展雷达」过滤，片单/入围/获奖类消息一键聚焦。
4. **🏆 电影节**：30 个全球重点电影节/奖项/市场的底库，含 2026 届期、**片单公布时间前瞻**（情报雷达），以及已闭幕节展的入围/获奖片单（戛纳/柏林/奥斯卡等已回填）。

---

## 启动方式

### 本地预览查看端（可选，调试用）
```
npm run serve
```
查看端是纯静态页面（index.html + app.js + styles.css + config.js），也可直接部署到任意静态托管。

### 手动跑一次抓取（需先配好 .env）
```
npm run daily        # 跑完整一轮：片单→评分→详情→票房→票房片详情→资讯+翻译
```
也可单独跑某一步：
```
npm run roster       # 抓豆瓣新片片单
npm run ratings      # 更新评分/5星/短评(5天一轮动)
npm run enrich       # 补豆瓣详情(国家/类型/导演/IMDb)
npm run boxoffice    # 抓全球票房榜
npm run bofilms      # 补票房榜影片的豆瓣/IMDb详情
npm run news         # 抓行业资讯 + 机器翻译
npm run festivals    # 灌/更新电影节底库(data/festivals.json)
npm run festfilms    # 灌/更新电影节入围片单(data/festival_films_2026.json)
npm run build:config # 由 .env 生成查看端 config.js
```

### 部署到 Mac mini（每天自动跑）
见 **`mac-mini保姆级步骤.md`**（小白版）或 **`SETUP-macmini.md`**。一句话流程：
```
git clone → 放 .env → bash setup-macmini.sh 09:00 → 防睡眠
```
立即手动触发一次：`launchctl start com.argos.douban.daily`
看实时日志：`tail -f logs/daily.out.log`

---

## 部署架构

```
 Mac mini(住宅IP)                Supabase(云端Postgres)         GitHub Pages(静态查看端)
 ┌───────────────┐  service_role  ┌──────────────────┐  anon key  ┌──────────────────┐
 │ launchd 每天   │ ─────写入────▶ │ douban_films     │ ◀───只读── │ index.html       │
 │ run-daily.mjs  │                │ boxoffice_entries│            │ app.js (原生JS)  │
 │ (Node 22+)     │                │ news_items       │  受限写★    │                  │
 └───────────────┘                │ festivals/_films │ ◀──status── │ 手机/电脑浏览器  │
                                   │ bo_films         │            └──────────────────┘
                                   └──────────────────┘
 ★查看端用 anon key 仅能改 douban_films 的 status/note 两列(用于点保留/淘汰)。
```

- **抓取与查看完全解耦**：抓取端挂了，查看端照常读历史数据；查看端不依赖任何后端服务器。
- **数据库是唯一真相源**：换任何一台机器跑抓取，连同一个 Supabase 即可，无需重新建表/灌数据。

---

## 依赖项

- **运行环境**：Node.js **22+**（mini 实测 v24 亦可）。
- **第三方 npm 包**：**零依赖**。全部用 Node 原生 `fetch` + 内置模块，`package.json` 的 dependencies 为空，mini 上无需 `npm install`。
- **外部服务**：
  - Supabase（免费版够用）——数据库。
  - 豆瓣 cookie——抓豆瓣需要登录态（几周~几月过期，需重取）。
  - 机器翻译：微软 Edge 翻译接口（免 key）为主，Google gtx 接口为备，均无需注册。
  - 数据源：Box Office Mojo（公开）、各媒体 RSS（公开）。
- **`.env` 必填项**（见 `.env.example` / `env-for-mini.txt`）：
  `SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`、`DOUBAN_COOKIE`、`DOUBAN_PROXY`(可空)。

---

## 关键文件

| 路径 | 作用 |
|---|---|
| `scripts/run-daily.mjs` | 每日编排：依次跑全部抓取步骤，写 daily 运行日志 |
| `scripts/lib.mjs` | 公共库：豆瓣请求/限速哨兵/HTML·RSS 解析/Supabase REST 封装 |
| `scripts/fetch-*.mjs` | 各数据源抓取脚本（roster/ratings/boxoffice/news） |
| `scripts/enrich-*.mjs` | 详情增强（豆瓣详情、票房片详情） |
| `scripts/seed-*.mjs` | 灌底库（影片种子、电影节、入围片单） |
| `app.js` / `index.html` / `styles.css` | 查看端（纯原生，无框架） |
| `supabase/schema.sql` + `schema2.sql` + `upgrade-v3.sql` | 数据库结构（按顺序执行；新库一次跑完即可） |
| `data/festivals.json` / `festival_films_2026.json` | 电影节底库与入围片单源数据 |
| `setup-macmini.sh` / `launchd/*.plist` | Mac mini 定时任务一键部署 |

---

## 维护提示

- **cookie 失效**：查看端顶部出现「⚠️被限速」或日志「哨兵未通过」→ 重取豆瓣 cookie，更新 `.env`，重跑 `bash setup-macmini.sh 时间`。
- **只让一台机器抓**：避免主力 Mac 与 mini 同时抓豆瓣（更易被限速）。
- **改抓取时间**：mini 上重跑 `bash setup-macmini.sh 新时间`，再按打印的 `pmset` 行设唤醒。
- **不要用 GitHub Actions 直接抓豆瓣**：机房 IP 会被封，抓取必须放住宅 IP 的 mini。
