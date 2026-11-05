-- Presyo Check database (Supabase project "presyo-ph").
-- This is the final state of the migrations already applied to the project;
-- keep it for reference or to recreate the database elsewhere.

-- ---------- Reference data ----------
create table public.cities (
  id text primary key,
  name text not null,
  sort_order int not null default 0
);

create table public.items (
  id text primary key,
  name text not null,
  unit text not null,
  category text not null,
  sort_order int not null default 0
);

create table public.official_prices (
  id bigint generated always as identity primary key,
  item_id text not null references public.items(id),
  channel text not null check (channel in ('palengke','supermarket','srp')),
  price numeric(10,2) not null check (price > 0),
  as_of date not null,
  source text not null,
  source_url text not null,
  note text
);
create index official_prices_item_idx on public.official_prices (item_id);

-- ---------- Community data ----------
create table public.stores (
  id uuid primary key default gen_random_uuid(),
  city_id text not null references public.cities(id),
  name text not null check (char_length(btrim(name)) between 3 and 80),
  kind text not null check (kind in ('palengke','supermarket','sari_sari','kadiwa')),
  is_seed boolean not null default false,
  hidden boolean not null default false,
  created_by_hash text,
  created_at timestamptz not null default now()
);
create unique index stores_city_name_kind_key on public.stores (city_id, lower(btrim(name)), kind);
create index stores_city_idx on public.stores (city_id);
create index stores_creator_idx on public.stores (created_by_hash, created_at desc);

create table public.price_reports (
  id bigint generated always as identity primary key,
  item_id text not null references public.items(id),
  store_id uuid not null references public.stores(id),
  price numeric(10,2) not null check (price > 0 and price <= 5000),
  observed_on date not null default ((now() at time zone 'Asia/Manila')::date),
  note text check (note is null or char_length(note) <= 140),
  hidden boolean not null default false,
  submitter_hash text,
  created_at timestamptz not null default now()
);
create index price_reports_store_item_idx on public.price_reports (store_id, item_id, observed_on desc);
create index price_reports_item_idx on public.price_reports (item_id, observed_on desc);
create index price_reports_submitter_idx on public.price_reports (submitter_hash, created_at desc);

-- ---------- Anti-spam (private schema, never exposed to the API) ----------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table private.settings (key text primary key, value text not null);
insert into private.settings (key, value) values ('ip_salt', gen_random_uuid()::text);

-- Salted hash of the visitor's IP, or null for admin SQL / migrations.
create or replace function private.client_hash()
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  raw text := nullif(current_setting('request.headers', true), '');
  headers json;
  ip text;
  salt text;
begin
  if raw is null then return null; end if;
  headers := raw::json;
  ip := btrim(split_part(coalesce(headers ->> 'x-forwarded-for', headers ->> 'x-real-ip', 'unknown'), ',', 1));
  select value into salt from private.settings where key = 'ip_salt';
  return md5(ip || ':' || salt);
end;
$$;

create or replace function private.before_price_report()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  today date := (now() at time zone 'Asia/Manila')::date;
  recent int;
begin
  new.submitter_hash := private.client_hash();
  new.hidden := false;
  new.created_at := now();
  if new.observed_on > today or new.observed_on < today - 60 then
    raise exception 'The date must be within the last 60 days' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.stores s where s.id = new.store_id and not s.hidden) then
    raise exception 'Unknown store' using errcode = 'foreign_key_violation';
  end if;
  if new.submitter_hash is not null then
    select count(*) into recent from public.price_reports
     where submitter_hash = new.submitter_hash and created_at > now() - interval '1 hour';
    if recent >= 40 then
      raise exception 'Too many reports from this connection in the last hour. Please try again later.' using errcode = 'P0001';
    end if;
    if exists (
      select 1 from public.price_reports
       where submitter_hash = new.submitter_hash and item_id = new.item_id and store_id = new.store_id
         and observed_on = new.observed_on and price = new.price and created_at > now() - interval '1 day'
    ) then
      raise exception 'You already reported this price today' using errcode = 'unique_violation';
    end if;
  end if;
  return new;
end;
$$;
create trigger price_reports_guard before insert on public.price_reports
for each row execute function private.before_price_report();

create or replace function private.before_store()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  recent int;
begin
  new.created_by_hash := private.client_hash();
  new.name := btrim(regexp_replace(new.name, '\s+', ' ', 'g'));
  new.hidden := false;
  new.created_at := now();
  if new.created_by_hash is not null then
    new.is_seed := false;
    select count(*) into recent from public.stores
     where created_by_hash = new.created_by_hash and created_at > now() - interval '1 day';
    if recent >= 10 then
      raise exception 'Too many new stores from this connection today. Please try again tomorrow.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger stores_guard before insert on public.stores
for each row execute function private.before_store();

-- ---------- Row level security ----------
alter table public.cities enable row level security;
alter table public.items enable row level security;
alter table public.official_prices enable row level security;
alter table public.stores enable row level security;
alter table public.price_reports enable row level security;

