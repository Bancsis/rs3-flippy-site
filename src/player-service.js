const WIKI_API = 'https://runescape.wiki/api.php';
const WIKI_RUNEMETRICS_QUESTS = 'https://runescape.wiki/cors/m=runemetrics/quests?user=';

const SKILLS = [
  'Attack','Defence','Strength','Constitution','Ranged','Prayer','Magic','Cooking',
  'Woodcutting','Fletching','Fishing','Firemaking','Crafting','Smithing','Mining','Herblore',
  'Agility','Thieving','Slayer','Farming','Runecrafting','Hunter','Construction','Summoning',
  'Dungeoneering','Divination','Invention','Archaeology','Necromancy',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (i + 1 < attempts) await sleep(250 * (i + 1));
    }
  }
  throw lastError ?? new Error('Player lookup failed.');
}

/** Convert RuneScape XP to a level, up to the current 120 display cap. */
function levelFromXp(xp) {
  const target = Number(xp);
  if (!Number.isFinite(target) || target < 0) return null;
  let points = 0;
  let level = 1;
  for (let next = 1; next < 120; next++) {
    points += Math.floor(next + 300 * Math.pow(2, next / 7));
    const required = Math.floor(points / 4);
    if (target < required) break;
    level = next + 1;
  }
  return Math.max(1, Math.min(120, level));
}

function parseAggregateHiscores(rawText) {
  let raw = String(rawText || '').trim();
  raw = raw.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
  if (!raw) throw new Error('RuneScape player could not be found.');

  const records = raw.split(/\s+/).filter(Boolean);
  // Record 0 is Overall, followed by the 29 RS3 skills in HiScores order.
  if (records.length < 2) throw new Error('RuneScape Wiki returned incomplete HiScores data.');

  const levels = {};
  const unrankedSkills = [];
  for (let i = 0; i < SKILLS.length; i++) {
    const record = records[i + 1];
    if (!record) {
      levels[SKILLS[i]] = 1;
      unrankedSkills.push(SKILLS[i]);
      continue;
    }

    const [rankText, levelText, xpText] = record.split(',');
    const rank = Number(rankText);
    const listedLevel = Number(levelText);
    const xp = Number(xpText);

    let level = Number.isFinite(listedLevel) && listedLevel > 0
      ? listedLevel
      : levelFromXp(xp);

    if (!Number.isFinite(level) || level < 1) {
      level = 1;
      unrankedSkills.push(SKILLS[i]);
    } else if (!(Number.isFinite(rank) && rank >= 0) && !(Number.isFinite(xp) && xp >= 0)) {
      unrankedSkills.push(SKILLS[i]);
    }

    levels[SKILLS[i]] = Math.max(1, Math.min(120, Math.floor(level)));
  }

  return { levels, unrankedSkills };
}

