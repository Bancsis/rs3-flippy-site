import { cacheGet, cachePut } from './idb.js';
import { getLiveData } from './price-service.js';

const WIKI_API_URL = 'https://runescape.wiki/api.php';
const BOSS_DROP_TTL_MS = 12 * 60 * 60 * 1000;
const bossDropMemory = new Map();

function decodeHtml(text) {
  return String(text || '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function stripHtml(text) {
  return decodeHtml(String(text || '')
    .replace(/<sup[\s\S]*?<\/sup>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}

function parseChance(text) {
  const cleaned = String(text || '').replace(/,/g, '');
  if (/always|100%/i.test(cleaned)) return { probability: 1, oneIn: 1, rate: '1/1' };
  let m = cleaned.match(/([\d.]+)\s*\/\s*([\d.]+)/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a > 0 && b > 0) {
      const p = a / b, oneIn = 1 / p;
      return { probability: p, oneIn, rate: `1/${oneIn >= 100 ? Math.round(oneIn) : oneIn.toFixed(oneIn < 10 ? 2 : 1).replace(/\.0$/, '')}` };
    }
  }
  m = cleaned.match(/([\d.]+)\s*%/);
  if (m) {
    const p = Number(m[1]) / 100;
    if (p > 0) return { probability: p, oneIn: 1 / p, rate: `1/${(1/p) >= 100 ? Math.round(1/p) : (1/p).toFixed(1).replace(/\.0$/, '')}` };
  }
  return null;
}

function parseNumericPrice(text) {
  if (/not sold|n\/a/i.test(String(text))) return null;
  const m = String(text || '').match(/(?:^|\s)([\d][\d,]*)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

function averageQuantity(text) {
  const nums = [...String(text || '').matchAll(/[\d,.]+/g)].map((m) => Number(m[0].replace(/,/g,''))).filter(Number.isFinite);
  if (!nums.length) return 1;
  return nums.length >= 2 ? (nums[0] + nums[1]) / 2 : nums[0];
}

function extractItemName(cellHtml) {
  const titles = [...String(cellHtml).matchAll(/<a[^>]+title="([^"]+)"[^>]*>/gi)].map((m) => decodeHtml(m[1]));
  const good = titles.find((x) => !/^File:|^Category:|^Special:/i.test(x));
  if (good) return good.replace(/ \(page does not exist\)$/i, '');
  return stripHtml(cellHtml).replace(/\s+\(m\)$/i, '').trim();
}

function parseDropTables(html) {
  const drops = [];
  const tables = String(html || '').match(/<table\b[\s\S]*?<\/table>/gi) || [];
  for (const table of tables) {
    const rowHtml = table.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
    if (!rowHtml.length) continue;
    const headers = [...rowHtml[0].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => stripHtml(m[1]).toLowerCase());
    const itemIdx = headers.findIndex((h) => /^item/.test(h));
    const qtyIdx = headers.findIndex((h) => /quantity/.test(h));
    const rarityIdx = headers.findIndex((h) => /rarity|drop rate|chance/.test(h));
    const priceIdx = headers.findIndex((h) => /ge price|price/.test(h));
    if (itemIdx < 0 || rarityIdx < 0 || priceIdx < 0) continue;
    for (const tr of rowHtml.slice(1)) {
      const cells = [...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
      if (cells.length <= Math.max(itemIdx, rarityIdx, priceIdx)) continue;
      const name = extractItemName(cells[itemIdx]);
      const chance = parseChance(stripHtml(cells[rarityIdx]));
      const wikiValue = parseNumericPrice(stripHtml(cells[priceIdx]));
      if (!name || !chance || !(wikiValue > 0)) continue;
      const qtyText = qtyIdx >= 0 && cells[qtyIdx] ? stripHtml(cells[qtyIdx]) : '1';
      const qtyAvg = averageQuantity(qtyText);
      drops.push({ name, quantity: qtyText, wikiValue, probability: chance.probability, rate: chance.rate, percent: chance.probability * 100, expectedValue: wikiValue * qtyAvg * chance.probability });
    }
  }
  return drops;
}

async function fetchWikiParse(params) {
  const qs = new URLSearchParams({ action: 'parse', format: 'json', origin: '*', ...params });
  const res = await fetch(`${WIKI_API_URL}?${qs}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Wiki returned ${res.status}`);
  const body = await res.json();
  if (body?.error) throw new Error(body.error.info || 'Wiki parse error');
  return body.parse;
}

export async function getBossDrops(page, method = '') {
  const key = `${page}|${/hard/i.test(method) ? 'hard' : 'normal'}`;
  const memory = bossDropMemory.get(key);
  if (memory && Date.now() - memory.at < BOSS_DROP_TTL_MS) return memory.value;
  const cached = await cacheGet(`boss-drops:${key}`);
  if (cached?.value && Date.now() - Number(cached.at || 0) < BOSS_DROP_TTL_MS) {
    bossDropMemory.set(key, cached);
    return cached.value;
  }
  const sections = (await fetchWikiParse({ page, prop: 'sections' }))?.sections || [];
  const wantHard = /hard/i.test(method);
  let section = sections.find((s) => wantHard && /^Drops \(hard mode\)$/i.test(stripHtml(s.line)));
  if (!section) section = sections.find((s) => !wantHard && /^Drops \(normal mode\)$/i.test(stripHtml(s.line)));
  if (!section) section = sections.find((s) => /^Drops$/i.test(stripHtml(s.line)));
  if (!section) section = sections.find((s) => /^Drops\b/i.test(stripHtml(s.line)));
  if (!section) return { page, drops: [], source: 'RuneScape Wiki', note: 'No structured drop section was found.' };
  const parsed = await fetchWikiParse({ page, prop: 'text', section: String(section.index) });
  let drops = parseDropTables(parsed?.text?.['*'] || '');
  try {
    const live = await getLiveData(false);
    const byName = new Map(live.mapping.map((x) => [String(x.name || '').toLowerCase(), x.id]));
    drops = drops.map((d) => {
      const id = byName.get(d.name.toLowerCase());
      const q = id !== undefined ? live.latest[String(id)] : null;
      const liveValue = Number(q?.low || q?.high || 0);
      const value = liveValue > 0 ? liveValue : d.wikiValue;
      return { ...d, value, expectedValue: value * averageQuantity(d.quantity) * d.probability };
    });
  } catch {}
  drops = drops
    .filter((d) => d.value >= 100_000 && (d.expectedValue >= 750 || d.value >= 1_000_000))
    .sort((a,b) => b.expectedValue - a.expectedValue)
    .slice(0, 12);
  const value = { page, section: stripHtml(section.line), drops, source: 'RuneScape Wiki', updatedAt: Date.now() };
  const entry = { at: Date.now(), value };
  bossDropMemory.set(key, entry);
  void cachePut(`boss-drops:${key}`, entry);
  return value;
}
