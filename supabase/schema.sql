-- How To Use Me: public guide library.
-- Run this in Supabase → SQL Editor → New query → Run. It is safe to run again (it upgrades in place).
-- Then, once, run:  select library_private.admin_new_key();   and keep the key it shows in a password manager.
--
-- What it guarantees (enforced here, so a modified app or a script cannot skip it):
--   * Only guides can be stored: a fixed set of plain-text fields and up to 4 real JPEG/PNG/WebP photos.
--   * No empty, junk or duplicate guides; no links, e-mail addresses, hidden characters or data blobs.
--   * Nobody can read or write any table directly. Only the public functions at the bottom are callable.
--   * Publishing and reporting need a small proof-of-work puzzle and are rate limited per network
--     and overall; publishing stops before the free database fills up.
--   * Photos stay hidden until an admin approves them. Reports count once per network.
--   * Each guide has a random edit key kept on the publishing phone (only its hash is stored here).

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
-- Helpers live in a schema the API does not expose.
create schema if not exists library_private;
revoke all on schema library_private from public;

-- ------------------------------------------------------------------ tables
create table if not exists public.library_settings (
  id                       boolean primary key default true check (id),
  pow_bits                 integer not null default 18 check (pow_bits between 0 and 26),
  publish_per_client_hour  integer not null default 6,
  publish_global_hour      integer not null default 60,
  publish_global_day       integer not null default 300,
  report_per_client_day    integer not null default 20,
  hide_after_reports       integer not null default 3,
  max_library_mb           integer not null default 350,
  max_photos               integer not null default 4 check (max_photos between 0 and 8),
  max_photo_kb             integer not null default 250 check (max_photo_kb between 10 and 1000),
  salt                     text not null default gen_random_uuid()::text
);
insert into public.library_settings default values on conflict do nothing;

create table if not exists public.library_guides (
  id              uuid primary key default gen_random_uuid(),
  title           text  not null check (char_length(title) between 3 and 120),
  item            text  not null default '' check (char_length(item) <= 120),
  location        text  not null default '' check (char_length(location) <= 120),
  steps           jsonb not null check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) between 1 and 60),
  notes           text  not null default '' check (char_length(notes) <= 1000),
  photos          jsonb not null default '[]' check (jsonb_typeof(photos) = 'array'),
  photos_approved boolean not null default false,
  fingerprint     text  not null,
  secret_hash     text  not null,
  publisher       text  not null,
  downloads       integer not null default 0,
  hidden          boolean not null default false,
  protected       boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  search          tsvector generated always as (
                    setweight(to_tsvector('english', title), 'A') ||
                    setweight(to_tsvector('english', item || ' ' || location), 'B') ||
                    setweight(to_tsvector('english', steps::text || ' ' || notes), 'C')
                  ) stored
);
create unique index if not exists library_guides_fingerprint_key on public.library_guides (fingerprint);
create index if not exists library_guides_search_idx on public.library_guides using gin (search);
create index if not exists library_guides_popular_idx on public.library_guides (downloads desc, updated_at desc) where not hidden;
create index if not exists library_guides_publisher_idx on public.library_guides (publisher);

create table if not exists public.library_reports (
  guide_id   uuid not null references public.library_guides (id) on delete cascade,
  reporter   text not null,
  reason     text not null check (reason in ('wrong', 'unsafe', 'spam', 'offensive', 'other')),
  created_at timestamptz not null default now(),
  primary key (guide_id, reporter)
);
create table if not exists public.library_events (
  kind   text not null,
  client text not null,
  at     timestamptz not null default now()
);
create index if not exists library_events_kind_idx on public.library_events (kind, at);
create index if not exists library_events_client_idx on public.library_events (kind, client, at);
create index if not exists library_events_at_idx on public.library_events (at);
create table if not exists public.library_challenges (
  token      text primary key,
  created_at timestamptz not null default now()
);
create table if not exists public.library_bans (
  client     text primary key,
  reason     text not null default '',
  created_at timestamptz not null default now()
);
create table if not exists public.library_blocklist (
  term text primary key check (term ~ '^[a-z0-9]+( [a-z0-9]+)*$' and char_length(term) between 2 and 40)
);
insert into public.library_blocklist (term) values
  ('porn'), ('porno'), ('xxx'), ('nude'), ('nudes'), ('onlyfans'), ('escort'), ('fuck'), ('fucking'),
  ('shit'), ('cunt'), ('bitch'), ('whore'), ('slut'), ('dick pic'), ('kill yourself'), ('kys'),
  ('casino'), ('crypto giveaway'), ('free money'), ('viagra'), ('bitcoin doubler')
