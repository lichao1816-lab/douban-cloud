# Mac mini 部署傻瓜教程（照着做就行）

这份教程面向**不写代码的人**。目标:让家里的 Mac mini 每天自动去豆瓣抓数据，存到云端，你用手机随时看。
全程大概 20 分钟。遇到任何一步卡住，把屏幕截图发出来问即可。

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

1. 在终端复制模板：
   ```
   cp .env.example .env
   ```
2. 用文本编辑器打开它：
   ```
   open -e .env
   ```
3. 把下面几项填上（等号后面换成真值，**不要加引号也不要留空格**）：
   - `SUPABASE_URL=` → Supabase 控制台 → ⚙️ Project Settings → API → **Project URL**
   - `SUPABASE_ANON_KEY=` → 同页面的 **anon public** key
   - `SUPABASE_SERVICE_ROLE_KEY=` → 同页面的 **service_role** key（保密！）
   - `DOUBAN_COOKIE=` → 粘贴第 3 步复制的**整段 cookie**
   - `DOUBAN_PROXY=` → **留空**即可（家里住宅 IP 不需要代理）
4. 保存（`Command + S`）关闭。

---

## 第 5 步：建数据库表（只做一次）

1. 打开 Supabase 控制台 → 左侧「**SQL Editor**」→ New query。
2. 用文本编辑器打开项目里的 `supabase/schema.sql`，**全选复制**，粘贴到 SQL Editor。
3. 点「**Run**」。看到成功提示即可。

---

## 第 6 步：灌入初始片单

终端里运行：
```
npm run seed
```
看到 `完成 ✅` 就好。这一步把 `data/seed.json`（八千多部片）导入了云端。

---

## 第 7 步：一键装定时任务

终端里运行：
```
bash setup-macmini.sh
```
脚本会自动：检查 Node、生成网页配置、把你的 .env 写进定时任务、装好「每天 10:30 自动抓」。
看到最后的 `部署完成 ✅` 就成功了。

**立刻测试一次**（不用等到明天 10:30）：
```
launchctl start com.argos.douban.daily
tail -f logs/daily.out.log
```
屏幕会滚动日志。看到 `今日汇总` 且 `是否被豆瓣限速: 否` 就一切正常。按 `Control + C` 退出查看。

---

## 第 8 步：设置“永不睡眠”（很重要）

电脑睡着了定时任务就不跑。二选一：

- **图形界面**：系统设置 →「电池」或「节能」→ 勾选「**防止电脑自动进入睡眠**」（接电源时）。
- **命令行（更稳，让它每天定时自己醒来）**：
  ```
  sudo pmset repeat wakeorpoweron MTWRFSU 10:25:00
  ```
  （每天 10:25 自动唤醒，留 5 分钟给 10:30 的任务；会要求输入开机密码。）

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
