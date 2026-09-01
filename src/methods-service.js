import { buildRuntime } from './engine/runtime.js';
import { buildPriceTable } from './engine/prices.js';
import { computeFrontiers } from './engine/frontier.js';
import { scorePathways } from './engine/dinkelbach.js';
import { cacheGet, cachePut } from './idb.js';

const DATA_BASE = 'https://raw.githubusercontent.com/Psyrcuit/rs3-pathfinder-data/main/data';
const WIKI_API = 'https://runescape.wiki/api.php';
const MMG_TTL_MS = 60 * 60 * 1000;
const ITEMS_FALLBACK = new URL('../data/fallback/items.core.json.gz', import.meta.url);
const ACTIONS_FALLBACK = new URL('../data/fallback/actions.json.gz', import.meta.url);
const MMG_FALLBACK = new URL('../data/fallback/mmg-frozen.json.gz', import.meta.url);
const SOURCE_MAP_URL = new URL('../data/method-source-map.json', import.meta.url);
export const SKILLS = [
  'Attack','Defence','Strength','Constitution','Ranged','Prayer','Magic','Cooking',
  'Woodcutting','Fletching','Fishing','Firemaking','Crafting','Smithing','Mining','Herblore',
  'Agility','Thieving','Slayer','Farming','Runecrafting','Hunter','Construction','Summoning',
  'Dungeoneering','Divination','Invention','Archaeology','Necromancy',
];
const SKILL_BY_LOWER = new Map(SKILLS.map((s) => [s.toLowerCase(), s]));

let datasetState = null;
let mmgState = null;
let sourceMapPromise = null;
let scoreCache = { key: '', at: 0, value: null };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithRetry(url, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        const e = new Error(`HTTP ${res.status} for ${url}`);
        e.status = res.status;
        throw e;
      }
      return res;
    } catch (e) {
      last = e;
      if (i + 1 >= attempts) break;
      await sleep(300 * (i + 1));
    }
  }
  throw last ?? new Error(`Could not fetch ${url}`);
}

const fetchJson = async (url) => (await fetchWithRetry(url)).json();
const fetchBytes = async (url) => new Uint8Array(await (await fetchWithRetry(url)).arrayBuffer());

async function parseMaybeGzip(bytes) {
  let raw = bytes;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (!('DecompressionStream' in globalThis)) throw new Error('This browser cannot decompress the bundled RuneScape dataset.');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    raw = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return JSON.parse(new TextDecoder().decode(raw));
}

async function loadFallbackDataset() {
  const [itemsBody, actionsBody] = await Promise.all([
    fetchBytes(ITEMS_FALLBACK).then(parseMaybeGzip),
    fetchBytes(ACTIONS_FALLBACK).then(parseMaybeGzip),
  ]);
  return {
    tag: 'bundled-2026-08-30',
    items: itemsBody.items ?? [],
    actions: actionsBody.actions ?? [],
    source: 'bundled fallback',
  };
}

async function loadLatestDataset() {
  try {
    const manifest = await fetchJson(`${DATA_BASE}/manifest.json`);
    const [itemsBody, actionsBody] = await Promise.all([
      fetchBytes(`${DATA_BASE}/items.core.json.gz`).then(parseMaybeGzip),
      fetchBytes(`${DATA_BASE}/actions.json.gz`).then(parseMaybeGzip),
    ]);
    if (!Array.isArray(itemsBody.items) || !Array.isArray(actionsBody.actions)) throw new Error('Unexpected dataset shape');
    return {
      tag: String(manifest?.tag || 'latest'),
      items: itemsBody.items,
      actions: actionsBody.actions,
      source: 'latest Pathfinder dataset',
    };
  } catch (error) {
    console.warn('[methods] latest dataset unavailable; using bundled fallback:', error?.message || error);
    return loadFallbackDataset();
  }
}

export async function getDataset() {
  if (datasetState) return datasetState;
  const loaded = await loadLatestDataset();
  datasetState = { ...loaded, graph: buildRuntime(loaded.items, loaded.actions) };
  console.log(`[methods] loaded ${loaded.actions.length} actions (${loaded.source}, ${loaded.tag})`);
  return datasetState;
}

function extractRows(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    if (data.error) throw new Error(`Wiki Bucket error: ${JSON.stringify(data.error)}`);
    for (const key of ['bucket','rows','result','data','query']) if (Array.isArray(data[key])) return data[key];
    for (const value of Object.values(data)) if (Array.isArray(value)) return value;
  }
  throw new Error('Wiki Bucket response contained no rows');
}

function buildMmgUrl() {
  const query = "bucket('money_making_guide').select('page_name','json').limit(5000).offset(0).run()";
  return `${WIKI_API}?action=bucket&format=json&origin=*&query=${encodeURIComponent(query)}`;
}

const loadFallbackMmgRows = async () => parseMaybeGzip(await fetchBytes(MMG_FALLBACK));

async function readMmgBrowserCache() {
  const body = await cacheGet('mmg-current');
  return Array.isArray(body?.rows) && Date.now() - Number(body.fetchedAt || 0) < MMG_TTL_MS ? body : null;
}

async function fetchCurrentMmgRows() {
  const data = await fetchJson(buildMmgUrl());
  const rows = extractRows(data);
  const body = { fetchedAt: Date.now(), rows };
  await cachePut('mmg-current', body);
  return { ...body, source: 'live RuneScape Wiki' };
}