on conflict do nothing;
create table if not exists public.library_admins (
  key_hash   text primary key,
  created_at timestamptz not null default now()
);

-- No direct access to any table from the API.
do $$
declare t text;
begin
  foreach t in array array['library_settings', 'library_guides', 'library_reports', 'library_events',
                           'library_challenges', 'library_bans', 'library_blocklist', 'library_admins'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public', t);
    begin
      execute format('revoke all on public.%I from anon, authenticated', t);
    exception when undefined_object then null;
    end;
  end loop;
end $$;

-- Drop every old version of our functions so signatures can change safely.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'library_private')
       or (n.nspname = 'public' and p.proname in ('library_query', 'search_guides', 'get_guide', 'get_challenge',
           'publish_guide', 'unpublish_guide', 'count_download', 'report_guide', 'admin_queue', 'admin_act',
           'admin_blocklist', 'admin_settings', 'admin_whoami'))
  loop
    execute 'drop function ' || f.sig;
  end loop;
end $$;

-- --------------------------------------------------------------- helpers
-- Raise an error the app can show as-is. PTxxx sets the HTTP status.
create function library_private.fail(code text, msg text, hint text default null)
returns void language plpgsql as $$
begin
  if hint is null then raise exception using errcode = code, message = msg;
  else raise exception using errcode = code, message = msg, hint = hint; end if;
end $$;

-- A salted hash of the caller's network address (never stored in the clear).
-- Cloudflare's header comes first because callers cannot fake it on Supabase.
create function library_private.client()
returns text language sql stable set search_path = public, extensions, pg_catalog as $$
  select encode(digest(coalesce(
           nullif(h ->> 'cf-connecting-ip', ''),
           nullif(btrim(split_part(coalesce(h ->> 'x-forwarded-for', ''), ',', 1)), ''),
           nullif(h ->> 'x-real-ip', ''),
           'unknown') || ':' || (select salt from public.library_settings), 'sha256'), 'hex')
  from (select coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json as h) x
$$;

-- Counts an action and refuses it when a per-network or overall limit is reached.
create function library_private.rate(p_kind text, p_client text, per_client integer, per_client_window interval,
                                     global_hour integer default null, global_day integer default null)
returns void language plpgsql set search_path = public, pg_catalog as $$
begin
  delete from public.library_events where at < now() - interval '2 days';
  if (select count(*) from public.library_events
      where kind = p_kind and client = p_client and at > now() - per_client_window) >= per_client then
    perform library_private.fail('PT429', 'You’ve reached the limit for now. Try again later.', 'rate_client');
  end if;
  if global_hour is not null and (select count(*) from public.library_events
      where kind = p_kind and at > now() - interval '1 hour') >= global_hour then
    perform library_private.fail('PT429', 'The library is very busy right now. Try again in an hour.', 'rate_global');
  end if;
  if global_day is not null and (select count(*) from public.library_events
      where kind = p_kind and at > now() - interval '1 day') >= global_day then
    perform library_private.fail('PT429', 'The library has reached today’s limit. Try again tomorrow.', 'rate_global');
  end if;
  insert into public.library_events (kind, client) values (p_kind, p_client);
end $$;

-- Proof of work: sha256(token || ':' || nonce) must start with `bits` zero bits. Each token works once.
create function library_private.check_pow(p_token text, p_nonce text, bits integer)
returns void language plpgsql set search_path = public, extensions, pg_catalog as $$
declare
  h bytea;
  i integer;
begin
  if bits = 0 then return; end if;
  delete from public.library_challenges where created_at < now() - interval '15 minutes';
  delete from public.library_challenges where token = coalesce(p_token, '');
  if not found then
    perform library_private.fail('PT400', 'The security check expired. Try again.', 'pow');
  end if;
  if coalesce(p_nonce, '') !~ '^[0-9]{1,12}$' then
    perform library_private.fail('PT400', 'The security check failed. Try again.', 'pow');
  end if;
  h := digest(p_token || ':' || p_nonce, 'sha256');
  for i in 0 .. (bits / 8) - 1 loop
    if get_byte(h, i) <> 0 then perform library_private.fail('PT400', 'The security check failed. Try again.', 'pow'); end if;
  end loop;
  if bits % 8 > 0 and (get_byte(h, bits / 8) >> (8 - bits % 8)) <> 0 then
    perform library_private.fail('PT400', 'The security check failed. Try again.', 'pow');
  end if;
