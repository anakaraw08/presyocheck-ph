# Presyo Check

A small website where anyone can compare and report prices store by store, down to the barangay.

- **Food & groceries** (`index.html`): palengke, supermarkets, small groceries, convenience stores,
  sari-sari and Kadiwa stores. Official reference: DA Bantay Presyo, SRA sugar monitoring, DTI SRP.
- **Gas prices** (`gas.html`): gas stations, with this week's DOE-based Metro Manila range per fuel.
- **Price map** (`map.html`): every store or station as a pin marked ₱ budget, ₱₱ typical or ₱₱₱ pricier.
  A place's level is its usual gap from the area's middle (median) price across products with at least
  two reported prices: more than 5% below is ₱, within 5% is ₱₱, more than 5% above is ₱₱₱
  (`TIER_BAND` and `MIN_COMPARED` in `summary.js`). Visitors pin stores themselves with "Place on map";
  a pin can be set once per store, inside Metro Manila, up to 20 per connection per day.

Each page is a table with a row per product and a column per store. Stores are sorted from usually
cheapest to most expensive; tap a product to sort them by that product's price, lowest first. The
lowest price in each row is green, the highest red. Tap an empty cell to add a price for that store.

## How it is put together

| File | What it does |
|---|---|
| `index.html` | Food & groceries page and the "Report a price" form |
| `gas.html` | Gas prices page (same layout, `data-section="fuel"`) |
| `map.html`, `map.js` | Price map (Leaflet + OpenStreetMap tiles) |
| `styles.css` | Styling (light and dark mode, phone-friendly) |
| `app.js` | Loads data from Supabase, draws the comparison table, sends reports (shared by both pages) |
| `summary.js` | Pure functions: time window, unusual-price filter, price grid, store ranking |
| `ads.js` | Ad slots and the pop-up ad (edit `AD_CONFIG` to add real ads) |
| `config.js` | Supabase project URL and publishable key |
| `supabase/schema.sql` | The database: tables, security rules, anti-spam limits |

The database is the Supabase project **presyo-ph** (org "children of the sun", Singapore region).

- Visitors need no login. They can read prices, add a store, and report a price.
- They cannot edit or delete anything, and cannot see the moderation columns.
- Each connection can send up to 40 reports per hour and add up to 10 stores per day.
  Duplicate reports of the same price on the same day are refused.
- Reports must be dated within the last 60 days, between ₱0.25 and ₱5,000 per unit.
- Fuel prices can only be reported at gas stations, and food prices only at stores and markets.

## Adding barangays and stores

Marikina's 16 barangays are loaded. For another city, add its barangays in the SQL editor:

```sql
insert into barangays (id, city_id, name, sort_order) values
('pasig-kapitolyo', 'pasig', 'Kapitolyo', 1);
```

Visitors can add stores themselves from the report form (name, type, barangay, street).

### Importing stores from OpenStreetMap

Supermarkets, groceries, convenience stores, markets and gas stations come from OpenStreetMap,
with their map pins, street and barangay (worked out from OSM's barangay boundaries). Run the
import from the SQL editor; running it again updates what's there and adds new places without
duplicating:

```sql
select private.osm_import('marikina', 'Marikina');   -- city id here, city name as OSM spells it
```

It links OSM places to stores already listed when the name matches, or when exactly one store of
the same brand and type is in that barangay, and only fills a pin or street that's empty. Places
with no name in OSM are skipped. Rows it added have `source = 'osm'` and an `osm_ref` such as
`node/123`. Other cities need their barangays in the `barangays` table first. The data is under the
ODbL licence, so keep the "OpenStreetMap contributors" credit in the page footers. Fixes are best
made on openstreetmap.org itself, so they reach everyone and come back on the next import.

The seeded stores came from public business directories, so check them on the ground:

```sql
-- Fix a wrong map pin (visitors can't move pins once set)
update stores set lat = 14.6612, lng = 121.1101 where id = '...';
-- Rename or move a store
update stores set name = 'Puregold Extra Parang', barangay_id = 'marikina-parang' where id = '...';
```

## Ads

Each page has two banner slots (`<aside data-ad="top">`, `<aside data-ad="bottom">`) and a pop-up ad
shown shortly after the page opens. The pop-up closes with ✕, Esc or a tap outside it, and is shown
once per browser session (`onceEvery: 'load'` shows it on every page load). Tapping any ad follows
its `href`. All of them are placeholders until you set `image` and `href` in `AD_CONFIG` in `ads.js`;
external links open in a new tab marked `rel="sponsored"`. Put your contact in the footer's
"Advertise here" line (`[YOUR EMAIL OR PAGE]` in each page).

## Run it on your computer

ES modules don't load from `file://`, so serve the folder:

```
cd presyo-check
python3 -m http.server 8000
```

Then open http://localhost:8000

## Put it online (free)

Any static host works, because there is no server code.

- **Netlify Drop**: go to https://app.netlify.com/drop and drag the `presyo-check` folder onto the page.
- **GitHub Pages**: push these files to a repository, then Settings → Pages → Deploy from branch → `main` / root.
- **Cloudflare Pages**: create a project, upload the folder.

## Moderation

Bad reports are hidden, never deleted. In the Supabase SQL editor:

```sql
-- See the latest reports
select r.id, i.name as item, s.name as store, s.city_id, r.price, r.observed_on, r.note
from price_reports r join items i on i.id = r.item_id join stores s on s.id = r.store_id
order by r.created_at desc limit 50;

-- Hide one report, or a spam store
update price_reports set hidden = true where id = 123;
update stores set hidden = true where id = '...';
```

## Updating official prices

Add a new row when DA, SRA, DTI or DOE publish newer figures; the site shows the most
recent one per item and channel (`palengke`, `supermarket`, `srp`, or `doe` for fuel).
Fuel prices change every Tuesday, so update the DOE ranges weekly:

```sql
insert into official_prices (item_id, channel, price, price_high, as_of, source, source_url, note)
values ('fuel_diesel', 'doe', 87.90, 97.30, '2026-11-10', 'DOE NCR price monitoring', 'https://doe.gov.ph/', 'Week of Nov 10–16, 2026');
```

For food:

```sql
insert into official_prices (item_id, channel, price, as_of, source, source_url, note)
values ('tomato', 'palengke', 98.50, '2026-11-10', 'DA Bantay Presyo, NCR', 'https://www.da.gov.ph/price-monitoring/', '15–18 pcs/kg');
```
