import { describe, expect, it } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { GameController } from '../src/game/GameController';
import { createInitialState } from '../src/sim/initialState';
import { serialize } from '../src/sim/save';
import { MemoryStorage, SEED } from './helpers';

function make(storage = new MemoryStorage(), autoLoad = false) {
  return { c: new GameController({ storage, autoLoad, seed: SEED }), storage };
}

describe('(h) pause and speed', () => {
  it('paused → advanceRealTime runs no ticks', () => {
    const { c } = make();
    c.setPaused(true);
    const t = c.state.time;
    for (let i = 0; i < 40; i++) c.advanceRealTime(0.25);
    expect(c.state.time).toBe(t);
    expect(c.ticksRun).toBe(0);
    c.togglePause();
    expect(c.paused).toBe(false);
    c.advanceRealTime(0.25);
    expect(c.state.time).toBeGreaterThan(t);
  });

  it('1× / 2× / 4× tick counts are proportional', () => {
    const counts = ([1, 2, 4] as const).map((speed) => {
      const { c } = make();
      c.setSpeed(speed);
      const t0 = c.state.time;
      for (let i = 0; i < 40; i++) c.advanceRealTime(0.25); // 10 s
      return c.state.time - t0;
    });
    expect(counts[0]).toBe(10 * BALANCE.time.ticksPerSecondAt1x);
    expect(counts[1]).toBe(2 * counts[0]);
    expect(counts[2]).toBe(4 * counts[0]);
  });

  it('long frames are clamped; fractions accumulate into tickFraction', () => {
    const { c } = make();
    const t0 = c.state.time;
    c.advanceRealTime(10); // clamped to 0.25 s → 1.5 ticks
    expect(c.state.time - t0).toBe(1);
    expect(c.tickFraction).toBeCloseTo(0.5, 6);
    c.advanceRealTime(1 / 12); // +0.5 tick
    expect(c.state.time - t0).toBe(2);
    expect(c.tickFraction).toBeCloseTo(0, 6);
    c.advanceRealTime(-1);
    c.advanceRealTime(NaN);
    expect(c.state.time - t0).toBe(2);
  });

  it('same total ticks with different frame chunking → identical state (determinism)', () => {
    const a = make().c;
    const b = make().c;
    a.setSpeed(4);
    b.setSpeed(4);
    a.dispatch({ type: 'acceptOrder', orderId: a.state.orders[0].id });
    b.dispatch({ type: 'acceptOrder', orderId: b.state.orders[0].id });
    for (let i = 0; i < 200; i++) a.advanceRealTime(0.25);
    for (let i = 0; i < 800; i++) b.advanceRealTime(0.0625);
    expect(a.state.time).toBe(b.state.time);
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
  });

  it('speed changes and dispatches notify subscribers immediately; ticking notifies throttled', () => {
    const { c } = make();
    let n = 0;
    const unsub = c.subscribe(() => n++);
    c.setSpeed(2);
    expect(n).toBe(1);
    c.setPaused(true);
    expect(n).toBe(2);
    c.dispatch({ type: 'dismissTutorial' });
    expect(n).toBe(3);
    c.setPaused(false);
    n = 0;
    for (let i = 0; i < 80; i++) c.advanceRealTime(1 / 60); // ~1.33 s of frames
    // 8 ticks happen in this window; never more than one notify per ~125 ms.
    expect(n).toBeGreaterThanOrEqual(6);
    expect(n).toBeLessThanOrEqual(11);
    unsub();
    c.setSpeed(4);
    expect(n).toBeLessThanOrEqual(12);
  });

  it('failed dispatch sets a toast with the message', () => {
    const { c } = make();
    const r = c.dispatch({ type: 'deliverOrder', orderId: 999999 });
    expect(r.ok).toBe(false);
    expect(c.toast).not.toBeNull();
    expect(c.toast!.ok).toBe(false);
    expect(c.toast!.text).toBe(r.message);
  });

  it('game over stops ticks; newGame resets and keeps speed', () => {
    const { c, storage } = make();
    c.setSpeed(4);
    c.state.cash = -10_000;
    for (let i = 0; i < 400 && !c.state.gameOver; i++) c.advanceRealTime(0.25);
    expect(c.state.gameOver).toBe(true);
    const t = c.state.time;
    c.advanceRealTime(0.25);
    expect(c.state.time).toBe(t);
    c.setPaused(true);
    c.newGame();
    expect(c.state.gameOver).toBe(false);
    expect(c.state.cash).toBe(BALANCE.start.cash);
    expect(c.state.time).toBe(BALANCE.time.startMinute);
    expect(c.paused).toBe(false);
    expect(c.speed).toBe(4);
    const auto = storage.getItem(BALANCE.save.autosaveKey);
    expect(auto).not.toBeNull();
    expect(JSON.parse(auto!).time).toBe(BALANCE.time.startMinute);
  });
});

