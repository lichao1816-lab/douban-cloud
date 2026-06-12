-- ============================================================
-- 阿尔戈斯计划 · v2 扩展 Schema(四板块改版)
-- 在 Supabase SQL Editor 整段执行。可重复执行(幂等)。
-- 变更:① douban_films 增详情/IMDb 字段(状态新增"重点关注"为
--   合法取值,无需改结构) ② 新表 boxoffice_entries / news_items /
--   festivals / festival_films + RLS。
-- ============================================================

-- ---------- 1. douban_films 详情增强字段 ----------
alter table douban_films add column if not exists orig_name  text;          -- 原片名/又名
alter table douban_films add column if not exists countries  text;          -- 全部制片国家(/分隔)
alter table douban_films add column if not exists genres     text;          -- 类型(/分隔)
alter table douban_films add column if not exists directors  text;          -- 导演(/分隔)
alter table douban_films add column if not exists actors     text;          -- 主演前2-3名(/分隔)
alter table douban_films add column if not exists duration   text;          -- 片长
alter table douban_films add column if not exists imdb_id    text;          -- ttXXXXXXX
alter table douban_films add column if not exists imdb_rating numeric;      -- IMDb 评分
alter table douban_films add column if not exists detail_updated_at timestamptz; -- 详情抓取时间

create index if not exists idx_douban_films_detail_pending
  on douban_films (status) where detail_updated_at is null;

-- ---------- 2. 全球票房 ----------
create table if not exists boxoffice_entries (
  id           bigint generated always as identity primary key,
  market       text not null,        -- 市场(国家/地区,中文)
  market_code  text,                 -- BOM area 代码
  period       text not null,        -- 周末范围,如 2026-06-05~06-07
  rank         int  not null,        -- 名次 1-3
  title        text not null,        -- 片名(当地榜单片名)
  weekend_gross text,                -- 周末票房(原始字符串,含币种)
  total_gross  text,                 -- 累计票房
  weeks        int,                  -- 上映周数
  douban_sid   text,                 -- 匹配到的豆瓣id(可空)
  douban_url   text,                 -- 豆瓣链接(可空)
  fetched_at   timestamptz default now(),
  unique (market, period, rank)
);
create index if not exists idx_boxoffice_period on boxoffice_entries (period desc, market);

-- ---------- 3. 媒体资讯 ----------
create table if not exists news_items (
  id           bigint generated always as identity primary key,
  source       text not null,        -- 媒体名(Variety/Deadline/…)
  title        text not null,
  url          text not null unique,
  summary      text,
  published_at timestamptz,
  fetched_at   timestamptz default now()
);
create index if not exists idx_news_published on news_items (published_at desc);

-- ---------- 4. 电影节 ----------
create table if not exists festivals (
  id            text primary key,    -- slug,如 cannes
  name          text not null,       -- 英文名
  name_cn       text not null,       -- 中文名
  tier          text not null,       -- S / A / B
  kind          text,                -- festival(电影节) / award(奖项) / market(交易市场)
  country       text,
  city          text,
  month_window  text,                -- 常规举办时间,如 "5月中旬"
  edition_2026  text,                -- 2026届期具体日期(可空=待公布)
  lineup_status text default '未公布', -- 入围片单: 未公布 / 部分公布 / 已公布
  official_url  text,
  notes         text,
  updated_at    timestamptz default now()
);

create table if not exists festival_films (
  id           bigint generated always as identity primary key,
  festival_id  text not null references festivals(id),
  edition      int  not null default 2026,   -- 届(年份)
  section      text,                          -- 单元,如 主竞赛/一种关注/展映
  title        text not null,
  orig_title   text,
  country      text,
  douban_sid   text,
  douban_url   text,
  prize        text,                          -- 获奖情况(可空)
  added_at     timestamptz default now(),
  unique (festival_id, edition, title)
);
create index if not exists idx_festfilms on festival_films (festival_id, edition);

-- ---------- 5. RLS ----------
alter table boxoffice_entries enable row level security;
alter table news_items        enable row level security;
alter table festivals         enable row level security;
alter table festival_films    enable row level security;

drop policy if exists bo_anon_select   on boxoffice_entries;
create policy bo_anon_select   on boxoffice_entries for select to anon using (true);
drop policy if exists news_anon_select on news_items;
create policy news_anon_select on news_items        for select to anon using (true);
drop policy if exists fest_anon_select on festivals;
create policy fest_anon_select on festivals         for select to anon using (true);
drop policy if exists ff_anon_select   on festival_films;
create policy ff_anon_select   on festival_films    for select to anon using (true);

grant select on boxoffice_entries, news_items, festivals, festival_films to anon;
-- service_role 默认绕过 RLS。anon 对新表只读;douban_films 的
-- status/note 列级更新权限沿用 v1(四档状态值无需额外授权)。
