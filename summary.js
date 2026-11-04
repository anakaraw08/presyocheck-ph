// Turns raw community price reports into the numbers the site shows.
// Pure functions only: no network, no DOM, so they are easy to test.

export const WINDOW_DAYS = 30;

export const KINDS = {
  palengke: 'Palengke',
  supermarket: 'Supermarket',
  grocery: 'Grocery',
  convenience: 'Convenience store',
  sari_sari: 'Sari-sari store',
  kadiwa: 'Kadiwa store',
  gas_station: 'Gas station',
};

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Decide whether one community-reported price looks implausible, so it is left
 * out of the medians. It still appears in the store list, marked "unusual".
 *
 * @param {number} price      Reported price in pesos per unit (per kg, per piece...).
 * @param {number|null} baseline  Official NCR price for this item (DA wet market,
 *                            SRA or DTI SRP), or null when there is none.
 * @param {number[]} peers    The other reported prices for the same item in the
 *                            same city over the last WINDOW_DAYS (may be empty).
 * @returns {boolean} true to exclude the price from the summary.
 */
export function isSuspicious(price, baseline, peers) {
  // TODO(Pio): write the rule that keeps typos and trolls out of the medians.
  // Until then every report counts.
  return false;
}

/** Reports from the last `days` days, given today's date as 'YYYY-MM-DD'. */
export function withinWindow(reports, today, days = WINDOW_DAYS) {
  const cutoff = new Date(today + 'T00:00:00Z');
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const min = cutoff.toISOString().slice(0, 10);
  return reports.filter((r) => r.observed_on >= min);
}

/** Mark each report with `suspicious` using isSuspicious against its peers. */
export function flagReports(reports, baseline) {
  const prices = reports.map((r) => Number(r.price));
  return reports.map((r, i) => {
    const peers = prices.filter((_, j) => j !== i);
    return { ...r, price: prices[i], suspicious: Boolean(isSuspicious(prices[i], baseline, peers)) };
  });
}

/** Median, range and count per store type, from flagged reports of one item. */
export function summarizeByKind(flagged) {
  const out = [];
  for (const kind of Object.keys(KINDS)) {
    const rows = flagged.filter((r) => r.store_kind === kind);
    const kept = rows.filter((r) => !r.suspicious).map((r) => r.price);
    if (!rows.length) continue;
    out.push({
      kind,
      median: median(kept),
      min: kept.length ? Math.min(...kept) : null,
      max: kept.length ? Math.max(...kept) : null,
      count: kept.length,
      excluded: rows.length - kept.length,
      latest: rows.reduce((d, r) => (r.observed_on > d ? r.observed_on : d), ''),
    });
  }
  return out;
}

const newer = (a, b) => a.observed_on > b.observed_on ||
  (a.observed_on === b.observed_on && a.created_at > b.created_at);

/**
 * Product × store price grid.
 * `flagged` are reports already run through flagReports, one item at a time.
 * Returns:
 *   cell(itemId, storeId) -> latest report there ({price, observed_on, suspicious, note, count}) or undefined
 *   row(itemId)           -> {min, max, priced} over non-suspicious cells (min/max null when fewer than 2)
 *   storeScore(storeId)   -> {score, priced}: median of (price / row minimum) over rows where at least
 *                            two stores have a price; 1.00 means "always the cheapest". null if not comparable.
 */
export function buildMatrix(flagged) {
  const cells = new Map();
  for (const r of flagged) {
    const key = r.item_id + '|' + r.store_id;
    const cur = cells.get(key);
    if (!cur) cells.set(key, { ...r, count: 1 });
    else {
      const count = cur.count + 1;
      cells.set(key, newer(r, cur) ? { ...r, count } : { ...cur, count });
    }
  }

  const rows = new Map();
  for (const c of cells.values()) {
    if (c.suspicious) continue;
    const row = rows.get(c.item_id) || { prices: [] };
    row.prices.push(c.price);
    rows.set(c.item_id, row);
  }
  for (const row of rows.values()) {
    row.priced = row.prices.length;
    row.min = row.priced > 1 ? Math.min(...row.prices) : null;
    row.max = row.priced > 1 ? Math.max(...row.prices) : null;
  }

  const ratios = new Map();
  const pricedCount = new Map();
  for (const c of cells.values()) {
    pricedCount.set(c.store_id, (pricedCount.get(c.store_id) || 0) + 1);
    const row = rows.get(c.item_id);
    if (c.suspicious || !row || row.min === null) continue;
    if (!ratios.has(c.store_id)) ratios.set(c.store_id, []);
    ratios.get(c.store_id).push(c.price / row.min);
  }

  return {
    cell: (itemId, storeId) => cells.get(itemId + '|' + storeId),
    row: (itemId) => rows.get(itemId) || { min: null, max: null, priced: 0 },
    storeScore: (storeId) => ({
      score: ratios.has(storeId) ? median(ratios.get(storeId)) : null,
      priced: pricedCount.get(storeId) || 0,
    }),
  };
}

/**
 * Column order, cheapest first.
 * With `byItemId`, stores are ordered by their price for that product; otherwise by storeScore.
 * Stores with no comparable price go after the ranked ones (those with any price first), then by name.
 */
export function orderStores(stores, matrix, byItemId = null) {
  const key = (s) => {
    if (byItemId) {
      const c = matrix.cell(byItemId, s.id);
      if (c && !c.suspicious) return [0, c.price];
    }
    const { score, priced } = matrix.storeScore(s.id);
    if (score !== null) return [byItemId ? 1 : 0, score];
    return [priced ? 2 : 3, 0];
  };
  return [...stores].sort((a, b) => {
    const ka = key(a), kb = key(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || a.name.localeCompare(b.name);
  });
}

/** One row per store: its most recent report and how many reports it has. */
export function latestByStore(flagged) {
  const byStore = new Map();
  for (const r of flagged) {
    const cur = byStore.get(r.store_id);
    const newer = !cur || r.observed_on > cur.latest.observed_on ||
      (r.observed_on === cur.latest.observed_on && r.created_at > cur.latest.created_at);
    if (!cur) byStore.set(r.store_id, { latest: r, count: 1 });
    else {
      cur.count += 1;
      if (newer) cur.latest = r;
    }
  }
  return [...byStore.values()].sort((a, b) => a.latest.price - b.latest.price);
}