export async function getMmgState() {
  if (mmgState && Date.now() - mmgState.fetchedAt < MMG_TTL_MS) return mmgState;
  const disk = await readMmgBrowserCache();
  let body;
  if (disk) body = { ...disk, source: 'cached RuneScape Wiki' };
  else {
    try { body = await fetchCurrentMmgRows(); }
    catch (error) {
      console.warn('[requirements] live Wiki MMG data unavailable; using bundled snapshot:', error?.message || error);
      body = { fetchedAt: Date.now(), rows: await loadFallbackMmgRows(), source: 'bundled Wiki snapshot' };
    }
  }
  const byPage = new Map();
  for (const r of body.rows) {
    const page = String(r?.page_name || '');
    if (!page) continue;
    let row;
    try { row = typeof r.json === 'string' ? JSON.parse(r.json) : r.json; } catch { continue; }
    if (!row || typeof row !== 'object') continue;
    const list = byPage.get(page) ?? [];
    list.push(row);
    byPage.set(page, list);
  }
  mmgState = { ...body, byPage };
  console.log(`[requirements] ${byPage.size} current MMG pages loaded from ${body.source}`);
  return mmgState;
}

async function getSourceMap() {
  if (!sourceMapPromise) sourceMapPromise = fetchJson(SOURCE_MAP_URL);
  return sourceMapPromise;
}

function attr(tag, name) {
  return new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
}

// Same strength rule as Pathfinder: blank data-mmg-imp inherits, and top-level blank = required.
function parseRequirements(html) {
  if (!html) return [];
  const out = [];
  const stack = [];
  const tagRe = /<(\/?)(?:span)([^>]*)>/g;
  let m;
  while ((m = tagRe.exec(String(html))) !== null) {
    if (m[1] === '/') { stack.pop(); continue; }
    const attrs = m[2] ?? '';
    const inherited = stack.length ? stack[stack.length - 1] : 'required';
    const raw = attr(attrs, 'data-mmg-imp');
    const strength = ['recommended','optional','required'].includes(raw) ? raw : inherited;
    if (/class="[^"]*\bmmg-req\b/.test(attrs)) {
      const skill = attr(attrs, 'data-mmg-skill');
      const quest = attr(attrs, 'data-mmg-quest');
      const item = attr(attrs, 'data-mmg-item');
      if (skill !== undefined || quest !== undefined || item !== undefined) {
        const level = Number(attr(attrs, 'data-mmg-level'));
        out.push({
          strength,
          ...(skill !== undefined ? { skill } : {}),
          ...(Number.isFinite(level) ? { level } : {}),
          ...(quest !== undefined ? { quest } : {}),
          ...(item !== undefined ? { item } : {}),
        });
      }
    }
    stack.push(strength);
  }
  return out;
}

function cleanWikiText(s) {
  return String(s || '').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}

function liveRequirementsFor(score, action, mmg, sourceMap) {
  let candidates = sourceMap[score.page];
  if (candidates && !Array.isArray(candidates)) candidates = [candidates];
  if ((!candidates || candidates.length === 0) && score.page.startsWith('Money making guide/')) candidates = [{ guide: score.page, row: 0 }];
  if (!candidates?.length) return null;

  const sig = [...new Set((action.inputs ?? []).map((i) => i.item))].sort((a,b) => a-b).join('+');
  const ref = candidates.find((c) => c.inputSig && c.inputSig === sig) ?? candidates[0];
  const rows = mmg.byPage.get(ref.guide);
  if (!rows?.length) return null;

  let row = rows[Math.min(Math.max(Number(ref.row || 0), 0), rows.length - 1)] ?? rows[0];
  if (rows.length > 1) {
    const wanted = String(score.outputName || '').toLowerCase();
    const byOutput = rows.find((candidate) => Array.isArray(candidate.outputs) && candidate.outputs.some((o) => String(o?.name || '').toLowerCase() === wanted));
    if (byOutput) row = byOutput;
  }

  const parsed = ['skill','quest','item','other'].flatMap((f) => parseRequirements(row[f]));
  const required = parsed.filter((r) => r.strength === 'required');
  const recommended = parsed.filter((r) => r.strength === 'recommended');
  const skills = new Map();
  const quests = new Set();
  const items = new Set();
  const recommendedSkills = new Map();
  const recommendedQuests = new Set();
  const recommendedItems = new Set();
  const absorb = (list, skillMap, questSet, itemSet) => {
    for (const r of list) {
      if (r.skill) {
        const canonical = SKILL_BY_LOWER.get(String(r.skill).toLowerCase());
        if (canonical && Number.isFinite(r.level)) skillMap.set(canonical, Math.max(skillMap.get(canonical) ?? 1, Number(r.level)));
      }
      if (r.quest) questSet.add(r.quest);
      if (r.item) itemSet.add(r.item);
    }
  };
  absorb(required, skills, quests, items);
  absorb(recommended, recommendedSkills, recommendedQuests, recommendedItems);

  const xp = Array.isArray(row.xp)
    ? row.xp
        .filter((x) => x && typeof x.skill === 'string' && SKILL_BY_LOWER.has(x.skill.toLowerCase()) && Number.isFinite(Number(x.xp)))
        .map((x) => ({
          skill: SKILL_BY_LOWER.get(x.skill.toLowerCase()),
          xp: Number(x.xp),
          isPerHour: x.isph === true,
        }))
    : [];

  let primarySkill = xp[0]?.skill ?? null;
  if (!primarySkill && skills.size) primarySkill = [...skills.keys()][0];

  return {
    skills: [...skills].map(([skill, level]) => ({ skill, level })),
    quests: [...quests],
    items: [...items],
    recommendedSkills: [...recommendedSkills].map(([skill, level]) => ({ skill, level })),
    recommendedQuests: [...recommendedQuests],
    recommendedItems: [...recommendedItems],
    xp,
    primarySkill,
    guide: ref.guide,
    source: mmg.source,
    activity: cleanWikiText(row.activity),
  };
}

