-- ============================================================
-- upgrade-v6.sql · 阿尔戈斯计划 第三轮改版所需 DDL
-- 在 Supabase SQL Editor 整段执行一次(幂等)。配合本轮新脚本/前端。
-- 内容: ①评分每日快照表(多日五星走势曲线) ②节展片 imdb_id ③票房当周市场大盘
-- ============================================================

-- ① 评分每日快照:每天每片一行,前端据此画 7/30 天五星增长曲线 -----------
--    fetch-ratings 每刷一片就 upsert 一行(同 sid+同日 覆盖)。
create table if not exists rating_history (
  sid        text not null,                 -- 豆瓣 subject id
  snap_date  date not null,                 -- 快照日期(本地)
  star1      int,
  star2      int,
  star3      int,
  star4      int,
  star5      int,                            -- 当日 5 星累计人数
  comments   int,                            -- 短评数
  score      numeric,                        -- 当日豆瓣评分
  created_at timestamptz default now(),
  primary key (sid, snap_date)
);
create index if not exists idx_rating_history_sid on rating_history (sid, snap_date);
alter table rating_history enable row level security;
drop policy if exists rh_anon_select on rating_history;
create policy rh_anon_select on rating_history for select to anon using (true);
grant select on rating_history to anon;
-- 写入走 service_role(mini 抓取脚本),绕过 RLS,无需匿名 insert 权限。

-- ② 电影节片单:补 IMDb 编号(用于前端 IMDb 链接按钮) -------------------
alter table festival_films add column if not exists imdb_id text;   -- ttXXXXXXX

-- ③ 票房:当周该市场大盘(全部在榜影片周末票房之和) --------------------
alter table boxoffice_entries add column if not exists market_total text;  -- 当周市场总票房(原始字符串)
