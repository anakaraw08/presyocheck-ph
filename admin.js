// Presyo Check admin: ads with run dates, report moderation, store fixes, official prices.
// Every change is checked by the database (row-level security): only emails in public.admins can write.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { KINDS } from './summary.js';

const db = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, storageKey: 'presyo-admin', autoRefreshToken: true },
});

const $ = (id) => document.getElementById(id);
const SLOT = { top: 'Top banner', bottom: 'Bottom banner', popup: 'Pop-up' };
const CHANNEL = { palengke: 'DA wet market', supermarket: 'SRA supermarket', srp: 'DTI SRP', doe: 'DOE NCR range' };
const todayManila = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
const fmtDate = (d) => (d ? new Date(d.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const peso = (v) => '₱' + Number(v).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

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
function setStatus(text, kind = '') { $('status').textContent = text; $('status').className = 'status ' + kind; }
const fail = (e) => { console.error(e); setStatus(e.message || String(e), 'err'); };

const state = { tab: 'ads', ads: [], cities: [], barangays: [], items: [], stores: [], editingAd: null };
const loaded = new Set();

// ---------- sign in ----------
async function showSignedIn(session) {
  const email = session?.user?.email;
  $('who').textContent = email || 'not signed in';
  $('sign-out').hidden = !email;
  if (!email) {
    $('admin-tabs').hidden = true;
    document.querySelectorAll('.admin-tab').forEach((t) => { t.hidden = true; });
    $('signin').hidden = false;
    return;
  }
  const { data: ok, error } = await db.rpc('am_i_admin');
  if (error || !ok) {
    $('signin').hidden = false;
    $('si-error').textContent = `${email} is not on the admin list.`;
    await db.auth.signOut();
    return;
  }
  $('signin').hidden = true;
  $('admin-tabs').hidden = false;
  await loadReference();
  openTab(location.hash.slice(1) || state.tab);
}

async function signIn(ev) {
  ev.preventDefault();
  $('si-error').textContent = '';
  const { data, error } = await db.auth.signInWithPassword({ email: $('si-email').value.trim(), password: $('si-pass').value });
  $('si-pass').value = '';
  if (error) { $('si-error').textContent = error.message; return; }
  showSignedIn(data.session);
}

async function loadReference() {
  const [cities, barangays, items] = await Promise.all([
    db.from('cities').select('id,name').order('sort_order'),
    db.from('barangays').select('id,city_id,name').order('sort_order'),
    db.from('items').select('id,name,unit,section,category').order('sort_order'),
  ]);
  for (const r of [cities, barangays, items]) if (r.error) throw r.error;
  Object.assign(state, { cities: cities.data, barangays: barangays.data, items: items.data });
}

function openTab(tab) {
  if (!['ads', 'reports', 'stores', 'official'].includes(tab)) tab = 'ads';
  state.tab = tab;
  history.replaceState(null, '', '#' + tab);
  document.querySelectorAll('#admin-tabs .tab').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  document.querySelectorAll('.admin-tab').forEach((t) => { t.hidden = t.id !== 'tab-' + tab; });
  setStatus('');
  if (!loaded.has(tab)) {
    loaded.add(tab);
    ({ ads: initAds, reports: initReports, stores: initStores, official: initOfficial })[tab]().catch(fail);
  }
}

// ---------- ads ----------
function adStatus(a, today = todayManila()) {
  if (!a.enabled) return ['off', 'Off'];
  if (today < a.starts_on) return ['scheduled', 'Scheduled'];
  if (today > a.ends_on) return ['ended', 'Ended'];
  return ['running', 'Running'];
}

async function initAds() {
  $('ad-new').addEventListener('click', () => editAd(null));
  $('ad-cancel').addEventListener('click', () => $('ad-dialog').close());
  $('ad-form').addEventListener('submit', saveAd);
  $('ad-delete').addEventListener('click', deleteAd);
  $('ad-slot').addEventListener('change', () => { $('ad-cta-field').hidden = $('ad-slot').value !== 'popup'; });
  $('ad-file').addEventListener('change', () => {
    const f = $('ad-file').files[0];
    if (f) showPreview(URL.createObjectURL(f));
  });
  $('ad-image').addEventListener('input', () => showPreview($('ad-image').value.trim()));
  await loadAds();
}

async function loadAds() {
  const { data, error } = await db.from('ads').select('*').order('ends_on', { ascending: false }).order('id', { ascending: false });
  if (error) throw error;
  state.ads = data;
  const order = { running: 0, scheduled: 1, off: 2, ended: 3 };
  const rows = [...data].sort((a, z) => order[adStatus(a)[0]] - order[adStatus(z)[0]] || a.starts_on.localeCompare(z.starts_on))
    .map((a) => {
      const [cls, label] = adStatus(a);
      return el('tr', {},
        el('td', {}, el('span', { class: 'ad-status ' + cls, text: label })),
        el('td', {},
          a.image_url ? el('img', { class: 'ad-thumb', src: a.image_url, alt: '' }) : null,
          el('strong', { text: a.name }),
          el('span', { class: 'sub', text: [a.title, a.href].filter(Boolean).join(' · ') })),
        el('td', { text: SLOT[a.slot] }),
        el('td', { text: `${fmtDate(a.starts_on)} – ${fmtDate(a.ends_on)}` }),
        el('td', {}, el('button', { class: 'btn small-btn', type: 'button', text: 'Edit', onclick: () => editAd(a) })));
    });
  $('ads-table').tBodies[0].replaceChildren(...(rows.length ? rows
    : [el('tr', {}, el('td', { colspan: '5', class: 'muted', text: 'No ads yet. Every slot shows the “Your ad here” placeholder.' }))]));
}

function showPreview(src) {
  const img = $('ad-preview');
  img.hidden = !src;
  if (src) img.src = src;
}

function editAd(a) {
  state.editingAd = a;
  const today = todayManila();
  $('ad-title').textContent = a ? `Edit ad: ${a.name}` : 'New ad';
  $('ad-name').value = a?.name || '';
  $('ad-slot').value = a?.slot || 'top';
  $('ad-start').value = a?.starts_on || today;
  $('ad-end').value = a?.ends_on || addDays(today, 29);
  $('ad-enabled').checked = a ? a.enabled : true;
  $('ad-file').value = '';
  $('ad-image').value = a?.image_url || '';
  $('ad-head').value = a?.title || '';
  $('ad-body').value = a?.body || '';
  $('ad-href').value = a?.href || '';
  $('ad-cta').value = a?.cta || '';
  $('ad-cta-field').hidden = $('ad-slot').value !== 'popup';
  $('ad-delete').hidden = !a;
  $('ad-error').textContent = '';
  showPreview(a?.image_url || '');
  $('ad-dialog').showModal();
  $('ad-name').focus();
}

async function uploadImage(file) {
  if (file.size > 2 * 1024 * 1024) throw new Error('That image is over 2 MB. Please use a smaller one.');
  const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
  const path = `${todayManila()}/${crypto.randomUUID()}.${ext}`;
  const { error } = await db.storage.from('ad-images').upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw error;
  return db.storage.from('ad-images').getPublicUrl(path).data.publicUrl;
}

async function saveAd(ev) {
  ev.preventDefault();
  const err = $('ad-error');
  err.textContent = '';
  const v = (id) => $(id).value.trim() || null;
  const row = {
    name: v('ad-name'), slot: $('ad-slot').value, starts_on: $('ad-start').value, ends_on: $('ad-end').value,
    enabled: $('ad-enabled').checked, image_url: v('ad-image'), title: v('ad-head'), body: v('ad-body'),
    href: v('ad-href'), cta: $('ad-slot').value === 'popup' ? v('ad-cta') : null,
  };
  if (!row.name) { err.textContent = 'Give the ad a label so you can find it later.'; return; }
  if (!row.starts_on || !row.ends_on) { err.textContent = 'Choose a start and end date.'; return; }
  if (row.ends_on < row.starts_on) { err.textContent = 'The end date is before the start date.'; return; }
  if (row.href && !/^https?:\/\//.test(row.href)) { err.textContent = 'The link should start with https://'; return; }
  const file = $('ad-file').files[0];
  if (!file && !row.image_url && !row.title) { err.textContent = 'Add an image or a headline.'; return; }
  const btn = $('ad-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    if (file) row.image_url = await uploadImage(file);
    row.updated_at = new Date().toISOString();
    const q = state.editingAd ? db.from('ads').update(row).eq('id', state.editingAd.id) : db.from('ads').insert(row);
    const { error } = await q;
    if (error) throw error;
    $('ad-dialog').close();
    await loadAds();
    const [, label] = adStatus(row);
    setStatus(`Saved “${row.name}”. ${label === 'Running' ? 'It is live now.' : `Status: ${label}.`}`, 'ok');
  } catch (e) {
    err.textContent = e.message || String(e);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save ad';
  }
}

async function deleteAd() {
  const a = state.editingAd;
  if (!a || !window.confirm(`Delete the ad “${a.name}”? To pause it instead, untick “Switched on”.`)) return;
  const { error } = await db.from('ads').delete().eq('id', a.id);
  if (error) { $('ad-error').textContent = error.message; return; }
  $('ad-dialog').close();
  await loadAds();
  setStatus(`Deleted “${a.name}”.`, 'ok');
}

// ---------- reports ----------
let repTimer;
async function initReports() {
  $('rep-filter').addEventListener('change', loadReports);
  $('rep-search').addEventListener('input', () => { clearTimeout(repTimer); repTimer = setTimeout(loadReports, 300); });
  await loadReports();
}

async function loadReports() {
  const q = $('rep-search').value.trim();
  let query = db.from('price_reports')
    .select(`id,price,observed_on,note,hidden,created_at,item_id,store_id,stores${q ? '!inner' : ''}(name,barangay_id)`)
    .order('created_at', { ascending: false }).limit(200);
  if ($('rep-filter').value === 'hidden') query = query.eq('hidden', true);
  if (q) query = query.ilike('stores.name', `%${q.replace(/[%_]/g, '')}%`);
  const { data, error } = await query;
  if (error) return fail(error);
  const item = (id) => state.items.find((i) => i.id === id);
  const brgy = (id) => state.barangays.find((b) => b.id === id)?.name;
  const rows = data.map((r) => {
    const it = item(r.item_id);
    return el('tr', { class: r.hidden ? 'is-hidden' : '' },
      el('td', {}, fmtDate(r.observed_on), el('span', { class: 'sub', text: 'sent ' + new Date(r.created_at).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) })),
      el('td', {}, it?.name || r.item_id, el('span', { class: 'sub', text: it ? 'per ' + it.unit : '' })),
      el('td', { class: 'num', text: peso(r.price) }),
      el('td', {}, r.stores?.name || '—', el('span', { class: 'sub', text: brgy(r.stores?.barangay_id) || '' })),
      el('td', { class: 'small', text: r.note || '' }),
      el('td', {}, el('button', {
        class: 'btn small-btn' + (r.hidden ? '' : ' danger'), type: 'button', text: r.hidden ? 'Show again' : 'Hide',
        onclick: async (e) => {
          e.target.disabled = true;
          const { error: err } = await db.from('price_reports').update({ hidden: !r.hidden }).eq('id', r.id);
          if (err) return fail(err);
          setStatus(r.hidden ? 'Report is visible again.' : 'Report hidden. It no longer counts on the site.', 'ok');
          loadReports();
        },
      })));
  });
  $('rep-table').tBodies[0].replaceChildren(...(rows.length ? rows
    : [el('tr', {}, el('td', { colspan: '6', class: 'muted', text: 'No reports match.' }))]));
}

// ---------- stores ----------
let stTimer;
async function initStores() {
  $('st-city').replaceChildren(...state.cities.map((c) => el('option', { value: c.id, text: c.name })));
  $('st-city').value = state.cities.some((c) => c.id === 'marikina') ? 'marikina' : state.cities[0]?.id;
  $('st-city').addEventListener('change', () => { fillBrgy(); loadStores(); });
  $('st-brgy').addEventListener('change', renderStores);
  $('st-hidden').addEventListener('change', renderStores);
  $('st-search').addEventListener('input', () => { clearTimeout(stTimer); stTimer = setTimeout(renderStores, 200); });
  fillBrgy();
  await loadStores();
}

const cityBrgys = () => state.barangays.filter((b) => b.city_id === $('st-city').value);
function fillBrgy() {
  $('st-brgy').replaceChildren(el('option', { value: '', text: 'All barangays' }), ...cityBrgys().map((b) => el('option', { value: b.id, text: b.name })));
}

async function loadStores() {
  const { data, error } = await db.from('stores').select('id,name,kind,barangay_id,address,lat,lng,hidden,source')
    .eq('city_id', $('st-city').value).order('name').range(0, 4999);
  if (error) return fail(error);
  state.stores = data;
  renderStores();
}

function renderStores() {
  const q = $('st-search').value.trim().toLowerCase();
  const b = $('st-brgy').value;
  const onlyHidden = $('st-hidden').checked;
  const list = state.stores.filter((s) => (!b || s.barangay_id === b) && (!q || s.name.toLowerCase().includes(q)) && (!onlyHidden || s.hidden));
  $('st-count').textContent = `${list.length} of ${state.stores.length} places in ${state.cities.find((c) => c.id === $('st-city').value)?.name}`;
  const rows = list.slice(0, 300).map(storeRow);
  if (list.length > 300) rows.push(el('tr', {}, el('td', { colspan: '6', class: 'muted', text: `Showing the first 300. Pick a barangay or search to narrow it down.` })));
  $('st-table').tBodies[0].replaceChildren(...(rows.length ? rows : [el('tr', {}, el('td', { colspan: '6', class: 'muted', text: 'No places match.' }))]));
}

function storeRow(s) {
  const name = el('input', { value: s.name, maxlength: '80', 'aria-label': 'Name' });
  const kind = el('select', { 'aria-label': 'Type' }, ...Object.entries(KINDS).map(([k, label]) => el('option', { value: k, text: label })));
  kind.value = s.kind;
  const brgy = el('select', { 'aria-label': 'Barangay' }, el('option', { value: '', text: '—' }), ...cityBrgys().map((b) => el('option', { value: b.id, text: b.name })));
  brgy.value = s.barangay_id || '';
  const addr = el('input', { value: s.address || '', maxlength: '120', 'aria-label': 'Street' });
  const save = el('button', { class: 'btn small-btn primary', type: 'button', text: 'Save', disabled: true });
  const changed = () => { save.disabled = name.value.trim() === s.name && kind.value === s.kind && (brgy.value || null) === s.barangay_id && (addr.value.trim() || null) === (s.address || null); };
  [name, addr].forEach((i) => i.addEventListener('input', changed));
  [kind, brgy].forEach((i) => i.addEventListener('change', changed));

  const update = async (patch, msg) => {
    const { error } = await db.from('stores').update(patch).eq('id', s.id);
    if (error) return fail(error);
    Object.assign(s, patch);
    setStatus(msg, 'ok');
    renderStores();
  };
  save.addEventListener('click', () => {
    if (name.value.trim().length < 2) return setStatus('The name is too short.', 'err');
    update({ name: name.value.trim(), kind: kind.value, barangay_id: brgy.value || null, address: addr.value.trim() || null }, `Saved ${name.value.trim()}.`);
  });
  const pin = s.lat != null
    ? el('span', {}, el('a', { href: `https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lng}#map=19/${s.lat}/${s.lng}`, target: '_blank', rel: 'noopener', text: 'View' }), ' ',
      el('button', { class: 'link', type: 'button', text: 'Clear', title: 'Remove the pin so a visitor can place it again', onclick: () => update({ lat: null, lng: null }, `Pin cleared for ${s.name}. Visitors can place it again on the map.`) }))
    : el('span', { class: 'muted', text: 'none' });
  return el('tr', { class: s.hidden ? 'is-hidden' : '' },
    el('td', {}, name, el('span', { class: 'sub', text: s.source === 'osm' ? 'from OpenStreetMap' : s.source === 'seed' ? 'starting list' : 'added by a visitor' })),
    el('td', {}, kind), el('td', {}, brgy), el('td', {}, addr), el('td', {}, pin),
    el('td', { class: 'row-actions' }, save,
      el('button', { class: 'btn small-btn' + (s.hidden ? '' : ' danger'), type: 'button', text: s.hidden ? 'Show' : 'Hide',
        onclick: () => update({ hidden: !s.hidden }, s.hidden ? `${s.name} is visible again.` : `${s.name} is hidden from the site.`) })));
}

// ---------- official prices ----------
async function initOfficial() {
  const groups = [...new Set(state.items.map((i) => i.category))];
  $('op-item').replaceChildren(...groups.map((g) => el('optgroup', { label: g },
    ...state.items.filter((i) => i.category === g).map((i) => el('option', { value: i.id, text: `${i.name} (per ${i.unit})` })))));
  const syncChannel = () => {
    const fuel = state.items.find((i) => i.id === $('op-item').value)?.section === 'fuel';
    if (fuel) $('op-channel').value = 'doe';
    else if ($('op-channel').value === 'doe') $('op-channel').value = 'palengke';
    $('op-high-field').hidden = $('op-channel').value !== 'doe';
  };
  $('op-item').addEventListener('change', syncChannel);
  $('op-channel').addEventListener('change', syncChannel);
  $('op-asof').value = todayManila();
  syncChannel();
  $('op-form').addEventListener('submit', addOfficial);
  await loadOfficial();
}

async function loadOfficial() {
  const { data, error } = await db.from('official_prices').select('id,item_id,channel,price,price_high,as_of,source,source_url,note')
    .order('as_of', { ascending: false }).order('id', { ascending: false }).limit(150);
  if (error) return fail(error);
  const item = (id) => state.items.find((i) => i.id === id)?.name || id;
  $('op-table').tBodies[0].replaceChildren(...data.map((o) => el('tr', {},
    el('td', { text: fmtDate(o.as_of) }),
    el('td', { text: item(o.item_id) }),
    el('td', {}, el('a', { href: o.source_url, target: '_blank', rel: 'noopener', text: CHANNEL[o.channel] }), el('span', { class: 'sub', text: o.source })),
    el('td', { class: 'num', text: o.price_high ? `${peso(o.price)}–${peso(o.price_high)}` : peso(o.price) }),
    el('td', { class: 'small', text: o.note || '' }),
    el('td', {}, el('button', { class: 'btn small-btn danger', type: 'button', text: 'Delete', onclick: async () => {
      if (!window.confirm(`Delete ${CHANNEL[o.channel]} ${item(o.item_id)} from ${fmtDate(o.as_of)}?`)) return;
      const { error: err } = await db.from('official_prices').delete().eq('id', o.id);
      if (err) return fail(err);
      setStatus('Deleted. The site now shows the next newest row for that product.', 'ok');
      loadOfficial();
    } })))));
}

async function addOfficial(ev) {
  ev.preventDefault();
  const err = $('op-error');
  err.textContent = '';
  const num = (id) => ($(id).value === '' ? null : Number($(id).value));
  const row = {
    item_id: $('op-item').value, channel: $('op-channel').value, price: num('op-price'),
    price_high: $('op-channel').value === 'doe' ? num('op-high') : null, as_of: $('op-asof').value,
    source: $('op-source').value.trim(), source_url: $('op-url').value.trim(), note: $('op-note').value.trim() || null,
  };
  if (!row.price || row.price <= 0) { err.textContent = 'Enter the price.'; return; }
  if (row.price_high !== null && row.price_high < row.price) { err.textContent = 'The high price is lower than the low price.'; return; }
  if (!row.as_of) { err.textContent = 'Choose the date.'; return; }
  if (!row.source || !/^https?:\/\//.test(row.source_url)) { err.textContent = 'Add the source name and a link starting with https://'; return; }
  const { error } = await db.from('official_prices').insert(row);
  if (error) { err.textContent = error.message; return; }
  $('op-price').value = '';
  $('op-high').value = '';
  setStatus('Added. The site uses it right away.', 'ok');
  loadOfficial();
}

// ---------- start ----------
document.querySelectorAll('#admin-tabs .tab').forEach((b) => b.addEventListener('click', () => openTab(b.dataset.tab)));
$('signin-form').addEventListener('submit', signIn);
// A fresh page after signing out, so nothing from the last session lingers
$('sign-out').addEventListener('click', async () => { await db.auth.signOut(); location.reload(); });
db.auth.getSession().then(({ data }) => showSignedIn(data.session)).catch(fail);
