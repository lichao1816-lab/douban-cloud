# 阿尔戈斯计划 · 豆瓣电影情报云端

一套可部署的豆瓣电影情报系统:**家里的 Mac mini 每天定时抓豆瓣 → 存进 Supabase → 任何手机/电脑打开静态网页查看与筛选。**

## 架构

```
┌─────────────────┐      每天定时(launchd)        ┌──────────────────┐
│  Mac mini(家)  │  ───────────────────────────▶  │   豆瓣 movie.douban │
│  住宅 IP         │   Node 原生 fetch + cookie      └──────────────────┘
│  scripts/run-daily│                                          │ HTML/JSON
└────────┬─────────┘                                          ▼
         │ Supabase REST (service_role 写)         解析 star1..5 / 短评 / 总分
         ▼
┌─────────────────────────────┐
│  Supabase (Postgres)         │   表: douban_films / douban_runs
│  RLS: anon 只读 + 受限写状态  │
└────────┬────────────────────┘
         │ Supabase REST (anon key 读 + 受限写)
         ▼
┌─────────────────────────────┐
│  静态查看端 index/app/styles  │  → Cloudflare Pages / Vercel / GitHub Pages
│  手机优先,筛选/排序/保留淘汰  │
└─────────────────────────────┘
```

## 用途
- **新片发现**:每天按国家+年份(2026/2027)拉豆瓣近期热度片单,自动去重、剔除剧集/综艺/短片,新片入库标记「待筛」。
- **5 星轮动追踪**:对「保留」的片子分 5 组轮流抓详情页,记录每档星级绝对人数、短评数,算出**今日新增 5 星 / 今日新增短评**,看口碑爬升势头。
- **随时随地筛选**:手机打开网页,按年份/状态/国家/评分筛选排序,一键「保留 / 淘汰 / 恢复」写回云端。

## 目录结构
```
douban-cloud/
├── index.html  app.js  styles.css     # 静态查看端(部署到 Pages)
├── config.js                          # 由 .env 生成(git 忽略,含 anon key)
├── data/seed.json                     # 初始片单(已就位)
├── supabase/schema.sql                # 建表 + RLS,在 Supabase SQL Editor 执行
├── scripts/
│   ├── lib.mjs                        # 公共库:豆瓣请求/解析/限速哨兵/Supabase REST
│   ├── seed-supabase.mjs              # 灌初始数据(幂等)
│   ├── fetch-roster.mjs              # 每日新片
│   ├── fetch-ratings.mjs            # 5星轮动追踪
│   ├── run-daily.mjs                 # 编排(launchd/Actions 调用)
│   ├── generate-config.mjs           # 从 .env 生成 config.js
│   └── serve.mjs                     # 本地静态预览
├── launchd/com.argos.douban.daily.plist  # Mac mini 定时任务模板
├── setup-macmini.sh                  # Mac mini 一键部署
└── .github/workflows/               # 备用:Actions 抓取 + Pages 部署
```

## 快速开始

### 1. 建数据库
在 Supabase 控制台 → SQL Editor,整段执行 `supabase/schema.sql`。

### 2. 配环境变量
```bash
cp .env.example .env
# 编辑 .env,填入 Supabase 三个 key + 豆瓣 cookie(取法见 SETUP-macmini.md)
```
Supabase 的 key 在:控制台 → Project Settings → API。

### 3. 灌初始数据
```bash
npm run seed     # 读 data/seed.json,upsert 进 douban_films
```

### 4. 本地预览查看端
```bash
npm run serve    # 自动生成 config.js,开 http://localhost:8080
```

### 5. 手动跑一次抓取(可选)
```bash
npm run roster   # 拉新片
npm run ratings  # 抓评分
npm run daily    # 两者一起(定时任务跑的就是这个)
```

## 三种部署

### A. 抓取端 → Mac mini(★推荐)
住宅 IP,不易被封。详见 **SETUP-macmini.md**(面向非开发者的图文步骤)。一句话:
```bash
bash setup-macmini.sh   # 检查环境、生成 config、装 launchd 定时任务
```

### B. 抓取端 → GitHub Actions(备用)
`.github/workflows/douban-refresh.yml`,每天 cron 跑。
**⚠️ 机房 IP 抓豆瓣大概率被封**,必须在仓库 Secrets 里配 `DOUBAN_PROXY`(住宅代理),否则基本无效。仅作 Mac mini 离线时的备份。

### C. 查看端 → 静态托管(任选其一)
- **GitHub Pages**:`.github/workflows/deploy-pages.yml` 已就绪,Settings → Pages → Source 选 "GitHub Actions",配 `SUPABASE_URL` / `SUPABASE_ANON_KEY` 两个 Secret。
- **Cloudflare Pages / Vercel**:直接连仓库,Build command 留空或 `node scripts/generate-config.mjs`(把 `SUPABASE_URL`/`SUPABASE_ANON_KEY` 设为环境变量),输出目录为根目录。

## 依赖
- **Node 22+**(用其原生 fetch / undici)。
- **零第三方 npm 依赖**(代理走 Node 内置 undici 的 ProxyAgent)。`package.json` 的 dependencies 为空。

## 安全
- `service_role` key 只在抓取端用,**绝不进前端**;`config.js` 只含 `anon` key。
- `.env`、`config.js`、`logs/` 均被 `.gitignore` 忽略。
- 查看端的「保留/淘汰」写回是**简化方案**:RLS 允许 anon 仅更新 `status`/`note` 两列。公开访问场景建议加 Supabase Auth 登录,详见 schema.sql 注释。

## 已知边界(重要)
- **GitHub Actions 机房 IP 抓豆瓣大概率被封**。强烈推荐 Mac mini 住宅 IP;Actions 仅备用且需住宅代理。
- **豆瓣 cookie 会过期**(通常几周到几个月),失效后抓取会被限速。届时重新从浏览器取 cookie 填进 `.env`,重跑 `setup-macmini.sh`(或更新 Secret)即可。脚本带**哨兵检测**,一旦被限速会立即停止并在 `douban_runs` 记 `blocked=true`,查看端顶部会显示「⚠️被限速」。
- 短评数 / 星级百分比解析依赖豆瓣详情页 HTML 结构,豆瓣若改版需调整 `lib.mjs` 的 `parseSubjectRatings` 正则。
- `fetch-roster.mjs` 默认只覆盖主要产地国家(见文件顶部 `COUNTRIES` 常量),可按需增减或做轮换。
```