end $$;

-- Plain-text rules shared by every text field.
create function library_private.check_text(label text, v text, min_len integer, max_len integer, multiline boolean)
returns void language plpgsql set search_path = public, pg_catalog as $$
declare bad text;
begin
  if v is null or char_length(btrim(v)) < min_len then
    if min_len <= 1 then perform library_private.fail('PT400', label || ' can’t be empty.', 'empty');
    else perform library_private.fail('PT400', label || ' is too short.', 'short'); end if;
  end if;
  if char_length(v) > max_len then
    perform library_private.fail('PT400', label || ' is too long (' || max_len || ' characters at most).', 'long');
  end if;
  if (multiline and v ~ '[\x01-\x09\x0B-\x1F\x7F]') or (not multiline and v ~ '[\x01-\x1F\x7F]') then
    perform library_private.fail('PT400', label || ' contains characters that aren’t allowed.', 'chars');
  end if;
  if v ~ '[​-‏‪-‮⁠-⁩﻿­]' then
    perform library_private.fail('PT400', label || ' contains hidden characters.', 'chars');
  end if;
  if v ~* '[^[:space:]@]+@[^[:space:]@]+\.[a-z]{2,}' then
    perform library_private.fail('PT400', 'E-mail addresses aren’t allowed in published guides (' || lower(label) || ').', 'email');
  end if;
  if v ~* '(https?://|ftp://|www\.|\m[a-z0-9-]+\.(com|net|org|io|ly|co|app|xyz|me|info|biz|ru|cn|tk|gg|link|site|online|shop|top|live|click|sh)\M)' then
    perform library_private.fail('PT400', 'Links aren’t allowed in published guides (' || lower(label) || ').', 'link');
  end if;
  if v ~ '[^[:space:]]{41,}' then
    perform library_private.fail('PT400', label || ' has a word that’s too long. Published guides can only contain readable text.', 'blob');
  end if;
  select term into bad from public.library_blocklist where v ~* ('\m' || term || '\M') limit 1;
  if found then
    perform library_private.fail('PT400', label || ' contains words that aren’t allowed in the library.', 'blocked');
  end if;
end $$;

-- Validates photos and returns them cleaned to {src, step}. Checks the real file bytes.
create function library_private.check_photos(p jsonb, step_count integer, max_photos integer, max_kb integer)
returns jsonb language plpgsql set search_path = public, extensions, pg_catalog as $$
declare
  ph jsonb;
  src text;
  kind text;
  b bytea;
  n integer;
  result jsonb := '[]'::jsonb;
  seen text[] := '{}';
  h text;
  st jsonb;
