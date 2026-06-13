# Mac mini 部署傻瓜教程（照着做就行）

这份教程面向**不写代码的人**。目标:让家里的 Mac mini 每天自动去豆瓣抓数据，存到云端，你用手机随时看。
全程大概 15 分钟。遇到任何一步卡住，把屏幕截图发出来问即可。

> **重要前提（2026-06 更新）**：Supabase 是**云端同一个数据库**，主力 Mac 已经把表结构和全部数据（片库/节展/票房等）都建好灌好了。
> 所以 **mini 不需要重新建表、不需要 `npm run seed`、不需要灌节展**——它连的就是那个云库，只负责"每天抓新数据写进去"。
> 因此下面**跳过了原来的「建表」「灌种子」两步**。如果你看到老版教程里的第5/6步，忽略即可。
>
> 简版路线：装 Node → git clone 代码 → 填 .env → `bash setup-macmini.sh 时间` → 防睡眠。

---

## 准备清单
- 一台 **Mac mini**（或任何一直开着的 Mac），连着家里的网（住宅宽带，**不要**用公司/机房网络）。
- 一个 **Supabase** 账号和项目（免费版够用）。
- 你的**豆瓣账号**（用来取 cookie）。

---

## 第 1 步：装 Node（电脑的“运行环境”）

1. 打开「**终端**」App（按 `Command + 空格`，输入 `终端` 回车）。
2. 先看有没有装过，粘贴这行回车：
   ```
   node -v
   ```
   - 如果显示 `v22.x.x` 或更高 → 已经有了，跳到第 2 步。
   - 如果提示 `command not found` → 继续往下装。
3. 最简单的装法：去 https://nodejs.org ，下载 **LTS 版（22 或更高）** 的 `.pkg` 安装包，双击一路下一步装完。
4. 装完关掉终端再重开，再 `node -v` 确认能看到版本号。

---

## 第 2 步：拿到项目代码

**方法 A（推荐，能自动更新）：用 git 克隆**
```
cd ~
git clone 你的仓库地址 douban-cloud
cd douban-cloud
```

**方法 B（不会 git）：AirDrop / 拷贝**
把整个 `douban-cloud` 文件夹用 AirDrop 或 U 盘拷到 Mac mini 的「**用户主目录**」（就是「访达 → 前往 → 个人」那个家图标的地方）。
然后在终端里：
```
cd ~/douban-cloud
```

> 之后所有命令，都假设你已经 `cd` 进了这个文件夹。

---

## 第 3 步：从浏览器取「豆瓣 cookie」

cookie 就是豆瓣用来认得“是你登录”的一串字符。取法（用 Chrome 为例）：

1. 用电脑浏览器**登录豆瓣**（https://movie.douban.com ）。
2. 按 `F12`（Mac 上是 `Option + Command + I`）打开「开发者工具」。
3. 切到顶部的「**Network（网络）**」标签页。
4. **刷新一下豆瓣页面**（按 `Command + R`），下面会刷出一堆请求。
5. 在列表里**随便点一个 douban 的请求**（比如名字带 `movie.douban.com` 的）。
6. 右侧找到「**Headers（标头）**」→ 往下翻到「**Request Headers（请求标头）**」→ 找到 `Cookie:` 这一行。
7. 把 `Cookie:` **冒号后面那一整段**（很长，从 `bid=...` 开始到结尾）**全部选中复制**。

> 备选取法：开发者工具切到「**Application（应用）**」→ 左侧「Cookies」→ 选 `https://www.douban.com`，
> 里面是一条条 cookie。这种要自己拼，**不如上面整段拷贝省事**，建议用上面的方法。

把复制到的整段先存到记事本，下一步要用。

---

## 第 4 步：填写 .env（钥匙文件）

**最省事**：主力 Mac 上的 `阿尔戈斯计划/env-for-mini.txt` 里已经把三把 Supabase 密钥 + 豆瓣 cookie 全填好了。
直接把这个文件 **AirDrop 到 mini**，放进 `~/douban-cloud/` 目录，改名为 `.env` 即可（终端：`mv ~/Downloads/env-for-mini.txt ~/douban-cloud/.env`）。然后跳到第 6 步。

