import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { KINDS, withinWindow, flagReports, buildMatrix, orderStores, priceTier } from './summary.js';

const db = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

// Each page (index.html = food, gas.html = fuel) sets data-section on <body>.
const SECTION = document.body.dataset.section === 'fuel' ? 'fuel' : 'food';
const CONF = {
  food: {
    kinds: ['palengke', 'supermarket', 'grocery', 'convenience', 'sari_sari', 'kadiwa'],
    windowDays: 30,
    storeWord: 'store',
    itemWord: 'product',
  },
  fuel: {
    kinds: ['gas_station'],
    windowDays: 14,
    storeWord: 'station',
    itemWord: 'fuel',
  },
}[SECTION];

const state = {
  cities: [],
  barangays: [],
  items: [],
  official: [],
  stores: [],
  reports: [],
  city: null,
  barangay: '',
  category: '',
  kind: '',
  sortItem: null,
};

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const peso = (v) => '₱' + Number(v).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const UNIT = { kg: 'per kg', piece: 'per piece', liter: 'per liter', bundle: 'per bundle', can: 'per can', sachet: 'per sachet', pack: 'per pack', loaf: 'per loaf', bottle: 'per bottle' };
const unitLabel = (u) => UNIT[u] || 'per ' + u;
const todayManila = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
const fmtDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
const shiftDate = (d, days) => {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
};
const OFFICIAL_LABEL = { palengke: 'DA wet market', supermarket: 'SRA supermarket', srp: 'DTI SRP', doe: 'DOE NCR range' };

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
const brgyById = (id) => state.barangays.find((b) => b.id === id);
const cityBarangays = () => state.barangays.filter((b) => b.city_id === state.city);
const officialFor = (itemId) => state.official.filter((o) => o.item_id === itemId);

function baselineFor(itemId) {
  const rows = officialFor(itemId);
  const pick = rows.find((o) => o.channel === 'palengke') || rows.find((o) => o.channel === 'srp') || rows[0];
  return pick ? Number(pick.price) : null;
}

function officialText(o) {
  const amount = o.price_high ? `${peso(o.price)}–${peso(o.price_high)}` : peso(o.price);
  return `${OFFICIAL_LABEL[o.channel]} ${amount}`;
}

function placeName() {
  const city = cityById(state.city);
  const b = brgyById(state.barangay);
  return b ? `${b.name}, ${city.name}` : city.name;
}

// ---------- data ----------
async function loadReference() {
  const [cities, barangays, items, official] = await Promise.all([
    db.from('cities').select('id,name').order('sort_order'),
    db.from('barangays').select('id,city_id,name').order('sort_order'),
    db.from('items').select('id,name,unit,category,section').eq('section', SECTION).order('sort_order'),
    db.from('official_prices').select('item_id,channel,price,price_high,as_of,source,source_url,note'),
  ]);
  for (const r of [cities, barangays, items, official]) if (r.error) throw r.error;
  state.cities = cities.data;
  state.barangays = barangays.data;
  state.items = items.data;
  const mine = new Set(items.data.map((i) => i.id));
  const latest = new Map();
  for (const o of official.data) {
    if (!mine.has(o.item_id)) continue;
    const key = o.item_id + '|' + o.channel;
    if (!latest.has(key) || o.as_of > latest.get(key).as_of) latest.set(key, o);
  }
  state.official = [...latest.values()];
}

async function loadCity(cityId) {
  const since = shiftDate(todayManila(), -CONF.windowDays);
  const [stores, reports] = await Promise.all([
    db.from('stores').select('id,name,kind,barangay_id,address').eq('city_id', cityId).in('kind', CONF.kinds).order('name'),
    db.from('recent_reports')
      .select('id,item_id,price,observed_on,note,created_at,store_id,store_name,store_kind,barangay_id')
      .eq('city_id', cityId)
      .in('store_kind', CONF.kinds)
      .gte('observed_on', since)
      .order('observed_on', { ascending: false })
      .limit(10000),
  ]);
  if (stores.error) throw stores.error;
  if (reports.error) throw reports.error;
  state.stores = stores.data;
  state.reports = reports.data;
}

