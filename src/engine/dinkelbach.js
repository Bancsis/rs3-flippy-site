import * as frontier_js_1 from "./frontier.js";
import * as modifiers_js_1 from "./modifiers.js";
import * as prices_js_1 from "./prices.js";
/**
 * An output worth less than this share of a run's revenue cannot bind the
 * volume clamp: being unable to sell a 1%-of-revenue byproduct cannot
 * plausibly stop you doing the method, and letting it clamp lets one thin
 * side-drop zero an otherwise sound row.
 *
 * Exported because the recurring scorer applies the same rule over a cadence
 * window instead of an hour, and the two must not drift apart.
 */
const MATERIAL_REVENUE_SHARE = 0.05;
/**
 * Any |gp/hr| beyond this is a data defect, not a method. The best real RS3
 * method is single-digit millions per hour sustained and low hundreds of
 * millions optimal, so 10 billion is ~1000x above anything legitimate — wide
 * enough that no real method is ever caught, tight enough to catch the class
 * of failure that produced -554 billion gp/hr for Full Easter basket (a
 * tick-derived rate of 947 runs/hr applied to a deeply negative margin).
 *
 * The number is rejected rather than clamped: a clamped value still sorts and
 * still gets read as a measurement, and we do not have a measurement here.
 */
const SANITY_GP_PER_HOUR = 1e10;
const DINKELBACH_ITERATIONS = 8;
const LAMBDA_EPSILON = 1e-4;

function acquisitionSummary(action, itemName, inputNames) {
    const ref = action.sourceRef || 'another method';
    const variant = action.variantLabel ? ` (${action.variantLabel})` : '';
    if (action.kind === 'recipe') {
        const from = inputNames.length ? ` from ${inputNames.join(' + ')}` : '';
        if (String(ref).toLowerCase() === String(itemName).toLowerCase())
            return `Craft ${itemName}${from}${variant}`;
        return `Craft/process ${itemName}${from} via ${ref}${variant}`;
    }
    if (action.kind === 'gather')
        return `Gather via ${ref}${variant}`;
    if (action.kind === 'shop')
        return `Buy from an NPC/vendor via ${ref}${variant}`;
    if (action.kind === 'kill')
        return `Obtain as PvM/loot via ${ref}${variant}`;
    return `Acquire via ${ref}${variant}`;
}

/**
 * Turn the compact provenance attached to a frontier point into JSON-safe,
 * human-readable acquisition detail. Depth is deliberately capped so the
 * Methods response stays small even when a route has many processing layers.
 */