> ⚠️ cookie 有时效（几周~几月会过期）。本文件里的 cookie 是 2026-06 取的；若 mini 首跑日志出现「被限速/哨兵未通过」，按本文最后「cookie 失效怎么办」重取。

**手动填法**（不想 AirDrop 时）：
1. `cp .env.example .env` 然后 `open -e .env`
2. 填四项（等号后换真值，**不要加引号也不要留空格**）：
   - `SUPABASE_URL=` `SUPABASE_ANON_KEY=` `SUPABASE_SERVICE_ROLE_KEY=` → 见 env-for-mini.txt 或 Supabase 控制台 → Project Settings → API
   - `DOUBAN_COOKIE=` → 第 3 步复制的整段 cookie
   - `DOUBAN_PROXY=` → 留空（住宅 IP 不需要代理）
3. 保存关闭。

---

## 第 5 步：~~建表~~ + ~~灌种子~~ —— 跳过！

云库已由主力 Mac 建好灌满，mini **不用**再做。直接进第 6 步。

---

## 第 6 步：一键装定时任务（可自定义时间）

终端里运行（把 `09:00` 换成你想每天几点抓，24 小时制；不写则默认 10:30）：
```
bash setup-macmini.sh 09:00
```
脚本会自动：检查 Node、生成网页配置、把你的 .env 写进定时任务、按你给的时间装好「每天自动抓」。
看到最后的 `部署完成 ✅` 就成功了。

**立刻测试一次**（不用等到点）：
```
launchctl start com.argos.douban.daily
tail -f logs/daily.out.log
```
屏幕会滚动日志。看到 `今日汇总` 且 `是否被豆瓣限速: 否` 就一切正常。按 `Control + C` 退出查看。

> 这一跑会完整执行：抓片单 → 抓评分 → 详情增强 → 全球票房 → 票房片详情 → 媒体资讯(含自动翻译)。
> 即本对话新增的"票房卡片详情"和"资讯中文化"在 mini 上每天都会自动带上。

---

## 第 7 步：设置“永不睡眠”（很重要）

电脑睡着了定时任务就不跑。二选一：

- **图形界面**：系统设置 →「电池」或「节能」→ 勾选「**防止电脑自动进入睡眠**」（接电源时）。
- **命令行（更稳，让它每天定时自己醒来）**：脚本跑完会**直接打印**一行带正确时间的 `sudo pmset ...` 命令（已按你设的抓取时间自动减 5 分钟算好），复制那行执行、输入开机密码即可。
  例如设 09:00 抓，它会让你跑 `sudo pmset repeat wakeorpoweron MTWRFSU 08:55:00`。

---

## 第 8 步：主力 Mac 别再重复跑

mini 接管后，主力 Mac 上若也装过定时任务，请停掉，避免两台机器同时抓豆瓣（更容易被限速）：
```
launchctl unload ~/Library/LaunchAgents/com.argos.douban.daily.plist
```
（主力 Mac 没装过就忽略这步。）

---

## 怎么确认成功？
- 打开 Supabase → Table Editor → `douban_runs` 表，能看到一条 `kind=daily` 的记录、`blocked=false`。
- 打开你的查看端网页（部署后），顶部显示「更新于 …」且没有「⚠️被限速」。

---

## cookie 失效了怎么办？

豆瓣 cookie 过几周/几个月会过期，过期后抓取会「被限速」。表现：
- `douban_runs` 里出现 `blocked=true`，网页顶部显示「⚠️被限速」。
- 日志里出现「哨兵未通过」。

处理（5 分钟）：
1. 重做**第 3 步**，重新取一段新的豆瓣 cookie。
2. 打开 `.env`（`open -e .env`），把 `DOUBAN_COOKIE=` 后面换成新 cookie，保存。
3. 重新运行 `bash setup-macmini.sh`（它会用新 cookie 重装定时任务）。
4. `launchctl start com.argos.douban.daily` 测一次，确认 `被限速: 否`。

---

## 常用命令速查
```
# 立即手动跑一次
launchctl start com.argos.douban.daily

# 看实时日志
tail -f logs/daily.out.log

# 暂停定时任务
launchctl unload ~/Library/LaunchAgents/com.argos.douban.daily.plist

# 重新启用
launchctl load ~/Library/LaunchAgents/com.argos.douban.daily.plist
```
