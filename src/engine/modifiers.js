/**
 * Buffs are applied through a side table keyed by the loadout rather than by
 * rebuilding the action set. Two reasons:
 *
 *  - The frontier IS the buy-vs-self-source decision, so a buff that is only
 *    applied at scoring time would price the self-source branch unbuffed and
 *    make Dinkelbach pick the wrong point. Both stages must see the same
 *    effective action.
 *  - Materializing a modified graph would invalidate the cached dependency
 *    ordering (keyed on graph identity) and cost a full cold recompute on
 *    every checkbox click.
 *
 * So: the graph stays identical, and the arrays here carry the deltas.
 */
/** One game tick — nothing can be faster. */
const MIN_ACTION_SECONDS = 0.6;
/**
 * Is this input the recipe's SECONDARY ingredient?
 *
 * `secondary` is a per-recipe role, not a property of an item: clean irit is
 * the secondary in one recipe and the base herb in another, so it cannot live
 * on `ItemDef` and has to be read off the action's shape.
 *
 * The shape is precise, and getting it loose matters. The scroll of cleansing
 * saves "the secondary ingredient" (wiki, 10%), which is what you add to an
 * ALREADY-UNFINISHED potion. A vial-of-water recipe -- "Vial of water + Clean
 * aloe -> Aloe potion (unfinished)" -- has no secondary at all; the herb is the
 * primary. Requiring an unfinished-potion input takes the candidate set from
 * 256 recipes to 129, every one of which has exactly one secondary.
 */
function isSecondaryInput(graph, action, itemId, nameOf) {
    const self = nameOf(itemId);
    if (UNFINISHED.test(self) || VESSEL.test(self))
        return false;
    return action.inputs.some((i) => i.item !== itemId && UNFINISHED.test(nameOf(i.item)));
}
const UNFINISHED = /\(unf\)|unfinished/i;
const VESSEL = /\bvial\b|\bflask\b/i;
/**
 * The input-quantity multiplier for ONE input of one action.
 *
 * Both the frontier and the scorer must use this: MODEL.md section 6 requires
 * them to see the same buffs, or the buy-vs-gather choice is priced against a
 * different action than the one being scored.
 */
export function inputMulFor(eff, actionIdx, itemId) {
    if (!eff)
        return 1;
    const tagged = eff.inputQtyMulByItem[actionIdx]?.get(itemId);
    return eff.inputQtyMul[actionIdx] * (tagged ?? 1);
}
/** A stable key so callers can tell whether the table needs rebuilding. */
export function loadoutKeyOf(ownedIds) {
    return [...ownedIds].sort().join(',');
}
/** Empty (base) effects — every array neutral. */
export function baseEffectiveActions(actionCount) {
    const ones = () => new Float64Array(actionCount).fill(1);
    const zeros = () => new Float64Array(actionCount);
    return {
        loadoutKey: '',
        secondsMul: ones(),
        secondsDelta: zeros(),
        successRate: ones(),
        inputQtyMul: ones(),
        inputQtyMulByItem: new Array(actionCount).fill(undefined),
        outputQtyMul: ones(),
        autobank: zeros(),
        overheadMul: ones(),
        upkeepPerHour: zeros(),
        upkeepPerRun: zeros(),
        upkeepPerItemBanked: zeros(),
        activeIds: Array.from({ length: actionCount }, () => []),
    };
}
function matchesScope(action, mod) {
    const { scope } = mod;
    if (scope.kinds && !scope.kinds.includes(action.kind))
        return false;
    if (scope.skills) {
        const actionSkills = action.reqs
            .filter((r) => r.type === 'skill')
            .map((r) => (r.type === 'skill' ? r.skill : ''));
        if (!actionSkills.some((s) => scope.skills.includes(s)))
            return false;
    }
    if (scope.sourceRefPattern && !new RegExp(scope.sourceRefPattern, 'i').test(action.sourceRef)) {
        return false;
    }
    if (scope.excludeSourceRefPattern &&
        new RegExp(scope.excludeSourceRefPattern, 'i').test(action.sourceRef)) {
        return false;
    }
    return true;
}
export function indexModifiers(graph, modifiers) {
    const matches = modifiers.map((mod) => {
        const hits = [];
        // A pure amplifier (no effects of its own) matches nothing directly.
        if (mod.effects.length > 0) {
            for (const action of graph.actions)
                if (matchesScope(action, mod))
                    hits.push(action.idx);
        }
        return Int32Array.from(hits);
    });
    return { modifiers, matches };
}
/** Combine probabilities so that the result is never above the additive sum. */
function combine(mode, values) {
    if (values.length === 0)
        return 0;
    if (mode === 'additive')
        return values.reduce((a, b) => a + b, 0);
    // product(1 + v) - 1. The seed is 1 because it is a running PRODUCT; seeding
    // it as if it were another (1+v) term inflates a single +5% into +110%.
    if (mode === 'multiplicative')
        return values.reduce((acc, v) => acc * (1 + v), 1) - 1;
    // independent: 1 - product(1 - p). Always <= the additive sum, so it is the
    // conservative default for both saves and extra-output rolls.
    return 1 - values.reduce((acc, p) => acc * (1 - p), 1);
}
/**
 * Resolve one effect's parameter: amplify first, clamp, then scale by uptime.
 * Scaling the PARAMETER rather than blending two outcomes is conservative
 * because gp/hr is convex in the parameter (time sits in the denominator).
 */
