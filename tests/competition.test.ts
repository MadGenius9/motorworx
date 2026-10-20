/** Milestone 3: rival manufacturers sharing the open market and competing for dealer offers. */
import { describe, expect, it } from 'vitest';
import { BALANCE, MODEL_IDS, TRIM_IDS } from '../src/config/balance';
import { applyCommand } from '../src/sim/commands';
import { runTicks, step } from '../src/sim/engine';
import { createInitialState } from '../src/sim/initialState';
import { deserialize, serialize } from '../src/sim/save';
import { getAlerts, recentMarketShare, segmentShares, trimSpec } from '../src/sim/selectors';
import type { GameState } from '../src/sim/types';
import { SAVE_VERSION } from '../src/sim/types';
import { checkInvariants, mustOk, toV4Shape } from './helpers';

const fair = 1 / BALANCE.competition.marketSizeCompanies;

describe('shared open market', () => {
  it('shares sum to 1 and parity gives roughly the old demand', () => {
    const s = createInitialState();
    for (const m of MODEL_IDS)
      for (const t of TRIM_IDS) {
        const seg = segmentShares(s, m, t);
        const total = seg.playerShare + seg.otherShare + seg.rivals.reduce((n, r) => n + r.share, 0);
        expect(total).toBeCloseTo(1, 6);
      }
    const seg = segmentShares(s, 'sedan', 'economy');
    // Sedan economy: Vantor cheaper, Halberd pricier, Sunline at parity — player around a fair share.
    expect(seg.playerShare).toBeGreaterThan(fair * 0.6);
    expect(seg.playerShare).toBeLessThan(fair * 1.6);
  });

  it('cutting price wins share; raising it loses share', () => {
    const s = createInitialState();
    const base = trimSpec('sedan', 'economy').baseValue;
    const cheap = segmentShares(s, 'sedan', 'economy', { price: base * 0.9 }).playerShare;
    const mid = segmentShares(s, 'sedan', 'economy', { price: base }).playerShare;
    const dear = segmentShares(s, 'sedan', 'economy', { price: base * 1.15 }).playerShare;
    expect(cheap).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(dear);
  });

  it('a segment with no launched rivals is filled by importers', () => {
    const s = createInitialState();
    // Nobody builds pickups except Vantor (day 3) and Sunline (day 0) — Halberd never does.
    const seg = segmentShares(s, 'pickup', 'economy');
    expect(seg.rivals.find((r) => r.id === 'halberd')?.active).toBe(false);
    expect(seg.otherShare).toBeGreaterThan(0);
  });
});

describe('rival behaviour', () => {
  it('rivals launch models on schedule and cut prices when the player takes their share', () => {
    const s = createInitialState(9);
    const vantor = s.market.rivals.find((r) => r.id === 'vantor')!;
    expect(vantor.segments.suv.economy.active).toBe(false);
    const before = s.market.rivals.map((r) => r.segments.sedan.economy.priceIndex);
    // Undercut hard so rivals fall below a fair share of the sedan economy segment.
    mustOk(s, { type: 'setPrice', model: 'sedan', trim: 'economy', price: Math.round(trimSpec('sedan', 'economy').baseValue * 0.75) });
    runTicks(s, 6 * 1440);
    expect(vantor.segments.suv.economy.active).toBe(true);
    const C = BALANCE.competition;
    for (const r of s.market.rivals)
      for (const m of MODEL_IDS)
        for (const t of TRIM_IDS) {
          const p = r.segments[m][t].priceIndex;
          expect(p).toBeGreaterThanOrEqual(C.minPriceIndex);
          expect(p).toBeLessThanOrEqual(C.maxPriceIndex);
        }
    const after = s.market.rivals.map((r) => r.segments.sedan.economy.priceIndex);
    expect(after.every((p, i) => p < before[i])).toBe(true);
    expect(s.market.history.length).toBeGreaterThan(0);
  });

  it('rivals can win offers the player leaves waiting, but never the first order', () => {
    const s = createInitialState(3);
    let lost = 0;
    for (let i = 0; i < 6 * 1440; i++) {
      step(s);
      lost = s.orders.filter((o) => o.status === 'lost').length;
    }
    expect(lost).toBeGreaterThan(0);
    const first = s.orders.find((o) => o.id === 1);
    if (first) expect(first.status).not.toBe('lost');
    for (const o of s.orders.filter((x) => x.status === 'lost')) {
      expect(o.lostTo).not.toBeNull();
      expect(o.reserved).toEqual([]);
    }
    // Losing an offer moves no money.
    expect(checkInvariants(s)).toEqual([]);
  });

  it('accepted orders can never be lost', () => {
    const s = createInitialState(3);
    for (let i = 0; i < 4 * 1440; i++) {
      for (const o of s.orders) if (o.status === 'offered') applyCommand(s, { type: 'acceptOrder', orderId: o.id });
      step(s);
    }
    expect(s.orders.some((o) => o.status === 'lost')).toBe(false);
  });

  it('is deterministic for a seed', () => {
    const a = createInitialState(42);
    const b = createInitialState(42);
    runTicks(a, 3 * 1440);
    for (let i = 0; i < 36; i++) runTicks(b, 120);
    expect(serialize(a)).toBe(serialize(b));
  });
});

describe('alerts', () => {
  it('flags unsold stock when rivals undercut, with a working price-match action', () => {
    const s = createInitialState();
    mustOk(s, { type: 'setPrice', model: 'sedan', trim: 'economy', price: 30_000 });
    // Two unreserved finished sedans in the yard.
    for (let k = 0; k < 2; k++) {
      const id = s.nextId++;
      s.vehicles[String(id)] = {
        id, plant: 0, serial: `MX-T${k}`, model: 'sedan', trim: 'economy', finish: 'solid', color: '#000', stage: 'finished',
        cost: 14000, defect: false, defectNotes: [], defectDetected: false, reworkCount: 0, orderId: null,
        plannedForOrderId: null, startedAt: s.time, finishedAt: s.time, closedAt: null, salePrice: null,
      };
      s.yard.push(id);
    }
    const alert = getAlerts(s).find((a) => a.id === 'losing-sedan-economy');
    expect(alert).toBeDefined();
    const cmd = alert!.actions.find((a) => a.action.kind === 'command');
    expect(cmd).toBeDefined();
    if (cmd && cmd.action.kind === 'command') {
      mustOk(s, cmd.action.command);
      expect(s.product.models.sedan.price.economy).toBeLessThan(30_000);
    }
  });
});

describe('market share history', () => {
  it('records player sales and rival estimates per day', () => {
    const s: GameState = createInitialState(11);
    runTicks(s, 3 * 1440);
    const share = recentMarketShare(s, 7);
    expect(share).not.toBeNull();
    const total = share!.player + Object.values(share!.rivals).reduce((n, x) => n + x, 0);
    expect(total).toBeCloseTo(1, 6);
  });
});

describe('save migration v2 → v3', () => {
  it('adds rivals to an older save and keeps running', () => {
    const s = createInitialState();
    runTicks(s, 600);
    const v2 = toV4Shape(JSON.parse(serialize(s)));
    v2.version = 2;
    delete v2.market;
    for (const o of v2.orders) {
      delete o.contested;
      delete o.lostTo;
    }
    const loaded = deserialize(JSON.stringify(v2));
    expect(loaded.version).toBe(SAVE_VERSION);
    expect(loaded.market.rivals).toHaveLength(BALANCE.competition.rivals.length);
    expect(loaded.orders.every((o) => o.contested === false)).toBe(true);
    runTicks(loaded, 1440);
    expect(checkInvariants(loaded)).toEqual([]);
  });
});
