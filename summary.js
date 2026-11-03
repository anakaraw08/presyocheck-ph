// Turns raw community price reports into the numbers the site shows.
// Pure functions only: no network, no DOM, so they are easy to test.

export const WINDOW_DAYS = 30;

export const KINDS = {
  palengke: 'Palengke',
  supermarket: 'Supermarket',
  sari_sari: 'Sari-sari store',
  kadiwa: 'Kadiwa store',
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

/** Reports from the last WINDOW_DAYS, given today's date as 'YYYY-MM-DD'. */
export function withinWindow(reports, today) {
  const cutoff = new Date(today + 'T00:00:00Z');
  cutoff.setUTCDate(cutoff.getUTCDate() - WINDOW_DAYS);
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
