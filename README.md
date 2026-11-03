# Presyo Check

A small website where anyone can check and report grocery prices at palengke,
supermarkets, sari-sari stores and Kadiwa stores in each Metro Manila city.
Community reports are shown next to official prices (DA Bantay Presyo, SRA, DTI SRP).

## How it is put together

| File | What it does |
|---|---|
| `index.html` | Page layout and the "Report a price" form |
| `styles.css` | Styling (light and dark mode, phone-friendly) |
| `app.js` | Loads data from Supabase, draws the city and item views, sends reports |
| `summary.js` | Pure functions: 30-day window, medians per store type, unusual-price filter |
| `config.js` | Supabase project URL and publishable key |
| `supabase/schema.sql` | The database: tables, security rules, anti-spam limits |

The database is the Supabase project **presyo-ph** (org "children of the sun", Singapore region).

- Visitors need no login. They can read prices, add a store, and report a price.
- They cannot edit or delete anything, and cannot see the moderation columns.
- Each connection can send up to 40 reports per hour and add up to 10 stores per day.
  Duplicate reports of the same price on the same day are refused.
- Reports must be dated within the last 60 days, between ₱0.25 and ₱5,000 per unit.

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

Add a new row when DA, SRA or DTI publish newer figures; the site shows the most
recent one per item and channel (`palengke`, `supermarket` or `srp`):

```sql
insert into official_prices (item_id, channel, price, as_of, source, source_url, note)
values ('tomato', 'palengke', 98.50, '2026-11-10', 'DA Bantay Presyo, NCR', 'https://www.da.gov.ph/price-monitoring/', '15–18 pcs/kg');
```
