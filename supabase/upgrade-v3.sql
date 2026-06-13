-- ============================================================
-- 阿尔戈斯计划 · v3 升级(2026-06-12)。整段粘贴到 Supabase SQL Editor
-- 点 Run 即可,可重复执行(幂等)。包含:
-- ① news_items 加中文译文列(资讯中文化)
-- ② festivals 加 lineup_announce 列(节展雷达:预计片单公布时间)
-- ③ festival_films 加 director 列
-- ④ 新表 bo_films(票房榜影片豆瓣详情缓存)+ RLS
-- 跑完后在 Mac 终端 douban-cloud 目录执行:
--   npm run festivals   (灌入各节展"片单公布时间"雷达数据)
--   npm run festfilms   (补 197 条入围片的导演信息)
--   npm run news        (立即抓一轮资讯并翻译存量英文标题)
--   npm run bofilms     (首次抓票房片详情,约3-5分钟)
-- ============================================================

-- ① 资讯中文化
alter table news_items add column if not exists title_cn   text;
alter table news_items add column if not exists summary_cn text;

-- ② 节展雷达
alter table festivals add column if not exists lineup_announce text;

-- ③ 入围片导演
alter table festival_films add column if not exists director text;

-- ④ 票房榜影片详情缓存(独立于筛片库 douban_films,不污染筛片流程)
create table if not exists bo_films (
  sid           text primary key,     -- 豆瓣 subject id
  name          text,
  score         numeric,              -- 豆瓣评分
  rating_people int,
  imdb_id       text,
  imdb_rating   numeric,
  countries     text,
  genres        text,
  directors     text,
  actors        text,
  duration      text,
  douban_url    text,
  updated_at    timestamptz default now()
);

alter table bo_films enable row level security;
drop policy if exists bofilms_anon_select on bo_films;
create policy bofilms_anon_select on bo_films for select to anon using (true);
grant select on bo_films to anon;
