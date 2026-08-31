import * as modifiers_js_1 from "./modifiers.js";
import * as prices_js_1 from "./prices.js";
/**
 * Non-action time per BANK/GE TRIP — not per item. A player makes a full
 * inventory between trips, so this is amortized over DEFAULT_BATCH_RUNS
 * executions (see overheadPerRun). Charging it per execution overstated the
 * time of fast recipes by up to 2x and made them rank below slow ones.
 */
const DEFAULT_OVERHEAD_SECONDS = {
    none: 0,
    bank_close: 8,
    bank_far: 20,
    ge_trip: 60,
};
/** Executions per bank trip: one inventory for skilling, per-kill for PvM. */
const DEFAULT_BATCH_RUNS = {
    recipe: 28,
    gather: 28,
    shop: 28,
    high_alch: 28,
    kill: 1,
    ge_buy: 1,
    ge_sell: 1,
};
/** A standard RS3 inventory. */
const DEFAULT_CAPACITY_SLOTS = 28;
/** Inventory reserved for food/potions/teleports while fighting. */
const COMBAT_RESERVED_SLOTS = 6;
/**
 * A kill trip also ends for reasons slots know nothing about: supplies run
 * out, instances expire, aggression drops. Half an hour is a generous cap
 * that mainly stops fast, low-loot monsters from claiming implausibly long
 * uninterrupted trips.
 */
const TRIP_MAX_SECONDS = 1800;
/**
 * Runs that fit in one bank trip, by peak simultaneous inventory occupancy.
 *
 * Fill the inventory, then run the action B times. After k runs the inventory
 * holds inFixed + [k>=1]*outFixed + (B-k)*inPerRun + k*outPerRun slots. That is
 * linear in k, but the outFixed term switches on at k=1, so the peak sits at
 * k = 0, 1, or B - three linear bounds, all of which must fit.
 *
 * The k=1 branch is what makes cannonballs come out at 28 rather than 27: the
 * first bar's slot frees before the first cannonball stack lands.
 */
export function batchRunsFor(s, capacity = DEFAULT_CAPACITY_SLOTS) {
    const C = capacity - s.toolFixed;
    if (C <= s.inFixed)
        return 1;
    const a = s.inPerRun;
    const b = s.outPerRun;
    const bound0 = a > 0 ? (C - s.inFixed) / a : Infinity;
    const bound1 = a > 0 ? (C - s.inFixed - s.outFixed - b + a) / a : Infinity;
    const boundB = b > 0 ? (C - s.inFixed - s.outFixed) / b : Infinity;
    const B = Math.floor(Math.min(bound0, bound1, boundB));
    if (!Number.isFinite(B))
        return capacity; // no slot pressure at all
    return Math.max(1, B);
}
/** Amortized overhead seconds attributable to one execution of an action. */
export function overheadPerRun(kind, overheadClass, overheads = DEFAULT_OVERHEAD_SECONDS, batchRuns = DEFAULT_BATCH_RUNS, runsPerTrip) {
    return (overheads[overheadClass] ?? 0) / (runsPerTrip ?? batchRuns[kind] ?? 1);
}
/**
 * Per-action amortized overhead, computed ONCE per graph rather than inside
 * the relaxation loop (which would repeat it up to 12x over ~13k actions).
 */