function resolveValue(effect, mod, amplify) {
    const amplified = effect.value * amplify;
    const isProbability = effect.kind === 'output_extra_chance' ||
        effect.kind === 'input_save_chance' ||
        effect.kind === 'output_destroy' ||
        effect.kind === 'autobank_chance' ||
        effect.kind === 'overhead_removal' ||
        effect.kind === 'action_success_chance';
    const clamped = isProbability ? Math.min(1, amplified) : amplified;
    return clamped * mod.uptime;
}
/**
 * Build the effective-action table for a loadout. Only actions matched by an
 * enabled modifier are touched, so a toggle costs a few thousand writes.
 */
export function computeEffectiveActions(graph, index, ownedIds, prices) {
    const eff = baseEffectiveActions(graph.actions.length);
    eff.loadoutKey = loadoutKeyOf(ownedIds);
    const owned = new Set(ownedIds);
    // Amplifiers (Brooch of the Gods) multiply other modifiers' proc rates.
    const amplifyFor = new Map();
    for (const mod of index.modifiers) {
        if (!owned.has(mod.id) || !mod.amplifies)
            continue;
        for (const target of mod.amplifies) {
            amplifyFor.set(target, (amplifyFor.get(target) ?? 1) * (mod.amplifyFactor ?? 1));
        }
    }
    // Gather per-action, per-kind contributions before combining, because
    // stacking semantics are per-kind rather than per-modifier.
    const byAction = new Map();
    const autobankedExtra = new Map();
    const taggedSaves = new Map();
    for (let m = 0; m < index.modifiers.length; m++) {
        const mod = index.modifiers[m];
        if (!owned.has(mod.id))
            continue;
        const amplify = amplifyFor.get(mod.id) ?? 1;
        for (const actionIdx of index.matches[m]) {
            eff.activeIds[actionIdx].push(mod.id);
            let perKind = byAction.get(actionIdx);
            if (!perKind) {
                perKind = new Map();
                byAction.set(actionIdx, perKind);
            }
            for (const effect of mod.effects) {
                const value = resolveValue(effect, mod, amplify);
                // A tagged input save applies to SOME inputs, so it cannot go in the
                // per-action bucket -- that is what made itemTags inert.
                if (effect.kind === 'input_save_chance' && effect.itemTags !== undefined) {
                    const arr = taggedSaves.get(actionIdx) ?? [];
                    arr.push({ tags: effect.itemTags, value, mode: mod.stackMode });
                    taggedSaves.set(actionIdx, arr);
                    continue;
                }
                const slot = perKind.get(effect.kind) ?? { mode: mod.stackMode, values: [] };
                slot.values.push(value);
                perKind.set(effect.kind, slot);
                if (effect.kind === 'output_extra_chance' && effect.autobanked) {
                    const arr = autobankedExtra.get(actionIdx) ?? [];
                    arr.push(value);
                    autobankedExtra.set(actionIdx, arr);
                }
            }
            // Costs
            if (mod.cost) {
                const unit = mod.cost.item !== undefined && prices
                    ? prices.buyOf(mod.cost.item) * (mod.cost.itemQty ?? 1)
                    : 0;
                eff.upkeepPerHour[actionIdx] += (mod.cost.perHour ?? 0) + unit;
                eff.upkeepPerRun[actionIdx] += mod.cost.perRun ?? 0;
                eff.upkeepPerItemBanked[actionIdx] += mod.cost.perItemBanked ?? 0;
            }
        }
    }
    /**
     * Turn tagged saves into a per-item multiplier, using the action's actual
     * inputs. An input whose item carries none of the effect's tags is left
     * alone; an effect whose tags match NOTHING therefore does nothing, which is
     * the conservative reading and the right one for `secondary` -- a per-recipe
     * role we do not yet derive, and which must not silently apply to every
     * input in the meantime.
     */
    for (const [actionIdx, saves] of taggedSaves) {
        const action = graph.actions[actionIdx];
        const perItem = new Map();
        const nameOf = (id) => graph.items[graph.indexById.get(id)].name;
        for (const input of action.inputs) {
            const item = graph.items[graph.indexById.get(input.item)];
            const itemTags = item.tags ?? [];
            const applicable = saves.filter((s) => s.tags.some((t) => 
            // `secondary` is a per-recipe role, so it is answered by the action's
            // shape rather than by the item's tag list.
            t === 'secondary'
                ? isSecondaryInput(graph, action, input.item, nameOf)
                : itemTags.includes(t)));
            if (applicable.length === 0)
                continue;
            perItem.set(input.item, 1 -
                combine(applicable[0].mode, applicable.map((s) => s.value)));
        }
        if (perItem.size > 0)
            eff.inputQtyMulByItem[actionIdx] = perItem;
    }
    for (const [actionIdx, perKind] of byAction) {
        for (const [kind, { mode, values }] of perKind) {
            switch (kind) {
                case 'input_save_chance':
                    eff.inputQtyMul[actionIdx] *= 1 - combine(mode, values);
                    break;
                case 'output_extra_chance':
                    eff.outputQtyMul[actionIdx] *= 1 + combine(mode, values);
                    break;
                case 'output_multiplier':
                    eff.outputQtyMul[actionIdx] *= 1 + combine('multiplicative', values);
                    break;
                case 'output_destroy':
                    eff.outputQtyMul[actionIdx] *= 1 - combine(mode, values);
                    break;
                case 'time_multiplier':
                    for (const v of values)
                        eff.secondsMul[actionIdx] *= v;
                    break;
                case 'time_delta':
                    for (const v of values)
                        eff.secondsDelta[actionIdx] += v;
                    break;
                case 'action_success_chance':
                    eff.successRate[actionIdx] = Math.min(1, eff.successRate[actionIdx] + combine(mode, values));
                    break;
                case 'autobank_chance':
                    eff.autobank[actionIdx] = combine(mode, values);
                    break;
                case 'overhead_removal':
                    eff.overheadMul[actionIdx] *= 1 - combine(mode, values);
                    break;
                case 'input_cost_discount':
                    // Only meaningful on coin-cost shop actions; applying it to a single
                    // point of a recipe's input frontier would break its convexity.
                    break;
            }
        }
    }
    return eff;
}
/** Effective seconds for one execution, floored at a single game tick. */
export function effectiveSeconds(action, eff) {
    const raw = (action.seconds + eff.secondsDelta[action.idx]) * eff.secondsMul[action.idx];
    return Math.max(MIN_ACTION_SECONDS, raw) / eff.successRate[action.idx];
}
