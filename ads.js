// Ad slots and the pop-up ad. Real ads are managed on admin.html (table public.ads):
// each has a slot, start and end date. Any element with data-ad="<slot>" is filled with a
// running ad for that slot, or with the placeholder below when none is running.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

// Placeholders, used when no ad is running in a slot:
//   href   where a tap goes (an advertiser's page; '#advertise' scrolls to the footer contact)
//   image  an image URL for a real ad, or null to show the placeholder
//   title / text   placeholder wording
export const AD_CONFIG = {
  slots: {
    top:    { size: '728 × 90', mobileSize: '320 × 100', href: '#advertise', image: null, title: 'Your ad here', text: 'Reach shoppers in your barangay' },
    bottom: { size: '728 × 90', mobileSize: '320 × 100', href: '#advertise', image: null, title: 'Advertise on Presyo Check', text: 'Palengke stalls, groceries and gas stations welcome' },
  },
  popup: {
    enabled: true,
    onceEvery: 'session',   // 'session' = once per browser session, 'load' = every page load
    delayMs: 600,
    href: '#advertise',
    image: null,
    size: '300 × 250',
    title: 'Your ad here',
    text: 'Promote your store, sari-sari or gas station to people checking prices nearby.',
    cta: 'Advertise with us',
  },
};

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of kids) if (c != null && c !== false) n.append(c);
  return n;
};

const isExternal = (href) => /^https?:\/\//.test(href);

function adBody(ad, { big = false } = {}) {
  if (ad.image) return el('img', { src: ad.image, alt: ad.title || 'Advertisement', class: 'ad-img', loading: 'lazy' });
  return el('span', { class: 'ad-ph' + (big ? ' big' : '') },
    el('span', { class: 'ad-ph-title', text: ad.title }),
    el('span', { class: 'ad-ph-text', text: ad.text }),
    big && ad.cta ? el('span', { class: 'btn primary ad-cta', text: ad.cta }) : null,
    ad.real ? null : el('span', { class: 'ad-ph-size', text: ad.mobileSize && matchMedia('(max-width: 640px)').matches ? ad.mobileSize : ad.size }));
}

function adLink(ad, onclick, big) {
  return el('a', {
    class: 'ad-link',
    href: ad.href || '#advertise',
    target: isExternal(ad.href) ? '_blank' : null,
    rel: isExternal(ad.href) ? 'sponsored noopener' : null,
    onclick,
  }, adBody(ad, { big }));
}

function fillSlots() {
  document.querySelectorAll('[data-ad]').forEach((slot) => {
    const ad = AD_CONFIG.slots[slot.dataset.ad];
    if (!ad) { slot.remove(); return; }
    slot.classList.add('ad-slot');
    slot.setAttribute('aria-label', 'Advertisement');
    slot.replaceChildren(el('span', { class: 'ad-label', text: 'Advertisement' }), adLink(ad));
  });
}

function seenPopup() {
  if (AD_CONFIG.popup.onceEvery !== 'session') return false;
  try { return sessionStorage.getItem('presyo.adPopupSeen') === '1'; } catch { return false; }
}
function markPopupSeen() {
  try { sessionStorage.setItem('presyo.adPopupSeen', '1'); } catch { /* storage unavailable */ }
}

function showPopup() {
  const ad = AD_CONFIG.popup;
  if (!ad.enabled || seenPopup()) return;
  const dlg = el('dialog', { class: 'ad-popup', 'aria-label': 'Advertisement' });
  const close = () => { markPopupSeen(); dlg.close(); };
  dlg.append(
    el('div', { class: 'ad-popup-bar' },
      el('span', { class: 'ad-label', text: 'Advertisement' }),
      el('button', { type: 'button', class: 'ad-close', 'aria-label': 'Close ad', onclick: close, text: '✕' })),
    adLink(ad, () => {
      markPopupSeen();
      if (!isExternal(ad.href)) dlg.close();
    }, true));
  // Tap outside the ad to close it
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  dlg.addEventListener('cancel', () => markPopupSeen());
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  dlg.querySelector('.ad-close').focus();
}

/** Running ads from the database (RLS returns only enabled ads whose dates include today). */
async function loadAds() {
  try {
    const db = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
    const { data, error } = await db.from('ads').select('id,slot,title,body,cta,image_url,href');
    if (error) throw error;
    const bySlot = {};
    for (const a of data) (bySlot[a.slot] ||= []).push(a);
    for (const [slot, list] of Object.entries(bySlot)) {
      // Several ads in one slot take turns: each page load picks one at random.
      const a = list[Math.floor(Math.random() * list.length)];
      const base = slot === 'popup' ? AD_CONFIG.popup : AD_CONFIG.slots[slot];
      if (!base) continue;
      Object.assign(base, {
        href: a.href || '#advertise', image: a.image_url, title: a.title || '', text: a.body || '',
        cta: a.cta || (slot === 'popup' ? 'Learn more' : ''), real: true,
      });
    }
  } catch (e) {
    console.warn('Ads could not load; showing placeholders.', e);
  }
}

fillSlots(); // placeholders straight away, so the layout doesn't jump
const adsReady = loadAds().then(fillSlots);
setTimeout(async () => {
  await adsReady;
  // Don't cover the report form if someone opened it already
  if (document.querySelector('dialog[open]')) return;
  showPopup();
}, AD_CONFIG.popup.delayMs);