export function overheadTable(graph, overheads = DEFAULT_OVERHEAD_SECONDS, capacity = DEFAULT_CAPACITY_SLOTS, eff) {
    const out = new Float64Array(graph.actions.length);
    for (let i = 0; i < graph.actions.length; i++) {
        const action = graph.actions[i];
        const isKill = action.kind === 'kill';
        const effectiveCapacity = isKill ? capacity - COMBAT_RESERVED_SLOTS : capacity;
        let runsPerTrip;
        if (action.slots) {
            // Buffs change slot demand: saved inputs are carried in smaller
            // quantities, and auto-banked output never occupies a slot at all.
            const slots = eff
                ? {
                    ...action.slots,
                    // Slots use the per-ACTION multiplier only. A tagged save shrinks
                    // some inputs but not others, and averaging it here would need the
                    // slot profile to know which input is which. Leaving it out means
                    // the batch is sized as if nothing were saved: fewer runs per
                    // trip, more overhead, i.e. the conservative direction.
                    inPerRun: action.slots.inPerRun * eff.inputQtyMul[i],
                    outPerRun: action.slots.outPerRun * (1 - eff.autobank[i]),
                    outFixed: action.slots.outFixed * (1 - eff.autobank[i]),
                }
                : action.slots;
            runsPerTrip = batchRunsFor(slots, effectiveCapacity);
        }
        const seconds = eff ? (0, modifiers_js_1.effectiveSeconds)(action, eff) : action.seconds;
        if (isKill && runsPerTrip !== undefined && seconds > 0) {
            runsPerTrip = Math.max(1, Math.min(runsPerTrip, Math.floor(TRIP_MAX_SECONDS / seconds)));
        }
        out[i] =
            overheadPerRun(action.kind, action.overheadClass, overheads, DEFAULT_BATCH_RUNS, runsPerTrip) * (eff ? eff.overheadMul[i] : 1);
    }
    return out;
}
const DEFAULT_MAX_POINTS = 8;
const EPSILON = 1e-6;
/** slope = gp paid per second saved between consecutive hull points. */
function slope(a, b) {
    return (b.gp - a.gp) / (a.sec - b.sec);
}
/**
 * Pareto-filter + convex prune + K-truncate. Input points need not be sorted.
 */
export function hull(points, maxPoints = DEFAULT_MAX_POINTS, presorted = false) {
    const finite = points.filter((p) => Number.isFinite(p.gp) && Number.isFinite(p.sec));
    if (finite.length === 0)
        return [];
    if (!presorted)
        finite.sort((a, b) => a.gp - b.gp || a.sec - b.sec);
    // Pareto: keep strictly-decreasing sec as gp rises.
    const pareto = [];
    for (const p of finite) {
        const last = pareto[pareto.length - 1];
        if (last && p.gp === last.gp)
            continue; // same gp, worse-or-equal sec
        if (!last || p.sec < last.sec - EPSILON)
            pareto.push(p);
    }
    // Convexity: slopes must strictly increase; middle points that don't bend
    // outward are dominated by a mix of their neighbours.
    const out = [];
    for (const p of pareto) {
        while (out.length >= 2) {
            const a = out[out.length - 2];
            const b = out[out.length - 1];
            if (slope(a, b) >= slope(b, p) - EPSILON)
                out.pop();
            else
                break;
        }
        out.push(p);
    }
    if (out.length <= maxPoints)
        return out;
    // Truncate: always keep both endpoints, sample the middle evenly.
    const kept = [out[0]];
    const step = (out.length - 1) / (maxPoints - 1);
    for (let k = 1; k < maxPoints - 1; k++)
        kept.push(out[Math.round(k * step)]);
    kept.push(out[out.length - 1]);
    return hullDedup(kept);
}
function hullDedup(points) {
    const out = [];
    for (const p of points)
        if (!out.some((q) => q === p))
            out.push(p);
    return out;
}
/**
 * Exact frontier of an action's per-primary-unit cost: Minkowski sum of the
 * scaled input frontiers (edges merged by slope — qty scaling preserves
 * slopes), shifted by action time and byproduct credit, divided by primary
 * quantity. Returns [] when any input is unobtainable.
 */