function datasetRequirements(action) {
  const skills = [];
  const quests = [];
  for (const r of action.reqs ?? []) {
    if (r.type === 'skill' && SKILLS.includes(r.skill)) skills.push({ skill: r.skill, level: Number(r.level || 1) });
    if (r.type === 'quest' && r.name) quests.push(r.name);
  }
  return { skills, quests, items: [], recommendedSkills: [], recommendedQuests: [], recommendedItems: [], xp: [], primarySkill: skills[0]?.skill ?? null, guide: null, source: 'Pathfinder Wiki dataset', activity: '' };
}

function primarySkillFor(score, action, req) {
  if (req.primarySkill) return req.primarySkill;
  const direct = (action.reqs ?? []).find((r) => r.type === 'skill' && SKILLS.includes(r.skill));
  if (direct) return direct.skill;
  return score.kind === 'kill' ? 'Combat' : null;
}

function categoryFor(kind) {
  if (kind === 'recipe') return 'processing';
  if (kind === 'gather') return 'gathering';
  if (kind === 'kill') return 'PvM';
  return null;
}

function buildAllowedActions(ds, mmg, sourceMap, profile) {
  if (!profile?.skills) return null;
  const allowed = new Set();
  for (const action of ds.actions) {
    let req;
    let candidates = sourceMap[action.sourceRef];
    if (candidates && !Array.isArray(candidates)) candidates = [candidates];
    const sig = [...new Set((action.inputs ?? []).map((i) => i.item))].sort((a,b) => a-b).join('+');
    const liveMappingFits = Array.isArray(candidates) && candidates.some((c) => !c.inputSig || c.inputSig === sig);
    if (liveMappingFits) {
      const primary = (action.outputs ?? []).find((o) => o.primary);
      const primaryItem = primary ? ds.graph.items[ds.graph.indexById.get(primary.item)] : null;
      req = liveRequirementsFor(
        { page: action.sourceRef, outputName: primaryItem?.name ?? '' },
        action,
        mmg,
        sourceMap,
      ) ?? datasetRequirements(action);
    } else {
      // Do not apply a live MMG row for a different recipe variant. The source
      // map can contain a guide row only for one input signature (e.g. normal
      // logs for Shaft); falling back to it for Magic logs would incorrectly
      // turn an 80 Fletching acquisition route into a level-1 route.
      req = datasetRequirements(action);
    }
    let ok = true;
    for (const r of req.skills ?? []) {
      const have = Number(profile.skills[r.skill] ?? 1);
      if (have < Number(r.level ?? 1)) { ok = false; break; }
    }
    // A self-source/acquisition action that needs a quest must not be assumed
    // available when the browser lookup cannot verify quest completion. If the
    // item is tradeable the frontier can still fall back to buying it on the GE.
    if (ok && (req.quests ?? []).length) {
      if (!Array.isArray(profile.quests)) ok = false;
      else {
        const completed = new Set(profile.quests);
        if ((req.quests ?? []).some((q) => !completed.has(q))) ok = false;
      }
    }
    if (ok) allowed.add(action.idx);
  }
  return allowed;
}

function sidedHourlyVolume(oneHour, daily) {
  const out = new Map();
  const fallbackFor = (id) => Number(daily[String(id)] || 0) / 24 / 2;
  for (const [id, b] of Object.entries(oneHour || {})) {
    const n = Number(id);
    const fallback = fallbackFor(n);
    out.set(n, {
      buy: Number(b?.highPriceVolume || 0) > 0 ? Number(b.highPriceVolume) : fallback,
      sell: Number(b?.lowPriceVolume || 0) > 0 ? Number(b.lowPriceVolume) : fallback,
    });
  }
  for (const [id, v] of Object.entries(daily || {})) {
    const n = Number(id);
    if (!out.has(n)) out.set(n, { buy: Number(v) / 24 / 2, sell: Number(v) / 24 / 2 });
  }
  return out;
}