begin
  if p is null or p = 'null'::jsonb then return result; end if;
  if jsonb_typeof(p) <> 'array' then perform library_private.fail('PT400', 'Photos must be a list.', 'shape'); end if;
  if jsonb_array_length(p) > max_photos then
    perform library_private.fail('PT400', 'A guide can have ' || max_photos || ' photos at most.', 'photos_many');
  end if;
  for ph in select * from jsonb_array_elements(p) loop
    if jsonb_typeof(ph) <> 'object' or exists (select 1 from jsonb_object_keys(ph) k where k not in ('src', 'step')) then
      perform library_private.fail('PT400', 'This isn’t a How To Use Me guide.', 'shape');
    end if;
    src := ph ->> 'src';
    if jsonb_typeof(ph -> 'src') is distinct from 'string'
       or src !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$' then
      perform library_private.fail('PT400', 'Photos must be JPEG, PNG or WebP images.', 'photo_type');
    end if;
    kind := substring(src from '^data:image/([a-z]+);');
    begin
      b := decode(substring(src from position(',' in src) + 1), 'base64');
    exception when others then
      perform library_private.fail('PT400', 'A photo is damaged.', 'photo_bad');
    end;
    n := length(b);
    if n > max_kb * 1024 then
      perform library_private.fail('PT400', 'A photo is too large (' || max_kb || ' KB at most).', 'photo_big');
    end if;
    if n < 100 then perform library_private.fail('PT400', 'A photo is damaged.', 'photo_bad'); end if;
    -- The bytes must really be the image type they claim, with nothing extra after the image ends.
    if kind = 'jpeg' and not (substring(b from 1 for 3) = '\xffd8ff'::bytea and substring(b from n - 1 for 2) = '\xffd9'::bytea) then
      perform library_private.fail('PT400', 'A photo isn’t a real JPEG image.', 'photo_bad');
    elsif kind = 'png' and not (substring(b from 1 for 8) = '\x89504e470d0a1a0a'::bytea
                                and substring(b from n - 7 for 8) = '\x49454e44ae426082'::bytea) then
      perform library_private.fail('PT400', 'A photo isn’t a real PNG image.', 'photo_bad');
    elsif kind = 'webp' and not (substring(b from 1 for 4) = 'RIFF'::bytea and substring(b from 9 for 4) = 'WEBP'::bytea
                                 and get_byte(b, 4) + get_byte(b, 5) * 256 + get_byte(b, 6) * 65536 + get_byte(b, 7) * 16777216 = n - 8) then
      perform library_private.fail('PT400', 'A photo isn’t a real WebP image.', 'photo_bad');
    end if;
    h := md5(b);
    if h = any (seen) then perform library_private.fail('PT400', 'The same photo is included twice.', 'photo_dup'); end if;
    seen := seen || h;
    st := ph -> 'step';
    if st is not null and st <> 'null'::jsonb then
      if jsonb_typeof(st) <> 'number' or (st #>> '{}') !~ '^[0-9]+$' or (st #>> '{}')::integer >= step_count then
        perform library_private.fail('PT400', 'A photo is attached to a step that doesn’t exist.', 'photo_step');
      end if;
    else
      st := 'null'::jsonb;
    end if;
    result := result || jsonb_build_array(jsonb_build_object('src', src, 'step', st));
  end loop;
  return result;
end $$;

-- Same steps (ignoring case, spaces and punctuation) = same guide.
create function library_private.fingerprint(steps jsonb)
returns text language sql immutable as $$
  select md5(string_agg(regexp_replace(lower(s #>> '{}'), '[^[:alnum:]]+', '', 'g'), '|' order by ord))
  from jsonb_array_elements(steps) with ordinality as t(s, ord)
$$;

-- Turns "park mach" into a prefix search: park:* & mach:*
create function library_private.query(q text)
returns tsquery language sql immutable as $$
  select case when coalesce(btrim(q), '') = '' then null else (
    select to_tsquery('english', string_agg(quote_literal(w) || ':*', ' & '))
    from regexp_split_to_table(lower(left(q, 200)), '[^[:alnum:]]+') as w
    where w <> ''
  ) end
$$;

create function library_private.admin_check(p_key text)
returns void language plpgsql set search_path = public, extensions, pg_catalog as $$
begin
  if not exists (select 1 from public.library_admins where key_hash = encode(digest(coalesce(p_key, ''), 'sha256'), 'hex')) then
    perform library_private.rate('admin_fail', library_private.client(), 10, interval '1 hour');
    perform library_private.fail('PT403', 'Wrong admin key.', 'admin');
  end if;
end $$;

-- Creates an admin key. Only callable from the SQL editor (not through the API).
create function library_private.admin_new_key()
returns text language plpgsql set search_path = public, extensions, pg_catalog as $$
declare k text := 'htu_admin_' || encode(gen_random_bytes(24), 'hex');
begin
  insert into public.library_admins (key_hash) values (encode(digest(k, 'sha256'), 'hex'));
  return k;
end $$;

-- --------------------------------------------------------- public API
-- Search. An empty query lists the most downloaded guides.
create function public.search_guides(q text default '', lim integer default 30, skip integer default 0)
returns table (id uuid, title text, item text, location text, step_count integer, photo_count integer,
               downloads integer, updated_at timestamptz)
language sql stable security definer set search_path = public, pg_catalog as $$
  with query as (select library_private.query(q) as tsq)
  select g.id, g.title, g.item, g.location, jsonb_array_length(g.steps),
         case when g.photos_approved then jsonb_array_length(g.photos) else 0 end,
         g.downloads, g.updated_at
  from public.library_guides g, query
  where not g.hidden and (query.tsq is null or g.search @@ query.tsq)
  order by case when query.tsq is null then 0 else ts_rank(g.search, query.tsq) end desc,
           g.downloads desc, g.updated_at desc
  limit least(greatest(coalesce(lim, 30), 1), 50) offset least(greatest(coalesce(skip, 0), 0), 1000)
$$;

-- One full guide. Photos appear only after an admin approves them. Never returns keys or network hashes.
create function public.get_guide(p_id uuid)
returns json language sql stable security definer set search_path = public, pg_catalog as $$
  select json_build_object('id', id, 'title', title, 'item', item, 'location', location, 'steps', steps,
           'notes', notes, 'photos', case when photos_approved then photos else '[]'::jsonb end,
           'photos_pending', case when photos_approved then 0 else jsonb_array_length(photos) end,
           'downloads', downloads, 'created_at', created_at, 'updated_at', updated_at)
  from public.library_guides where id = p_id and not hidden
$$;

-- A fresh puzzle for publishing or reporting.
create function public.get_challenge()
returns json language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
declare
  s public.library_settings;
  t text := encode(gen_random_bytes(16), 'hex');
begin
  select * into s from public.library_settings;
  perform library_private.rate('challenge', library_private.client(), 120, interval '1 hour');
  delete from public.library_challenges where created_at < now() - interval '15 minutes';
  insert into public.library_challenges (token) values (t);
  return json_build_object('token', t, 'bits', s.pow_bits);
end $$;

-- Publish a new guide (p_id null) or update one you published (needs the same edit key).
create function public.publish_guide(p_id uuid, p_secret text, p_guide jsonb, p_token text default null, p_nonce text default null)
returns json language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
declare
  s public.library_settings;
  v_client text := library_private.client();
  v_title text; v_item text; v_location text; v_notes text;
  v_steps jsonb; v_photos jsonb;
  v_count integer; v_distinct integer;
  v_words integer; v_good integer;
  v_fp text; v_dup uuid;
  v_hash text;
  v_row public.library_guides;
  i integer;
begin
  select * into s from public.library_settings;
  if exists (select 1 from public.library_bans where client = v_client) then
    perform library_private.fail('PT403', 'Publishing is blocked from this network.', 'banned');
  end if;

  -- 1. Shape: only guide fields, with the right types.
  if p_guide is null or jsonb_typeof(p_guide) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_guide) k where k not in ('title', 'item', 'location', 'steps', 'notes', 'photos')) then
    perform library_private.fail('PT400', 'This isn’t a How To Use Me guide.', 'shape');
  end if;
  if exists (select 1 from unnest(array['title', 'item', 'location', 'notes']) k
             where p_guide ? k and jsonb_typeof(p_guide -> k) <> 'string') then
    perform library_private.fail('PT400', 'This isn’t a How To Use Me guide.', 'shape');
  end if;
  if jsonb_typeof(p_guide -> 'steps') is distinct from 'array'
     or exists (select 1 from jsonb_array_elements(p_guide -> 'steps') x where jsonb_typeof(x) <> 'string') then
    perform library_private.fail('PT400', 'This isn’t a How To Use Me guide.', 'shape');
  end if;
  if coalesce(p_secret, '') !~ '^[A-Za-z0-9_-]{24,100}$' then
    perform library_private.fail('PT400', 'This isn’t a How To Use Me guide.', 'secret');
  end if;
  if octet_length(p_guide::text) > s.max_photos * s.max_photo_kb * 1400 + 100000 then
    perform library_private.fail('PT400', 'This guide is too large to publish.', 'size');
  end if;

  -- 2. Text: real, readable, plain.
  v_title := btrim(coalesce(p_guide ->> 'title', ''));
  v_item := btrim(coalesce(p_guide ->> 'item', ''));
  v_location := btrim(coalesce(p_guide ->> 'location', ''));
  v_notes := btrim(coalesce(p_guide ->> 'notes', ''));
  perform library_private.check_text('The title', v_title, 3, 120, false);
  if v_title !~ '[[:alpha:]]{2,}' then perform library_private.fail('PT400', 'The title needs real words.', 'empty'); end if;
  perform library_private.check_text('“What it’s for”', v_item, 0, 120, false);
  perform library_private.check_text('The location', v_location, 0, 120, false);
  perform library_private.check_text('The notes', v_notes, 0, 1000, true);
  select coalesce(jsonb_agg(btrim(x #>> '{}') order by ord), '[]'::jsonb) into v_steps
    from jsonb_array_elements(p_guide -> 'steps') with ordinality as t(x, ord);
  v_count := jsonb_array_length(v_steps);
  if v_count = 0 then perform library_private.fail('PT400', 'A guide needs at least one step.', 'empty'); end if;
  if v_count > 60 then perform library_private.fail('PT400', 'A guide can have 60 steps at most.', 'long'); end if;
  for i in 0 .. v_count - 1 loop
    perform library_private.check_text('Step ' || (i + 1), v_steps ->> i, 2, 300, false);
    if (v_steps ->> i) !~ '[[:alpha:]]{2,}' then
      perform library_private.fail('PT400', 'Step ' || (i + 1) || ' needs real words.', 'empty');
    end if;
  end loop;
  select count(distinct regexp_replace(lower(x #>> '{}'), '[^[:alnum:]]+', '', 'g')) into v_distinct
    from jsonb_array_elements(v_steps) x;
  if v_count >= 3 and v_distinct < ceil(v_count * 0.7) then
    perform library_private.fail('PT400', 'Too many steps are repeated.', 'repeat');
  end if;
  -- Scanning mistakes and random text: most Latin-letter words must look like words.
  select count(*), count(*) filter (where w ~ '[aeiouy]' and w !~ '[bcdfghjklmnpqrstvwxz]{5,}')
    into v_words, v_good
    from regexp_split_to_table(lower(v_title || ' ' || (select string_agg(x #>> '{}', ' ') from jsonb_array_elements(v_steps) x)),
                               '[^a-z]+') as w
    where length(w) >= 2;
  if v_words >= 4 and v_good < v_words * 0.6 then
    perform library_private.fail('PT400', 'This doesn’t look like readable instructions. Check the steps for scanning mistakes.', 'junk');
  end if;

  -- 3. Photos: real images only.
  v_photos := library_private.check_photos(p_guide -> 'photos', v_count, s.max_photos, s.max_photo_kb);

  -- 4. Abuse protection.
  perform library_private.check_pow(p_token, p_nonce, s.pow_bits);
  perform library_private.rate('publish', v_client, s.publish_per_client_hour, interval '1 hour', s.publish_global_hour, s.publish_global_day);
  if p_id is null and pg_total_relation_size('public.library_guides') > s.max_library_mb::bigint * 1048576 then
    perform library_private.fail('PT503', 'The library is full right now, so new guides can’t be published.', 'full');
  end if;

  -- 5. No duplicates.
  v_fp := library_private.fingerprint(v_steps);
  select id into v_dup from public.library_guides where fingerprint = v_fp and id is distinct from p_id;
  if found then
    perform library_private.fail('PT409', 'A guide with the same steps is already in the library.', 'duplicate:' || v_dup);
  end if;

  v_hash := encode(digest(p_secret, 'sha256'), 'hex');
  begin
    if p_id is null then
      insert into public.library_guides (title, item, location, steps, notes, photos, photos_approved, fingerprint, secret_hash, publisher)
      values (v_title, v_item, v_location, v_steps, v_notes, v_photos, jsonb_array_length(v_photos) = 0, v_fp, v_hash, v_client)
      returning * into v_row;
    else
      select * into v_row from public.library_guides where id = p_id and secret_hash = v_hash for update;
      if not found then
        perform library_private.fail('PT403', 'This guide was published from another phone, so it can’t be changed here.', 'not_owner');
      end if;
      update public.library_guides set
        title = v_title, item = v_item, location = v_location, steps = v_steps, notes = v_notes, photos = v_photos,
        photos_approved = case when v_photos = v_row.photos then v_row.photos_approved else jsonb_array_length(v_photos) = 0 end,
        fingerprint = v_fp, updated_at = now()
      where id = p_id
      returning * into v_row;
    end if;
  exception when unique_violation then
    select id into v_dup from public.library_guides where fingerprint = v_fp;
    perform library_private.fail('PT409', 'A guide with the same steps is already in the library.', 'duplicate:' || v_dup);
  end;
  return json_build_object('id', v_row.id, 'updated_at', v_row.updated_at,
                           'photos_pending', case when v_row.photos_approved then 0 else jsonb_array_length(v_row.photos) end);
end $$;

-- Remove a guide you published.
create function public.unpublish_guide(p_id uuid, p_secret text)
returns boolean language plpgsql security definer set search_path = public, extensions, pg_catalog as $$
begin
  delete from public.library_guides where id = p_id and secret_hash = encode(digest(coalesce(p_secret, ''), 'sha256'), 'hex');
  return found;
end $$;

-- Counts a download once per network.
create function public.count_download(p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_catalog as $$
declare v_client text := library_private.client();
begin
  if exists (select 1 from public.library_events where kind = 'dl:' || p_id and client = v_client) then return; end if;
  insert into public.library_events (kind, client) values ('dl:' || p_id, v_client);
  update public.library_guides set downloads = downloads + 1 where id = p_id and not hidden;
end $$;

-- Report a guide. Each network counts once; enough reports hide it until an admin looks.
create function public.report_guide(p_id uuid, p_reason text, p_token text default null, p_nonce text default null)
returns void language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  s public.library_settings;
  v_client text := library_private.client();
begin
  select * into s from public.library_settings;
  if exists (select 1 from public.library_bans where client = v_client) then
    perform library_private.fail('PT403', 'Reporting is blocked from this network.', 'banned');
  end if;
  if coalesce(p_reason, '') not in ('wrong', 'unsafe', 'spam', 'offensive', 'other') then
    perform library_private.fail('PT400', 'Choose a reason for the report.', 'reason');
  end if;
  if not exists (select 1 from public.library_guides where id = p_id and not hidden) then return; end if;
  perform library_private.check_pow(p_token, p_nonce, s.pow_bits);
  perform library_private.rate('report', v_client, s.report_per_client_day, interval '1 day');
  insert into public.library_reports (guide_id, reporter, reason) values (p_id, v_client, p_reason) on conflict do nothing;
  update public.library_guides set hidden = true
  where id = p_id and not protected
    and (select count(*) from public.library_reports where guide_id = p_id) >= s.hide_after_reports;
end $$;

-- ------------------------------------------------------- admin API
-- Lists guides for review: view = 'review' (reported, hidden or photos waiting) or 'all'.
create function public.admin_queue(p_key text, p_view text default 'review', p_q text default '')
returns json language plpgsql security definer set search_path = public, pg_catalog as $$
declare r json;
begin
  perform library_private.admin_check(p_key);
  select coalesce(json_agg(x order by x.needs desc, x.updated_at desc), '[]'::json) into r from (
    select g.id, g.title, g.item, g.location, g.steps, g.notes, g.photos, g.photos_approved, g.hidden, g.protected,
           g.downloads, g.created_at, g.updated_at, left(g.publisher, 10) as publisher,
           exists (select 1 from public.library_bans b where b.client = g.publisher) as publisher_banned,
           (select count(*) from public.library_guides o where o.publisher = g.publisher) as publisher_guides,
           (select count(*) from public.library_reports rp where rp.guide_id = g.id) as reports,
           (select coalesce(json_agg(rp.reason), '[]'::json) from public.library_reports rp where rp.guide_id = g.id) as reasons,
           (g.hidden or exists (select 1 from public.library_reports rp where rp.guide_id = g.id)
              or (not g.photos_approved and jsonb_array_length(g.photos) > 0)) as needs
    from public.library_guides g
    where (p_view = 'all' or g.hidden or exists (select 1 from public.library_reports rp where rp.guide_id = g.id)
           or (not g.photos_approved and jsonb_array_length(g.photos) > 0))
      and (coalesce(btrim(p_q), '') = '' or g.search @@ library_private.query(p_q))
    order by g.updated_at desc
    limit 100
  ) x;
  return r;
end $$;

create function public.admin_act(p_key text, p_id uuid, p_action text)
returns json language plpgsql security definer set search_path = public, pg_catalog as $$
declare v_pub text;
begin
  perform library_private.admin_check(p_key);
  select publisher into v_pub from public.library_guides where id = p_id;
  if not found then perform library_private.fail('PT404', 'That guide no longer exists.', 'missing'); end if;
  case p_action
    when 'approve_photos' then update public.library_guides set photos_approved = true where id = p_id;
    when 'remove_photos' then update public.library_guides set photos = '[]', photos_approved = true where id = p_id;
    when 'hide' then update public.library_guides set hidden = true where id = p_id;
    when 'restore' then
      delete from public.library_reports where guide_id = p_id;
      update public.library_guides set hidden = false where id = p_id;
    when 'protect' then
      delete from public.library_reports where guide_id = p_id;
      update public.library_guides set hidden = false, protected = true where id = p_id;
    when 'unprotect' then update public.library_guides set protected = false where id = p_id;
    when 'delete' then delete from public.library_guides where id = p_id;
    when 'ban' then
      insert into public.library_bans (client, reason) values (v_pub, 'banned from admin page') on conflict do nothing;
      update public.library_guides set hidden = true where publisher = v_pub and not protected;
    when 'unban' then delete from public.library_bans where client = v_pub;
    else perform library_private.fail('PT400', 'Unknown action.', 'action');
  end case;
  return json_build_object('ok', true);
end $$;

create function public.admin_blocklist(p_key text, p_add text default null, p_remove text default null)
returns json language plpgsql security definer set search_path = public, pg_catalog as $$
declare r json;
begin
  perform library_private.admin_check(p_key);
  if coalesce(btrim(p_add), '') <> '' then
    if lower(btrim(p_add)) !~ '^[a-z0-9]+( [a-z0-9]+)*$' or char_length(btrim(p_add)) not between 2 and 40 then
      perform library_private.fail('PT400', 'Blocked words can only use letters, numbers and single spaces (2–40 characters).', 'term');
    end if;
    insert into public.library_blocklist (term) values (lower(btrim(p_add))) on conflict do nothing;
  end if;
  if coalesce(btrim(p_remove), '') <> '' then delete from public.library_blocklist where term = lower(btrim(p_remove)); end if;
  select coalesce(json_agg(term order by term), '[]'::json) into r from public.library_blocklist;
  return r;
end $$;

-- Read or change limits. Only the listed numeric settings can be changed.
create function public.admin_settings(p_key text, p_changes jsonb default '{}')
returns json language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  k text;
  r json;
begin
  perform library_private.admin_check(p_key);
  for k in select jsonb_object_keys(coalesce(p_changes, '{}'::jsonb)) loop
    if k not in ('pow_bits', 'publish_per_client_hour', 'publish_global_hour', 'publish_global_day',
                 'report_per_client_day', 'hide_after_reports', 'max_library_mb', 'max_photos', 'max_photo_kb')
       or jsonb_typeof(p_changes -> k) <> 'number' or (p_changes ->> k) !~ '^[0-9]+$' then
      perform library_private.fail('PT400', 'Unknown or invalid setting: ' || left(k, 40), 'setting');
    end if;
    execute format('update public.library_settings set %I = $1', k) using (p_changes ->> k)::integer;
  end loop;
  select json_build_object('pow_bits', pow_bits, 'publish_per_client_hour', publish_per_client_hour,
           'publish_global_hour', publish_global_hour, 'publish_global_day', publish_global_day,
           'report_per_client_day', report_per_client_day, 'hide_after_reports', hide_after_reports,
           'max_library_mb', max_library_mb, 'max_photos', max_photos, 'max_photo_kb', max_photo_kb,
           'library_mb', round(pg_total_relation_size('public.library_guides') / 1048576.0, 1),
           'guides', (select count(*) from public.library_guides))
    into r from public.library_settings;
  return r;
end $$;

-- Shows which network header identified you, to confirm per-network limits work on this host.
create function public.admin_whoami(p_key text)
returns json language plpgsql security definer set search_path = public, pg_catalog as $$
declare h json := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json;
begin
  perform library_private.admin_check(p_key);
  return json_build_object(
    'source', case when coalesce(h ->> 'cf-connecting-ip', '') <> '' then 'cf-connecting-ip'
                   when coalesce(h ->> 'x-forwarded-for', '') <> '' then 'x-forwarded-for'
                   when coalesce(h ->> 'x-real-ip', '') <> '' then 'x-real-ip' else 'none' end,
    'cf_connecting_ip', h ->> 'cf-connecting-ip', 'x_forwarded_for', h ->> 'x-forwarded-for', 'x_real_ip', h ->> 'x-real-ip',
    'client', left(library_private.client(), 10));
end $$;

-- ------------------------------------------------------ permissions
-- Helpers: nobody but the owner. (Supabase grants new functions to anon by default, so revoke explicitly.)
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'library_private' loop
    execute 'revoke all on function ' || f.sig || ' from public';
    begin execute 'revoke all on function ' || f.sig || ' from anon, authenticated'; exception when undefined_object then null; end;
  end loop;
end $$;
do $$ begin
  execute 'revoke all on schema library_private from anon, authenticated';
exception when undefined_object then null; end $$;
grant execute on function public.search_guides(text, integer, integer), public.get_guide(uuid), public.get_challenge(),
  public.publish_guide(uuid, text, jsonb, text, text), public.unpublish_guide(uuid, text), public.count_download(uuid),
  public.report_guide(uuid, text, text, text), public.admin_queue(text, text, text), public.admin_act(text, uuid, text),
  public.admin_blocklist(text, text, text), public.admin_settings(text, jsonb), public.admin_whoami(text) to public;
