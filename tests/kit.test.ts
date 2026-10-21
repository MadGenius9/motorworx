/** One-click parts kits: buy exactly what is missing, atomically. */
import { describe, expect, it } from 'vitest';
import { COMPONENT_IDS } from '../src/config/balance';
import { applyCommand } from '../src/sim/commands';
import { createInitialState } from '../src/sim/initialState';
import { kitCost, kitShortfall, ledgerReconciliation, tutorialSteps } from '../src/sim/selectors';
import { checkInvariants, mustOk } from './helpers';

describe('parts kit', () => {
  it('buys only the shortfall, net of stock and shipments', () => {
    const s = createInitialState();
    // Start: 6 steel and 3 paint on hand; 3 economy sedans need 6 steel, 3 paint, 3 each of the rest.
    const kit = kitShortfall(s, 'sedan', 'economy', 3);
    expect(kit).toEqual({ powertrain: 3, interior: 3, wheels: 3 });
    const cash = s.cash;
    mustOk(s, { type: 'purchaseKit', supplierId: 'corvan', model: 'sedan', trim: 'economy', cars: 3 });
    expect(cash - s.cash).toBe(kitCost('corvan', kit));
    expect(s.shipments.map((x) => [x.component, x.qty])).toEqual([
      ['powertrain', 3],
      ['interior', 3],
      ['wheels', 3],
    ]);
    // Everything is covered now (on hand + on the way).
    expect(kitShortfall(s, 'sedan', 'economy', 3)).toEqual({});
    expect(applyCommand(s, { type: 'purchaseKit', supplierId: 'corvan', model: 'sedan', trim: 'economy', cars: 3 }).ok).toBe(false);
    expect(ledgerReconciliation(s).ok).toBe(true);
    expect(checkInvariants(s)).toEqual([]);
  });

  it('is all-or-nothing when cash or warehouse space is short', () => {
    const s = createInitialState();
    s.cash = 5000;
    const r = applyCommand(s, { type: 'purchaseKit', supplierId: 'apex', model: 'sedan', trim: 'economy', cars: 3 });
    expect(r.ok).toBe(false);
    expect(s.shipments).toHaveLength(0);
    const t = createInitialState();
    const big = applyCommand(t, { type: 'purchaseKit', supplierId: 'corvan', model: 'sedan', trim: 'premium', cars: 99 });
    expect(big.ok).toBe(false);
    expect(big.message).toMatch(/warehouse/i);
    expect(t.shipments).toHaveLength(0);
    for (const c of COMPONENT_IDS) expect(t.inventory[c].qty).toBe(createInitialState().inventory[c].qty);
  });

  it('the tutorial offers a working one-click kit for the accepted order', () => {
    const s = createInitialState();
    mustOk(s, { type: 'acceptOrder', orderId: s.orders[0].id });
    const step = tutorialSteps(s).find((x) => x.id === 'buy-components')!;
    expect(step.action?.action.kind).toBe('command');
    if (step.action?.action.kind === 'command') mustOk(s, step.action.action.command);
    expect(tutorialSteps(s).find((x) => x.id === 'buy-components')!.done).toBe(true);
    expect(kitShortfall(s, 'sedan', 'economy', 3)).toEqual({});
  });
});