describe('controller saves', () => {
  it('manual save → list slots → load restores the saved state', () => {
    const { c, storage } = make();
    for (let i = 0; i < 20; i++) c.advanceRealTime(0.25);
    const r = c.saveManual();
    expect(r.ok).toBe(true);
    expect(c.toast?.ok).toBe(true);
    const savedTime = c.state.time;
    const savedJson = JSON.stringify(c.state);
    const slots = c.listSaveSlots();
    expect(slots.map((s) => s.label)).toEqual(['Autosave', 'Manual save']);
    const manual = slots.find((s) => s.key === BALANCE.save.manualKey)!;
    expect(manual.time).toBe(savedTime);
    expect(manual.savedAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(slots.find((s) => s.key === BALANCE.save.autosaveKey)!.time).toBeNull();

    for (let i = 0; i < 20; i++) c.advanceRealTime(0.25);
    expect(c.state.time).toBeGreaterThan(savedTime);
    const before = c.state;
    expect(c.loadSlot(BALANCE.save.manualKey).ok).toBe(true);
    expect(c.state).not.toBe(before);
    expect(JSON.stringify(c.state)).toBe(savedJson);
    expect(storage.map.size).toBeGreaterThan(0);
  });

  it('loading empty or corrupted slots fails gracefully', () => {
    const { c, storage } = make();
    const state = c.state;
    expect(c.loadSlot(BALANCE.save.manualKey).ok).toBe(false);
    storage.setItem(BALANCE.save.manualKey, '{"format":"motorworx-save","state":"garbage"}');
    const r = c.loadSlot(BALANCE.save.manualKey);
    expect(r.ok).toBe(false);
    expect(r.message).toBeTruthy();
    expect(c.toast?.ok).toBe(false);
    expect(c.state).toBe(state);
  });

  it('storage that throws (quota/private mode) reports failure, never crashes', () => {
    const storage = new MemoryStorage();
    storage.failWrites = true;
    const { c } = make(storage);
    const r = c.saveManual();
    expect(r.ok).toBe(false);
    expect(c.toast?.ok).toBe(false);
    expect(() => {
      for (let i = 0; i < 4 * BALANCE.save.autosaveRealSeconds + 4; i++) c.advanceRealTime(0.25);
    }).not.toThrow();
    expect(() => c.newGame()).not.toThrow();
  });

  it('autosaves every autosaveRealSeconds of running real time', () => {
    const { c, storage } = make();
    const frames = (BALANCE.save.autosaveRealSeconds / 0.25) | 0;
    for (let i = 0; i < frames - 1; i++) c.advanceRealTime(0.25);
    expect(storage.getItem(BALANCE.save.autosaveKey)).toBeNull();
    c.advanceRealTime(0.25);
    c.advanceRealTime(0.25);
    expect(storage.getItem(BALANCE.save.autosaveKey)).not.toBeNull();
  });

  it('constructor loads a valid autosave and ignores a corrupted one', () => {
    const storage = new MemoryStorage();
    const s = createInitialState(SEED);
    s.cash = 77_777;
    s.finance.startingCash = 77_777;
    storage.setItem(
      BALANCE.save.autosaveKey,
      JSON.stringify({ format: 'motorworx-save', savedAtIso: new Date().toISOString(), time: s.time, state: serialize(s) }),
    );
    const c = new GameController({ storage, seed: SEED });
    expect(c.state.cash).toBe(77_777);

    storage.setItem(BALANCE.save.autosaveKey, 'nonsense');
    const c2 = new GameController({ storage, seed: SEED });
    expect(c2.state.cash).toBe(BALANCE.start.cash);
  });

  it('works with no storage and no browser globals', () => {
    const c = new GameController({ storage: null, autoLoad: true, seed: SEED });
    c.start();
    c.stop();
    expect(c.saveManual().ok).toBe(false);
    expect(c.listSaveSlots().every((s) => s.time === null)).toBe(true);
  });
});
