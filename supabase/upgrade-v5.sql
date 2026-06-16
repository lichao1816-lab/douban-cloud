-- ============================================================
-- upgrade-v5.sql · 阿尔戈斯计划 第二轮改版所需 DDL
-- 在 Supabase SQL Editor 整段执行一次(幂等)。配合本轮新脚本/前端。
-- 内容: ①海报列 ②电影节国际分类列 ③watchlist(自助添加监测) ④2025补扫进度表
-- ============================================================

-- ① 海报(豆瓣 og:image URL,只存文本,不存图片本体) ----------------
alter table douban_films add column if not exists poster_url text;

-- ② 电影节国际分类(FIAPF口径) ------------------------------------
alter table festivals    add column if not exists class_intl text;   -- 国际A类/专门竞赛/重要展映/电影奖项/交易市场

-- ③ watchlist:网页端自助添加要监测的影片(粘豆瓣链接) --------------
create table if not exists watchlist (
  sid            text primary key,                 -- 豆瓣 subject id
  douban_url     text,
  desired_status text default '重点关注',           -- 重点关注 / 保留
  note           text,
  source         text default 'manual',            -- manual / festival / news
  ingested       boolean default false,            -- mini 是否已并入 douban_films
  added_at       timestamptz default now()
);
alter table watchlist enable row level security;
drop policy if exists wl_anon_select on watchlist;
create policy wl_anon_select on watchlist for select to anon using (true);
drop policy if exists wl_anon_insert on watchlist;
create policy wl_anon_insert on watchlist for insert to anon with check (true);
grant select, insert on watchlist to anon;

-- ④ 2025 全年补扫进度(按地区断点续传,service_role 写,无需匿名权限) --
create table if not exists backfill_2025 (
  region     text primary key,
  status     text default 'pending',               -- pending / done
  found      int  default 0,
  inserted   int  default 0,
  updated_at timestamptz default now()
);
alter table backfill_2025 enable row level security;   -- 仅 service_role(绕过RLS)读写