function visibleStores() {
  return state.stores.filter((s) =>
    (!state.barangay || s.barangay_id === state.barangay) &&
    (!state.kind || s.kind === state.kind));
}

function visibleItems() {
  return state.items.filter((i) => !state.category || i.category === state.category);
}

function buildGrid(stores, items) {
  const storeIds = new Set(stores.map((s) => s.id));
  const today = todayManila();
  const flagged = [];
  for (const item of items) {
    const rows = withinWindow(state.reports.filter((r) => r.item_id === item.id && storeIds.has(r.store_id)), today, CONF.windowDays);
    flagged.push(...flagReports(rows, baselineFor(item.id)));
  }
  return { matrix: buildMatrix(flagged), reportCount: flagged.length };
}

// ---------- rendering ----------
function renderPickers() {
  const city = $('city');
  city.replaceChildren(...state.cities.map((c) => el('option', { value: c.id, text: c.name })));
  city.value = state.city;
  city.disabled = false;
  renderBarangayPicker();

  const cat = $('category');
  if (cat) {
    const cats = [...new Set(state.items.map((i) => i.category))];
    cat.replaceChildren(el('option', { value: '', text: 'All products' }), ...cats.map((c) => el('option', { value: c, text: c })));
    cat.value = state.category;
    cat.disabled = false;
  }
  const kind = $('kind');
  if (kind) {
    kind.replaceChildren(el('option', { value: '', text: 'All store types' }), ...CONF.kinds.map((k) => el('option', { value: k, text: KINDS[k] })));
    kind.value = state.kind;
    kind.disabled = false;
  }
  $('open-report').disabled = false;
}

function renderBarangayPicker() {
  const list = cityBarangays();
  $('barangay-field').hidden = list.length === 0;
  const sel = $('barangay');
  sel.replaceChildren(el('option', { value: '', text: 'All barangays' }), ...list.map((b) => el('option', { value: b.id, text: b.name })));
  sel.value = state.barangay;
  sel.disabled = list.length === 0;
}

