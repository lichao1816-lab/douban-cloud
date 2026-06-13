-- ============================================================
-- upgrade-v4.sql · 阿尔戈斯计划 节展片豆瓣匹配 所需列
-- 在 Supabase SQL Editor 执行一次即可(幂等)。配合 scripts/match-festival-douban.mjs。
-- ============================================================

alter table festival_films add column if not exists douban_score          numeric;      -- 豆瓣评分
alter table festival_films add column if not exists douban_rating_people   int;          -- 豆瓣评分人数
alter table festival_films add column if not exists imdb_rating            numeric;      -- IMDb 评分
alter table festival_films add column if not exists douban_matched_at      timestamptz;  -- 最近一次匹配尝试时间(占位,避免重复死磕)
