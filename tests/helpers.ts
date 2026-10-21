/** Shared helpers for the simulation/controller tests. */
import { BALANCE, COMPONENT_IDS, STATION_IDS } from '../src/config/balance';
import type { ComponentId, ModelId, StationId, TrimId } from '../src/config/balance';
import { applyCommand } from '../src/sim/commands';
import type { Command, CommandResult } from '../src/sim/commandTypes';
import { step } from '../src/sim/engine';
import {
  buildPlantBlocker,
  nextPlantSite,
  orderProgress,
  projectedDailyCosts,
  queueCapacity,
  researchStatus,
  stationRequiredStaff,
  unassignedFor,
  unlockBlocker,
  yardCapacity,
} from '../src/sim/selectors';
import type { GameState, LedgerCategory, SalesOrder, Vehicle } from '../src/sim/types';
import type { StorageLike } from '../src/game/GameController';

export const SEED = 12345;

/** In-memory Storage replacement. Set `failWrites` to simulate quota/private-mode errors. */
export class MemoryStorage implements StorageLike {
  map = new Map<string, string>();
  failWrites = false;
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

export function mustOk(s: GameState, cmd: Command): CommandResult {
  const r = applyCommand(s, cmd);
  if (!r.ok) throw new Error(`Command ${JSON.stringify(cmd)} failed: ${r.message}`);
  return r;
}

export function ticks(s: GameState, n: number, onTick?: (s: GameState) => void): void {
  for (let i = 0; i < n; i++) {
    step(s);
    onTick?.(s);
  }
}

/** Steps until pred is true; throws if it never happens within maxTicks. Returns ticks used. */
export function runUntil(
  s: GameState,
  pred: (s: GameState) => boolean,
  maxTicks: number,
  onTick?: (s: GameState) => void,
  what = 'condition',
): number {
  for (let i = 0; i < maxTicks; i++) {
    if (pred(s)) return i;
    step(s);
    onTick?.(s);
  }
  if (pred(s)) return maxTicks;
  throw new Error(`Timed out after ${maxTicks} ticks waiting for ${what} (time=${s.time})`);
}

/** Keeps every station above the breakdown hazard threshold so a test is not disturbed by random breakdowns. */
export function healAll(s: GameState): void {
  for (const p of s.plants) for (const id of STATION_IDS) p.stations[id].condition = 100;
}

/** A sensible player repairs broken stations. */
export function autoRepair(s: GameState): void {
  for (const p of s.plants)
    for (const id of STATION_IDS) {
      const st = p.stations[id];
      if (st.broken && !st.service) applyCommand(s, { type: 'repair', station: id, plant: p.id });
    }
}

/** Hire 3 operators and staff Paint (1) and Final Assembly (2), as the tutorial asks. */
export function staffLine(s: GameState): void {
  mustOk(s, { type: 'hire', role: 'operator', count: 3 });
  mustOk(s, { type: 'assignOperator', station: 'paint', delta: 1 });
  mustOk(s, { type: 'assignOperator', station: 'final', delta: 1 });
  mustOk(s, { type: 'assignOperator', station: 'final', delta: 1 });
}

/** Components needed to build `qty` vehicles of `model`/`trim` with the current product finish. */
export function componentsFor(
  s: GameState,
  trim: TrimId,
  qty: number,
  stations: StationId[] = [...STATION_IDS],
  model: ModelId = 'sedan',
) {
  const need: Record<ComponentId, number> = { steel: 0, powertrain: 0, interior: 0, wheels: 0, paint: 0 };
  const recipe = BALANCE.models[model].trims[trim].recipe;
  const finish = BALANCE.finishes[s.product.models[model].finish[trim]];
  for (const st of stations) {
    const parts = recipe[st];
    if (!parts) continue;
    for (const [c, n] of Object.entries(parts) as [ComponentId, number][]) {
      const mult = st === 'paint' ? finish.paintMult : 1;
      need[c] += n * mult * qty;
    }
  }
  return need;
}

export function incoming(s: GameState, c: ComponentId): number {
  return s.shipments.filter((sh) => sh.component === c).reduce((a, sh) => a + sh.qty, 0);
}

/** Buy (from Corvan) whatever is missing to build `qty` vehicles of `trim`, excluding `skip` components. */
export function buyShortfall(
  s: GameState,
  trim: TrimId,
  qty: number,
  skip: ComponentId[] = [],
  model: ModelId = 'sedan',
): void {
  const need = componentsFor(s, trim, qty, [...STATION_IDS], model);
  for (const c of COMPONENT_IDS) {
    if (skip.includes(c)) continue;
    const short = need[c] - s.inventory[c].qty - incoming(s, c);
    if (short > 0) mustOk(s, { type: 'purchase', supplierId: 'corvan', component: c, quantity: short });
  }
}

export function order(s: GameState, id: number): SalesOrder {
  const o = s.orders.find((x) => x.id === id);
  if (!o) throw new Error(`order ${id} not found`);
  return o;
}

export function vehicles(s: GameState): Vehicle[] {
  return Object.values(s.vehicles);
}

export function ledgerSum(s: GameState, cat?: LedgerCategory): number {
  return s.finance.ledger.filter((e) => !cat || e.category === cat).reduce((a, e) => a + e.amount, 0);
}

/**
 * Plays the starting order up to "ready to deliver": accept, buy parts, staff, schedule, build.
 * Returns the order id.
 */
export function buildFirstOrder(s: GameState): number {
  const offer = s.orders.find((o) => o.status === 'offered');
  if (!offer) throw new Error('initial state has no offer');
  const id = offer.id;
  mustOk(s, { type: 'acceptOrder', orderId: id });
  buyShortfall(s, offer.trim, offer.quantity);
  staffLine(s);
  mustOk(s, { type: 'scheduleForOrder', orderId: id });
  runUntil(s, (st) => orderProgress(st, order(st, id)).ready, 3 * 1440, autoRepair, 'order ready');
  return id;
}

const STAGE_OK = (stage: Vehicle['stage'], where: string | undefined): boolean => {
  if (stage === 'delivered' || stage === 'sold') return where === undefined;
  if (stage === 'finished') return where === 'yard';
  if (stage === 'rework') return where !== undefined && where.startsWith('rework.');
  return where !== undefined && where.startsWith(`${stage}.`);
};

/** Returns a list of invariant violations (empty = OK). */
export function checkInvariants(s: GameState): string[] {
  const errs: string[] = [];
  if (!Number.isFinite(s.cash)) errs.push(`cash not finite: ${s.cash}`);

  // Inventory never negative.
  for (const c of COMPONENT_IDS) {
    const inv = s.inventory[c];
    if (inv.qty < 0 || !Number.isInteger(inv.qty)) errs.push(`inventory ${c} qty=${inv.qty}`);
    if (inv.value < -1e-6) errs.push(`inventory ${c} value=${inv.value}`);
    if (inv.qualitySum < -1e-6) errs.push(`inventory ${c} qualitySum=${inv.qualitySum}`);
    if (inv.qty === 0 && Math.abs(inv.value) > 1e-6) errs.push(`inventory ${c} has value ${inv.value} with qty 0`);
  }
  for (const sh of s.shipments) if (sh.qty <= 0) errs.push(`shipment ${sh.id} qty=${sh.qty}`);

  // Every vehicle in exactly one place.
  const loc = new Map<number, string>();
  const place = (id: number, where: string) => {
    if (loc.has(id)) errs.push(`vehicle ${id} in both ${loc.get(id)} and ${where}`);
    else loc.set(id, where);
    if (!s.vehicles[id]) errs.push(`unknown vehicle ${id} at ${where}`);
  };
  const plantAt = new Map<number, number>();
  for (const p of s.plants) {
    const at = (id: number, where: string) => {
      place(id, where);
      plantAt.set(id, p.id);
    };
    for (const id of STATION_IDS) {
      const st = p.stations[id];
      st.queue.forEach((v) => at(v, `${id}.queue`));
      st.slots.forEach((sl) => sl && at(sl.vehicleId, `${id}.slot`));
      if (st.queue.length > queueCapacity(s, id, p.id)) errs.push(`p${p.id} ${id} queue ${st.queue.length} > cap`);
      if (st.slots.length !== 1 + st.capacityLevel) errs.push(`p${p.id} ${id} slots ${st.slots.length} != 1+capacityLevel`);
      if (st.assigned < 0) errs.push(`p${p.id} ${id} negative staff`);
    }
    p.rework.queue.forEach((v) => at(v, 'rework.queue'));
    if (p.rework.slot) at(p.rework.slot.vehicleId, 'rework.slot');
    // The sim may hold one extra car to break a rework/inspection gridlock.
    if (p.rework.queue.length > BALANCE.quality.reworkQueueCapacity + 1) errs.push(`p${p.id} rework queue over capacity`);
    if (p.constructionRemaining > 0 && STATION_IDS.some((id) => p.stations[id].queue.length || p.stations[id].slots.some(Boolean))) {
      errs.push(`p${p.id} works while under construction`);
    }
  }
  // Staff assignments never exceed headcount.
  let ops = 0;
  let insp = 0;
  for (const p of s.plants) for (const id of STATION_IDS) (id === 'inspection' ? (insp += p.stations[id].assigned) : (ops += p.stations[id].assigned));
  if (ops > s.staff.operator) errs.push(`assigned operators ${ops} > ${s.staff.operator}`);
  if (insp > s.staff.inspector) errs.push(`assigned inspectors ${insp} > ${s.staff.inspector}`);
  s.yard.forEach((v) => place(v, 'yard'));
  const yardCap = yardCapacity(s);
  if (s.yard.length > yardCap) errs.push(`yard ${s.yard.length} > cap ${yardCap}`);
  for (const v of vehicles(s)) {
    const where = loc.get(v.id);
    if (!STAGE_OK(v.stage, where)) errs.push(`vehicle ${v.id} stage=${v.stage} but located at ${where ?? 'nowhere'}`);
    if (v.cost < -1e-6) errs.push(`vehicle ${v.id} negative cost`);
    const pa = plantAt.get(v.id);
    if (pa !== undefined && pa !== v.plant) errs.push(`vehicle ${v.id} of plant ${v.plant} found in plant ${pa}`);
  }

  // Reservations consistent.
  const reservedBy = new Map<number, number>();
  for (const o of s.orders) {
    if (o.status !== 'accepted') continue;
    if (o.reserved.length > o.quantity) errs.push(`order ${o.id} over-reserved`);
    for (const vid of o.reserved) {
      if (reservedBy.has(vid)) errs.push(`vehicle ${vid} reserved by orders ${reservedBy.get(vid)} and ${o.id}`);
      reservedBy.set(vid, o.id);
      const v = s.vehicles[vid];
      if (!v || v.stage !== 'finished' || v.orderId !== o.id) errs.push(`order ${o.id} reserves bad vehicle ${vid}`);
      if (v && v.trim !== o.trim) errs.push(`order ${o.id} reserves wrong trim vehicle ${vid}`);
    }
  }
  for (const vid of s.yard) {
    const v = s.vehicles[vid];
    if (v && v.orderId !== null && reservedBy.get(vid) !== v.orderId) errs.push(`yard vehicle ${vid} orderId=${v.orderId} not reserved by it`);
  }

  // Ledger reconciles with cash.
  const expected = s.finance.startingCash + s.finance.ledgerCarriedForward + ledgerSum(s);
  if (Math.abs(expected - s.cash) > 0.01) errs.push(`ledger expected ${expected} but cash ${s.cash}`);
  return errs;
}

/** Deterministic PRNG for scripted players (independent from the sim RNG). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A competent automated player for balance tests: takes on only what the line can build in time, buys
 * parts just in time for scheduled and in-progress work (keeping a payroll reserve), keeps a little
 * market stock, and maintains equipment. Call every 30 game minutes.
 */
export function competentBot(s: GameState, maxBacklog = 6): void {
  const reserve = projectedDailyCosts(s).total * 1.2;
  for (const p of s.plants)
    for (const id of STATION_IDS) {
      const st = p.stations[id];
      if (st.broken && !st.service) applyCommand(s, { type: 'repair', station: id, plant: p.id });
      else if (!st.broken && !st.service && st.condition < 45 && s.cash > reserve + BALANCE.equipment.maintenance.cost)
        applyCommand(s, { type: 'scheduleMaintenance', station: id, plant: p.id });
    }
  for (const o of s.orders.filter((x) => x.status === 'accepted')) {
    const p = orderProgress(s, o);
    if (p.ready) applyCommand(s, { type: 'deliverOrder', orderId: o.id });
    else if (p.shortfall > 0) applyCommand(s, { type: 'scheduleForOrder', orderId: o.id });
  }
  const queued = s.plan.reduce((n, j) => n + j.quantity - j.started, 0);
  const wip = Object.values(s.vehicles).filter((v) => STATION_IDS.includes(v.stage as StationId) || v.stage === 'rework').length;
  for (const o of s.orders.filter((x) => x.status === 'offered')) {
    const hoursLeft = (o.deadline - s.time) / 60;
    // ~2.5 h per car through the bottleneck, plus the cars already ahead of it.
    const lines = s.plants.filter((p) => p.constructionRemaining <= 0 && p.stations.stamping.assigned > 0).length || 1;
    if (queued + wip + o.quantity <= maxBacklog && hoursLeft > ((queued + wip + o.quantity) * 2.5) / lines + 8) {
      applyCommand(s, { type: 'acceptOrder', orderId: o.id });
      break;
    }
  }
  const unreserved = s.yard.filter((v) => s.vehicles[String(v)].orderId === null).length;
  if (queued === 0 && unreserved < 2 && s.cash > 40_000) {
    applyCommand(s, { type: 'scheduleBuild', model: 'sedan', trim: 'economy', quantity: 2 });
  }
  // Just-in-time parts for planned + in-progress work.
  const need: Record<ComponentId, number> = { steel: 0, powertrain: 0, interior: 0, wheels: 0, paint: 0 };
  const add = (n: Record<ComponentId, number>) => COMPONENT_IDS.forEach((c) => (need[c] += n[c]));
  for (const j of s.plan) add(componentsFor(s, j.trim, j.quantity - j.started, [...STATION_IDS], j.model));
  for (const v of Object.values(s.vehicles)) {
    if (v.stage === 'stamping' || v.stage === 'body') add(componentsFor(s, v.trim, 1, ['paint', 'final'], v.model));
    else if (v.stage === 'paint') add(componentsFor(s, v.trim, 1, ['final'], v.model));
  }
  const byValue = [...COMPONENT_IDS].sort((a, b) => BALANCE.components[b].basePrice - BALANCE.components[a].basePrice);
  for (const c of byValue) {
    const short = need[c] - s.inventory[c].qty - incoming(s, c);
    const affordable = Math.floor((s.cash - reserve) / BALANCE.components[c].basePrice);
    const qty = Math.min(short, affordable);
    if (qty > 0) applyCommand(s, { type: 'purchase', supplierId: 'corvan', component: c, quantity: qty });
  }
}

/** Rebuilds the pre-plants (save version 4) layout from a current save object, for migration tests. */
export function toV4Shape(save: Record<string, any>): Record<string, any> {
  const out = structuredClone(save);
  out.stations = out.plants[0].stations;
  out.rework = out.plants[0].rework;
  delete out.plants;
  for (const v of Object.values(out.vehicles) as Record<string, unknown>[]) delete v.plant;
  out.version = 4;
  return out;
}

/**
 * A player who grows the business: everything competentBot does, plus staffing every operating plant,
 * research, new models and new plants when cash allows. Call once per game hour.
 */
export function growthBot(s: GameState): void {
  const plants = s.plants.filter((p) => p.constructionRemaining <= 0);
  competentBot(s, 6 * plants.length);
  for (const p of plants) {
    for (const id of STATION_IDS) {
      const need = stationRequiredStaff(s, id, p.id) - p.stations[id].assigned;
      for (let i = 0; i < need; i++) {
        if (unassignedFor(s, id) <= 0) {
          const role = id === 'inspection' ? 'inspector' : 'operator';
          if (!applyCommand(s, { type: 'hire', role, count: 1 }).ok) break;
          if (role === 'inspector') continue; // auto-assigned
        }
        applyCommand(s, { type: 'assignOperator', station: id, delta: 1, plant: p.id });
      }
    }
  }
  if (s.staff.technician < plants.length) applyCommand(s, { type: 'hire', role: 'technician', count: 1 });
  const reserve = projectedDailyCosts(s).total * 3 + 40_000;
  if (!s.research.active) {
    const avail = Object.entries(BALANCE.research.projects)
      .filter(([id]) => researchStatus(s, id) === 'available')
      .sort((a, b) => a[1].cost - b[1].cost);
    if (avail.length && s.cash > avail[0][1].cost + reserve) applyCommand(s, { type: 'startResearch', project: avail[0][0] });
  }
  for (const m of ['suv', 'pickup'] as ModelId[]) {
    if (!s.product.models[m].unlocked && !unlockBlocker(s, m) && s.cash > BALANCE.models[m].unlockCost + reserve) {
      applyCommand(s, { type: 'unlockModel', model: m });
    }
  }
  const site = nextPlantSite(s);
  if (site && !buildPlantBlocker(s) && s.cash > site.cost + reserve + 60_000) applyCommand(s, { type: 'buildPlant' });
}
