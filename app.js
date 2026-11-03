import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { KINDS, WINDOW_DAYS, withinWindow, flagReports, summarizeByKind, latestByStore } from './summary.js';

const db = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const state = {
  cities: [],
  items: [],
  official: [],
  stores: [],
  reports: [],
  city: null,
  item: '',
};

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const peso = (v) => '₱' + Number(v).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const UNIT = { kg: 'per kg', piece: 'per piece', liter: 'per liter', bundle: 'per bundle', can: 'per can', sachet: 'per sachet', pack: 'per pack' };
const unitLabel = (u) => UNIT[u] || 'per ' + u;
const todayManila = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
const fmtDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
const shiftDate = (d, days) => {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
};
const OFFICIAL_LABEL = { palengke: 'DA wet market (NCR)', supermarket: 'SRA supermarket avg', srp: 'DTI suggested price' };
// Which official figure a store type is compared against, in order of preference.
// The DA wet market price is the fallback for every type, so supermarkets show how far they sit above it.
const COMPARE = {
  palengke: ['palengke', 'srp'],
  supermarket: ['supermarket', 'srp', 'palengke'],
  sari_sari: ['srp', 'palengke'],
  kadiwa: ['palengke', 'srp'],
};

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
}

function setStatus(text, kind = '') {
  const s = $('status');
  s.textContent = text;
  s.className = 'status ' + kind;
}

const itemById = (id) => state.items.find((i) => i.id === id);
const cityById = (id) => state.cities.find((c) => c.id === id);
const officialFor = (itemId) => state.official.filter((o) => o.item_id === itemId);

function officialForKind(itemId, kind) {
  const rows = officialFor(itemId);
  for (const ch of COMPARE[kind] || []) {
    const hit = rows.find((o) => o.channel === ch);
    if (hit) return hit;
  }
  return null;
}

// One number per item for the "is this report plausible?" check.
function baselineFor(itemId) {
  const rows = officialFor(itemId);
  const pick = rows.find((o) => o.channel === 'palengke') || rows.find((o) => o.channel === 'srp') || rows[0];
  return pick ? Number(pick.price) : null;
}

function diffNode(price, official) {
  if (!official || price === null || price === undefined) return el('span', { class: 'none', text: '—' });
  const pct = (price - Number(official.price)) / Number(official.price);
  const rounded = Math.round(pct * 100);
  const title = `Compared with the ${OFFICIAL_LABEL[official.channel]} price of ${peso(official.price)}`;
  if (rounded === 0) return el('span', { title, text: 'about the same' });
  return el('span', { title, class: rounded > 0 ? 'up' : 'down', text: (rounded > 0 ? '+' : '−') + Math.abs(rounded) + '%' });
}

// ---------- data ----------
async function loadReference() {
  const [cities, items, official] = await Promise.all([
    db.from('cities').select('id,name').order('sort_order'),
    db.from('items').select('id,name,unit,category').order('sort_order'),
    db.from('official_prices').select('item_id,channel,price,as_of,source,source_url,note'),
  ]);
  for (const r of [cities, items, official]) if (r.error) throw r.error;
  state.cities = cities.data;
  state.items = items.data;
  // Keep only the most recent official figure per item and channel.
  const latest = new Map();
  for (const o of official.data) {
    const key = o.item_id + '|' + o.channel;
    if (!latest.has(key) || o.as_of > latest.get(key).as_of) latest.set(key, o);
  }
  state.official = [...latest.values()];
}

async function loadCity(cityId) {
  const since = shiftDate(todayManila(), -WINDOW_DAYS);
  const [stores, reports] = await Promise.all([
    db.from('stores').select('id,name,kind').eq('city_id', cityId).order('name'),
    db.from('recent_reports')
      .select('id,item_id,price,observed_on,note,created_at,store_id,store_name,store_kind')
      .eq('city_id', cityId)
      .gte('observed_on', since)
      .order('observed_on', { ascending: false })
      .limit(5000),
  ]);
  if (stores.error) throw stores.error;
  if (reports.error) throw reports.error;
  state.stores = stores.data;
  state.reports = reports.data;
}