function render() {
  const stores = visibleStores();
  const items = visibleItems();
  const { matrix, reportCount } = buildGrid(stores, items);
  const ordered = orderStores(stores, matrix, state.sortItem);

  $('view').hidden = false;
  $('title').textContent = SECTION === 'fuel' ? `Gas prices in ${placeName()}` : `Prices in ${placeName()}`;
  const storeWord = (n) => `${n} ${CONF.storeWord}${n === 1 ? '' : 's'}`;
  $('sub').textContent = reportCount
    ? `${storeWord(stores.length)} · ${reportCount} reported price${reportCount === 1 ? '' : 's'} in the last ${CONF.windowDays} days`
    : `${storeWord(stores.length)} listed · no prices reported in the last ${CONF.windowDays} days yet. Tap any cell to add the first one.`;

  const sortItem = state.sortItem && itemById(state.sortItem);
  $('sort-label').textContent = sortItem
    ? `${CONF.storeWord[0].toUpperCase() + CONF.storeWord.slice(1)}s sorted by ${sortItem.name} price, lowest to highest.`
    : `${CONF.storeWord[0].toUpperCase() + CONF.storeWord.slice(1)}s sorted from usually cheapest to most expensive.`;
  $('sort-reset').hidden = !sortItem;

  $('no-stores').hidden = stores.length > 0;
  $('grid-wrap').hidden = stores.length === 0;
  if (!stores.length) return;

  // Header: one column per store
  const head = el('tr', {}, el('th', { class: 'corner', scope: 'col', text: SECTION === 'fuel' ? 'Fuel' : 'Product' }));
  ordered.forEach((s, i) => {
    const { score, vsAverage, compared } = matrix.storeScore(s.id);
    const tier = priceTier(vsAverage, compared);
    const b = brgyById(s.barangay_id);
    const where = [!state.barangay && b ? b.name : null, s.address].filter(Boolean).join(' · ');
    head.append(el('th', { scope: 'col', class: 'store-col', title: s.address || '' },
      el('span', { class: 'store-name' }, el('span', { class: 'dot ' + s.kind }), s.name,
        tier ? el('b', { class: 'pin t' + tier, title: ['', 'Budget', 'Typical', 'Pricier'][tier] + ' for this area', text: '₱'.repeat(tier) }) : null),
      el('span', { class: 'store-meta', text: KINDS[s.kind] + (where ? ' · ' + where : '') }),
      score !== null && !state.sortItem
        ? el('span', { class: 'rank' + (i === 0 ? ' top' : ''), text: i === 0 ? 'Usually cheapest' : `About +${Math.round((score - 1) * 100)}% vs lowest` })
        : null));
  });
  $('grid').tHead.replaceChildren(head);

  // Body: one row per product, grouped by category when showing all
  const rows = [];
  let lastCat = null;
  for (const item of items) {
    if (!state.category && item.category !== lastCat) {
      rows.push(el('tr', { class: 'cat' }, el('th', { scope: 'rowgroup', class: 'cat-label', text: item.category }), el('td', { colspan: String(ordered.length) })));
      lastCat = item.category;
    }
    const row = matrix.row(item.id);
    const off = officialFor(item.id);
    const isSorted = state.sortItem === item.id;
    const tr = el('tr', { class: isSorted ? 'sorted' : '' },
      el('th', { scope: 'row', class: 'item-col' },
        el('button', {
          class: 'item-btn', type: 'button', 'aria-pressed': isSorted ? 'true' : 'false',
          title: `Sort ${CONF.storeWord}s by ${item.name} price`,
          onclick: () => setSort(isSorted ? null : item.id),
        }, item.name, el('span', { class: 'sort-ind', 'aria-hidden': 'true', text: isSorted ? ' ▲' : '' })),
        el('span', { class: 'sub', text: unitLabel(item.unit) }),
        ...off.map((o) => el('a', { class: 'official', href: o.source_url, target: '_blank', rel: 'noopener', title: `${o.source}, ${fmtDate(o.as_of)}${o.note ? ' · ' + o.note : ''}`, text: officialText(o) }))));
    for (const s of ordered) {
      const c = matrix.cell(item.id, s.id);
      if (!c) {
        tr.append(el('td', { class: 'price blank' },
          el('button', { type: 'button', class: 'add', 'aria-label': `Add ${item.name} price at ${s.name}`, onclick: () => openReport({ storeId: s.id, itemId: item.id }), text: '+' })));
        continue;
      }
      let cls = 'price';
      if (c.suspicious) cls += ' sus';
      else if (row.min !== null && c.price === row.min) cls += ' best';
      else if (row.max !== null && c.price === row.max && row.max !== row.min) cls += ' worst';
      const tip = [`${s.name}: ${peso(c.price)} ${unitLabel(item.unit)}`, `Reported ${fmtDate(c.observed_on)}`,
        c.count > 1 ? `${c.count} reports in the last ${CONF.windowDays} days` : null,
        c.note ? `Note: ${c.note}` : null, c.suspicious ? 'Looks unusual, left out of the comparison' : null].filter(Boolean).join('\n');
      tr.append(el('td', { class: cls, title: tip },
        el('button', { type: 'button', class: 'cell-btn', onclick: () => openReport({ storeId: s.id, itemId: item.id }), 'aria-label': tip.replace(/\n/g, '. ') },
          el('span', { class: 'amt', text: peso(c.price) }),
          el('span', { class: 'when', text: fmtDate(c.observed_on) }))));
    }
    rows.push(tr);
  }
  $('grid').tBodies[0].replaceChildren(...rows);
}

