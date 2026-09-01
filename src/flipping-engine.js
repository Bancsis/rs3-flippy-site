/**
 * Flipping mathematics adapted from the flipping-only parts of the supplied
 * rs3-pathfinder repository (commit 1faaab8, 2026-08-29).
 *
 * This file intentionally keeps the original model's core ideas:
 * - volume-weighted historical buy/sell placement search
 * - robust p25 fill estimates across 4-hour windows
 * - 48-hour consistency measurement
 * - price-floor stability discount inputs
 * - GE buy-limit and bankroll caps
 * - 2% RS3 seller tax
 */

export const BOND_ITEM_ID = 29492;
export const FALLBACK_BUY_LIMIT = 100;
export const MAX_QUOTE_AGE_SECONDS = 7 * 24 * 3600;

export const CONSISTENCY_WINDOW_HOURS = 48;
export const CONSISTENCY_SUBWINDOW_HOURS = 4;
export const CONSISTENCY_QUANTILE = 0.25;
export const HIT_MIN_UNITS_PER_WINDOW = 1;

export const QBUY_GRID = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5];
export const QSELL_GRID = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];

// A narrower, more liquid part of the historical distribution. This is used
// for the 'quicker' edge of the user-facing price range. The existing robust
// optimiser is still retained as the patient/profit-seeking edge.
export const BALANCED_BUY_GRID = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5];
export const BALANCED_SELL_GRID = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];

export function sellTax(price, itemId) {
  if (itemId === BOND_ITEM_ID || price < 50) return 0;
  return Math.floor(price / 50);
}

export function netSell(price, itemId) {
  return price - sellTax(price, itemId);
}

export function trimToWindow(points, hours, nowSec) {
  const cutoff = nowSec - hours * 3600;
  return points.filter((p) => p.timestamp >= cutoff).sort((a, b) => a.timestamp - b.timestamp);
}

export function weightedPercentile(samples, q) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a.price - b.price);
  const total = sorted.reduce((s, x) => s + x.weight, 0);
  if (total <= 0) {
    const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
    return sorted[idx].price;
  }
  let acc = 0;
  for (const s of sorted) {
    acc += s.weight;
    if (acc >= q * total) return s.price;
  }
  return sorted[sorted.length - 1].price;
}

export function computeBand(points, opts) {
  const win = trimToWindow(points, opts.windowHours, opts.nowSec);
  if (win.length === 0) return null;

  const lowSide = [];
  const highSide = [];
  const allSide = [];
  for (const p of win) {
    if (p.avgLowPrice !== null && p.avgLowPrice > 0) {
      lowSide.push({ price: p.avgLowPrice, weight: p.lowPriceVolume });
      allSide.push({ price: p.avgLowPrice, weight: p.lowPriceVolume });
    }
    if (p.avgHighPrice !== null && p.avgHighPrice > 0) {
      highSide.push({ price: p.avgHighPrice, weight: p.highPriceVolume });
      allSide.push({ price: p.avgHighPrice, weight: p.highPriceVolume });
    }
  }
  if (allSide.length === 0) return null;

  const floor = weightedPercentile(lowSide.length ? lowSide : allSide, opts.floorQ ?? 0.15);
  const ceiling = weightedPercentile(highSide.length ? highSide : allSide, opts.ceilingQ ?? 0.85);
  const median = weightedPercentile(allSide, 0.5);
  if (floor === null || ceiling === null || median === null) return null;

  const current = opts.currentPrice ?? median;
  const span = ceiling - floor;
  return {
    floor,
    ceiling,
    median,
    position: span > 0 ? Math.max(0, Math.min(1, (current - floor) / span)) : 0.5,
    bandMargin: netSell(ceiling, opts.itemId) - floor,
    samples: win.length,
    windowHours: opts.windowHours,
  };
}

export function sideVolumesPerHour(points, hours, nowSec) {
  const win = trimToWindow(points, hours, nowSec);
  let low = 0;
  let high = 0;
  for (const p of win) {
    low += p.lowPriceVolume;
    high += p.highPriceVolume;
  }
  const spanHours = Math.max(1, hours);
  return { lowPerHour: low / spanHours, highPerHour: high / spanHours };
}