async function lookupViaWikiHiscores(name) {
  // Jagex's own HiScores endpoint does not expose browser CORS headers.
  // RuneScape Wiki's RSHiscores parser already retrieves that data server-side,
  // while the Wiki API itself supports browser requests with origin=*.
  const params = new URLSearchParams({
    action: 'expandtemplates',
    format: 'json',
    formatversion: '2',
    origin: '*',
    prop: 'wikitext',
    text: `{{#hs:rs3|${name}}}`,
  });

  const body = await fetchJson(`${WIKI_API}?${params.toString()}`);
  const expanded = String(body?.expandtemplates?.wikitext || '');
  if (/class=["']?error/i.test(expanded)) throw new Error('RuneScape player could not be found.');

  const { levels, unrankedSkills } = parseAggregateHiscores(expanded);
  return {
    levels,
    source: 'RuneScape Wiki HiScores',
    unrankedSkills,
  };
}

function normaliseQuestName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\((?:mini)?quest\)|\(saga\)|\(minigame\)/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');
}

function parseQuestList(rawQuests) {
  const questStatuses = {};
  const completed = [];
  if (!Array.isArray(rawQuests)) return { quests: null, questStatuses: null };
  for (const raw of rawQuests) {
    if (typeof raw === 'string') {
      const key = normaliseQuestName(raw);
      if (key) { questStatuses[key] = { status: 'COMPLETED', title: raw }; completed.push(raw); }
      continue;
    }
    const title = String(raw?.title || raw?.name || '').trim();
    const status = String(raw?.status || '').toUpperCase();
    const key = normaliseQuestName(title);
    if (!key || !status) continue;
    questStatuses[key] = {
      status,
      title,
      questPoints: Number(raw?.questPoints || 0) || 0,
      eligible: raw?.userEligible ?? raw?.eligible ?? null,
    };
    if (status === 'COMPLETED') completed.push(title);
  }
  return Object.keys(questStatuses).length
    ? { quests: completed, questStatuses }
    : { quests: null, questStatuses: null };
}

async function lookupViaWikiRuneMetrics(name) {
  const body = await fetchJson(`${WIKI_RUNEMETRICS_QUESTS}${encodeURIComponent(name)}`);
  const parsed = parseQuestList(body?.quests);
  if (!parsed.questStatuses) throw new Error('RuneMetrics quest completion is unavailable or private.');
  return parsed;
}

function normaliseProxyResponse(body) {
  const levels = body?.levels || body?.skills || {};
  let parsed = parseQuestList(body?.quests);
  if (body?.questStatuses && typeof body.questStatuses === 'object') {
    const questStatuses = {};
    const completed = new Set(parsed.quests || []);
    for (const [rawKey, rawEntry] of Object.entries(body.questStatuses)) {
      const entry = typeof rawEntry === 'string' ? { status: rawEntry, title: rawKey } : rawEntry || {};
      const title = String(entry.title || entry.name || rawKey).trim();
      const status = String(entry.status || '').toUpperCase();
      const key = normaliseQuestName(title);
      if (!key || !status) continue;
      questStatuses[key] = { ...entry, title, status };
      if (status === 'COMPLETED') completed.add(title);
    }
    parsed = {
      quests: [...completed],
      questStatuses: Object.keys(questStatuses).length ? questStatuses : parsed.questStatuses,
    };
  }
  return {
    ...body,
    levels,
    quests: parsed.quests,
    questStatuses: parsed.questStatuses,
    source: body?.source || 'Configured player service',
  };
}

/**
 * Browser-safe automatic player lookup.
 *
 * If a dedicated proxy is configured we prefer it because it can optionally
 * return RuneMetrics quest completion data as well. Otherwise the static site
 * uses RuneScape Wiki's CORS-enabled HiScores bridge, so GitHub Pages needs no
 * backend just to load skill levels.
 */
export async function lookupPlayer(username) {
  const name = String(username || '').trim();
  if (!name) throw new Error('Enter a RuneScape name.');
  if (!/^[A-Za-z0-9 _-]{1,12}$/.test(name)) throw new Error('Enter a valid RuneScape display name.');

  const proxy = String(globalThis.RS3_FLIPPY_PLAYER_PROXY || '').trim();
  if (proxy) {
    const joiner = proxy.includes('?') ? '&' : '?';
    const response = await fetch(`${proxy}${joiner}name=${encodeURIComponent(name)}`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Player lookup failed (${response.status}).`);
    return normaliseProxyResponse(await response.json());
  }

  const [skillsResult, questsResult] = await Promise.allSettled([
    lookupViaWikiHiscores(name),
    lookupViaWikiRuneMetrics(name),
  ]);
  if (skillsResult.status === 'rejected') throw skillsResult.reason;
  const skills = skillsResult.value;
  const questData = questsResult.status === 'fulfilled'
    ? questsResult.value
    : { quests: null, questStatuses: null };
  return {
    ...skills,
    ...questData,
    source: questsResult.status === 'fulfilled'
      ? 'RuneScape Wiki HiScores and RuneMetrics'
      : skills.source,
    questWarning: questsResult.status === 'rejected'
      ? (questsResult.reason?.message || 'Quest completion could not be loaded.')
      : null,
  };
}
