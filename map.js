import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { KINDS, withinWindow, flagReports, buildMatrix, priceTier } from './summary.js';

const db = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
const L = window.L;

const SECTIONS = {
  food: { kinds: ['palengke', 'supermarket', 'grocery', 'convenience', 'sari_sari', 'kadiwa'], windowDays: 30, noun: 'stores' },
  fuel: { kinds: ['gas_station'], windowDays: 14, noun: 'gas stations' },
};
const TIER = {
  1: { label: '₱', name: 'Budget' },
  2: { label: '₱₱', name: 'Typical' },
  3: { label: '₱₱₱', name: 'Pricier' },
  0: { label: '?', name: 'Not enough prices' },
};

const state = {
  cities: [], barangays: [], items: [], official: [], stores: [], reports: [],
  show: 'food', city: null, barangay: '', kind: '',
  placing: null, // store being placed
};

const $ = (id) => document.getElementById(id);
const todayManila = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
const shiftDate = (d, days) => {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
};
const cityById = (id) => state.cities.find((c) => c.id === id);
const brgyById = (id) => state.barangays.find((b) => b.id === id);
const cityBarangays = () => state.barangays.filter((b) => b.city_id === state.city);

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
  $('status').textContent = text;
  $('status').className = 'status ' + kind;
}

function gapText(vsAverage) {
  if (vsAverage === null) return '—';
  const pct = Math.round((vsAverage - 1) * 100);
  if (pct === 0) return 'typical';
  return pct < 0 ? `${-pct}% below` : `${pct}% above`;
}

// ---------- data ----------
async function loadReference() {
  const [cities, barangays, items, official] = await Promise.all([
    db.from('cities').select('id,name,lat,lng').order('sort_order'),
    db.from('barangays').select('id,city_id,name').order('sort_order'),
    db.from('items').select('id,name,unit,category,section').order('sort_order'),
    db.from('official_prices').select('item_id,channel,price,as_of'),
  ]);
  for (const r of [cities, barangays, items, official]) if (r.error) throw r.error;
  Object.assign(state, { cities: cities.data, barangays: barangays.data, items: items.data, official: official.data });
}

async function loadCity(cityId) {
  const since = shiftDate(todayManila(), -SECTIONS.food.windowDays);
  const [stores, reports] = await Promise.all([
    db.from('stores').select('id,name,kind,barangay_id,address,lat,lng').eq('city_id', cityId).order('name'),
    db.from('recent_reports').select('id,item_id,price,observed_on,created_at,store_id,store_kind')
      .eq('city_id', cityId).gte('observed_on', since).limit(10000),
  ]);
  if (stores.error) throw stores.error;
  if (reports.error) throw reports.error;
  state.stores = stores.data;
  state.reports = reports.data;
}

function baselineFor(itemId) {
  const rows = state.official.filter((o) => o.item_id === itemId);
  const pick = rows.find((o) => o.channel === 'palengke') || rows.find((o) => o.channel === 'srp') || rows[0];
  return pick ? Number(pick.price) : null;
}

/** Visible places with their tier, compared against each other (the selected area). */
function places() {
  const conf = SECTIONS[state.show];
  const stores = state.stores.filter((s) => conf.kinds.includes(s.kind) &&
    (!state.barangay || s.barangay_id === state.barangay) && (!state.kind || s.kind === state.kind));
  const ids = new Set(stores.map((s) => s.id));
  const today = todayManila();
  const flagged = [];
  for (const item of state.items.filter((i) => i.section === state.show)) {
    const rows = withinWindow(state.reports.filter((r) => r.item_id === item.id && ids.has(r.store_id)), today, conf.windowDays);
    flagged.push(...flagReports(rows, baselineFor(item.id)));
  }
  const m = buildMatrix(flagged);
  return stores.map((s) => {
    const sc = m.storeScore(s.id);
    return { ...s, ...sc, tier: priceTier(sc.vsAverage, sc.compared) };
  });
}

// ---------- map ----------
let map, layer, draft;