export function bandTrend(points, nowSec, opts = {}) {
  const shortHours = opts.shortHours ?? 24;
  const longHours = opts.longHours ?? 120;
  const threshold = opts.threshold ?? 0.02;
  const minLongSamples = opts.minLongSamples ?? 48;
  const short = computeBand(points, { windowHours: shortHours, nowSec, itemId: 0 });
  const long = computeBand(points, { windowHours: longHours, nowSec, itemId: 0 });
  if (!short || !long || long.samples < minLongSamples) {
    return { trend: 'unknown', trendPct: null };
  }
  const shortMid = (short.floor + short.ceiling) / 2;
  const longMid = (long.floor + long.ceiling) / 2;
  if (longMid <= 0) return { trend: 'unknown', trendPct: null };
  const trendPct = (shortMid - longMid) / longMid;
  const trend = trendPct > threshold ? 'rising' : trendPct < -threshold ? 'falling' : 'steady';
  return { trend, trendPct };
}

function buildSide(points, low) {
  const samples = [];
  for (const p of points) {
    const price = low ? p.avgLowPrice : p.avgHighPrice;
    const weight = low ? p.lowPriceVolume : p.highPriceVolume;
    if (price !== null && price > 0) samples.push({ price, weight });
  }
  if (samples.length === 0) return null;
  const sorted = samples.sort((a, b) => a.price - b.price);
  const prices = sorted.map((s) => s.price);
  const cumVol = new Array(sorted.length + 1);
  cumVol[0] = 0;
  for (let i = 0; i < sorted.length; i++) cumVol[i + 1] = cumVol[i] + sorted[i].weight;
  return { prices, cumVol, total: cumVol[sorted.length] };
}

function percentileFromSide(side, q) {
  const n = side.prices.length;
  if (n === 0) return null;
  if (side.total <= 0) {
    return side.prices[Math.min(n - 1, Math.floor(q * n))];
  }
  const target = q * side.total;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (side.cumVol[mid + 1] >= target) hi = mid;
    else lo = mid + 1;
  }
  return side.prices[lo];
}

