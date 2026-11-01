-- How To Use Me: public guide library.
-- Run this once in Supabase → SQL Editor → New query → Run. It is safe to run again.
--
-- Design:
--   * Anyone can publish without an account. Publishing returns nothing secret; instead the app
--     makes a random edit key, keeps it on the phone, and only its SHA-256 hash is stored here.
--     Updating or removing a published guide needs that key.
--   * Nobody can read or write the table directly. The app only calls the functions below.
--   * A guide is hidden automatically once 3 different devices report it.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.library_guides (
  id           uuid primary key default gen_random_uuid(),
  title        text  not null check (char_length(title) between 1 and 140),
  item         text  not null default '' check (char_length(item) <= 140),
  location     text  not null default '' check (char_length(location) <= 140),
  steps        jsonb not null check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) between 1 and 100),
  notes        text  not null default '' check (char_length(notes) <= 2000),
  photos       jsonb not null default '[]' check (jsonb_typeof(photos) = 'array' and jsonb_array_length(photos) <= 12),
  secret_hash  text  not null,
  downloads    integer not null default 0,
  hidden       boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  search       tsvector generated always as (
                 setweight(to_tsvector('english', title), 'A') ||
                 setweight(to_tsvector('english', item || ' ' || location), 'B') ||
                 setweight(to_tsvector('english', steps::text || ' ' || notes), 'C')
               ) stored
);
create index if not exists library_guides_search_idx on public.library_guides using gin (search);
create index if not exists library_guides_popular_idx on public.library_guides (downloads desc, updated_at desc) where not hidden;

create table if not exists public.library_reports (
  guide_id   uuid not null references public.library_guides (id) on delete cascade,
  reporter   text not null check (char_length(reporter) between 8 and 80),
  reason     text not null default '' check (char_length(reason) <= 500),
  created_at timestamptz not null default now(),
  primary key (guide_id, reporter)
);

-- No direct table access for app users; everything goes through the functions.
alter table public.library_guides enable row level security;
alter table public.library_reports enable row level security;
revoke all on public.library_guides, public.library_reports from public;
do $$ begin
  execute 'revoke all on public.library_guides, public.library_reports from anon';
  execute 'revoke all on public.library_guides, public.library_reports from authenticated';
exception when undefined_object then null; end $$;

-- Turns "park mach" into a prefix search: park:* & mach:*
create or replace function public.library_query(q text)
returns tsquery language sql immutable set search_path = public, pg_catalog as $$
  select case when coalesce(trim(q), '') = '' then null else (
    select to_tsquery('english', string_agg(quote_literal(w) || ':*', ' & '))
    from regexp_split_to_table(lower(left(q, 200)), '[^[:alnum:]]+') as w
    where w <> ''
  ) end
$$;

-- Search. An empty query lists the most downloaded guides.
create or replace function public.search_guides(q text default '', lim integer default 30, skip integer default 0)
returns table (id uuid, title text, item text, location text, step_count integer, photo_count integer,
               downloads integer, updated_at timestamptz)
language sql stable security definer set search_path = public, pg_catalog as $$
  with query as (select public.library_query(q) as tsq)
  select g.id, g.title, g.item, g.location, jsonb_array_length(g.steps), jsonb_array_length(g.photos),
         g.downloads, g.updated_at
  from public.library_guides g, query
  where not g.hidden and (query.tsq is null or g.search @@ query.tsq)
  order by case when query.tsq is null then 0 else ts_rank(g.search, query.tsq) end desc,
           g.downloads desc, g.updated_at desc
  limit least(greatest(coalesce(lim, 30), 1), 50) offset greatest(coalesce(skip, 0), 0)
$$;

-- One full guide, ready to view or download. Never returns the edit-key hash.
create or replace function public.get_guide(p_id uuid)
returns json language sql stable security definer set search_path = public, pg_catalog as $$
  select json_build_object('id', id, 'title', title, 'item', item, 'location', location, 'steps', steps,
                           'notes', notes, 'photos', photos, 'downloads', downloads,
                           'created_at', created_at, 'updated_at', updated_at)
  from public.library_guides where id = p_id and not hidden
