const QUEST_DATA_URL = new URL('../data/quests.json', import.meta.url);

let datasetPromise = null;

export function normaliseQuestName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\((?:mini)?quest\)|\(saga\)|\(minigame\)/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');
}

export async function getQuestDataset() {
  if (!datasetPromise) {
    datasetPromise = fetch(QUEST_DATA_URL, { headers: { accept: 'application/json' } })
      .then((response) => {
        if (!response.ok) throw new Error(`Quest dataset returned ${response.status}`);
        return response.json();
      })
      .then((body) => {
        if (!Array.isArray(body?.quests) || !body.quests.length) throw new Error('Quest dataset is empty.');
        return body;
      })
      .catch((error) => {
        datasetPromise = null;
        throw error;
      });
  }
  return datasetPromise;
}

export function questCompletionStatus(profile, quest) {
  const statuses = profile?.questStatuses;
  const candidates = [quest.name, quest.wikiPage, ...(quest.aliases || [])].map(normaliseQuestName).filter(Boolean);
  if (statuses && typeof statuses === 'object' && !Array.isArray(statuses)) {
    for (const candidate of candidates) {
      const entry = statuses[candidate];
      const status = typeof entry === 'string' ? entry : entry?.status;
      if (status) return String(status).toUpperCase();
    }
  }
  if (Array.isArray(profile?.quests)) {
    const completed = new Set(profile.quests.map(normaliseQuestName));
    if (candidates.some((candidate) => completed.has(candidate))) return 'COMPLETED';
  }
  return null;
}

function addAggregated(target, item, quest, priceRows) {
  const isConditional = item.requirementType === 'conditional' || item.requirementType === 'alternative';
  const key = isConditional ? `${quest.id}:${item.key}` : item.key;
  const existing = target.get(key);
  const quantity = Number.isFinite(Number(item.quantity)) && Number(item.quantity) > 0 ? Number(item.quantity) : null;
  if (existing) {
    if (quantity !== null && existing.quantity !== null) existing.quantity += quantity;
    else existing.quantity = null;
    if (!existing.quests.includes(quest.name)) existing.quests.push(quest.name);
    existing.totalPrice = existing.priceEach && existing.quantity !== null
      ? existing.priceEach * existing.quantity
      : null;
    return;
  }
  const price = item.itemId !== null && item.itemId !== undefined ? priceRows?.[String(item.itemId)] : null;
  const priceEach = Number(price?.high || price?.low || 0) || null;
  target.set(key, {
    key,
    name: item.name,
    itemId: item.itemId ?? null,
    quantity,
    requirementType: item.requirementType || 'required',
    reusable: item.reusable === true,
    note: item.note || '',
    quests: [quest.name],
    priceEach,
    totalPrice: priceEach && quantity !== null ? priceEach * quantity : null,
  });
}

export function aggregateQuestItems(quests, selectedIds, priceRows = {}) {
  const selected = new Set(selectedIds || []);
  const geMap = new Map();
  const selfMap = new Map();
  const selectedQuests = quests.filter((quest) => selected.has(quest.id));
  for (const quest of selectedQuests) {
    for (const item of quest.items || []) {
      if (item.prepMode === 'exclude') continue;
      addAggregated(item.prepMode === 'ge' ? geMap : selfMap, item, quest, priceRows);
    }
  }
  const geItems = [...geMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  const selfItems = [...selfMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  const estimatedCost = geItems.reduce((sum, item) => sum + (item.totalPrice || 0), 0);
  const missingPrices = geItems.filter((item) => item.priceEach === null).length;
  return {
    selectedQuests,
    geItems,
    selfItems,
    estimatedCost,
    missingPrices,
  };
}