function volBelow(side, x) {
  let lo = 0;
  let hi = side.prices.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (side.prices[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return side.cumVol[lo];
}

const dedupeSorted = (xs) => [...new Set(xs)];

function buildSubSides(points, K, subHours, nowSec) {
  const subSec = subHours * 3600;
  const groups = Array.from({ length: K }, () => []);
  for (const p of points) {
    if (p.timestamp >= nowSec) continue;
    const k = Math.ceil((nowSec - p.timestamp) / subSec) - 1;
    if (k >= 0 && k < K) groups[k].push(p);
  }
  return {
    low: groups.map((g) => buildSide(g, true)),
    high: groups.map((g) => buildSide(g, false)),
  };
}

function buyUnitsIn(side, B, captureShare) {
  if (side === null) return 0;
  const through = volBelow(side, B);
  const at = volBelow(side, B + 1) - through;
  return through + captureShare * at;
}

function sellUnitsIn(side, S, captureShare) {
  if (side === null) return 0;
  const through = side.total - volBelow(side, S + 1);
  const at = side.total - volBelow(side, S) - through;
  return through + captureShare * at;
}

export function lowQuantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0;
}

export function measureConsistency(points, opts) {
  const captureShare = opts.captureShare ?? 0.5;
  const windowHours = opts.windowHours ?? CONSISTENCY_WINDOW_HOURS;
  const subHours = CONSISTENCY_SUBWINDOW_HOURS;
  const subSec = subHours * 3600;
  const K = Math.max(1, Math.floor(windowHours / subHours));
  const coverageStart = opts.coverageStartSec ?? opts.nowSec - windowHours * 3600;
  const { low, high } = buildSubSides(points, K, subHours, opts.nowSec);

  const pairFillsPerWindow = [];
  const resolvedPairFillsPerHour = [];
  let hitWindows = 0;
  let windowsResolved = 0;
  for (let k = 0; k < K; k++) {
    const pairUnits = Math.min(
      buyUnitsIn(low[k] ?? null, opts.buyAt, captureShare),
      sellUnitsIn(high[k] ?? null, opts.sellAt, captureShare),
    );
    const rate = pairUnits / subHours;
    pairFillsPerWindow.push(rate);

    // A browser on its first visit initially has only a few hours of history.
    // Older, not-yet-downloaded windows are UNKNOWN, not zero-volume windows.
    // Only fully covered windows are allowed into consistency quantiles.
    const resolved = opts.nowSec - (k + 1) * subSec >= coverageStart;
    if (resolved) {
      windowsResolved++;
      resolvedPairFillsPerHour.push(rate);
      if (pairUnits >= HIT_MIN_UNITS_PER_WINDOW) hitWindows++;
    }
  }

  const fillP25PairPerHour = resolvedPairFillsPerHour.length
    ? lowQuantile(resolvedPairFillsPerHour, CONSISTENCY_QUANTILE)
    : null;
  const meanPairFillPerHour = resolvedPairFillsPerHour.length
    ? resolvedPairFillsPerHour.reduce((a, b) => a + b, 0) / resolvedPairFillsPerHour.length
    : null;

  return {
    pairFillsPerWindow,
    resolvedPairFillsPerHour,
    fillP25PairPerHour,
    meanPairFillPerHour,
    hitWindows,
    windowsResolved,
    windows: K,
  };
}

export function optimizePlacement(points, opts) {
  const captureShare = opts.captureShare ?? 0.5;
  const minMargin = opts.minMargin ?? 1;
  const objective = opts.objective ?? 'robust';
  const win = trimToWindow(points, opts.windowHours, opts.nowSec);
  if (win.length === 0) return null;
  const low = buildSide(win, true);
  const high = buildSide(win, false);
  if (!low || !high || low.total <= 0 || high.total <= 0) return null;

  const buyCands = dedupeSorted(
    (opts.buyGrid ?? QBUY_GRID)
      .map((q) => percentileFromSide(low, q))
      .filter((p) => p !== null)
      .map((p) => Math.floor(p) + 1),
  );
  const sellCands = dedupeSorted(
    (opts.sellGrid ?? QSELL_GRID)
      .map((q) => percentileFromSide(high, q))
      .filter((p) => p !== null)
      .map((p) => Math.ceil(p) - 1),
  );

  const buyFill = new Map();
  for (const B of buyCands) {
    const through = volBelow(low, B);
    const at = volBelow(low, B + 1) - through;
    buyFill.set(B, (through + captureShare * at) / opts.windowHours);
  }
  const sellFill = new Map();
  for (const S of sellCands) {
    const through = high.total - volBelow(high, S + 1);
    const at = high.total - volBelow(high, S) - through;
    sellFill.set(S, (through + captureShare * at) / opts.windowHours);
  }

  const K = Math.max(1, Math.floor(opts.windowHours / CONSISTENCY_SUBWINDOW_HOURS));
  const subs = buildSubSides(win, K, CONSISTENCY_SUBWINDOW_HOURS, opts.nowSec);
  const buyUnitsW = new Map(
    buyCands.map((B) => [B, subs.low.map((s) => buyUnitsIn(s, B, captureShare))]),
  );
  const sellUnitsW = new Map(
    sellCands.map((S) => [S, subs.high.map((s) => sellUnitsIn(s, S, captureShare))]),
  );

  let best = null;
  for (const B of buyCands) {
    for (const S of sellCands) {
      if (S <= B) continue;
      const margin = netSell(S, opts.itemId) - B;
      if (margin < minMargin) continue;
      const fill4h = 4 * Math.min(buyFill.get(B), sellFill.get(S));
      if (fill4h < 1) continue;
      const ev = margin * Math.min(fill4h, opts.buyLimit);
      const bw = buyUnitsW.get(B);
      const sw = sellUnitsW.get(S);
      const pairUnits = bw.map((u, w) => Math.min(u, sw[w]));
      const robust = margin * Math.min(lowQuantile(pairUnits, CONSISTENCY_QUANTILE), opts.buyLimit);
      const beats =
        best === null
          ? true
          : objective === 'robust'
            ? robust > best.robust ||
              (robust === best.robust &&
                (ev > best.ev ||
                  (ev === best.ev &&
                    (margin > best.margin || (margin === best.margin && B < best.B)))))
            : ev > best.ev ||
              (ev === best.ev && (margin > best.margin || (margin === best.margin && B < best.B)));
      if (beats) best = { B, S, margin, ev, robust };
    }
  }
  if (best === null) return null;

  const buyFillPerHour = buyFill.get(best.B);
  const sellFillPerHour = sellFill.get(best.S);
  return {
    buyAt: best.B,
    sellAt: best.S,
    qBuy: volBelow(low, best.B + 1) / low.total,
    qSell: (high.total - volBelow(high, best.S)) / high.total,
    buyFillPerHour,
    sellFillPerHour,
    fillPerHour: Math.min(buyFillPerHour, sellFillPerHour),
    marginPerItem: best.margin,
    evPer4h: best.ev,
    evRobustPer4h: best.robust,
    samples: win.length,
  };
}

export function floorStability(points, opts) {
  const steps = opts.steps ?? 6;
  const stepSec = opts.stepSec ?? 4 * 3600;
  const floors = [];
  for (let i = 0; i < steps; i++) {
    const at = opts.nowSec - i * stepSec;
    const from = at - opts.windowHours * 3600;
    const win = points.filter((p) => p.timestamp >= from && p.timestamp < at);
    if (win.length === 0) continue;
    const lows = [];
    for (const p of win) {
      if (p.avgLowPrice !== null && p.avgLowPrice > 0) {
        lows.push({ price: p.avgLowPrice, weight: p.lowPriceVolume });
      }
    }
    if (lows.length < 6) continue;
    const f = weightedPercentile(lows, opts.q);
    if (f !== null) floors.push(f);
  }
  if (floors.length < 4) return null;
  const mean = floors.reduce((a, b) => a + b, 0) / floors.length;
  return Math.sqrt(floors.reduce((a, f) => a + (f - mean) ** 2, 0) / floors.length);
}

export function analyzePlacements(items, series1h, series5m, opts) {
  const windowHours = opts.bandWindowHours ?? 24;
  const minSamples = opts.minSamples ?? 12;
  const minSamples5m = opts.minSamples5m ?? 72;
  const cutoff = opts.nowSec - windowHours * 3600;
  const inWindow = (pts) => {
    if (!pts) return 0;
    let n = 0;
    for (const p of pts) if (p.timestamp >= cutoff) n++;
    return n;
  };

  const out = new Map();
  for (const item of items) {
    if (item.id === BOND_ITEM_ID) continue;
    const pts5m = series5m?.get(item.id);
    const pts1h = series1h.get(item.id);
    let source;
    let points;
    if (pts5m && inWindow(pts5m) >= minSamples5m) {
      source = '5m';
      points = pts5m;
    } else if (pts1h && inWindow(pts1h) >= minSamples) {
      source = '1h';
      points = pts1h;
    } else {
      continue;
    }

    const buyLimit = item.buyLimit ?? FALLBACK_BUY_LIMIT;

    // Keep two defensible placements rather than pretending one exact price is
    // always correct:
    // - patientPlacement: Pathfinder's robust/p25 choice, favouring dependable
    //   margin across repeated 4-hour windows.
    // - balancedPlacement: expected-profit choice restricted to the more liquid
    //   centre of recent traded prices, favouring faster fills.
    //
    // The balanced placement drives GP/hour/risk; the two placements form the
    // simple buy/sell ranges shown to the player.
    const patientPlacement = optimizePlacement(points, {
      windowHours,
      nowSec: opts.nowSec,
      itemId: item.id,
      buyLimit,
      ...(opts.captureShare !== undefined ? { captureShare: opts.captureShare } : {}),
      ...(opts.minMargin !== undefined ? { minMargin: opts.minMargin } : {}),
      objective: 'robust',
    });
    const balancedPlacement = optimizePlacement(points, {
      windowHours,
      nowSec: opts.nowSec,
      itemId: item.id,
      buyLimit,
      buyGrid: BALANCED_BUY_GRID,
      sellGrid: BALANCED_SELL_GRID,
      ...(opts.captureShare !== undefined ? { captureShare: opts.captureShare } : {}),
      ...(opts.minMargin !== undefined ? { minMargin: opts.minMargin } : {}),
      objective: 'ev',
    });
    const placement = balancedPlacement ?? patientPlacement;
    if (placement === null) continue;

    const band = computeBand(points, { windowHours, nowSec: opts.nowSec, itemId: item.id });
    if (!band) continue;

    const patient = patientPlacement ?? placement;
    const quicker = balancedPlacement ?? placement;
    const priceRange = {
      buyLow: Math.min(patient.buyAt, quicker.buyAt),
      buyHigh: Math.max(patient.buyAt, quicker.buyAt),
      sellLow: Math.min(patient.sellAt, quicker.sellAt),
      sellHigh: Math.max(patient.sellAt, quicker.sellAt),
      patientBuy: patient.buyAt,
      patientSell: patient.sellAt,
      quickerBuy: quicker.buyAt,
      quickerSell: quicker.sellAt,
    };

    const coverageStartSec = source === '5m' ? opts.coverage5mStartSec : opts.coverage1hStartSec;
    const consistency = measureConsistency(points, {
      buyAt: placement.buyAt,
      sellAt: placement.sellAt,
      nowSec: opts.nowSec,
      ...(opts.captureShare !== undefined ? { captureShare: opts.captureShare } : {}),
      ...(opts.consistencyWindowHours !== undefined
        ? { windowHours: opts.consistencyWindowHours }
        : {}),
      ...(coverageStartSec !== undefined ? { coverageStartSec } : {}),
    });

    const rates = sideVolumesPerHour(points, windowHours, opts.nowSec);
    const stabSd = floorStability(points, {
      windowHours,
      nowSec: opts.nowSec,
      q: placement.qBuy,
    });
    const { trend, trendPct } = pts1h
      ? bandTrend(pts1h, opts.nowSec)
      : { trend: 'unknown', trendPct: null };

    out.set(item.id, {
      id: item.id,
      name: item.name,
      members: item.members === true,
      buyLimit: item.buyLimit ?? null,
      source,
      placement,
      patientPlacement,
      balancedPlacement,
      priceRange,
      consistency,
      stabilityRatio: stabSd === null ? null : stabSd / Math.max(1, placement.marginPerItem),
      band,
      lowVolPerHour: rates.lowPerHour,
      highVolPerHour: rates.highPerHour,
      trend,
      trendPct,
      windowHours,
    });
  }
  return out;
}

export function scoreBandFlips(analyses, latest, opts) {
  const maxPositionAge = opts.maxPositionQuoteAgeSec ?? MAX_QUOTE_AGE_SECONDS;
  const out = [];

  for (const a of analyses.values()) {
    const p = a.placement;
    const c = a.consistency;
    const limitCap = a.buyLimit ?? FALLBACK_BUY_LIMIT;
    const capitalCap = opts.bankroll !== undefined ? Math.floor(opts.bankroll / p.buyAt) : Infinity;
    if (capitalCap < 1) continue;

    // V9: GP/hour is an EXPECTED throughput calculation. The p25 consistency
    // figure remains valuable for risk, but it is deliberately not a hard gate
    // on profitability. Previously floor(4 * p25) made any rate below one whole
    // item per four hours become zero, and missing browser-history windows also
    // entered the p25 calculation as zeros.
    const placementRate = Number.isFinite(Number(p.fillPerHour)) && Number(p.fillPerHour) > 0
      ? Number(p.fillPerHour)
      : null;
    const resolvedMeanRate = Number.isFinite(Number(c.meanPairFillPerHour)) && Number(c.meanPairFillPerHour) > 0
      ? Number(c.meanPairFillPerHour)
      : null;
    const marketRates = [placementRate, resolvedMeanRate].filter((x) => x !== null);
    const marketRatePerHour = marketRates.length ? Math.min(...marketRates) : null;
    const limitRatePerHour = limitCap / 4;
    const capitalRatePerHour = capitalCap / 4;
    const effectiveRatePerHour = marketRatePerHour === null
      ? null
      : Math.min(marketRatePerHour, limitRatePerHour, capitalRatePerHour);

    let binding = 'unknown';
    if (effectiveRatePerHour !== null) {
      const eps = 1e-9;
      if (Math.abs(effectiveRatePerHour - capitalRatePerHour) <= eps) binding = 'capital';
      else if (Math.abs(effectiveRatePerHour - limitRatePerHour) <= eps) binding = 'limit';
      else binding = 'volume';
    }

    const q = latest[String(a.id)];
    const low = typeof q?.low === 'number' && q.low > 0 ? q.low : null;
    const lowAge = low !== null && typeof q?.lowTime === 'number' ? opts.nowSec - q.lowTime : null;
    const positionUsable = low !== null && lowAge !== null && lowAge <= maxPositionAge;
    const span = a.band.ceiling - a.band.floor;
    const position = positionUsable
      ? span > 0
        ? Math.max(0, Math.min(1, (low - a.band.floor) / span))
        : 0.5
      : null;

    const qtyPer4h = effectiveRatePerHour === null ? null : effectiveRatePerHour * 4;
    const fillableQty4h = marketRatePerHour === null ? null : marketRatePerHour * 4;
    const gpPerHour = effectiveRatePerHour !== null && effectiveRatePerHour > 0
      ? p.marginPerItem * effectiveRatePerHour
      : null;
    const gpPer4h = gpPerHour === null ? null : gpPerHour * 4;
    const robustRate = Number.isFinite(Number(c.fillP25PairPerHour)) && Number(c.fillP25PairPerHour) > 0
      ? Number(c.fillP25PairPerHour)
      : null;
    const sustainedRatePerHour = effectiveRatePerHour ?? 0;
    const meanSustainedRatePerHour = Math.min(
      p.buyFillPerHour,
      p.sellFillPerHour,
      limitRatePerHour,
      capitalRatePerHour,
    );
    const limitBound = effectiveRatePerHour !== null && limitRatePerHour <= marketRatePerHour;
    const gpPerSlotHour = (p.marginPerItem * sustainedRatePerHour) / 2;
    const stabilityDiscount = 1 + (a.stabilityRatio ?? 0);
    const marginPct = p.marginPerItem / p.buyAt;
    const fillEstimateSource = resolvedMeanRate !== null
      ? 'recent resolved windows + placement flow'
      : placementRate !== null
        ? 'placement-flow fallback'
        : 'unavailable';

    out.push({
      id: a.id,
      name: a.name,
      members: a.members,
      buyLimit: a.buyLimit,
      buyAt: p.buyAt,
      sellAt: p.sellAt,
      buyRangeLow: a.priceRange?.buyLow ?? p.buyAt,
      buyRangeHigh: a.priceRange?.buyHigh ?? p.buyAt,
      sellRangeLow: a.priceRange?.sellLow ?? p.sellAt,
      sellRangeHigh: a.priceRange?.sellHigh ?? p.sellAt,
      qBuy: p.qBuy,
      qSell: p.qSell,
      source: a.source,
      marginPerItem: p.marginPerItem,
      marginPct,
      bandFloor: a.band.floor,
      bandCeiling: a.band.ceiling,
      samples: p.samples,
      windowHours: a.windowHours,
      lowVolPerHour: a.lowVolPerHour,
      highVolPerHour: a.highVolPerHour,
      buyFillPerHour: p.buyFillPerHour,
      sellFillPerHour: p.sellFillPerHour,
      fillPerHour: p.fillPerHour,
      marketRatePerHour,
      effectiveRatePerHour,
      fillEstimateSource,
      fillableQty4h,
      qtyPer4h,
      binding,
      capitalRequired: qtyPer4h === null ? null : p.buyAt * qtyPer4h,
      gpPer4h,
      gpPerHour,
      adjustedGpPer4h: gpPer4h === null ? null : gpPer4h / stabilityDiscount,
      adjustedGpPerHour: gpPerHour === null ? null : gpPerHour / stabilityDiscount,
      fillP25PairPerHour: c.fillP25PairPerHour,
      meanPairFillPerHour: c.meanPairFillPerHour,
      robustRatePerHour: robustRate,
      hitWindows: c.hitWindows,
      consistencyWindows: c.windows,
      windowsResolved: c.windowsResolved,
      sustainedRatePerHour,
      meanSustainedRatePerHour,
      gpPerSlotHour,
      adjustedGpPerSlotHour: gpPerSlotHour / stabilityDiscount,
      capitalEfficiency: marginPct / stabilityDiscount,
      pairCapitalPer4h: 2 * p.buyAt * 4 * sustainedRatePerHour,
      cycleHoursBatch:
        qtyPer4h !== null && p.buyFillPerHour > 0 && p.sellFillPerHour > 0
          ? qtyPer4h / p.buyFillPerHour + qtyPer4h / p.sellFillPerHour
          : Infinity,
      limitBound,
      stabilityRatio: a.stabilityRatio,
      estFillMinutes: effectiveRatePerHour !== null && effectiveRatePerHour > 0
        ? 60 / effectiveRatePerHour
        : Infinity,
      trend: a.trend,
      trendPct: a.trendPct,
      position,
      quoteAgeSec: lowAge,
    });
  }

  const sortable = (x) => Number.isFinite(Number(x)) ? Number(x) : -Infinity;
  return out.sort(
    (a, b) =>
      sortable(b.adjustedGpPerHour) - sortable(a.adjustedGpPerHour) ||
      sortable(b.gpPerHour) - sortable(a.gpPerHour) ||
      a.id - b.id,
  );
}

/**
 * Collapse Pathfinder's underlying stability + consistency warnings into one
 * beginner-friendly traffic-light label. Thresholds are the same ones used by
 * the supplied repo's flipping UI:
 * - consistency: green >= 11/12 windows, red < 8/12
 * - stability: steady < .15, mixed < .50, choppy >= .50
 * Trend is a warning only: a non-steady/unknown trend can raise Green to Amber.
 */
export function riskForCandidate(c) {
  const reasons = [];
  const resolved = Math.max(0, Number(c.windowsResolved || 0));
  const total = Math.max(1, Number(c.consistencyWindows || 1));
  const fullCoverage = resolved >= total;
  const hitRatio = resolved > 0 ? c.hitWindows / resolved : null;
  const enoughConsistency = resolved >= 3;
  const choppy = c.stabilityRatio !== null && c.stabilityRatio >= 0.5;
  const mixed = c.stabilityRatio !== null && c.stabilityRatio >= 0.15;
  const poorConsistency = enoughConsistency && hitRatio !== null && hitRatio < 2 / 3;
  const goodConsistency = enoughConsistency && hitRatio !== null && hitRatio >= 0.9;
  const robustKnown = Number.isFinite(Number(c.fillP25PairPerHour));
  const noRobustFlow = enoughConsistency && robustKnown && Number(c.fillP25PairPerHour) <= 0;

  if (!fullCoverage) reasons.push(`consistency history is still building (${resolved}/${total} full 4h windows available)`);
  if (poorConsistency) reasons.push('recent full windows have inconsistent two-sided fills');
  else if (enoughConsistency && !goodConsistency) reasons.push('some recent full windows did not fill on both sides');
  if (c.stabilityRatio === null) reasons.push('not enough history to judge price stability');
  else if (choppy) reasons.push('recent prices have been choppy');
  else if (mixed) reasons.push('recent prices have had mixed stability');
  if (c.trend === 'rising') reasons.push('the broader price range is trending upward');
  else if (c.trend === 'falling') reasons.push('the broader price range is trending downward');
  else if (c.trend === 'unknown') reasons.push('not enough hourly history to judge the longer trend');
  if (c.buyLimit === null) reasons.push('GE limit is unknown; the model conservatively uses 100');

  let risk;
  if (noRobustFlow || poorConsistency || choppy) risk = 'red';
  else if (
    !fullCoverage ||
    !goodConsistency ||
    c.stabilityRatio === null ||
    mixed ||
    c.trend !== 'steady' ||
    c.buyLimit === null
  ) {
    risk = 'amber';
  } else {
    risk = 'green';
  }

  if (reasons.length === 0) reasons.push('recent trading has been consistent and prices have been steady');
  return { risk, reasons };
}