// ---------- navigation ----------
function syncUrl() {
  const p = new URLSearchParams();
  p.set('city', state.city);
  if (state.barangay) p.set('brgy', state.barangay);
  if (state.category) p.set('cat', state.category);
  if (state.kind) p.set('type', state.kind);
  if (state.sortItem) p.set('sort', state.sortItem);
  history.replaceState(null, '', '?' + p.toString());
  // Keep the place when switching between the food and gas pages.
  const place = new URLSearchParams({ city: state.city });
  if (state.barangay) place.set('brgy', state.barangay);
  document.querySelectorAll('.tab[data-page]').forEach((a) => {
    const q = new URLSearchParams(place);
    if (a.dataset.page === 'map.html') q.set('show', SECTION);
    a.href = a.dataset.page + '?' + q.toString();
  });
  try {
    localStorage.setItem('presyo.city', state.city);
    localStorage.setItem('presyo.brgy', state.barangay);
  } catch { /* storage unavailable */ }
}

async function selectCity(cityId, barangayId = '') {
  state.city = cityId;
  state.barangay = barangayId && brgyById(barangayId)?.city_id === cityId ? barangayId : '';
  $('city').value = cityId;
  renderBarangayPicker();
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

function setFilter(key, value) {
  state[key] = value;
  if (key === 'category' && state.sortItem && itemById(state.sortItem)?.category !== value && value) state.sortItem = null;
  syncUrl();
  render();
}

function setSort(itemId) {
  state.sortItem = itemId;
  syncUrl();
  render();
  $('grid-wrap').scrollLeft = 0;
}

// ---------- reporting ----------
function storeLabel(s) {
  const b = brgyById(s.barangay_id);
  return s.name + (b && !state.barangay ? ` (${b.name})` : '');
}

function openReport({ storeId = '', itemId = '', newStore = false } = {}) {
  $('report-place').textContent = placeName();
  const pool = state.stores.filter((s) => !state.barangay || s.barangay_id === state.barangay || !s.barangay_id);
  const groups = CONF.kinds.map((k) => {
    const list = pool.filter((s) => s.kind === k);
    return list.length ? el('optgroup', { label: KINDS[k] }, ...list.map((s) => el('option', { value: s.id, text: storeLabel(s) }))) : null;
  }).filter(Boolean);
  const storeSel = $('report-store');
  storeSel.replaceChildren(el('option', { value: '', text: `Choose a ${CONF.storeWord}…` }), ...groups,
    el('option', { value: '__new', text: `+ Add a ${CONF.storeWord} not listed` }));
  storeSel.value = newStore ? '__new' : storeId;
  showNewStore(storeSel.value === '__new');

  $('store-kind').replaceChildren(...CONF.kinds.map((k) => el('option', { value: k, text: KINDS[k] })));
  if (state.kind) $('store-kind').value = state.kind;
  const brgys = cityBarangays();
  $('store-brgy-field').hidden = brgys.length === 0;
  $('store-brgy').replaceChildren(el('option', { value: '', text: 'Not sure' }), ...brgys.map((b) => el('option', { value: b.id, text: b.name })));
  $('store-brgy').value = state.barangay;
  $('store-name').value = '';
  $('store-address').value = '';

  const itemSel = $('report-item');
  const cats = [...new Set(state.items.map((i) => i.category))];
  itemSel.replaceChildren(...cats.map((c) => el('optgroup', { label: c },
    ...state.items.filter((i) => i.category === c).map((i) => el('option', { value: i.id, text: i.name })))));
  itemSel.value = itemId || state.sortItem || visibleItems()[0]?.id || state.items[0].id;
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
  (storeSel.value && storeSel.value !== '__new' ? $('report-price') : storeSel.value === '__new' ? $('store-name') : storeSel).focus();
}

function showNewStore(show) {
  $('new-store').hidden = !show;
}

function updateUnit() {
  const item = itemById($('report-item').value);
  $('report-unit').textContent = item ? unitLabel(item.unit) : '';
}

async function findOrCreateStore() {
  const name = $('store-name').value.trim().replace(/\s+/g, ' ');
  const kind = $('store-kind').value;
  const barangayId = $('store-brgy').value || null;
  const address = $('store-address').value.trim() || null;
  if (name.length < 3) throw new Error(`Please enter the ${CONF.storeWord} name (at least 3 letters).`);
  const same = (s) => s.kind === kind && (s.barangay_id || null) === barangayId && s.name.toLowerCase() === name.toLowerCase();
  const existing = state.stores.find(same);
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  const { error } = await db.from('stores').insert({ id, city_id: state.city, barangay_id: barangayId, name, kind, address });
  if (!error) return id;
  if (error.code === '23505') {
    await loadCity(state.city);
    const hit = state.stores.find(same);
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
  const min = Number($('report-price').min), max = Number($('report-price').max);
  if (!storeChoice) { errBox.textContent = `Choose a ${CONF.storeWord}, or add one.`; return; }
  if (!(price >= min && price <= max)) { errBox.textContent = `Enter a price between ${peso(min)} and ${peso(max)}.`; return; }
  if (!date || date > $('report-date').max || date < $('report-date').min) { errBox.textContent = 'Pick a date within the last 60 days.'; return; }

  const submit = $('report-submit');
  submit.disabled = true;
  submit.textContent = 'Sending…';
  try {
    const storeId = storeChoice === '__new' ? await findOrCreateStore() : storeChoice;
    const note = $('report-note').value.trim();
    const { error } = await db.from('price_reports').insert({
      item_id: $('report-item').value,
      store_id: storeId,
      price: Math.round(price * 100) / 100,
      observed_on: date,
      note: note || null,
    });
    if (error) throw new Error(error.message);
    $('report-dialog').close();
    await loadCity(state.city);
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
  let savedCity = null, savedBrgy = null;
  try {
    savedCity = localStorage.getItem('presyo.city');
    savedBrgy = localStorage.getItem('presyo.brgy');
  } catch { /* storage unavailable */ }
  const hasParams = params.has('city');
  const city = [params.get('city'), savedCity, 'marikina'].find((c) => c && cityById(c)) || state.cities[0].id;
  const brgy = hasParams ? params.get('brgy') : (savedCity ? savedBrgy : 'marikina-parang');
  state.category = params.get('cat') && state.items.some((i) => i.category === params.get('cat')) ? params.get('cat') : '';
  state.kind = CONF.kinds.includes(params.get('type')) ? params.get('type') : '';
  state.sortItem = itemById(params.get('sort')) ? params.get('sort') : null;
  state.city = city;
  state.barangay = brgy && brgyById(brgy)?.city_id === city ? brgy : '';
  renderPickers();

  $('city').addEventListener('change', (e) => selectCity(e.target.value));
  $('barangay').addEventListener('change', (e) => setFilter('barangay', e.target.value));
  $('category')?.addEventListener('change', (e) => setFilter('category', e.target.value));
  $('kind')?.addEventListener('change', (e) => setFilter('kind', e.target.value));
  $('sort-reset').addEventListener('click', () => setSort(null));
  $('open-report').addEventListener('click', () => openReport());
  $('add-first-store').addEventListener('click', () => openReport({ newStore: true }));
  $('report-cancel').addEventListener('click', () => $('report-dialog').close());
  $('report-item').addEventListener('change', updateUnit);
  $('report-store').addEventListener('change', (e) => {
    showNewStore(e.target.value === '__new');
    if (e.target.value === '__new') $('store-name').focus();
  });
  $('report-form').addEventListener('submit', submitReport);

  await selectCity(state.city, state.barangay);
}

init();
