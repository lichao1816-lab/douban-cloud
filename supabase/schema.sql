-- ============================================================
-- 阿尔戈斯计划 · 豆瓣电影情报云端 · Supabase Schema
-- 在 Supabase 项目的 SQL Editor 里整段执行即可。
-- 表名统一加 douban_ 前缀，避免和你已有的表冲突。
-- ============================================================

-- ---------- 1. 影片主表 ----------
create table if not exists douban_films (
  id                 text primary key,          -- 豆瓣 subject id (sid)
  name               text not null,             -- 片名
  country            text,                       -- 制片国家/地区(第一国)
  year               int,                        -- 年份 2026 / 2027
  score              numeric,                    -- 当前总分(可空,未开分为 null)
  douban_url         text,                       -- 豆瓣详情页链接
  notion_page_id     text,                       -- 关联的 Notion 页面 id(可空)
  status             text not null default '待筛', -- 筛选状态: 待筛 / 保留 / 淘汰
  note               text,                       -- 备注(可空)
  出品公司            text,                       -- 出品公司(可空)

  -- 当前各档星级绝对人数(由百分比×总评价人数四舍五入得到)
  star1              int,   -- 1星人数
  star2              int,
  star3              int,
  star4              int,
  star5              int,   -- 5星人数

  -- 上一次抓取时的星级人数(用于算今日新增 d_*)
  prev_star1         int,
  prev_star2         int,
  prev_star3         int,
  prev_star4         int,
  prev_star5         int,

  -- 今日新增 = 当前 - 上一次
  d_star1            int,
  d_star2            int,
  d_star3            int,
  d_star4            int,
  d_star5            int,   -- 今日新增 5星(核心追踪指标)

  comments           int,   -- 短评总数(当前)
  prev_comments      int,   -- 上一次短评总数
  d_comments         int,   -- 今日新增短评

  first_seen         date default current_date,  -- 第一次进入情报库的日期
  last_rating_update timestamptz,                 -- 最近一次评分抓取时间(可空)
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);

-- ---------- 2. 运行日志表 ----------
create table if not exists douban_runs (
  id           bigint generated always as identity primary key,
  run_date     date default current_date,
  started_at   timestamptz default now(),
  finished_at  timestamptz,
  kind         text,            -- roster / ratings / daily
  status       text,            -- ok / blocked / error
  new_films    int default 0,   -- 本次新增影片数
  rated_films  int default 0,   -- 本次更新评分的影片数
  summary      text,
  blocked      boolean default false
);

-- ---------- 3. 索引 ----------
create index if not exists idx_douban_films_year     on douban_films (year);
create index if not exists idx_douban_films_status   on douban_films (status);
create index if not exists idx_douban_films_country  on douban_films (country);
create index if not exists idx_douban_films_year_st  on douban_films (year, status);
create index if not exists idx_douban_runs_date      on douban_runs (run_date desc);

-- ---------- 4. updated_at 自动维护 ----------
create or replace function douban_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_douban_films_touch on douban_films;
create trigger trg_douban_films_touch
  before update on douban_films
  for each row execute function douban_touch_updated_at();

-- ============================================================
-- 5. 行级安全 (RLS)
-- ============================================================
-- 设计:
--   * 查看端用 anon key,只读 + 允许更新筛选状态(status/note)。
--   * 抓取脚本用 service_role key,绕过 RLS,可任意写入。
--
-- ⚠️ 简化方案说明:
--   下面允许匿名(anon)UPDATE douban_films,是为了让查看端能直接
--   点"保留/淘汰"写回状态。这是【单工作区/自用】的简化做法。
--   生产环境若公开访问,应改为:加一层登录(Supabase Auth),
--   或把写操作收敛到带密钥的 Edge Function。此处先图省事。
-- ============================================================

alter table douban_films enable row level security;
alter table douban_runs  enable row level security;

-- 影片表:匿名可读
drop policy if exists douban_films_anon_select on douban_films;
create policy douban_films_anon_select
  on douban_films for select
  to anon
  using (true);

-- 影片表:匿名可更新(简化方案;主要用于改 status/note)
-- 注:Postgres RLS 的 UPDATE policy 难以限制"只能改某几列",
-- 列级限制需用 GRANT 列权限实现(见下),policy 这里放行整行更新。
drop policy if exists douban_films_anon_update on douban_films;
create policy douban_films_anon_update
  on douban_films for update
  to anon
  using (true)
  with check (true);

-- 列级收紧:只授予 anon 对 status / note 两列的 UPDATE 权限,
-- 其余列匿名无法改(即使 policy 放行行,也写不进别的列)。
revoke update on douban_films from anon;
grant  update (status, note) on douban_films to anon;
grant  select on douban_films to anon;

-- 运行日志表:匿名只读(查看端用来显示"最后更新时间")
drop policy if exists douban_runs_anon_select on douban_runs;
create policy douban_runs_anon_select
  on douban_runs for select
  to anon
  using (true);
grant select on douban_runs to anon;

-- service_role 默认绕过 RLS,无需额外 policy。
