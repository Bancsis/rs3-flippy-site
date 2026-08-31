import { scoreBandFlips, riskForCandidate } from './flipping-engine.js';
import { getAnalyses, getHistoryStatus, getLiveData, mostRecentCompleteHour, restartHistoryRefresh } from './price-service.js';
import { getMethodRows, SKILLS } from './methods-service.js';
import { lookupPlayer } from './player-service.js';
import { getBossDrops } from './wiki-service.js';

export { SKILLS };

export async function loadFlips({ bankroll, minVolume = 0, force = false }) {
  if (!Number.isFinite(bankroll) || bankroll < 1) throw new Error('Enter cash greater than 0.');
  const live = await getLiveData(force);
  if (force) await restartHistoryRefresh();
  const analyses = await getAnalyses(live.mapping);
  const nowSec = Math.floor(Date.now() / 1000);
  const eligibleAnalyses = minVolume > 0
    ? new Map([...analyses].filter(([id]) => Number(live.volumes[String(id)] || 0) >= minVolume))
    : analyses;
  const candidates = scoreBandFlips(eligibleAnalyses, live.latest, { nowSec, bankroll });
  const rows = candidates.map((candidate) => {
    const { risk, reasons } = riskForCandidate(candidate);
    return {
      id: candidate.id,
      name: candidate.name,
      members: candidate.members,
      buy: candidate.buyAt,
      sell: candidate.sellAt,
      profitEach: candidate.marginPerItem,
      profitPer4h: candidate.gpPer4h,
      geLimit: candidate.buyLimit,
      youCanAfford: Math.floor(bankroll / candidate.buyAt),
      volume: Number(live.volumes[String(candidate.id)] || 0),
      risk,
      riskReasons: reasons,
      details: {
        modelSource: candidate.source,
        effectiveQtyPer4h: candidate.qtyPer4h,
        robustFillPerHour: candidate.fillP25PairPerHour,
        consistencyHits: candidate.hitWindows,
        consistencyWindows: candidate.consistencyWindows,
        windowsResolved: candidate.windowsResolved,
        stabilityRatio: candidate.stabilityRatio,
        trend: candidate.trend,
        binding: candidate.binding,
        limitBound: candidate.limitBound,
      },
    };
  });
  return { bankroll, minVolume, updatedAt: Date.now(), rows, model: getHistoryStatus() };
}

export async function loadMethods({ profile = null, geOnly = false, force = false }) {
  const live = await getLiveData(force);
  if (force) await restartHistoryRefresh();
  const lastCompleteHour = await mostRecentCompleteHour();
  const [result, analyses] = await Promise.all([
    getMethodRows({
      latest: live.latest,
      volumes: live.volumes,
      oneHour: live.oneHour,
      lastCompleteHour,
      bankroll: 0,
      profile,
      geOnly,
    }),
    getAnalyses(live.mapping),
  ]);
  const rows = result.rows.map((row) => {
    const analysis = row.primaryGeId !== null ? analyses.get(row.primaryGeId) : null;
    return {
      ...row,
      patientSell: analysis?.placement?.sellAt ?? null,
      patientSellSource: analysis ? `${analysis.source} history / 24h placement` : null,
    };
  });
  return { ...result, rows, skills: SKILLS, updatedAt: Date.now() };
}

export async function lookupPlayerBrowser(name) {
  return lookupPlayer(name);
}

export async function loadBossDrops({ page, method = '' }) {
  if (!page) throw new Error('Missing boss page.');
  return getBossDrops(page, method);
}