export function actionFrontier(inputFrontiers, actionSeconds, byproductCredit, primaryQty, maxPoints = DEFAULT_MAX_POINTS, meta = {}) {
    let baseGp = 0;
    let baseSec = actionSeconds;
    const edges = [];
    const positions = new Array(inputFrontiers.length).fill(0);
    for (let inputIndex = 0; inputIndex < inputFrontiers.length; inputIndex++) {
        const { frontier, qty } = inputFrontiers[inputIndex];
        if (frontier.length === 0)
            return [];
        baseGp += qty * frontier[0].gp;
        baseSec += qty * frontier[0].sec;
        for (let j = 0; j + 1 < frontier.length; j++) {
            const a = frontier[j];
            const b = frontier[j + 1];
            edges.push({
                dGp: qty * (b.gp - a.gp),
                dSec: qty * (b.sec - a.sec),
                slope: slope(a, b),
                inputIndex,
                nextIndex: j + 1,
            });
        }
    }
    edges.sort((e, f) => e.slope - f.slope);
    const points = [];
    const push = (gp, sec) => {
        const point = {
            gp: Math.max(0, (gp - byproductCredit) / primaryQty),
            sec: sec / primaryQty,
            isBuy: false,
        };
        // Keep compact provenance for the acquisition route that produced this
        // frontier point. This does not alter the maths; it only lets the UI
        // explain *why* a self-source price/time was selected later.
        if (meta.actionIdx !== undefined) {
            point.source = {
                kind: 'action',
                actionIdx: meta.actionIdx,
                actionSeconds,
                byproductCredit,
                primaryQty,
                inputs: inputFrontiers.map((input, i) => ({
                    item: input.item,
                    qty: input.qty,
                    point: input.frontier[positions[i]],
                })),
            };
        }
        points.push(point);
    };
    push(baseGp, baseSec);
    let gp = baseGp;
    let sec = baseSec;
    for (const e of edges) {
        gp += e.dGp;
        sec += e.dSec;
        positions[e.inputIndex] = e.nextIndex;
        push(gp, sec);
    }
    // The Minkowski walk emits ascending gp / descending sec already; the
    // credit clamp only flattens a prefix, which the Pareto sweep handles.
    return hull(points, maxPoints, true);
}
/** Frontier tables for every item, via bounded relaxation in dependency order. */
export function computeFrontiers(graph, prices, opts = {}) {
    const n = graph.items.length;
    const maxPoints = opts.maxPoints ?? DEFAULT_MAX_POINTS;
    const overheads = opts.overheadSeconds ?? DEFAULT_OVERHEAD_SECONDS;
    const maxRounds = opts.maxRounds ?? 12;
    const buyPoint = new Array(n).fill(null);
    const frontiers = new Array(n);
    for (let i = 0; i < n; i++) {
        const item = graph.items[i];
        if (item.id === 995) {
            buyPoint[i] = { gp: 1, sec: 0, isBuy: true, source: { kind: 'coins', item: item.id } };
        }
        else if (!opts.ironman && item.tradeable && Number.isFinite(prices.buy[i])) {
            buyPoint[i] = { gp: prices.buy[i], sec: 0, isBuy: true, source: { kind: 'ge', item: item.id } };
        }
        frontiers[i] = buyPoint[i] ? [buyPoint[i]] : [];
    }
    // GE-only intentionally disables every produced/gathered/vendor route. An
    // item is available only when it has a current tradeable GE buy quote
    // (coins remain the numeraire). Any method needing something else therefore
    // becomes unusable instead of silently falling back to self-source.
    if (opts.geOnly)
        return frontiers;
    const { ordered: producing, consumers } = orderProducingActions(graph);
    const overheadByAction = overheadTable(graph, overheads, opts.capacitySlots, opts.eff);
    const eff = opts.eff;
    // Dirty-propagation: round 1 visits everything; afterwards only actions
    // consuming an item whose frontier changed last round are revisited. This
    // is what makes a warm reprice cheap — most of the graph settles in one pass.
    let dirtyActions = null; // null = all
    for (let round = 0; round < maxRounds; round++) {
        let improved = false;
        const nextDirty = new Set();
        for (const action of producing) {
            if (dirtyActions !== null && !dirtyActions.has(action.idx))
                continue;
            if (opts.allowedActions && !opts.allowedActions.has(action.idx))
                continue;
            if (!opts.allowedActions && opts.profile?.skills) {
                let meetsSkills = true;
                for (const req of action.reqs ?? []) {
                    if (req.type !== 'skill')
                        continue;
                    const have = Number(opts.profile.skills[req.skill] ?? 1);
                    if (have < Number(req.level ?? 1)) {
                        meetsSkills = false;
                        break;
                    }
                }
                if (!meetsSkills)
                    continue;
            }
            const primary = action.outputs.find((o) => o.primary);
            const primaryIdx = graph.indexById.get(primary.item);
            if (graph.items[primaryIdx].id === 995)
                continue; // coins are the numeraire
            const inputMulOf = (item) => (0, modifiers_js_1.inputMulFor)(eff, action.idx, item);
            const outputMul = eff ? eff.outputQtyMul[action.idx] : 1;
            const inputFrontiers = [];
            let usable = true;
            for (const input of action.inputs) {
                const f = frontiers[graph.indexById.get(input.item)];
                if (f.length === 0) {
                    usable = false;
                    break;
                }
                inputFrontiers.push({ item: input.item, frontier: f, qty: input.qty * inputMulOf(input.item) });
            }
            if (!usable)
                continue;
            let credit = 0;
            for (const output of action.outputs) {
                if (output.primary)
                    continue;
                const outIdx = graph.indexById.get(output.item);
                const sellPrice = prices.sell[outIdx];
                if (!opts.ironman && graph.items[outIdx].tradeable && Number.isFinite(sellPrice)) {
                    credit += output.qtyEV * outputMul * (0, prices_js_1.netSell)(sellPrice, graph.items[outIdx].id);
                }
            }
            const actionSeconds = eff ? (0, modifiers_js_1.effectiveSeconds)(action, eff) : action.seconds;
            const seconds = actionSeconds + overheadByAction[action.idx];
            // Upkeep (portables, chompas) is a constant shift of the frontier's base
            // point, which preserves every edge slope and therefore convexity.
            const upkeep = eff
                ? eff.upkeepPerRun[action.idx] + (eff.upkeepPerHour[action.idx] * seconds) / 3600
                : 0;
            const produced = actionFrontier(inputFrontiers, seconds, credit - upkeep, primary.qtyEV * outputMul, maxPoints, { actionIdx: action.idx });
            if (produced.length === 0)
                continue;
            const current = frontiers[primaryIdx];
            const merged = hull([...current, ...produced, ...(buyPoint[primaryIdx] ? [buyPoint[primaryIdx]] : [])], maxPoints);
            if (!frontiersEqual(current, merged)) {
                frontiers[primaryIdx] = merged;
                improved = true;
                for (const consumerIdx of consumers[primaryIdx])
                    nextDirty.add(consumerIdx);
            }
        }
        if (!improved)
            break;
        dirtyActions = nextDirty;
    }
    return frontiers;
}
const orderCache = new WeakMap();
function computeOrder(graph) {
    // Dependency depth per item: buy-only items are depth 0; an action's
    // primary output sits one past its deepest input. Kahn-style iteration,
    // cycles settle at their entry depth. Computed once per graph — price
    // ticks reuse the schedule, which is what makes reprice cheap: processing
    // actions shallow-to-deep converges in one or two passes instead of many.
    const n = graph.items.length;
    const depth = new Int32Array(n);
    const producing = graph.actions.filter((a) => a.kind === 'recipe' || a.kind === 'gather' || a.kind === 'kill' || a.kind === 'shop');
    for (let round = 0; round < 20; round++) {
        let changed = false;
        for (const action of producing) {
            let d = 0;
            for (const input of action.inputs) {
                d = Math.max(d, depth[graph.indexById.get(input.item)] + 1);
            }
            const primary = action.outputs.find((o) => o.primary);
            const pi = graph.indexById.get(primary.item);
            if (d > depth[pi]) {
                // Cap depth growth so recipe cycles cannot spin the loop forever.
                depth[pi] = Math.min(d, 64);
                changed = true;
            }
        }
        if (!changed)
            break;
    }
    const ordered = [...producing].sort((a, b) => {
        const da = depth[graph.indexById.get(a.outputs.find((o) => o.primary).item)];
        const db = depth[graph.indexById.get(b.outputs.find((o) => o.primary).item)];
        return da - db;
    });
    // item index -> producing-action idxs that consume it (for dirty propagation)
    const consumers = graph.items.map(() => []);
    for (const action of producing) {
        for (const input of action.inputs) {
            consumers[graph.indexById.get(input.item)].push(action.idx);
        }
    }
    return { ordered, consumers };
}
function orderProducingActions(graph) {
    let ordered = orderCache.get(graph);
    if (!ordered) {
        ordered = computeOrder(graph);
        orderCache.set(graph, ordered);
    }
    return ordered;
}
function frontiersEqual(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        if (Math.abs(a[i].gp - b[i].gp) > EPSILON || Math.abs(a[i].sec - b[i].sec) > EPSILON) {
            return false;
        }
    }
    return true;
}
/**
 * The frontier point minimizing gp + λ·sec. Slopes increase along the hull,
 * so the optimum is the last point whose incoming slope is ≤ λ.
 */
export function pickPoint(frontier, lambdaPerSec) {
    let best = frontier[0];
    for (let i = 1; i < frontier.length; i++) {
        if (slope(frontier[i - 1], frontier[i]) <= lambdaPerSec)
            best = frontier[i];
        else
            break;
    }
    return best;
}

export { DEFAULT_OVERHEAD_SECONDS, DEFAULT_BATCH_RUNS, DEFAULT_CAPACITY_SLOTS, COMBAT_RESERVED_SLOTS, TRIP_MAX_SECONDS };