function reportsFor(itemId) {
  const rows = withinWindow(state.reports.filter((r) => r.item_id === itemId), todayManila());
  return flagReports(rows, baselineFor(itemId));
}

// ---------- rendering ----------
function renderPickers() {
  const city = $('city');
  city.replaceChildren(...state.cities.map((c) => el('option', { value: c.id, text: c.name })));
  city.value = state.city;
  city.disabled = false;

  const item = $('item');
  const groups = new Map();
  for (const i of state.items) {
    if (!groups.has(i.category)) groups.set(i.category, el('optgroup', { label: i.category }));
    groups.get(i.category).append(el('option', { value: i.id, text: i.name }));
  }
  item.replaceChildren(el('option', { value: '', text: 'All items' }), ...groups.values());
  item.value = state.item;
  item.disabled = false;
  $('open-report').disabled = false;
}

function render() {
  const city = cityById(state.city);
  if (!state.item) renderOverview(city);
  else renderItem(city, itemById(state.item));
}

function renderOverview(city) {
  $('item-view').hidden = true;
  $('city-view').hidden = false;
  $('city-title').textContent = `Prices in ${city.name}`;
  const recent = withinWindow(state.reports, todayManila());
  const storeCount = new Set(recent.map((r) => r.store_id)).size;
  $('city-sub').textContent = recent.length
    ? `${recent.length} shopper report${recent.length === 1 ? '' : 's'} from ${storeCount} store${storeCount === 1 ? '' : 's'} in the last ${WINDOW_DAYS} days.`
    : `No shopper reports in the last ${WINDOW_DAYS} days yet. Official Metro Manila prices are shown for now; add what you paid to fill in ${city.name}.`;

  const tbody = $('overview').tBodies[0];
  const rows = [];
  let lastCat = null;
  for (const item of state.items) {
    if (item.category !== lastCat) {
      rows.push(el('tr', { class: 'cat' }, el('td', { colspan: '6', text: item.category })));
      lastCat = item.category;
    }
    const kinds = summarizeByKind(reportsFor(item.id));
    const med = (k) => {
      const hit = kinds.find((x) => x.kind === k);
      return hit && hit.median !== null ? peso(hit.median) : '—';
    };
    const total = kinds.reduce((t, k) => t + k.count, 0);
    const off = officialFor(item.id);
    const offMain = off.find((o) => o.channel === 'palengke') || off.find((o) => o.channel === 'srp') || off[0];
    rows.push(el('tr', { class: 'clickable', tabindex: '0', onclick: () => selectItem(item.id), onkeydown: (e) => { if (e.key === 'Enter') selectItem(item.id); } },
      el('td', {}, item.name, el('span', { class: 'sub', text: unitLabel(item.unit) })),
      el('td', { class: 'num' + (med('palengke') === '—' ? ' none' : ''), text: med('palengke') }),
      el('td', { class: 'num' + (med('supermarket') === '—' ? ' none' : ''), text: med('supermarket') }),
      el('td', { class: 'num hide-sm' + (med('sari_sari') === '—' ? ' none' : ''), text: med('sari_sari') }),
      el('td', { class: 'num' }, offMain ? peso(offMain.price) : el('span', { class: 'none', text: '—' }),
        offMain ? el('span', { class: 'sub', text: OFFICIAL_LABEL[offMain.channel] }) : null),
      el('td', { class: 'num hide-sm' + (total ? '' : ' none'), text: total ? String(total) : '—' }),
    ));
  }
  tbody.replaceChildren(...rows);
}