$$;

-- Publish a new guide (p_id null) or update one you published (needs the same edit key).
create or replace function public.publish_guide(p_id uuid, p_secret text, p_guide jsonb)
returns json language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
declare
  v_hash text;
  v_steps jsonb;
  v_photos jsonb := coalesce(p_guide -> 'photos', '[]'::jsonb);
  v_row public.library_guides;
begin
  if p_secret is null or char_length(p_secret) < 24 then
    raise exception 'edit key too short' using errcode = '22023';
  end if;
  if octet_length(p_guide::text) > 4000000 then
    raise exception 'guide is too large to publish (photos over 4 MB)' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(left(btrim(s #>> '{}'), 1000)) filter (where btrim(s #>> '{}') <> ''), '[]'::jsonb)
    into v_steps from jsonb_array_elements(coalesce(p_guide -> 'steps', '[]'::jsonb)) as s;
  if jsonb_typeof(v_photos) <> 'array' or exists (
       select 1 from jsonb_array_elements(v_photos) p
       where coalesce(jsonb_typeof(p -> 'src'), '') <> 'string' or (p ->> 'src') not like 'data:image/%') then
    raise exception 'photos must be images' using errcode = '22023';
  end if;
  -- keep only what the app needs from each photo
  select coalesce(jsonb_agg(jsonb_build_object(
           'src', p ->> 'src',
           'step', case when jsonb_typeof(p -> 'step') = 'number' then p -> 'step' else 'null'::jsonb end)), '[]'::jsonb)
    into v_photos from jsonb_array_elements(v_photos) p;
  v_hash := encode(digest(p_secret, 'sha256'), 'hex');

  if p_id is null then
    insert into public.library_guides (title, item, location, steps, notes, photos, secret_hash)
    values (left(btrim(coalesce(p_guide ->> 'title', '')), 140), left(btrim(coalesce(p_guide ->> 'item', '')), 140),
            left(btrim(coalesce(p_guide ->> 'location', '')), 140), v_steps,
            left(coalesce(p_guide ->> 'notes', ''), 2000), v_photos, v_hash)
    returning * into v_row;
  else
    update public.library_guides set
      title = left(btrim(coalesce(p_guide ->> 'title', '')), 140), item = left(btrim(coalesce(p_guide ->> 'item', '')), 140),
      location = left(btrim(coalesce(p_guide ->> 'location', '')), 140), steps = v_steps,
      notes = left(coalesce(p_guide ->> 'notes', ''), 2000), photos = v_photos, updated_at = now()
    where id = p_id and secret_hash = v_hash
    returning * into v_row;
    if not found then
      raise exception 'not allowed to change this guide' using errcode = '42501';
    end if;
  end if;
  return json_build_object('id', v_row.id, 'updated_at', v_row.updated_at);
end $$;

-- Remove a guide you published.
create or replace function public.unpublish_guide(p_id uuid, p_secret text)
returns boolean language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
begin
  delete from public.library_guides where id = p_id and secret_hash = encode(digest(coalesce(p_secret, ''), 'sha256'), 'hex');
  return found;
end $$;

create or replace function public.count_download(p_id uuid)
returns void language sql security definer set search_path = public, pg_catalog as $$
  update public.library_guides set downloads = downloads + 1 where id = p_id and not hidden
$$;

-- Report a guide. Each device counts once; 3 reports hide it.
create or replace function public.report_guide(p_id uuid, p_reporter text, p_reason text default '')
returns void language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  insert into public.library_reports (guide_id, reporter, reason)
  values (p_id, left(p_reporter, 80), left(coalesce(p_reason, ''), 500))
  on conflict do nothing;
  update public.library_guides set hidden = true
  where id = p_id and (select count(*) from public.library_reports where guide_id = p_id) >= 3;
end $$;

revoke all on function public.library_query(text) from public;
grant execute on function public.search_guides(text, integer, integer), public.get_guide(uuid),
  public.publish_guide(uuid, text, jsonb), public.unpublish_guide(uuid, text),
  public.count_download(uuid), public.report_guide(uuid, text, text) to public;