export async function scoreMethods({ latest, volumes, oneHour, lastCompleteHour, bankroll, profile, geOnly = false }) {
  const ds = await getDataset();
  const mmg = await getMmgState();
  const sourceMap = await getSourceMap();
  const nowSec = Math.floor(Date.now() / 1000);
  const profileKey = profile?.skills
    ? SKILLS.map((skill) => `${skill}:${Number(profile.skills[skill] ?? 1)}`).join(',')
    : 'no-profile';
  const cacheKey = `${Math.floor(nowSec / 55)}:${Math.floor(bankroll)}:${geOnly ? 'ge' : 'smart'}:${profileKey}:${Object.keys(lastCompleteHour || {}).length}`;
  if (scoreCache.value && scoreCache.key === cacheKey && Date.now() - scoreCache.at < 50_000) return scoreCache.value;

  const prices = buildPriceTable(ds.graph, latest, { nowSec });
  const mergedHour = { ...(oneHour || {}), ...(lastCompleteHour || {}) };
  const volumeByGe = sidedHourlyVolume(mergedHour, volumes);
  const buyVolume = new Float64Array(ds.graph.items.length).fill(0);
  const sellVolume = new Float64Array(ds.graph.items.length).fill(0);
  for (let i = 0; i < ds.graph.items.length; i++) {
    const geId = ds.graph.items[i]?.geId;
    if (geId === undefined) continue;
    const v = volumeByGe.get(geId);
    buyVolume[i] = v?.buy ?? 0;
    sellVolume[i] = v?.sell ?? 0;
  }

  // These are the original Pathfinder engine functions, compiled from the supplied repository.
  const allowedActions = buildAllowedActions(ds, mmg, sourceMap, profile);
  const frontiers = computeFrontiers(ds.graph, prices, {
    geOnly,
    profile,
    allowedActions,
  });
  const raw = scorePathways(ds.graph, prices, frontiers, {
    buyVolume,
    sellVolume,
    volumeShare: 0.1,
    ...(bankroll > 0 ? { bankroll } : {}),
  });

  const rows = [];
  for (const score of raw) {
    const category = categoryFor(score.kind);
    if (!category || !(score.sustainedGpPerHour > 0)) continue;
    const action = ds.actions[score.actionIdx];
    if (!action) continue;
    const req = liveRequirementsFor(score, action, mmg, sourceMap) ?? datasetRequirements(action);
    const primarySkill = primarySkillFor(score, action, req);
    const primaryOutput = (action.outputs ?? []).find((o) => o.primary);
    const primaryOutputQty = Number(primaryOutput?.qtyEV ?? primaryOutput?.qty ?? 0);
    const primaryItem = primaryOutput ? ds.graph.items[ds.graph.indexById.get(primaryOutput.item)] : null;
    const primaryXp = (req.xp ?? []).find((x) => x.skill === primarySkill) ?? req.xp?.[0] ?? null;
    const xpPerHour = primaryXp
      ? primaryXp.isPerHour
        ? primaryXp.xp
        : primaryXp.xp * (3600 / Math.max(0.001, score.secondsPerRun))
      : null;
    rows.push({
      id: score.actionIdx,
      method: score.page,
      variant: score.variantLabel ?? '',
      output: score.outputName,
      primaryGeId: Number.isFinite(Number(primaryItem?.geId)) ? Number(primaryItem.geId) : null,
      category,
      primarySkill,
      gpPerHour: score.sustainedGpPerHour,
      xpPerHour,
      effort: score.effort,
      actionsPerMinute: score.interactionSec > 0 ? 60 / score.interactionSec : null,
      profitPerRun: score.profitPerRun,
      profitPerItem: primaryOutputQty > 0 ? score.profitPerRun / primaryOutputQty : null,
      outputQtyPerRun: primaryOutputQty > 0 ? primaryOutputQty : null,
      costPerRun: score.costPerRun,
      revenuePerRun: score.revenuePerRun,
      secondsPerRun: score.secondsPerRun,
      selfSourceSecondsPerRun: score.selfSourceSecondsPerRun ?? 0,
      interactionSec: score.interactionSec,
      requirements: req,
      requiredItems: score.inputChoices
        .filter((c) => String(c.itemName || '').trim().toLowerCase() !== 'coins')
        .map((c) => ({
          name: c.itemName,
          qty: c.qty,
          source: c.mode === 'buy'
            ? 'Buy on GE'
            : `Self-source${c.acquisition?.summary ? ` — ${c.acquisition.summary}` : ''}`,
          sourceMode: c.mode === 'buy' ? 'ge' : 'self',
          gpPerUnit: c.gpPerUnit,
          secPerUnit: c.secPerUnit ?? 0,
          acquisition: c.acquisition ?? null,
        })),
      wikiPage: req.guide || score.page,
      requirementSkills: req.skills.map((x) => x.skill),
      confidence: score.confidence,
    });
  }
  rows.sort((a,b) => b.gpPerHour - a.gpPerHour);
  const value = {
    rows,
    datasetTag: ds.tag,
    datasetSource: ds.source,
    requirementsSource: mmg.source,
    sourcingMode: geOnly ? 'ge-only' : 'optimised',
    updatedAt: Date.now(),
  };
  scoreCache = { key: cacheKey, at: Date.now(), value };
  return value;
}


const CONFIDENCE_ORDER = { curated: 4, computed: 3, estimated: 2, theoretical: 1 };
const PVM_SKILLS = ['Necromancy','Ranged','Magic','Attack','Strength','Slayer','Defence','Prayer','Constitution','Herblore','Summoning'];
const PVM_STYLE_SKILLS = new Set(['Attack','Strength','Ranged','Magic','Necromancy']);