function renderItem(city, item) {
  $('city-view').hidden = true;
  $('item-view').hidden = false;
  $('item-title').textContent = `${item.name} in ${city.name}`;
  $('item-sub').textContent = `Prices ${unitLabel(item.unit)} · shopper reports from the last ${WINDOW_DAYS} days`;

  // Official reference figures
  const off = officialFor(item.id);
  $('official').replaceChildren(...off.map((o) =>
    el('span', { class: 'chip' },
      `${OFFICIAL_LABEL[o.channel]}: `, el('b', { text: peso(o.price) }),
      ` · ${fmtDate(o.as_of)} · `, el('a', { href: o.source_url, target: '_blank', rel: 'noopener', text: 'source' }))));
  if (!off.length) $('official').replaceChildren(el('span', { class: 'chip muted', text: 'No official price for this item yet' }));

  // Community summary per store type
  const flagged = reportsFor(item.id);
  const kinds = summarizeByKind(flagged);
  const priced = kinds.filter((k) => k.median !== null);
  const cheapest = priced.length > 1 ? priced.reduce((a, b) => (b.median < a.median ? b : a)).kind : null;
  $('kinds').replaceChildren(...kinds.map((k) => {
    const official = officialForKind(item.id, k.kind);
    return el('div', { class: 'kind' + (k.kind === cheapest ? ' best' : '') },
      k.kind === cheapest ? el('span', { class: 'badge', text: 'Cheapest' }) : null,
      el('div', { class: 'label' }, el('span', { class: 'dot ' + k.kind }), KINDS[k.kind]),
      el('div', { class: 'big', text: k.median !== null ? peso(k.median) : '—' }),
      el('div', { class: 'meta', text: k.median !== null
        ? `Median of ${k.count} report${k.count === 1 ? '' : 's'}` + (k.count > 1 ? ` · ${peso(k.min)}–${peso(k.max)}` : '')
        : 'Only unusual reports so far' }),
      el('div', { class: 'meta' }, official ? el('span', {}, 'vs official: ', diffNode(k.median, official)) : null,
        k.excluded ? ` · ${k.excluded} unusual left out` : ''),
    );
  }));

  const hasReports = flagged.length > 0;
  $('empty').hidden = hasReports;
  $('empty-city').textContent = city.name;
  $('stores-block').hidden = !hasReports;

  // Latest price per store
  const rows = latestByStore(flagged).map(({ latest, count }) =>
    el('tr', {},
      el('td', {},
        el('span', { class: 'dot ' + latest.store_kind }), latest.store_name,
        latest.suspicious ? el('span', { class: 'tag', title: 'Left out of the medians', text: 'unusual' }) : null,
        el('span', { class: 'sub', text: KINDS[latest.store_kind] + (latest.note ? ` · “${latest.note}”` : '') })),
      el('td', { class: 'num', text: peso(latest.price) }),
      el('td', { class: 'num' }, diffNode(latest.price, officialForKind(item.id, latest.store_kind))),
      el('td', { class: 'hide-sm', text: fmtDate(latest.observed_on) }),
      el('td', { class: 'num hide-sm', text: String(count) }),
    ));
  $('stores').tBodies[0].replaceChildren(...rows);
}

// ---------- navigation ----------
function syncUrl() {
  const p = new URLSearchParams();
  p.set('city', state.city);
  if (state.item) p.set('item', state.item);
  history.replaceState(null, '', '?' + p.toString());
  try { localStorage.setItem('presyo.city', state.city); } catch { /* storage unavailable */ }
}

async function selectCity(cityId) {
  state.city = cityId;
  $('city').value = cityId;
  syncUrl();
  setStatus('Loading prices…');
  try {
    await loadCity(cityId);
    setStatus('');
    render();
  } catch (e) {
    setStatus('Could not load prices. Check your connection and try again.', 'err');
    console.error(e);
  }
}

