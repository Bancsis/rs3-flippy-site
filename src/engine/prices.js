/**
 * RS3 GE tax: 2% seller-side, floor(price/50) per item, exempt under 50 gp
 * and for Bonds. No per-item cap exists in RS3 (the 5m cap is OSRS-only).
 * Boundary per wiki body text: items BELOW 50 gp are exempt, so a 50 gp sale
 * pays 1 gp (the update-history "50 or less" wording conflicts; body text wins).
 * Bond id verified against /api/v2/rs/mapping on 2026-08-08.
 */
const BOND_ITEM_ID = 29492;
export function sellTax(price, itemId) {
    if (itemId === BOND_ITEM_ID || price < 50)
        return 0;
    return Math.floor(price / 50);
}
/** Post-tax proceeds from selling one unit at `price`. */
export function netSell(price, itemId) {
    return price - sellTax(price, itemId);
}
/**
 * Beyond this, a quote is a historical record rather than a price.
 *
 * Uncooked meat pie was the case that forced this: its last instant-sell print
 * was **15 days old**, its hourly bucket was empty, and one unit had traded all
 * day -- yet the model read 185,000 gp as today's price and built a 355M gp/hr
 * method on it. The volume clamp caught the sustained figure, but the optimal
 * column still published the fiction, and the table is sortable by it.
 *
 * Seven days is deliberately generous: 87% of items have a side older than an
 * hour and 38% older than a day, so a tight gate would delete most of the
 * market. At seven days only 10% of items are touched, and what it removes is
 * genuinely dead. Rejecting is conservative on BOTH sides -- a stale sell price
 * would overstate revenue, a stale buy price would understate cost.
 */
const MAX_QUOTE_AGE_SECONDS = 7 * 24 * 3600;
export function buildPriceTable(graph, latest, opts = {}) {
    const maxAge = opts.maxQuoteAgeSec ?? MAX_QUOTE_AGE_SECONDS;
    const nowSec = opts.nowSec;
    /** A quote with no timestamp is accepted: absence of evidence, not staleness. */
    const fresh = (t) => nowSec === undefined || typeof t !== 'number' || nowSec - t <= maxAge;
    const n = graph.items.length;
    const buy = new Float64Array(n).fill(NaN);
    const sell = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
        const item = graph.items[i];
        if (item.id === 995) {
            // Coins: 1 gp buys/sells for exactly 1 gp, no spread, no tax at this layer.
            buy[i] = 1;
            sell[i] = 1;
            continue;
        }
        if (item.geId === undefined)
            continue;
        const p = latest[String(item.geId)];
        if (!p)
            continue;
        const high = typeof p.high === 'number' && p.high > 0 && fresh(p.highTime) ? p.high : NaN;
        const low = typeof p.low === 'number' && p.low > 0 && fresh(p.lowTime) ? p.low : NaN;
        // ~21% of /latest items have high < low at any moment (stale/illiquid
        // crossings). Take the worse side each way so crossed quotes stay
        // conservative: pay the larger buying, receive the smaller selling.
        if (Number.isFinite(high) && Number.isFinite(low)) {
            buy[i] = Math.max(high, low);
            sell[i] = Math.min(high, low);
        }
        else {
            if (Number.isFinite(high))
                buy[i] = high;
            if (Number.isFinite(low))
                sell[i] = low;
        }
    }
    return { buy, sell };
}

export { BOND_ITEM_ID, MAX_QUOTE_AGE_SECONDS };