function mmgCategory(raw) {
  const value = String(raw || '').toLowerCase();
  if (value === 'processing') return 'processing';
  if (value === 'gathering' || value === 'collecting' || value === 'divination' || value === 'skilling') return 'gathering';
  if (value.startsWith('combat')) return 'PvM';
  return null;
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function publishedProfit(row) {
  const prices = row?.prices || {};
  const direct = finiteNumber(prices.value);
  if (direct !== null) return direct;
  return finiteNumber(prices.default_value);
}

function publishedInputPerHour(row) {
  const p = row?.prices || {};
  const direct = finiteNumber(p.input);
  if (direct !== null) return Math.max(0, direct);
  const perHour = finiteNumber(p.input_perhour) || 0;
  const perKill = finiteNumber(p.input_perkill) || 0;
  const kph = finiteNumber(p.default_kph) || 0;
  const value = perHour + perKill * kph;
  return value > 0 ? value : 0;
}

function publishedRoi(row) {
  const profit = publishedProfit(row);
  const input = publishedInputPerHour(row);
  return profit !== null && profit > 0 && input > 0 ? (profit / input) * 100 : null;
}

function requirementsFromWikiRow(row, page, source) {
  const parsed = ['skill','quest','item','other'].flatMap((f) => parseRequirements(row?.[f]));
  const collect = (strength) => {
    const skills = new Map();
    const quests = new Set();
    const items = new Set();
    for (const r of parsed.filter((x) => x.strength === strength)) {
      if (r.skill) {
        const canonical = SKILL_BY_LOWER.get(String(r.skill).toLowerCase());
        if (canonical && Number.isFinite(r.level)) skills.set(canonical, Math.max(skills.get(canonical) || 1, Number(r.level)));
      }
      if (r.quest) quests.add(r.quest);
      if (r.item) items.add(r.item);
    }
    return { skills: [...skills].map(([skill, level]) => ({ skill, level })), quests: [...quests], items: [...items] };
  };
  const hard = collect('required');
  const rec = collect('recommended');
  const xp = Array.isArray(row?.xp) ? row.xp
    .filter((x) => x && typeof x.skill === 'string' && SKILL_BY_LOWER.has(x.skill.toLowerCase()) && Number.isFinite(Number(x.xp)))
    .map((x) => ({ skill: SKILL_BY_LOWER.get(x.skill.toLowerCase()), xp: Number(x.xp), isPerHour: x.isph === true })) : [];
  return {
    ...hard,
    recommendedSkills: rec.skills,
    recommendedQuests: rec.quests,
    recommendedItems: rec.items,
    xp,
    guide: page,
    source,
    activity: cleanWikiText(row?.activity),
  };
}

function primarySkillFromWiki(category, req) {
  if (category === 'PvM') {
    for (const skill of PVM_SKILLS) {
      if ((req.skills || []).some((r) => r.skill === skill) || (req.recommendedSkills || []).some((r) => r.skill === skill)) return skill;
    }
    return 'Combat';
  }
  const xpSkill = (req.xp || []).find((x) => x.skill && !['Constitution','Prayer'].includes(x.skill))?.skill;
  return xpSkill || req.skills?.[0]?.skill || req.recommendedSkills?.[0]?.skill || null;
}

function inferPrimarySkill(activity, category) {
  const t = String(activity || '').toLowerCase();
  const rules = [
    [/mining|ore|sandstone|clay/, 'Mining'], [/woodcut|cutting .*logs|logs$/, 'Woodcutting'],
    [/fish|fishing/, 'Fishing'], [/smith|smelt|bar(s)?\b/, 'Smithing'], [/fletch|shaft|arrow|bolt/, 'Fletching'],
    [/potion|herb|cleaning .*herb|incense/, 'Herblore'], [/craft|tanning|hide|leather|jewell|urn|glass/, 'Crafting'],
    [/cook|bake|wine|food/, 'Cooking'], [/runecraft|rune altar|runes\b/, 'Runecrafting'], [/divinat|energy|memory/, 'Divination'],
    [/archaeolog|material cache|excavat/, 'Archaeology'], [/hunter|hunting|chinchompa/, 'Hunter'], [/farm|harvest|pick .*herb/, 'Farming'],
    [/thiev|pickpocket|steal/, 'Thieving'], [/firemak|bonfire|burn/, 'Firemaking'], [/summon|binding contract|pouch/, 'Summoning'],
    [/construction|plank/, 'Construction'], [/agility|course/, 'Agility'], [/slayer/, 'Slayer'], [/necrom|ritual|ectoplasm/, 'Necromancy'],
  ];
  for (const [re, skill] of rules) if (re.test(t)) return skill;
  return category === 'PvM' ? 'Combat' : 'General';
}

function baseEffortFromIntensity(intensity) {
  const x = String(intensity || '').toLowerCase();
  if (x === 'low') return 3;
  if (x === 'moderate') return 6;
  if (x === 'high') return 9;
  return 5;
}

function adjustEffortForProfile(base, category, req, profile) {
  let effort = Math.max(1, Math.min(10, Math.round(Number(base) || 5)));
  let basis = 'Estimated from the RuneScape Wiki intensity rating.';
  if (category !== 'PvM' || !profile?.skills) return { effort, basis };
  const relevant = (req.recommendedSkills || []).filter((r) => PVM_SKILLS.includes(r.skill) && r.level > 1);
  const hard = (req.skills || []).filter((r) => PVM_SKILLS.includes(r.skill) && r.level > 1);
  const targets = relevant.length ? relevant : hard;
  if (!targets.length) return { effort, basis: `${basis} No reliable player-specific combat target was available.` };
  const ratios = targets.map((r) => Number(profile.skills[r.skill] || 1) / Number(r.level || 1));
  const avg = ratios.reduce((a,b) => a+b, 0) / ratios.length;
  if (avg >= 1.25) effort -= 3;
  else if (avg >= 1.10) effort -= 2;
  else if (avg >= 1.00) effort -= 1;
  else if (avg < 0.80) effort += 2;
  else if (avg < 0.95) effort += 1;
  effort = Math.max(1, Math.min(10, effort));
  basis = 'Adjusted from the Wiki intensity using your relevant combat levels. Equipment is not available from the player lookup, so gear is not guessed.';
  return { effort, basis };
}

function confidenceByPage(ds, sourceMap = {}) {
  const map = new Map();
  for (const action of ds.actions || []) {
    const page = String(action.sourceRef || '');
    if (!page) continue;
    const c = String(action.confidence || '');
    const apply = (target) => {
      const prev = map.get(target);
      if (!prev || (CONFIDENCE_ORDER[c] || 0) > (CONFIDENCE_ORDER[prev] || 0)) map.set(target, c);
    };
    apply(page);
    let refs = sourceMap[page];
    if (refs && !Array.isArray(refs)) refs = [refs];
    for (const ref of refs || []) if (ref?.guide) apply(String(ref.guide));
  }
  return map;
}

function buildItemNameLookup(ds) {
  const map = new Map();
  for (const item of ds.graph.items || []) {
    if (!item?.name) continue;
    map.set(String(item.name).trim().toLowerCase(), item);
  }
  return map;
}

function liveSidePrice(itemName, side, itemLookup, latest) {
  if (String(itemName).toLowerCase() === 'coins') return 1;
  const item = itemLookup.get(String(itemName || '').trim().toLowerCase());
  const geId = item?.geId;
  if (!Number.isFinite(Number(geId))) return null;
  const q = latest?.[String(geId)] || latest?.[Number(geId)];
  const value = side === 'buy' ? Number(q?.high) : Number(q?.low);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function qtyPerHour(entry, row) {
  const qty = finiteNumber(entry?.qty);
  if (qty === null) return null;
  if (entry?.isph === true) return qty;
  const kph = finiteNumber(row?.prices?.default_kph);
  if (kph !== null && kph > 0) return qty * kph;
  return null;
}

function geOnlyWikiEconomics(row, itemLookup, latest) {
  let input = 0;
  let output = 0;
  for (const x of row.inputs || []) {
    const price = liveSidePrice(x.name, 'buy', itemLookup, latest);
    const qph = qtyPerHour(x, row);
    if (price === null || qph === null) return null;
    input += price * qph;
  }
  for (const x of row.outputs || []) {
    const price = liveSidePrice(x.name, 'sell', itemLookup, latest);
    const qph = qtyPerHour(x, row);
    if (price === null || qph === null) return null;
    output += price * qph;
  }
  if (!(output > 0)) return null;
  const profit = output - input;
  return { profit, input, output, roi: input > 0 ? (profit / input) * 100 : null };
}

function pickMmgRow(mmg, page, outputName = '') {
  const rows = mmg.byPage.get(page) || [];
  if (!rows.length) return null;
  const wanted = String(outputName || '').toLowerCase();
  if (wanted) {
    const byOutput = rows.find((r) => (r.outputs || []).some((o) => String(o?.name || '').toLowerCase() === wanted));
    if (byOutput) return byOutput;
  }
  return rows[0];
}

function bossPageFromActivity(row) {
  const text = String(row?.activity || '');
  const links = [...text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].map((m) => m[1]);
  const bad = /^(coins?|money|grand exchange)$/i;
  return links.find((x) => !bad.test(x)) || null;
}

function wikiDirectRows({ ds, mmg, latest, profile, geOnly, coveredPages, sourceMap }) {
  const out = [];
  const itemLookup = buildItemNameLookup(ds);
  const confidence = confidenceByPage(ds, sourceMap);
  let serial = 1;
  for (const [page, variants] of mmg.byPage) {
    for (let vi = 0; vi < variants.length; vi++) {
      const row = variants[vi];
      const category = mmgCategory(row.category);
      if (!category) continue;
      if (row.recurrence || row.time) continue;
      if (category !== 'PvM' && coveredPages.has(page)) continue;
      const wikiGp = publishedProfit(row);
      if (!(wikiGp > 0) || wikiGp > 1e10) continue;
      const req = requirementsFromWikiRow(row, page, mmg.source);
      const primarySkill = primarySkillFromWiki(category, req) || inferPrimarySkill(row.activity, category);
      const inputCostWiki = publishedInputPerHour(row);
      let gpPerHour = wikiGp;
      let roi = publishedRoi(row);
      let economicsSource = 'RuneScape Wiki hourly profit';
      if (geOnly) {
        // GE-only must never silently fall back to vendor/self-source/non-tradeable consumables.
        const allInputsTradeable = (row.inputs || []).every((x) => liveSidePrice(x.name, 'buy', itemLookup, latest) !== null);
        if (!allInputsTradeable) continue;
        // V7 explicitly keeps PvM profit on the Wiki-published figure so we do not
        // recreate kills/hour, supplies and loot assumptions from drop tables.
        if (category !== 'PvM') {
          const live = geOnlyWikiEconomics(row, itemLookup, latest);
          if (!live || !(live.profit > 0)) continue;
          gpPerHour = live.profit;
          roi = live.roi;
          economicsSource = 'GE-only live input/output prices';
        }
      }
      const baseEffort = baseEffortFromIntensity(row.intensity);
      const adjusted = adjustEffortForProfile(baseEffort, category, req, profile);
      const kph = finiteNumber(row?.prices?.default_kph);
      const actionsPerMinute = category === 'processing' && kph !== null && kph > 0 ? kph / 60 : null;
      const output = (row.outputs || [])[0] || null;
      const outputName = cleanWikiText(output?.name || '');
      const outputItem = itemLookup.get(outputName.toLowerCase());
      const outputGeId = Number.isFinite(Number(outputItem?.geId)) ? Number(outputItem.geId) : null;
      const secondsPerRun = kph !== null && kph > 0 ? 3600 / kph : null;
      const profitPerRun = kph !== null && kph > 0 ? gpPerHour / kph : null;
      const outputQtyCycle = output && output.isph !== true ? Number(output.qty || 0) : null;
      const profitPerItem = profitPerRun !== null && outputQtyCycle > 0 ? profitPerRun / outputQtyCycle : null;
      const conf = confidence.get(page) || '';
      out.push({
        id: `wiki:${serial++}`,
        method: cleanWikiText(row.activity) || page.replace(/^Money making guide\//, ''),
        variant: cleanWikiText(row.version || ''),
        output: outputName,
        primaryGeId: outputGeId,
        category,
        primarySkill,
        gpPerHour,
        roi,
        effort: adjusted.effort,
        effortBase: baseEffort,
        effortBasis: adjusted.basis,
        actionsPerMinute,
        profitPerRun,
        profitPerItem,
        outputQtyPerRun: outputQtyCycle,
        costPerRun: null,
        revenuePerRun: null,
        secondsPerRun,
        selfSourceSecondsPerRun: 0,
        interactionSec: actionsPerMinute ? 60 / actionsPerMinute : null,
        requirements: req,
        requiredItems: (row.inputs || [])
          .filter((x) => cleanWikiText(x.name).toLowerCase() !== 'coins')
          .map((x) => {
            const live = liveSidePrice(x.name, 'buy', itemLookup, latest);
            return {
              name: cleanWikiText(x.name),
              qty: Number(x.qty || 0),
              qtyIsPerHour: x.isph === true,
              source: live !== null ? 'Buy on GE' : 'Wiki-calculated / non-GE input',
              sourceMode: live !== null ? 'ge' : 'wiki',
              gpPerUnit: live !== null ? live : Number(x.value || 0),
              secPerUnit: 0,
              acquisition: null,
            };
          }),
        wikiPage: page,
        bossPage: category === 'PvM' ? bossPageFromActivity(row) : null,
        requirementSkills: req.skills.map((x) => x.skill),
        confidence: conf,
        theoretical: conf === 'theoretical',
        wikiPublished: true,
        economicsSource,
        wikiInputCostPerHour: inputCostWiki,
        wikiIntensity: String(row.intensity || ''),
      });
    }
  }
  return out;
}

function enrichPathfinderRows(rows, mmg, profile) {
  return rows.filter((r) => r.category !== 'PvM').map((row) => {
    const wikiRow = pickMmgRow(mmg, row.wikiPage, row.output);
    const req = wikiRow ? requirementsFromWikiRow(wikiRow, row.wikiPage, mmg.source) : row.requirements;
    const wikiRoi = wikiRow ? publishedRoi(wikiRow) : null;
    const base = wikiRow ? baseEffortFromIntensity(wikiRow.intensity) : Math.max(1, Math.min(10, Math.round(Number(row.effort || 50) / 10)));
    const adjusted = adjustEffortForProfile(base, row.category, req, profile);
    return {
      ...row,
      requirements: req,
      primarySkill: row.primarySkill || primarySkillFromWiki(row.category, req),
      roi: wikiRoi !== null ? wikiRoi : (row.costPerRun > 0 ? (row.profitPerRun / row.costPerRun) * 100 : null),
      effort: adjusted.effort,
      effortBase: base,
      effortBasis: adjusted.basis,
      theoretical: row.confidence === 'theoretical',
      wikiPublished: false,
      economicsSource: 'Pathfinder sourcing model',
    };
  });
}

function neutralRequirements(req) {
  const parts = [
    ...(req.skills ?? []).map((r) => `${r.skill} ${r.level}`),
    ...(req.quests ?? []).map((q) => q),
  ];
  return parts.length ? parts.join(' • ') : 'No level requirement';
}

function recommendedLabel(req) {
  const parts = [
    ...(req?.recommendedSkills ?? []).map((r) => `${r.level}+ ${r.skill}`),
    ...(req?.recommendedQuests ?? []).map((q) => q),
  ];
  return parts.join(', ');
}

function practicalSkillAssessment(row, profile) {
  const recs = row.requirements?.recommendedSkills ?? [];
  if (!profile?.skills || recs.length === 0) return { known: !!profile?.skills, unmet: [] };

  const levels = profile.skills;
  const unmet = [];
  const styleRecs = row.category === 'PvM' ? recs.filter((r) => PVM_STYLE_SKILLS.has(r.skill)) : [];
  const supportRecs = row.category === 'PvM' ? recs.filter((r) => !PVM_STYLE_SKILLS.has(r.skill)) : recs;

  // Combat styles are alternatives. A Ranged-ready character should not fail
  // because their Magic or melee stats are below an alternative recommendation.
  if (styleRecs.length) {
    const bySkill = new Map(styleRecs.map((r) => [r.skill, Number(r.level || 1)]));
    const options = [];
    if (bySkill.has('Attack') || bySkill.has('Strength')) {
      const melee = [];
      if (bySkill.has('Attack')) melee.push({ skill: 'Attack', level: bySkill.get('Attack') });
      if (bySkill.has('Strength')) melee.push({ skill: 'Strength', level: bySkill.get('Strength') });
      options.push(melee);
    }
    for (const skill of ['Ranged','Magic','Necromancy']) {
      if (bySkill.has(skill)) options.push([{ skill, level: bySkill.get(skill) }]);
    }

    const optionPasses = (option) => option.every((r) => Number(levels[r.skill] ?? 1) >= r.level);
    if (options.length === 1) {
      for (const r of options[0]) {
        if (Number(levels[r.skill] ?? 1) < r.level) unmet.push(`${r.level}+ ${r.skill}`);
      }
    } else if (options.length > 1 && !options.some(optionPasses)) {
      const label = options
        .map((option) => option.map((r) => `${r.level}+ ${r.skill}`).join(' + '))
        .join(' or ');
      unmet.push(label);
    }
  }

  for (const r of supportRecs) {
    const have = Number(levels[r.skill] ?? 1);
    if (have < Number(r.level ?? 1)) unmet.push(`${r.level}+ ${r.skill}`);
  }

  // Recommended quests affect practical readiness only when quest completion is
  // actually available. Unknown quest state is handled as confidence below.
  if (Array.isArray(profile.quests)) {
    const completed = new Set(profile.quests);
    for (const q of row.requirements?.recommendedQuests ?? []) {
      if (!completed.has(q)) unmet.push(q);
    }
  }

  return { known: true, unmet };
}

const GATHERING_SKILLS = new Set(['Mining','Woodcutting','Fishing','Hunter','Farming','Divination','Archaeology']);

function shortReadinessSummary(row, unmet, practicalUnmet, unverified) {
  if (unmet.length || practicalUnmet.length) {
    const details = practicalUnmet.length ? practicalUnmet : unmet;
    const recSkills = row.requirements?.recommendedSkills ?? [];
    const gathering = recSkills.filter((r) => GATHERING_SKILLS.has(r.skill));
    const combat = recSkills.filter((r) => PVM_SKILLS.includes(r.skill));
    if (gathering.length >= 3) {
      const min = Math.min(...gathering.map((r) => Number(r.level || 1)));
      return `${min}+ gathering skills`;
    }
    if (row.category === 'PvM' && combat.length >= 3) return 'High-level combat recommended';
    return `${details.slice(0, 2).join(' • ')}${details.length > 2 ? ` • +${details.length - 2} more` : ''}`;
  }
  if (unverified.length) return 'Quest / unlock not verified';

  const req = row.requirements ?? {};
  if ((req.skills ?? []).length === 1 && !(req.quests ?? []).length && !(req.items ?? []).length) {
    const r = req.skills[0];
    return `${r.skill} ${r.level}`;
  }
  if ((req.skills ?? []).length > 1) {
    const gathering = req.skills.filter((r) => GATHERING_SKILLS.has(r.skill));
    if (gathering.length >= 3) {
      const min = Math.min(...gathering.map((r) => Number(r.level || 1)));
      return `${min}+ gathering skills`;
    }
    if (row.category === 'PvM') return 'Combat requirements';
    return `${req.skills.slice(0, 2).map((r) => `${r.skill} ${r.level}`).join(' • ')}${req.skills.length > 2 ? ` • +${req.skills.length - 2} more` : ''}`;
  }
  if ((req.quests ?? []).length || (req.items ?? []).length) return 'Quest / unlock requirement';
  return 'No level requirement';
}

function accessItemUncertainty(req, itemLookup) {
  const out = [];
  for (const itemName of req?.items ?? []) {
    const item = itemLookup?.get(String(itemName || '').trim().toLowerCase());
    // Ordinary tradeable tools/items can be acquired before starting the method;
    // non-tradeable or unknown special items/access objects cannot be confirmed.
    if (!item || item.tradeable !== true) out.push(`${itemName} possession/access not verified`);
  }
  return out;
}

export function evaluateEligibility(row, profile, itemLookup = null) {
  if (!profile?.skills) {
    return {
      known: false,
      eligible: false,
      confirmedEligible: false,
      practicalEligible: false,
      status: 'unknown',
      unmet: [],
      practicalUnmet: [],
      unverified: [],
      requirementsText: neutralRequirements(row.requirements),
      recommendedText: recommendedLabel(row.requirements),
      summary: 'Load character levels to check readiness',
    };
  }

  const unmetSkills = [];
  const unmetQuests = [];
  const unverified = [];
  for (const r of row.requirements.skills ?? []) {
    const have = Number(profile.skills[r.skill] ?? 1);
    if (have < r.level) unmetSkills.push(`${r.skill} ${r.level} required`);
  }

  const requiredQuests = row.requirements.quests ?? [];
  if (requiredQuests.length) {
    if (Array.isArray(profile.quests)) {
      const completed = new Set(profile.quests);
      for (const q of requiredQuests) if (!completed.has(q)) unmetQuests.push(`${q} required`);
    } else {
      unverified.push(...requiredQuests.map((q) => `${q} completion not verified`));
    }
  }

  unverified.push(...accessItemUncertainty(row.requirements, itemLookup));

  const unmet = [...unmetSkills, ...unmetQuests];
  const practical = unmet.length === 0
    ? practicalSkillAssessment(row, profile)
    : { known: true, unmet: [] };
  const practicalUnmet = practical.unmet ?? [];

  // If a recommended quest exists but the browser player lookup has no quest
  // completion data, keep the method discoverable but do not call it confirmed.
  if (!Array.isArray(profile.quests) && (row.requirements?.recommendedQuests ?? []).length) {
    unverified.push('Recommended quest/unlock completion not verified');
  }

  const uniqueUnverified = [...new Set(unverified)];
  const notReady = unmet.length > 0 || practicalUnmet.length > 0;
  const status = notReady ? 'not_ready' : uniqueUnverified.length ? 'potential' : 'eligible';
  const confirmedEligible = status === 'eligible';

  return {
    known: true,
    eligible: confirmedEligible,
    confirmedEligible,
    practicalEligible: confirmedEligible,
    status,
    unmet,
    practicalUnmet,
    unverified: uniqueUnverified,
    requirementsText: unmet.length ? unmet.join(' • ') : neutralRequirements(row.requirements),
    recommendedText: recommendedLabel(row.requirements),
    summary: shortReadinessSummary(row, unmet, practicalUnmet, uniqueUnverified),
  };
}

export async function getMethodRows(args) {
  const [scored, ds, mmg, sourceMap] = await Promise.all([scoreMethods(args), getDataset(), getMmgState(), getSourceMap()]);
  const pathRows = enrichPathfinderRows(scored.rows, mmg, args.profile);
  const coveredPages = new Set(pathRows.map((r) => String(r.wikiPage || '')));
  const wikiRows = wikiDirectRows({
    ds, mmg, latest: args.latest, profile: args.profile, geOnly: args.geOnly, coveredPages, sourceMap,
  });
  const itemLookup = buildItemNameLookup(ds);
  const rows = [...pathRows, ...wikiRows]
    .map((row) => ({ ...row, eligibility: evaluateEligibility(row, args.profile, itemLookup) }))
    .sort((a,b) => b.gpPerHour - a.gpPerHour);
  return { ...scored, rows, requirementsSource: mmg.source, methodCount: rows.length };
}


/**
 * Jagex's RuneMetrics and HiScores endpoints do not send CORS headers. The
 * original Pathfinder web build has the same limitation: its browser build
 * falls back to manual levels, while Electron/Android inject a native fetch.
 * Keep this function so a future tiny proxy can be added without changing UI.
 */
export async function lookupPlayer(username) {
  const name = String(username || '').trim();
  if (!name) throw new Error('Enter a RuneScape name.');
  const proxy = String(globalThis.RS3_FLIPPY_PLAYER_PROXY || '').trim();
  if (proxy) {
    const joiner = proxy.includes('?') ? '&' : '?';
    const res = await fetch(`${proxy}${joiner}name=${encodeURIComponent(name)}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`Player lookup failed (${res.status}).`);
    return res.json();
  }
  throw new Error('RuneScape blocks automatic player lookup from normal web pages. Use Manual levels for now.');
}