function selectItem(itemId) {
  state.item = itemId;
  $('item').value = itemId;
  syncUrl();
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------- reporting ----------
function openReport() {
  const city = cityById(state.city);
  $('report-city').textContent = city.name;
  const storeSel = $('report-store');
  const byKind = Object.keys(KINDS).map((k) => {
    const stores = state.stores.filter((s) => s.kind === k);
    return stores.length ? el('optgroup', { label: KINDS[k] }, ...stores.map((s) => el('option', { value: s.id, text: s.name }))) : null;
  }).filter(Boolean);
  storeSel.replaceChildren(el('option', { value: '', text: 'Choose a store…' }), ...byKind,
    el('option', { value: '__new', text: '+ Add a store or market not listed' }));
  storeSel.value = '';
  $('new-store').hidden = true;

  const itemSel = $('report-item');
  itemSel.replaceChildren(...Array.from($('item').querySelectorAll('optgroup'), (g) => g.cloneNode(true)));
  itemSel.value = state.item || state.items[0].id;
  updateUnit();

  const today = todayManila();
  const date = $('report-date');
  date.value = today;
  date.max = today;
  date.min = shiftDate(today, -60);
  $('report-price').value = '';
  $('report-note').value = '';
  $('report-error').textContent = '';
  $('report-dialog').showModal();
}

function updateUnit() {
  const item = itemById($('report-item').value);
  $('report-unit').textContent = item ? unitLabel(item.unit) : '';
}

async function findOrCreateStore(name, kind) {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (clean.length < 3) throw new Error('Please enter the store name (at least 3 letters).');
  const existing = state.stores.find((s) => s.kind === kind && s.name.toLowerCase() === clean.toLowerCase());
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  const { error } = await db.from('stores').insert({ id, city_id: state.city, name: clean, kind });
  if (!error) return id;
  if (error.code === '23505') {
    // Someone else just added it: look it up.
    const { data: found } = await db.from('stores').select('id,name').eq('city_id', state.city).eq('kind', kind);
    const hit = (found || []).find((s) => s.name.toLowerCase() === clean.toLowerCase());
    if (hit) return hit.id;
  }
  throw new Error(error.message);
}

async function submitReport(ev) {
  ev.preventDefault();
  const errBox = $('report-error');
  errBox.textContent = '';
  const storeChoice = $('report-store').value;
  const price = Number($('report-price').value);
  const date = $('report-date').value;
  if (!storeChoice) { errBox.textContent = 'Choose a store, or add one.'; return; }
  if (!(price > 0 && price <= 5000)) { errBox.textContent = 'Enter a price between ₱0.25 and ₱5,000.'; return; }
  if (!date || date > $('report-date').max || date < $('report-date').min) { errBox.textContent = 'Pick a date within the last 60 days.'; return; }

  const submit = $('report-submit');
  submit.disabled = true;
  submit.textContent = 'Sending…';
  try {
    const storeId = storeChoice === '__new'
      ? await findOrCreateStore($('store-name').value, $('store-kind').value)
      : storeChoice;
    const itemId = $('report-item').value;
    const note = $('report-note').value.trim();
    const { error } = await db.from('price_reports').insert({
      item_id: itemId,
      store_id: storeId,
      price: Math.round(price * 100) / 100,
      observed_on: date,
      note: note || null,
    });
    if (error) throw new Error(error.message);
    $('report-dialog').close();
    await loadCity(state.city);
    state.item = itemId;
    $('item').value = itemId;
    syncUrl();
    render();
    setStatus('Salamat! Your price has been added.', 'ok');
  } catch (e) {
    errBox.textContent = e.message || 'Something went wrong. Please try again.';
  } finally {
    submit.disabled = false;
    submit.textContent = 'Submit price';
  }
}

// ---------- start ----------
async function init() {
  try {
    await loadReference();
  } catch (e) {
    setStatus('Could not reach the price database. Please refresh in a moment.', 'err');
    console.error(e);
    return;
  }
  const params = new URLSearchParams(location.search);
  let saved = null;
  try { saved = localStorage.getItem('presyo.city'); } catch { /* storage unavailable */ }
  const wantCity = [params.get('city'), saved, 'manila'].find((c) => c && cityById(c));
  state.city = wantCity || state.cities[0].id;
  const wantItem = params.get('item');
  state.item = wantItem && itemById(wantItem) ? wantItem : '';
  renderPickers();

  $('city').addEventListener('change', (e) => selectCity(e.target.value));
  $('item').addEventListener('change', (e) => selectItem(e.target.value));
  $('back').addEventListener('click', () => selectItem(''));
  $('open-report').addEventListener('click', openReport);
  $('empty-report').addEventListener('click', openReport);
  $('report-cancel').addEventListener('click', () => $('report-dialog').close());
  $('report-item').addEventListener('change', updateUnit);
  $('report-store').addEventListener('change', (e) => {
    const isNew = e.target.value === '__new';
    $('new-store').hidden = !isNew;
    if (isNew) $('store-name').focus();
  });
  $('report-form').addEventListener('submit', submitReport);

  await selectCity(state.city);
}

init();
