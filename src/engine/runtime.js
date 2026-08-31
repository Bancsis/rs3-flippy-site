export function buildRuntime(items, actions) {
    const indexById = new Map();
    items.forEach((item, i) => {
        if (indexById.has(item.id))
            throw new Error(`duplicate item id ${item.id}`);
        indexById.set(item.id, i);
    });
    const producers = items.map(() => []);
    actions.forEach((action, i) => {
        if (action.idx !== i) {
            throw new Error(`action idx ${action.idx} at position ${i}: idx must equal array position`);
        }
    });
    for (const action of actions) {
        for (const output of action.outputs) {
            const idx = indexById.get(output.item);
            if (idx === undefined)
                throw new Error(`action ${action.idx} outputs unknown item ${output.item}`);
            producers[idx].push(action.idx);
        }
        for (const input of action.inputs) {
            if (!indexById.has(input.item)) {
                throw new Error(`action ${action.idx} consumes unknown item ${input.item}`);
            }
        }
    }
    return { items, actions, indexById, producers };
}