create policy "Anyone can read cities" on public.cities for select to anon, authenticated using (true);
create policy "Anyone can read items" on public.items for select to anon, authenticated using (true);
create policy "Anyone can read official prices" on public.official_prices for select to anon, authenticated using (true);
create policy "Anyone can read visible stores" on public.stores for select to anon, authenticated using (not hidden);
create policy "Anyone can add a store" on public.stores for insert to anon, authenticated with check (not hidden);
create policy "Anyone can read visible reports" on public.price_reports for select to anon, authenticated using (not hidden);
create policy "Anyone can report a price" on public.price_reports for insert to anon, authenticated with check (not hidden);

-- Column privileges: visitors never see or set moderation and hash columns.
revoke all on public.cities, public.items, public.official_prices, public.stores, public.price_reports from anon, authenticated;
grant select on public.cities, public.items, public.official_prices to anon, authenticated;
grant select (id, city_id, name, kind, is_seed, created_at) on public.stores to anon, authenticated;
grant insert (id, city_id, name, kind) on public.stores to anon, authenticated;
grant select (id, item_id, store_id, price, observed_on, note, created_at) on public.price_reports to anon, authenticated;
grant insert (item_id, store_id, price, observed_on, note) on public.price_reports to anon, authenticated;

-- Last 90 days of visible reports with their store (runs with the visitor's rights).
create view public.recent_reports with (security_invoker = true) as
select r.id, r.item_id, r.price, r.observed_on, r.note, r.created_at,
       s.id as store_id, s.name as store_name, s.kind as store_kind, s.city_id
  from public.price_reports r
  join public.stores s on s.id = r.store_id
 where r.observed_on >= ((now() at time zone 'Asia/Manila')::date - 90);
grant select on public.recent_reports to anon, authenticated;

-- Seed data (17 NCR cities, 26 items, official prices, 18 public markets) was
-- loaded separately; see the project's migration "seed_ncr_reference_data".

-- ======================================================================
-- v2 (Nov 4, 2026): barangays, more store types, fuel, DOE ranges
-- ======================================================================
create table public.barangays (
  id text primary key,
  city_id text not null references public.cities(id),
  name text not null,
  sort_order int not null default 0
);
create index barangays_city_idx on public.barangays (city_id);
alter table public.barangays enable row level security;
create policy "Anyone can read barangays" on public.barangays for select to anon, authenticated using (true);
grant select on public.barangays to anon, authenticated;

alter table public.stores add column barangay_id text references public.barangays(id);
alter table public.stores add column address text check (address is null or char_length(address) <= 120);
create index stores_barangay_idx on public.stores (barangay_id);
alter table public.stores drop constraint stores_kind_check;
alter table public.stores add constraint stores_kind_check
  check (kind in ('palengke','supermarket','grocery','convenience','sari_sari','kadiwa','gas_station'));
drop index public.stores_city_name_kind_key;
create unique index stores_city_brgy_name_kind_key
  on public.stores (city_id, coalesce(barangay_id, ''), lower(btrim(name)), kind);
grant select (id, city_id, barangay_id, name, kind, address, is_seed, created_at) on public.stores to anon, authenticated;
grant insert (id, city_id, barangay_id, name, kind, address) on public.stores to anon, authenticated;

alter table public.items add column section text not null default 'food' check (section in ('food','fuel'));

alter table public.official_prices drop constraint official_prices_channel_check;
alter table public.official_prices add constraint official_prices_channel_check
  check (channel in ('palengke','supermarket','srp','doe'));
alter table public.official_prices add column price_high numeric(10,2) check (price_high is null or price_high >= price);

-- private.before_store(): now also checks the barangay belongs to the city and tidies the address.
-- private.before_price_report(): now also refuses fuel prices at non-gas-stations and food prices at gas stations.
-- recent_reports view: now also returns barangay_id.
-- Seed data: Marikina's 16 barangays, 11 packaged goods, 6 fuels with this week's NCR ranges,
-- and 17 Marikina stores and gas stations (10 in Parang); see migration "seed_marikina_parang_and_fuel".

-- ======================================================================
-- v3 (Nov 4, 2026): store pins for the price map
-- ======================================================================
-- cities.lat/lng: approximate centre, for framing the map only.
-- stores.lat/lng (+ private location_hash, location_set_at), limited to a Metro Manila box.
-- public.set_store_location(p_store, p_lat, p_lng): SECURITY DEFINER, callable by visitors;
--   sets a pin only when the store has none, inside Metro Manila, max 20 pins per connection per day.
-- See migration "store_locations_for_map" for the full SQL.

-- v4: OpenStreetMap import (applied as migrations osm_import_setup, osm_import_function, osm_import_fix_branch, osm_import_tidy_parang)
-- extensions http + postgis (schema extensions); stores.source ('community'|'seed'|'osm'|'bplo'), stores.osm_ref (unique), stores.osm_synced_at
-- private.osm_features, private.osm_barangays (staging), private.overpass(q), private.norm(t)
-- select private.osm_import('<city id>', '<OSM city name>');   -- re-runnable; see README
-- v5: public.add_store_at(city, name, kind, lat, lng, address) adds a pinned place; barangay from private.barangay_at() (OSM shapes); near-duplicates within 60 m return the existing place
-- v6: admin page — public.admins (by email), private.is_admin(), public.am_i_admin(); public.ads (slot, dates, enabled); admin RLS on stores, price_reports, official_prices; storage bucket ad-images (public read, admin write)