function explainAcquisition(point, itemId, graph, depth = 0) {
    const idx = graph.indexById.get(itemId);
    const item = idx === undefined ? null : graph.items[idx];
    const itemName = item?.name ?? String(itemId);
    if (!point || point.isBuy || point.source?.kind === 'ge') {
        return {
            type: 'ge',
            item: itemId,
            itemName,
            summary: 'Buy directly on the GE',
            gpPerUnit: Number(point?.gp ?? NaN),
            secPerUnit: Number(point?.sec ?? 0),
            upstream: [],
        };
    }
    if (point.source?.kind === 'coins') {
        return {
            type: 'coins',
            item: itemId,
            itemName,
            summary: 'Coins',
            gpPerUnit: 1,
            secPerUnit: 0,
            upstream: [],
        };
    }
    const source = point.source;
    if (!source || source.kind !== 'action' || !Number.isInteger(source.actionIdx)) {
        return {
            type: 'self',
            item: itemId,
            itemName,
            summary: 'Self-source through another acquisition route',
            gpPerUnit: Number(point.gp),
            secPerUnit: Number(point.sec),
            upstream: [],
        };
    }
    const action = graph.actions[source.actionIdx];
    if (!action) {
        return {
            type: 'self', item: itemId, itemName,
            summary: 'Self-source through another acquisition route',
            gpPerUnit: Number(point.gp), secPerUnit: Number(point.sec), upstream: [],
        };
    }
    const directInputs = (source.inputs ?? []).map((input) => {
        const childIdx = graph.indexById.get(input.item);
        const childName = childIdx === undefined ? String(input.item) : graph.items[childIdx].name;
        const child = depth < 2 ? explainAcquisition(input.point, input.item, graph, depth + 1) : null;
        return {
            item: input.item,
            itemName: childName,
            qtyPerCycle: Number(input.qty),
            source: child?.type === 'ge' ? 'Buy on GE' : child?.type === 'coins' ? 'Coins' : 'Self-source',
            summary: child?.summary ?? (input.point?.isBuy ? 'Buy directly on the GE' : 'Self-source'),
            gpPerUnit: Number(input.point?.gp ?? NaN),
            secPerUnit: Number(input.point?.sec ?? 0),
            ...(child && depth < 1 ? { acquisition: child } : {}),
        };
    });
    const inputNames = directInputs.map((x) => x.itemName);
    const primaryQty = Number(source.primaryQty || 1);
    return {
        type: action.kind === 'shop' ? 'vendor' : action.kind,
        item: itemId,
        itemName,
        summary: acquisitionSummary(action, itemName, inputNames),
        page: action.sourceRef || null,
        variant: action.variantLabel || null,
        gpPerUnit: Number(point.gp),
        secPerUnit: Number(point.sec),
        outputQtyPerCycle: primaryQty,
        effectiveSecondsPerCycle: Number(point.sec) * primaryQty,
        directActionSeconds: Number(source.actionSeconds || action.seconds || 0),
        interactionSec: Number(action.interactionSec || 0),
        requirements: (action.reqs ?? []).map((r) => r.type === 'skill' ? `${r.skill} ${r.level}` : r.type === 'quest' ? r.name : '').filter(Boolean),
        upstream: directInputs,
    };
}

/**
 * Score every producing action as a money-making method. Profit rate is the
 * fractional program max (R - Σ gp_i(λ)·qty_i) / (t + Σ sec_i(λ)·qty_i) over
 * per-input frontier choices; Dinkelbach iteration converges in a few rounds
 * because picking points for a fixed λ is exact on convex hulls. "Gather your
 * inputs vs buy them" (and blends) falls out of the choice structure.
 */