function initMap() {
  map = L.map('map', { scrollWheelZoom: false, zoomControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  layer = L.layerGroup().addTo(map);
  map.on('click', (e) => {
    if (!state.placing) return;
    if (draft) draft.setLatLng(e.latlng);
    else {
      draft = L.marker(e.latlng, { draggable: true, icon: pinIcon(0, true), keyboard: false }).addTo(map);
    }
    $('placing-save').disabled = false;
    $('placing-text').textContent = `Drag the pin if needed, then save the spot for ${state.placing.name}.`;
  });
}

function pinIcon(tier, isDraft = false) {
  const t = TIER[tier || 0];
  return L.divIcon({
    className: 'pin-wrap',
    html: `<span class="pin t${tier || 0}${isDraft ? ' draft' : ''}">${isDraft ? '📍' : t.label}</span>`,
    iconSize: null,
    iconAnchor: [18, 14],
    popupAnchor: [0, -12],
  });
}

function popupFor(p) {
  const b = brgyById(p.barangay_id);
  const t = TIER[p.tier || 0];
  const tablePage = state.show === 'fuel' ? 'gas.html' : 'index.html';
  const q = new URLSearchParams({ city: state.city });
  if (p.barangay_id) q.set('brgy', p.barangay_id);
  return el('div', { class: 'popup' },
    el('strong', { text: p.name }),
    el('div', { class: 'muted small', text: [KINDS[p.kind], b?.name, p.address].filter(Boolean).join(' · ') }),
    el('div', { class: 'popup-tier' }, el('b', { class: `pin t${p.tier || 0}`, text: t.label }), ' ', t.name,
      p.tier ? ` · usually ${gapText(p.vsAverage)} typical` : ''),
    el('div', { class: 'muted small', text: `${p.priced} reported price${p.priced === 1 ? '' : 's'}, ${p.compared} compared` }),
    el('a', { href: `${tablePage}?${q}`, text: 'See prices →' }));
}

function render() {
  const conf = SECTIONS[state.show];
  const city = cityById(state.city);
  const b = brgyById(state.barangay);
  const place = b ? `${b.name}, ${city.name}` : city.name;
  const list = places();
  const pinned = list.filter((p) => p.lat !== null && p.lng !== null);
  const rated = list.filter((p) => p.tier);

  $('title').textContent = `${state.show === 'fuel' ? 'Gas stations' : 'Stores'} in ${place}`;
  $('sub').textContent = `${list.length} ${conf.noun} · ${pinned.length} on the map · ${rated.length} with a price level`;
  $('list-title').textContent = `${state.show === 'fuel' ? 'Gas stations' : 'Places'} in ${place}`;

  layer.clearLayers();
  for (const p of pinned) {
    L.marker([p.lat, p.lng], { icon: pinIcon(p.tier), title: `${p.name}: ${TIER[p.tier || 0].name}`, riseOnHover: true })
      .bindPopup(() => popupFor(p))
      .addTo(layer);
  }
  if (pinned.length) map.fitBounds(L.latLngBounds(pinned.map((p) => [p.lat, p.lng])).pad(0.25), { maxZoom: 16 });
  else map.setView([city.lat || 14.6, city.lng || 121.03], b ? 15 : 14);

  // List: budget first, then typical, pricier, unrated
  const order = (p) => (p.tier ? p.tier : 4);
  const rows = [...list].sort((a, z) => order(a) - order(z) || (a.vsAverage ?? 9) - (z.vsAverage ?? 9) || a.name.localeCompare(z.name))
    .map((p) => {
      const t = TIER[p.tier || 0];
      const where = [!state.barangay && brgyById(p.barangay_id)?.name, p.address].filter(Boolean).join(' · ');
      const onMap = p.lat !== null
        ? el('button', { class: 'link', type: 'button', text: 'Show', onclick: () => { map.setView([p.lat, p.lng], 17); window.scrollTo({ top: $('map').offsetTop - 80, behavior: 'smooth' }); } })
        : el('button', { class: 'btn small-btn', type: 'button', text: 'Place on map', onclick: () => startPlacing(p) });
      return el('tr', {},
        el('td', {}, el('b', { class: `pin t${p.tier || 0}`, text: t.label }), el('span', { class: 'sub', text: t.name })),
        el('td', {}, el('span', { class: 'dot ' + p.kind }), p.name, el('span', { class: 'sub', text: KINDS[p.kind] + (where ? ' · ' + where : '') })),
        el('td', { class: 'num', text: p.tier ? gapText(p.vsAverage) : '—' }),
        el('td', { class: 'num hide-sm', text: String(p.priced) }),
        el('td', {}, onMap));
    });
  $('places').tBodies[0].replaceChildren(...rows);
  if (!rows.length) {
    $('places').tBodies[0].replaceChildren(el('tr', {}, el('td', { colspan: '5', class: 'muted', text: `No ${conf.noun} listed here yet. Add one from the ${state.show === 'fuel' ? 'Gas prices' : 'Food & groceries'} page.` })));
  }
}

// ---------- placing a pin ----------
function startPlacing(store) {
  stopPlacing();
  map.closePopup();
  state.placing = store;
  $('placing').hidden = false;
  $('placing-save').disabled = true;
  $('placing-text').textContent = `Tap the map where ${store.name} is.`;
  $('map').classList.add('placing-mode');
  window.scrollTo({ top: $('placing').offsetTop - 80, behavior: 'smooth' });
}

function stopPlacing() {
  state.placing = null;
  if (draft) { draft.remove(); draft = null; }
  $('placing').hidden = true;
  $('map').classList.remove('placing-mode');
}

async function savePlacing() {
  if (!state.placing || !draft) return;
  const { lat, lng } = draft.getLatLng();
  const btn = $('placing-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  const name = state.placing.name;
  const { error } = await db.rpc('set_store_location', { p_store: state.placing.id, p_lat: lat, p_lng: lng });
  btn.textContent = 'Save this spot';
  if (error) {
    btn.disabled = false;
    $('placing-text').textContent = error.message;
    return;
  }
  stopPlacing();
  await loadCity(state.city);
  render();
  setStatus(`Salamat! ${name} is now on the map.`, 'ok');
}

// ---------- pickers & navigation ----------
function renderPickers() {
  $('show').value = state.show;
  const city = $('city');
  city.replaceChildren(...state.cities.map((c) => el('option', { value: c.id, text: c.name })));
  city.value = state.city;
  city.disabled = false;
  renderBarangayPicker();
  renderKindPicker();
}

function renderBarangayPicker() {
  const list = cityBarangays();
  $('barangay-field').hidden = list.length === 0;
  $('barangay').replaceChildren(el('option', { value: '', text: 'All barangays' }), ...list.map((b) => el('option', { value: b.id, text: b.name })));
  $('barangay').value = state.barangay;
  $('barangay').disabled = list.length === 0;
}

function renderKindPicker() {
  const kinds = SECTIONS[state.show].kinds;
  $('kind-field').hidden = kinds.length < 2;
  $('kind').replaceChildren(el('option', { value: '', text: 'All store types' }), ...kinds.map((k) => el('option', { value: k, text: KINDS[k] })));
  if (!kinds.includes(state.kind)) state.kind = '';
  $('kind').value = state.kind;
}

function syncUrl() {
  const p = new URLSearchParams({ show: state.show, city: state.city });
  if (state.barangay) p.set('brgy', state.barangay);
  if (state.kind) p.set('type', state.kind);
  history.replaceState(null, '', '?' + p.toString());
  const place = new URLSearchParams({ city: state.city });
  if (state.barangay) place.set('brgy', state.barangay);
  document.querySelectorAll('.tab[data-page]').forEach((a) => { a.href = a.dataset.page + '?' + place; });
  try {
    localStorage.setItem('presyo.city', state.city);
    localStorage.setItem('presyo.brgy', state.barangay);
  } catch { /* storage unavailable */ }
}

async function selectCity(cityId, barangayId = '') {
  stopPlacing();
  state.city = cityId;
  state.barangay = barangayId && brgyById(barangayId)?.city_id === cityId ? barangayId : '';
  $('city').value = cityId;
  renderBarangayPicker();
  syncUrl();
  setStatus('Loading…');
  try {
    await loadCity(cityId);
    setStatus('');
    render();
  } catch (e) {
    setStatus('Could not load the map data. Check your connection and try again.', 'err');
    console.error(e);
  }
}

function update(key, value) {
  stopPlacing();
  state[key] = value;
  if (key === 'show') renderKindPicker();
  syncUrl();
  render();
}

async function init() {
  if (!L) {
    setStatus('The map could not load. Check your connection and refresh.', 'err');
    return;
  }
  initMap();
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
  state.show = params.get('show') === 'fuel' ? 'fuel' : 'food';
  const city = [params.get('city'), savedCity, 'marikina'].find((c) => c && cityById(c)) || state.cities[0].id;
  const brgy = params.has('city') ? params.get('brgy') : (savedCity ? savedBrgy : 'marikina-parang');
  state.kind = params.get('type') || '';
  state.city = city;
  state.barangay = brgy && brgyById(brgy)?.city_id === city ? brgy : '';
  renderPickers();

  $('show').addEventListener('change', (e) => update('show', e.target.value));
  $('city').addEventListener('change', (e) => selectCity(e.target.value));
  $('barangay').addEventListener('change', (e) => update('barangay', e.target.value));
  $('kind').addEventListener('change', (e) => update('kind', e.target.value));
  $('placing-cancel').addEventListener('click', stopPlacing);
  $('placing-save').addEventListener('click', savePlacing);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.placing) stopPlacing(); });

  await selectCity(state.city, state.barangay);
}

init();
