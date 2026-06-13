#!/usr/bin/env bash
# ============================================================
# 阿尔戈斯计划 · Mac mini 一键部署脚本
# 作用:检查 node、装依赖(若有)、生成 config.js、
#       把 .env 注入 launchd plist 并装载、提示防睡眠设置。
# 用法:在项目根目录执行  bash setup-macmini.sh
# ============================================================
set -euo pipefail

# 切到脚本所在目录(= 项目根目录)
cd "$(dirname "$0")"
ROOT="$(pwd)"
echo "项目目录: $ROOT"

# ---------- 0. 解析定时时间(可选参数 HH:MM,默认 10:30) ----------
RUN_TIME="${1:-10:30}"
if ! echo "$RUN_TIME" | grep -Eq '^[0-2]?[0-9]:[0-5][0-9]$'; then
  echo "❌ 时间格式应为 HH:MM(24小时制),例如 09:00。你传的是: $RUN_TIME"
  exit 1
fi
RUN_HOUR=$((10#$(echo "$RUN_TIME" | cut -d: -f1)))   # 去前导0转十进制
RUN_MIN=$((10#$(echo "$RUN_TIME" | cut -d: -f2)))
echo "✅ 每日抓取时间设为: $(printf '%02d:%02d' "$RUN_HOUR" "$RUN_MIN")"
# 唤醒时间 = 抓取前 5 分钟
WAKE_TOTAL=$(( RUN_HOUR*60 + RUN_MIN - 5 )); [ "$WAKE_TOTAL" -lt 0 ] && WAKE_TOTAL=$((WAKE_TOTAL+1440))
WAKE_HM="$(printf '%02d:%02d:00' $((WAKE_TOTAL/60)) $((WAKE_TOTAL%60)))"

# ---------- 1. 检查 Node ----------
if ! command -v node >/dev/null 2>&1; then
  echo "❌ 没找到 node。请先安装 Node 22:"
  echo "   推荐用 Homebrew:  brew install node@22"
  echo "   或到 https://nodejs.org 下载安装包。"
  exit 1
fi
NODE_BIN="$(command -v node)"
NODE_VER="$(node -v)"
echo "✅ Node: $NODE_VER  ($NODE_BIN)"
case "$NODE_VER" in
  v2[2-9]*|v[3-9][0-9]*) : ;;  # >=22 OK
  *) echo "⚠️ 需要 Node 22+,当前 $NODE_VER,建议升级。" ;;
esac

# ---------- 2. .env 检查 ----------
if [ ! -f .env ]; then
  echo "❌ 未找到 .env。请先复制模板并填写:"
  echo "   cp .env.example .env  然后用文本编辑器填入密钥和豆瓣 cookie。"
  exit 1
fi
echo "✅ 找到 .env"

# ---------- 3. 安装依赖(本项目零第三方依赖,有则装)----------
if grep -q '"dependencies": {[^}]' package.json 2>/dev/null; then
  echo "→ 安装 npm 依赖..."
  npm install
else
  echo "✅ 无第三方依赖,跳过 npm install"
fi

# ---------- 4. 生成前端 config.js ----------
echo "→ 生成 config.js..."
node scripts/generate-config.mjs

# ---------- 5. 准备日志目录 ----------
mkdir -p logs

# ---------- 6. 读取 .env 值,注入 launchd plist ----------
# 极简读取(忽略注释,取 = 右边,去引号)
getenv () { grep -E "^$1=" .env | head -1 | sed -E "s/^$1=//; s/^[\"']//; s/[\"']\$//"; }
SUPA_URL="$(getenv SUPABASE_URL)"
SUPA_SR="$(getenv SUPABASE_SERVICE_ROLE_KEY)"
SUPA_AN="$(getenv SUPABASE_ANON_KEY)"
DB_COOKIE="$(getenv DOUBAN_COOKIE)"
DB_PROXY="$(getenv DOUBAN_PROXY)"

PLIST_SRC="launchd/com.argos.douban.daily.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.argos.douban.daily.plist"

echo "→ 生成 launchd plist 到 $PLIST_DST"
# 用 python 做安全替换(避免 sed 对特殊字符/路径出错)
python3 - "$PLIST_SRC" "$PLIST_DST" "$NODE_BIN" "$ROOT" \
  "$SUPA_URL" "$SUPA_SR" "$SUPA_AN" "$DB_COOKIE" "$DB_PROXY" "$RUN_HOUR" "$RUN_MIN" <<'PY'
import sys
src,dst,node,root,url,sr,an,cookie,proxy,hour,minute = sys.argv[1:12]
t = open(src,encoding='utf-8').read()
t = t.replace('/替换为node路径/node', node)
t = t.replace('/替换为你的实际路径/douban-cloud', root)
t = t.replace('__SUPABASE_URL__', url)
t = t.replace('__SUPABASE_SERVICE_ROLE_KEY__', sr)
t = t.replace('__SUPABASE_ANON_KEY__', an)
t = t.replace('__DOUBAN_COOKIE__', cookie)
t = t.replace('__DOUBAN_PROXY__', proxy)
t = t.replace('__HOUR__', hour)
t = t.replace('__MINUTE__', minute)
import os
os.makedirs(os.path.dirname(dst), exist_ok=True)
open(dst,'w',encoding='utf-8').write(t)
print('  plist 已写入')
PY

# ---------- 7. 装载 launchd ----------
echo "→ 装载定时任务..."
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"
echo "✅ 已装载 com.argos.douban.daily(每天 $(printf '%02d:%02d' "$RUN_HOUR" "$RUN_MIN") 运行)"
echo "   立即测试一次:  launchctl start com.argos.douban.daily"
echo "   看日志:        tail -f logs/daily.out.log"

# ---------- 8. 防睡眠提示 ----------
cat <<TIP

──────────────────────────────────────────────
防睡眠设置(重要,否则定时任务会被睡眠跳过):
  方式一(系统设置):系统设置 → 电池/节能 → 勾选"防止电脑自动进入睡眠"。
  方式二(命令行,临时):  caffeinate -s &
  方式三(更稳,定时唤醒,推荐):
    sudo pmset repeat wakeorpoweron MTWRFSU $WAKE_HM
    (每天 $WAKE_HM 自动唤醒,留 5 分钟给 $(printf '%02d:%02d' "$RUN_HOUR" "$RUN_MIN") 的任务)
──────────────────────────────────────────────

部署完成 ✅
查看端已在 GitHub Pages 上线,mini 只负责抓取,无需再发布。
TIP
