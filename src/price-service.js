import { bucketDelete, bucketGet, bucketKeys, bucketPut, requestPersistentStorage } from './idb.js';
import { analyzePlacements } from './flipping-engine.js';

const API_BASE = 'https://prices.runescape.wiki/api/v2/rs';
const LIVE_TTL_MS = 55_000;
const HOURLY_STEP = 3600;
const HOURLY_STEPS = 120;
const FIVEM_STEP = 300;
const FIVEM_STEPS = 576;
const INITIAL_HOURLY = 25;
const INITIAL_FIVEM = 73;

const hourlyBuckets = new Map();
const fiveMinBuckets = new Map();
let historyVersion = 0;
let cachedAnalysisVersion = -1;
let cachedAnalyses = new Map();
let lastAnalysisAt = 0;
let analysisRunning = null;
let historyInitPromise = null;
let backgroundPromise = null;
let liveCache = null;
let liveCacheAt = 0;
let livePromise = null;

const historyStatus = {
  hourly: { have: 0, total: HOURLY_STEPS + 1, errors: 0, complete: false },
  fivem: { have: 0, total: FIVEM_STEPS + 1, errors: 0, complete: false },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(path, attempts = 3) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(`${API_BASE}${path}`, { headers: { accept: 'application/json' } });
      if (!response.ok) {
        const error = new Error(`RuneScape Wiki price API returned ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } catch (error) {
      last = error;
      const status = Number(error?.status || 0);
      if (attempt >= attempts || (status > 0 && status < 429)) break;
      await sleep(250 * attempt);
    }
  }
  throw last || new Error('Could not reach RuneScape Wiki price API.');
}

export async function getLiveData(force = false) {
  const now = Date.now();
  if (!force && liveCache && now - liveCacheAt < LIVE_TTL_MS) return liveCache;
  if (livePromise) return livePromise;
  livePromise = (async () => {
    const [mapping, latest, volumes, oneHour] = await Promise.all([
      fetchJson('/mapping'), fetchJson('/latest'), fetchJson('/volumes'), fetchJson('/1h'),
    ]);
    liveCache = {
      mapping: Array.isArray(mapping) ? mapping : [],
      latest: latest?.data ?? {},
      volumes: volumes?.data ?? {},
      oneHour: oneHour?.data ?? {},
    };
    liveCacheAt = Date.now();
    return liveCache;
  })();
  try { return await livePromise; } finally { livePromise = null; }
}

function lastCompleteBucket(nowSec, stepSec) {
  return Math.floor(nowSec / stepSec) * stepSec - stepSec;
}

function wantedStamps(nowSec, stepSec, windowSteps) {
  const newest = lastCompleteBucket(nowSec, stepSec);
  return Array.from({ length: windowSteps + 1 }, (_, i) => newest - i * stepSec);
}

function validBucketData(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function loadCachedBuckets(storeName, targets, bucketMap) {
  const wanted = new Set(targets);
  const keys = await bucketKeys(storeName);
  const stale = keys.filter((k) => !wanted.has(k));
  for (const stamp of stale) void bucketDelete(storeName, stamp);
  const load = keys.filter((k) => wanted.has(k));
  await Promise.all(load.map(async (stamp) => {
    const value = await bucketGet(storeName, stamp);
    if (value && typeof value === 'object') bucketMap.set(stamp, value);
  }));
}

async function fetchMissing({ path, storeName, targets, bucketMap, concurrency, pauseMs = 0, status }) {
  const missing = targets.filter((stamp) => !bucketMap.has(stamp));
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= missing.length) return;
      const stamp = missing[index];
      try {
        const result = await fetchJson(`${path}?timestamp=${stamp}`);
        const data = validBucketData(result?.data);
        bucketMap.set(stamp, data);
        await bucketPut(storeName, stamp, data);
        historyVersion++;
      } catch {
        status.errors++;
      }
      status.have = bucketMap.size;
      if (pauseMs) await sleep(pauseMs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, missing.length)) }, worker));
  status.have = bucketMap.size;
  status.complete = bucketMap.size >= targets.length;
}

async function initializeHistory() {
  if (historyInitPromise) return historyInitPromise;
  historyInitPromise = (async () => {
    void requestPersistentStorage();
    const nowSec = Math.floor(Date.now() / 1000);
    const hTargets = wantedStamps(nowSec, HOURLY_STEP, HOURLY_STEPS);
    const mTargets = wantedStamps(nowSec, FIVEM_STEP, FIVEM_STEPS);
    await Promise.all([
      loadCachedBuckets('history1h', hTargets, hourlyBuckets),
      loadCachedBuckets('history5m', mTargets, fiveMinBuckets),
    ]);
    historyVersion++;
    historyStatus.hourly.have = hourlyBuckets.size;
    historyStatus.fivem.have = fiveMinBuckets.size;

    // Get enough recent history to produce useful bands before returning on a cold start.
    await Promise.all([
      fetchMissing({ path: '/1h', storeName: 'history1h', targets: hTargets.slice(0, INITIAL_HOURLY), bucketMap: hourlyBuckets, concurrency: 5, pauseMs: 30, status: historyStatus.hourly }),
      fetchMissing({ path: '/5m', storeName: 'history5m', targets: mTargets.slice(0, INITIAL_FIVEM), bucketMap: fiveMinBuckets, concurrency: 8, status: historyStatus.fivem }),
    ]);

    // Finish the 48h / 120h windows in the background. Subsequent visits normally need only new buckets.
    if (!backgroundPromise) {
      backgroundPromise = Promise.all([
        fetchMissing({ path: '/1h', storeName: 'history1h', targets: hTargets, bucketMap: hourlyBuckets, concurrency: 4, pauseMs: 50, status: historyStatus.hourly }),
        fetchMissing({ path: '/5m', storeName: 'history5m', targets: mTargets, bucketMap: fiveMinBuckets, concurrency: 6, status: historyStatus.fivem }),
      ]).then(() => {
        cachedAnalysisVersion = -1;
        globalThis.dispatchEvent?.(new CustomEvent('rs3flippy:history-ready'));
      }).finally(() => { backgroundPromise = null; });
    }
  })();
  return historyInitPromise;
}

function bucketCoverage(bucketMap) {
  if (!bucketMap.size) return undefined;
  return Math.min(...bucketMap.keys());
}

function seriesByItem(bucketMap) {
  const out = new Map();
  const stamps = [...bucketMap.keys()].sort((a,b) => a-b);
  for (const stamp of stamps) {
    const data = bucketMap.get(stamp) ?? {};
    for (const [id, bucket] of Object.entries(data)) {
      const key = Number(id);
      if (!Number.isFinite(key)) continue;
      const list = out.get(key) ?? [];
      list.push({
        timestamp: stamp,
        avgHighPrice: typeof bucket.avgHighPrice === 'number' ? bucket.avgHighPrice : null,
        avgLowPrice: typeof bucket.avgLowPrice === 'number' ? bucket.avgLowPrice : null,
        highPriceVolume: Number(bucket.highPriceVolume || 0),
        lowPriceVolume: Number(bucket.lowPriceVolume || 0),
      });
      if (!out.has(key)) out.set(key, list);
    }
  }
  return out;
}

export async function getAnalyses(mapping) {
  await initializeHistory();
  if (cachedAnalysisVersion === historyVersion) return cachedAnalyses;
  if (cachedAnalyses.size && Date.now() - lastAnalysisAt < 5_000) return cachedAnalyses;
  if (analysisRunning) return analysisRunning;
  analysisRunning = (async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const items = mapping
      .filter((item) => item && Number.isFinite(Number(item.id)) && typeof item.name === 'string')
      .map((item) => ({
        id: Number(item.id), name: item.name,
        buyLimit: Number.isFinite(Number(item.limit)) && Number(item.limit) > 0 ? Number(item.limit) : undefined,
        members: item.members === true,
      }));
    const hourly = seriesByItem(hourlyBuckets);
    const fivem = fiveMinBuckets.size ? seriesByItem(fiveMinBuckets) : null;
    const analyses = analyzePlacements(items, hourly, fivem, {
      nowSec,
      bandWindowHours: 24,
      minSamples: 12,
      minSamples5m: 72,
      consistencyWindowHours: 48,
      coverage1hStartSec: bucketCoverage(hourlyBuckets),
      coverage5mStartSec: bucketCoverage(fiveMinBuckets),
      objective: 'robust',
    });
    cachedAnalyses = analyses;
    cachedAnalysisVersion = historyVersion;
    lastAnalysisAt = Date.now();
    return analyses;
  })();
  try { return await analysisRunning; } finally { analysisRunning = null; }
}

export async function mostRecentCompleteHour() {
  await initializeHistory();
  if (!hourlyBuckets.size) return {};
  const newest = Math.max(...hourlyBuckets.keys());
  return hourlyBuckets.get(newest) ?? {};
}

export function getHistoryStatus() {
  return {
    hourly: { ...historyStatus.hourly, have: hourlyBuckets.size },
    fivem: { ...historyStatus.fivem, have: fiveMinBuckets.size },
    analysedItems: cachedAnalyses.size,
  };
}

export function restartHistoryRefresh() {
  historyInitPromise = null;
  cachedAnalysisVersion = -1;
  return initializeHistory();
}