export function scorePathways(graph, prices, frontiers, opts = {}) {
    const overheads = opts.overheadSeconds ?? frontier_js_1.DEFAULT_OVERHEAD_SECONDS;
    const volumeShare = opts.volumeShare ?? 0.1;
    const overheadByAction = (0, frontier_js_1.overheadTable)(graph, overheads, opts.capacitySlots, opts.eff);
    const eff = opts.eff;
    const scores = [];
    for (const action of graph.actions) {
        if (action.kind === 'ge_buy' || action.kind === 'ge_sell' || action.kind === 'high_alch') {
            continue;
        }
        // Per input, not per action: a tagged save covers only the inputs it
        // names. Resolved via inputMulFor so the frontier and the scorer cannot
        // drift apart (MODEL.md section 6).
        const inputMulOf = (item) => (0, modifiers_js_1.inputMulFor)(eff, action.idx, item);
        const outputMul = eff ? eff.outputQtyMul[action.idx] : 1;
        // Revenue: all priced outputs at post-tax instant-sell. Primary must be priced.
        let revenue = 0;
        const soldOutputs = [];
        let primaryName = null;
        let primaryPriced = false;
        // Coins need no sell offer, so a coins-primary method uses one slot fewer.
        let primaryIsCoins = false;
        let primaryIdxForClamp = -1;
        for (const output of action.outputs) {
            const outIdx = graph.indexById.get(output.item);
            const item = graph.items[outIdx];
            const sellPrice = prices.sell[outIdx];
            // Ironman mode: no GE — outputs are worth their high-alch floor
            // (coins are coins). Normal mode: post-tax instant-sell.
            let priced;
            let unitValue = 0;
            if (opts.ironman) {
                if (item.id === 995) {
                    priced = true;
                    unitValue = 1;
                }
                else {
                    priced = (item.highalch ?? 0) > 0;
                    unitValue = item.highalch ?? 0;
                }
            }
            else {
                priced = item.tradeable && Number.isFinite(sellPrice);
                unitValue = priced ? (0, prices_js_1.netSell)(sellPrice, item.id) : 0;
            }
            if (priced) {
                const line = output.qtyEV * outputMul * unitValue;
                revenue += line;
                // Every SOLD output competes for market depth, not just the primary.
                // Pickpocketing fairy traders is 57% rare item drops behind a coins
                // primary: clamping only the primary left the part you actually have
                // to sell entirely unchecked.
                if (item.id !== 995)
                    soldOutputs.push({
                        idx: outIdx,
                        name: item.name,
                        perRun: output.qtyEV * outputMul,
                        revenue: line,
                    });
            }
            if (output.primary) {
                primaryName = item.name;
                primaryPriced = priced;
                primaryIsCoins = item.id === 995;
                primaryIdxForClamp = outIdx;
            }
        }
        if (!primaryPriced || primaryName === null)
            continue;
        // Aggregate duplicate input rows by item BEFORE scoring. The buy-limit and
        // volume clamps divide by the per-run quantity, so one item split across
        // two rows would clamp at qty 1 twice and permit double the sustainable
        // rate. Cost and time are linear, so summing first is equivalent for them.
        const qtyByItem = new Map();
        for (const input of action.inputs) {
            qtyByItem.set(input.item, (qtyByItem.get(input.item) ?? 0) + input.qty * inputMulOf(input.item));
        }
        const inputs = [];
        let usable = true;
        for (const [item, qty] of qtyByItem) {
            const f = frontiers[graph.indexById.get(item)];
            if (f.length === 0) {
                usable = false;
                break;
            }
            inputs.push({ item, qty, frontier: f });
        }
        if (!usable)
            continue;
        const tAct = (eff ? (0, modifiers_js_1.effectiveSeconds)(action, eff) : action.seconds) + overheadByAction[action.idx];
        // Dinkelbach: λ in gp/second.
        let lambda = 0;
        let chosen = inputs.map((i) => (0, frontier_js_1.pickPoint)(i.frontier, 0));
        for (let iter = 0; iter < DINKELBACH_ITERATIONS; iter++) {
            chosen = inputs.map((i) => (0, frontier_js_1.pickPoint)(i.frontier, lambda));
            let cost = 0;
            let secs = tAct;
            for (let k = 0; k < inputs.length; k++) {
                cost += inputs[k].qty * chosen[k].gp;
                secs += inputs[k].qty * chosen[k].sec;
            }
            const next = (revenue - cost) / secs;
            if (Math.abs(next - lambda) < LAMBDA_EPSILON) {
                lambda = next;
                break;
            }
            lambda = next;
        }
        let costPerRun = 0;
        let secondsPerRun = tAct;
        for (let k = 0; k < inputs.length; k++) {
            costPerRun += inputs[k].qty * chosen[k].gp;
            secondsPerRun += inputs[k].qty * chosen[k].sec;
        }
        if (eff) {
            costPerRun +=
                eff.upkeepPerRun[action.idx] + (eff.upkeepPerHour[action.idx] * secondsPerRun) / 3600;
        }
        const profitPerRun = revenue - costPerRun;
        const runsPerHour = 3600 / secondsPerRun;
        // ---- Sustained clamps ----
        let runsCap = runsPerHour;
        let bindingCap = null;
        const clamp = (cap, label) => {
            if (cap < runsCap) {
                runsCap = cap;
                bindingCap = label;
            }
        };
        for (let k = 0; k < inputs.length; k++) {
            const inIdx = graph.indexById.get(inputs[k].item);
            const item = graph.items[inIdx];
            if (chosen[k].isBuy && item.id !== 995) {
                if (item.buyLimit !== undefined) {
                    clamp(item.buyLimit / 4 / inputs[k].qty, `${item.name} buy limit`);
                }
                const vol = (opts.buyVolume ?? opts.hourlyVolume)?.[inIdx];
                if (vol !== undefined && Number.isFinite(vol)) {
                    clamp((volumeShare * vol) / inputs[k].qty, `${item.name} volume`);
                }
            }
        }
        // Coins are the numeraire, not a traded good: you never queue a sell offer
        // for gold on the GE, so it has no volume and clamping against it would
        // zero every kill method (coins are their primary output).
        // Clamp against every output that carries a MATERIAL share of revenue.
        //
        // Only the primary used to be clamped, which is wrong in both directions.
        // A coins-primary catch method (coins are exempt -- you never queue a sell
        // offer for gold) was left completely unclamped even though most of its
        // value is item drops. And clamping literally every output would let a
        // 0.1%-of-revenue side drop with no observed trades zero an otherwise
        // sound method, which is the objection that killed the naive version.
        //
        // The threshold is the compromise: an output worth less than 5% of the
        // run's revenue cannot bind, because being unable to sell it cannot
        // plausibly stop you doing the method.
        const materialShare = MATERIAL_REVENUE_SHARE;
        const sellVol = opts.sellVolume ?? opts.hourlyVolume;
        /**
         * A LOOT drop you cannot sell is discarded, not a reason to stop.
         *
         * For a recipe the output is the point: if you cannot sell planks there is
         * no plank method, so a thin market genuinely caps the rate. A kill or a
         * catch is different — Rune dragon drops rune salvage, and being unable to
         * offload salvage does not stop you killing dragons, you just leave it.
         * Clamping the rate on it said otherwise and drove the method to 6 kills
         * an hour and -7M gp/hr.
         *
         * So loot methods cap that output's REVENUE at what the market absorbs and
         * keep their rate; recipes clamp the rate as before.
         */
        const lootMethod = action.kind === 'kill' || action.kind === 'gather';
        for (const out of soldOutputs) {
            if (revenue > 0 && out.revenue / revenue < materialShare)
                continue;
            const vol = sellVol?.[out.idx];
            if (vol === undefined || !Number.isFinite(vol) || out.perRun <= 0)
                continue;
            if (!lootMethod || out.idx === primaryIdxForClamp) {
                clamp((volumeShare * vol) / out.perRun, `${out.name} sell volume`);
            }
        }
        let sustainedRuns = Math.min(runsPerHour, runsCap);
        const capitalPerHour = costPerRun * sustainedRuns;
        if (opts.bankroll !== undefined && capitalPerHour > opts.bankroll && capitalPerHour > 0) {
            sustainedRuns *= opts.bankroll / capitalPerHour;
            bindingCap = 'bankroll';
        }
        const gpPerHour = profitPerRun * runsPerHour;
        /**
         * A consumable on a timer costs the same per hour however slowly you go.
         *
         * Hourly supplies sit in `inputs` at their per-run share, which is exactly
         * right at full rate — so `gpPerHour` needs no correction. But scaling
         * them down with a clamp bills you for overloads you still drank: Rune
         * dragon clamps to 3% of its kill rate and was charged 3% of a 7.4M gp/hr
         * supply bill, understating its cost by 7.19M gp/hr.
         *
         * The correction adds back exactly what the scaling removed, so it is zero
         * when nothing binds. It touches only this line: the hourly cost is
         * constant with respect to the frontier choice, so it drops out of the
         * Dinkelbach scalarisation entirely and neither the hull nor the inner
         * loop changes (docs/MODEL.md §3).
         */
        let hourlyShortfall = 0;
        if (action.hourlyInputs !== undefined && sustainedRuns < runsPerHour) {
            const unitGp = new Map();
            inputs.forEach((inp, k) => unitGp.set(inp.item, chosen[k].gp));
            let hourlyCost = 0;
            for (const h of action.hourlyInputs) {
                const gp = unitGp.get(h.item);
                if (gp !== undefined)
                    hourlyCost += gp * h.qtyPerHour;
            }
            hourlyShortfall = hourlyCost * (1 - sustainedRuns / runsPerHour);
        }
        /**
         * Revenue actually realisable at the sustained rate. A loot drop produced
         * faster than the market absorbs it is simply left on the floor.
         */
        let unsellablePerHour = 0;
        if (lootMethod && sustainedRuns > 0) {
            for (const out of soldOutputs) {
                if (out.idx === primaryIdxForClamp)
                    continue;
                const vol = sellVol?.[out.idx];
                if (vol === undefined || !Number.isFinite(vol))
                    continue;
                const produced = out.perRun * sustainedRuns;
                const sellable = volumeShare * vol;
                if (produced > sellable) {
                    // out.revenue / out.perRun is the unit value already net of tax.
                    unsellablePerHour += (produced - sellable) * (out.revenue / out.perRun);
                }
            }
        }
        const sustained = profitPerRun * sustainedRuns - hourlyShortfall - unsellablePerHour;
        if (!Number.isFinite(gpPerHour) ||
            !Number.isFinite(sustained) ||
            Math.abs(gpPerHour) > SANITY_GP_PER_HOUR) {
            opts.onImplausible?.(action.idx, gpPerHour);
            continue;
        }
        const selfSourceSecondsPerRun = inputs.reduce((total, inp, k) => total + (chosen[k].isBuy ? 0 : inp.qty * chosen[k].sec), 0);
        scores.push({
            actionIdx: action.idx,
            kind: action.kind,
            page: action.sourceRef,
            ...(action.variantLabel === undefined ? {} : { variantLabel: action.variantLabel }),
            outputName: primaryName,
            memberOnly: action.members,
            revenuePerRun: revenue,
            costPerRun,
            profitPerRun,
            secondsPerRun,
            selfSourceSecondsPerRun,
            gpPerHour,
            sustainedGpPerHour: sustained,
            bindingCap: sustainedRuns < runsPerHour - 1e-9 ? bindingCap : null,
            capitalPerHour,
            geSlots: inputs.filter((inp, k) => chosen[k].isBuy && inp.item !== 995).length +
                (primaryIsCoins ? 0 : 1),
            inputChoices: inputs.map((inp, k) => ({
                item: inp.item,
                itemName: graph.items[graph.indexById.get(inp.item)].name,
                qty: inp.qty,
                mode: chosen[k].isBuy ? 'buy' : 'self',
                gpPerUnit: chosen[k].gp,
                secPerUnit: chosen[k].sec,
                acquisition: chosen[k].isBuy ? null : explainAcquisition(chosen[k], inp.item, graph),
            })),
            skillReqs: action.reqs
                .filter((r) => r.type === 'skill')
                .map((r) => r.type === 'skill' ? `${r.skill} ${r.level}${r.boostable ? ' (boostable)' : ''}` : ''),
            questReqs: action.reqs
                .filter((r) => r.type === 'quest')
                .map((r) => (r.type === 'quest' ? r.name : '')),
            advisories: (action.advisories ?? []).map((a) => `${a.name}${a.level === undefined ? '' : ` ${a.level}`}` +
                (a.strength === 'optional' ? ' (optional)' : '')),
            confidence: action.confidence,
            effort: action.effort,
            interactionSec: action.interactionSec,
            activeModifiers: eff ? eff.activeIds[action.idx] : [],
        });
    }
    return scores.sort((a, b) => b.sustainedGpPerHour - a.sustainedGpPerHour);
}

export { MATERIAL_REVENUE_SHARE, SANITY_GP_PER_HOUR };
