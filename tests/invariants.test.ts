import { describe, expect, it } from 'vitest';
import { COMPONENT_IDS, STATION_IDS, TRIM_IDS } from '../src/config/balance';
import { applyCommand } from '../src/sim/commands';
import type { Command } from '../src/sim/commandTypes';
import { step } from '../src/sim/engine';
import { createInitialState } from '../src/sim/initialState';
import { deserialize, serialize } from '../src/sim/save';
import { orderProgress } from '../src/sim/selectors';
import type { GameState } from '../src/sim/types';
import { SAVE_VERSION } from '../src/sim/types';
import { SEED, buyShortfall, checkInvariants, mulberry32, mustOk, staffLine, ticks } from './helpers';

/** A scripted "chaos" player issuing plausible (and sometimes invalid) commands. */
function randomCommand(s: GameState, rnd: () => number): Command {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const offered = s.orders.filter((o) => o.status === 'offered');
  const accepted = s.orders.filter((o) => o.status === 'accepted');
  const anyOrder = s.orders.length ? pick(s.orders) : null;
  const r = rnd();
  if (r < 0.12 && offered.length) return { type: 'acceptOrder', orderId: pick(offered).id };
  if (r < 0.2 && accepted.length) return { type: 'scheduleForOrder', orderId: pick(accepted).id };
  if (r < 0.28 && accepted.length) return { type: 'deliverOrder', orderId: pick(accepted).id };
  if (r < 0.45)
    return {
      type: 'purchase',
      supplierId: pick(['brightline', 'corvan', 'apex']),
      component: pick(COMPONENT_IDS),
      quantity: 1 + Math.floor(rnd() * 8),
    };
  if (r < 0.53) return { type: 'scheduleBuild', trim: pick(TRIM_IDS), quantity: 1 + Math.floor(rnd() * 3) };
  if (r < 0.6) return { type: 'assignOperator', station: pick(STATION_IDS), delta: rnd() < 0.7 ? 1 : -1 };
  if (r < 0.65) return { type: 'hire', role: pick(['operator', 'inspector', 'technician'] as const), count: 1 };
  if (r < 0.67) return { type: 'fire', role: pick(['operator', 'inspector', 'technician'] as const) };
  if (r < 0.72) return { type: 'repair', station: pick(STATION_IDS) };
  if (r < 0.76) return { type: 'scheduleMaintenance', station: pick(STATION_IDS) };
  if (r < 0.8) return { type: 'setMarketListed', trim: pick(TRIM_IDS), listed: rnd() < 0.7 };
  if (r < 0.83 && anyOrder) return { type: 'moveOrderPriority', orderId: anyOrder.id, dir: rnd() < 0.5 ? -1 : 1 };
  if (r < 0.86 && s.plan.length) return { type: 'cancelJob', jobId: pick(s.plan).id };
  if (r < 0.88 && s.plan.length) return { type: 'moveJob', jobId: pick(s.plan).id, dir: rnd() < 0.5 ? -1 : 1 };
  if (r < 0.9 && anyOrder) return { type: 'declineOrder', orderId: anyOrder.id };
  if (r < 0.92) return { type: 'setFinish', trim: pick(TRIM_IDS), finish: rnd() < 0.5 ? 'solid' : 'metallic' };
  if (r < 0.94) return { type: 'setPrice', trim: pick(TRIM_IDS), price: 15000 + Math.floor(rnd() * 25000) };
  if (r < 0.95) return { type: 'upgradeCapacity', station: pick(STATION_IDS) };
  if (r < 0.96) return { type: 'upgradeReliability', station: pick(STATION_IDS) };
  if (r < 0.97) return { type: 'upgradeWarehouse' };
  return { type: 'purchase', supplierId: 'corvan', component: pick(COMPONENT_IDS), quantity: 999 };
}

describe('(f) inventory never negative, every vehicle in exactly one place', () => {
  for (const seed of [1, 2, 3]) {
    it(`randomized 5-day run (seed ${seed})`, () => {
      const s = createInitialState(SEED + seed);
      staffLine(s);
      const rnd = mulberry32(seed * 7919);
      let commands = 0;
      let accepted = 0;
      for (let t = 0; t < 5 * 1440; t++) {
        if (t % 20 === 0) {
          const cmd = randomCommand(s, rnd);
          const cashBefore = s.cash;
          const res = applyCommand(s, cmd);
          commands++;
          if (res.ok && cmd.type === 'acceptOrder') accepted++;
          if (!res.ok) expect(s.cash, `failed ${cmd.type} must not move cash`).toBe(cashBefore);
          const errs = checkInvariants(s);
          if (errs.length) throw new Error(`after ${JSON.stringify(cmd)} at ${s.time}:\n${errs.join('\n')}`);
        }
        step(s);
        const errs = checkInvariants(s);
        if (errs.length) throw new Error(`tick ${s.time}:\n${errs.join('\n')}`);
        if (s.gameOver) break;
      }
      expect(commands).toBeGreaterThan(100);
      expect(s.stats.vehiclesStarted).toBeGreaterThan(0);
      expect(accepted).toBeGreaterThanOrEqual(0);
    });
  }
});

describe('(g) save/load preserves production state', () => {
  it('serialize mid-production, deserialize, run both → identical', () => {
    const s = createInitialState(SEED);
    const id = s.orders[0].id;
    mustOk(s, { type: 'acceptOrder', orderId: id });
    buyShortfall(s, 'economy', 3);
    staffLine(s);
    mustOk(s, { type: 'scheduleForOrder', orderId: id });
    ticks(s, 420);
    // Mid-production: something is being worked on and something is in transit or queued.
    const busy = STATION_IDS.some((st) => s.stations[st].slots.some((sl) => sl !== null));
    expect(busy).toBe(true);
    expect(orderProgress(s, s.orders[0]).inProduction).toBeGreaterThan(0);

    const json = serialize(s);
    const copy = deserialize(json);
    expect(copy).not.toBe(s);
    expect(serialize(copy)).toBe(json);
    expect(JSON.stringify(copy)).toBe(JSON.stringify(s));

    ticks(s, 1500);
    ticks(copy, 1500);
    expect(JSON.stringify(copy)).toBe(JSON.stringify(s));
    expect(s.time).toBeGreaterThan(420);
    // A copy is independent of its source.
    copy.cash += 1;
    expect(copy.cash).not.toBe(s.cash);
  });

  it('rejects corrupted or incompatible saves with a readable error', () => {
    expect(() => deserialize('not json {')).toThrow(Error);
    expect(() => deserialize('{}')).toThrow(Error);
    const s = createInitialState(SEED);
    const bad = JSON.parse(serialize(s));
    bad.version = SAVE_VERSION + 99;
    expect(() => deserialize(JSON.stringify(bad))).toThrow(/version|incompatible/i);
  });
});
