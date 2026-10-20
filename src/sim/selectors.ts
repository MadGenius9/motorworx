/**
 * Read-only helpers used by the UI and renderer. All functions are pure (never mutate state).
 */
import { BALANCE, COMPONENT_IDS, MODEL_IDS, STATION_IDS } from '../config/balance';
import type { TrimSpec } from '../config/balance';
import type { Command } from './commandTypes';
import type {
  ComponentId,
  FinishId,
  GameState,
  ModelId,
  RivalState,
  SalesOrder,
  StationId,
  TrimId,
  Vehicle,
  VehicleStage,
} from './types';

export type PanelTab = 'orders' | 'vehicles' | 'market' | 'suppliers' | 'staff' | 'finances' | 'upgrades';
export type StationStatus = 'running' | 'idle' | 'blocked' | 'understaffed' | 'broken' | 'repair' | 'maintenance';
export type AlertAction =
  | { kind: 'openTab'; tab: PanelTab }
  | { kind: 'openStation'; station: StationId }
  | { kind: 'command'; command: Command };
export interface Alert {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  cause: string;
  actions: { label: string; action: AlertAction }[];
}
export interface TutorialStep {
  id: string;
  title: string;
  text: string;
  done: boolean;
  action?: { label: string; action: AlertAction };
}

const MPD = BALANCE.time.minutesPerDay;

// ───────────────────────────── time & formatting ─────────────────────────────

export function dayOf(time: number): number {
  return Math.floor(time / MPD) + 1;
}

export function clockOf(time: number): string {
  const m = ((Math.floor(time) % MPD) + MPD) % MPD;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function formatTime(time: number): string {
  return `Day ${dayOf(time)} · ${clockOf(time)}`;
}

export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  if (m < MPD) {
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h}h ${r}m` : `${h}h`;
  }
  const d = Math.floor(m / MPD);
  const h = Math.floor((m % MPD) / 60);
  return h ? `${d}d ${h}h` : `${d}d`;
}

function groupThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatMoney(n: number): string {
  const r = Math.round(n);
  const s = groupThousands(Math.abs(r));
  return r < 0 ? `−$${s}` : `$${s}`;
}

export function stationName(id: StationId): string {
  return BALANCE.stations[id].name;
}

export function componentName(c: ComponentId): string {
  return BALANCE.components[c].name;
}

export function trimName(t: TrimId): string {
  return BALANCE.trims[t].name;
}

/** Vehicle class, e.g. "SUV". */
export function modelClassName(m: ModelId): string {
  return BALANCE.models[m].className;
}

/** The player's name for a model, e.g. "Kestrel". */
export function modelName(state: GameState, m: ModelId): string {
  return state.product.models[m]?.name ?? BALANCE.models[m].defaultName;
}

/** "Kestrel Premium" */
export function vehicleLabel(state: GameState, m: ModelId, t: TrimId): string {
  return `${modelName(state, m)} ${trimName(t)}`;
}

export function trimSpec(m: ModelId, t: TrimId): TrimSpec {
  return BALANCE.models[m].trims[t];
}

export function isModel(m: unknown): m is ModelId {
  return typeof m === 'string' && (MODEL_IDS as readonly string[]).includes(m);
}

export function unlockedModels(state: GameState): ModelId[] {
  return MODEL_IDS.filter((m) => state.product.models[m]?.unlocked);
}

/** Why the model's tooling can't be bought right now, or null if it can. */
export function unlockBlocker(state: GameState, m: ModelId): string | null {
  const spec = BALANCE.models[m];
  if (state.product.models[m].unlocked) return `${modelName(state, m)} is already in production.`;
  if (state.reputation < spec.minReputation) {
    return `Needs reputation ${spec.minReputation} (you have ${Math.floor(state.reputation)}).`;
  }
  if (state.cash < spec.unlockCost) return `Needs ${formatMoney(spec.unlockCost)} cash (you have ${formatMoney(state.cash)}).`;
  return null;
}

export function modelColorHex(state: GameState, m: ModelId): string {
  const id = state.product.models[m].colorId;
  return (BALANCE.colors.find((c) => c.id === id) ?? BALANCE.colors[0]).hex;
}

// ───────────────────────────── stations ─────────────────────────────

export function stationStaff(state: GameState, id: StationId): number {
  return id === 'inspection' ? state.staff.inspector : state.stations[id].assigned;
}

export function stationRequiredStaff(state: GameState, id: StationId): number {
  return BALANCE.stations[id].staffPerSlot * state.stations[id].slots.length;
}

export function staffFactor(state: GameState, id: StationId): number {
  const req = stationRequiredStaff(state, id);
  if (req <= 0) return 0;
  return Math.max(0, Math.min(1, stationStaff(state, id) / req));
}

/** True if the station has any vehicle in a slot or queue (or, for stamping, scheduled work). */
export function stationHasWork(state: GameState, id: StationId): boolean {
  const st = state.stations[id];
  if (st.slots.some((s) => s !== null) || st.queue.length > 0) return true;
  if (id === 'stamping') return state.plan.some((j) => j.started < j.quantity);
  return false;
}

export function stationStatus(state: GameState, id: StationId): StationStatus {
  const st = state.stations[id];
  if (st.service) return st.service.kind === 'repair' ? 'repair' : 'maintenance';
  if (st.broken) return 'broken';
  if (st.issues.some((i) => i.kind === 'downstream' || i.kind === 'materials' || i.kind === 'cash')) return 'blocked';
  const sf = staffFactor(state, id);
  if (sf < 1 && (sf === 0 || st.issues.some((i) => i.kind === 'staff') || stationHasWork(state, id))) {
    return 'understaffed';
  }
  if (st.slots.some((s) => s !== null && !s.done)) return 'running';
  return 'idle';
}

export function queueCapacity(state: GameState, id: StationId): number {
  if (id === 'stamping') return 0;
  return BALANCE.queue.baseCapacity + BALANCE.queue.perCapacityLevel * state.stations[id].capacityLevel;
}

/** Work minutes for one vehicle at a station, excluding any model changeover. */
export function cycleMinutes(id: StationId, model: ModelId, trim: TrimId, finish: FinishId): number {
  const base = Math.round(BALANCE.stations[id].baseMinutes * BALANCE.trims[trim].timeMult * BALANCE.models[model].timeMult);
  return base + (id === 'paint' ? BALANCE.finishes[finish].paintMinutesAdd : 0);
}

/** Retooling minutes the station would add before starting a vehicle of `model` now. */
export function changeoverMinutes(state: GameState, id: StationId, model: ModelId): number {
  const last = state.stations[id].lastModel;
  return last !== null && last !== model ? BALANCE.changeover.minutes[id] : 0;
}

/** Components consumed by `station` for one vehicle (paint station quantities × finish.paintMult). */
export function recipeFor(
  model: ModelId,
  trim: TrimId,
  station: StationId,
  finish: FinishId,
): Partial<Record<ComponentId, number>> {
  const r = trimSpec(model, trim).recipe[station];
  const out: Partial<Record<ComponentId, number>> = {};
  if (!r) return out;
  const mult = station === 'paint' ? BALANCE.finishes[finish].paintMult : 1;
  for (const c of COMPONENT_IDS) {
    const q = r[c];
    if (q && q > 0) out[c] = q * mult;
  }
  return out;
}

/** Breakdown probability per active minute at the station's current condition. */
export function hazardPerActiveMinute(state: GameState, id: StationId): number {
  const st = state.stations[id];
  const E = BALANCE.equipment;
  if (st.condition <= 0) return 1;
  if (st.condition >= E.hazardThreshold) return 0;
  const x = (E.hazardThreshold - st.condition) / E.hazardThreshold;
  return E.hazardScale * x * x * Math.pow(E.reliabilityHazardMult, st.reliabilityLevel);
}

export function breakdownHazardPerHour(state: GameState, id: StationId): number {
  const p = hazardPerActiveMinute(state, id);
  if (p >= 1) return 1;
  return 1 - Math.pow(1 - p, 60);
}

export function breakdownRisk(state: GameState, id: StationId): 'low' | 'elevated' | 'high' {
  const c = state.stations[id].condition;
  if (c < BALANCE.equipment.dangerCondition) return 'high';
  if (c < BALANCE.equipment.warnCondition) return 'elevated';
  return 'low';
}

/** Probability that inspection catches a defect (0 when there are no inspectors). */
export function detectionRate(state: GameState): number {
  const n = state.staff.inspector;
  if (n <= 0) return 0;
  const Q = BALANCE.quality;
  return Math.min(Q.detectionMax, Q.detectionBase + Q.detectionPerInspector * (n - 1));
}

// ───────────────────────────── staff ─────────────────────────────

export function assignedOperators(state: GameState): number {
  let n = 0;
  for (const id of STATION_IDS) if (id !== 'inspection') n += state.stations[id].assigned;
  return n;
}

export function unassignedOperators(state: GameState): number {
  return Math.max(0, state.staff.operator - assignedOperators(state));
}

export function busyTechnicians(state: GameState): number {
  return STATION_IDS.filter((id) => state.stations[id].service !== null).length;
}

export function freeTechnicians(state: GameState): number {
  return Math.max(0, state.staff.technician - busyTechnicians(state));
}

// ───────────────────────────── warehouse ─────────────────────────────

export function warehouseCapacity(state: GameState): number {
  return BALANCE.start.warehouseCapacity + state.warehouseLevel * BALANCE.upgrades.warehouse.componentAdd;
}

export function yardCapacity(state: GameState): number {
  return BALANCE.start.yardCapacity + state.warehouseLevel * BALANCE.upgrades.warehouse.yardAdd;
}

export function stockOnHand(state: GameState): number {
  let n = 0;
  for (const c of COMPONENT_IDS) n += state.inventory[c].qty;
  return n;
}

export function incomingUnits(state: GameState): number {
  let n = 0;
  for (const s of state.shipments) n += s.qty;
  return n;
}

export function incomingOf(state: GameState, c: ComponentId): number {
  let n = 0;
  for (const s of state.shipments) if (s.component === c) n += s.qty;
  return n;
}

function referenceSupplier() {
  return BALANCE.suppliers.find((s) => s.id === 'corvan') ?? BALANCE.suppliers[0];
}

export function supplierUnitPrice(supplierId: string, c: ComponentId): number | null {
  const sup = BALANCE.suppliers.find((s) => s.id === supplierId);
  if (!sup) return null;
  return Math.round(BALANCE.components[c].basePrice * sup.priceMult);
}

export function avgUnitCost(state: GameState, c: ComponentId): number {
  const s = state.inventory[c];
  if (s.qty > 0) return s.value / s.qty;
  return Math.round(BALANCE.components[c].basePrice * referenceSupplier().priceMult);
}

export function avgQuality(state: GameState, c: ComponentId): number {
  const s = state.inventory[c];
  if (s.qty > 0) return s.qualitySum / s.qty;
  return referenceSupplier().quality;
}

// ───────────────────────────── costs & economics ─────────────────────────────

export function dailyPayroll(state: GameState): number {
  const S = BALANCE.staff;
  return (
    state.staff.operator * S.operator.dailyWage +
    state.staff.inspector * S.inspector.dailyWage +
    state.staff.technician * S.technician.dailyWage
  );
}

/** Energy accrued so far today plus the current active slots running until midnight. */
export function projectedDailyCosts(state: GameState): { payroll: number; overhead: number; energy: number; total: number } {
  const payroll = dailyPayroll(state);
  const overhead = BALANCE.overhead.dailyBase;
  const minutesLeft = MPD - (((state.time % MPD) + MPD) % MPD);
  let energy = 0;
  for (const id of STATION_IDS) {
    const st = state.stations[id];
    energy += st.energyAccrued;
    if (st.broken || st.service) continue;
    const sf = staffFactor(state, id);
    if (sf <= 0) continue;
    const active = st.slots.filter((s) => s !== null && !s.done).length;
    energy += (active * BALANCE.stations[id].energyPerActiveHour * minutesLeft) / 60;
  }
  energy = Math.round(energy);
  return { payroll, overhead, energy, total: payroll + overhead + energy };
}

// ───────────────────────────── competition ─────────────────────────────

type RivalSpec = (typeof BALANCE.competition.rivals)[number];

export function rivalSpec(id: string): RivalSpec {
  return BALANCE.competition.rivals.find((r) => r.id === id) ?? BALANCE.competition.rivals[0];
}

export function rivalName(id: string): string {
  return rivalSpec(id).name;
}

/** Reference value of a segment (the price that counts as "parity"). */
export function segmentReference(model: ModelId, trim: TrimId, finish: FinishId = 'solid'): number {
  return trimSpec(model, trim).baseValue + BALANCE.finishes[finish].valueAdd;
}

/** Appeal × reputation × price factor — the same formula for the player and for rivals. */
function attractiveness(appeal: number, reputation: number, priceIndex: number): number {
  const M = BALANCE.market;
  const priceFactor = Math.min(M.maxPriceFactor, Math.exp(-M.elasticity * (priceIndex - 1)));
  return (appeal / M.appealReference) * (M.repBase + reputation / 100) * priceFactor;
}

/** A rival's current price index in a segment, including any running promotion. */
export function rivalPriceIndex(state: GameState, r: RivalState, model: ModelId, trim: TrimId): number {
  const seg = r.segments[model][trim];
  const promo = seg.promoUntil !== null && state.time < seg.promoUntil;
  return seg.priceIndex * (promo ? 1 - BALANCE.competition.promoDiscount : 1);
}

export function rivalPrice(state: GameState, r: RivalState, model: ModelId, trim: TrimId): number {
  return Math.round((segmentReference(model, trim) * rivalPriceIndex(state, r, model, trim)) / 50) * 50;
}

export function rivalOnPromo(state: GameState, r: RivalState, model: ModelId, trim: TrimId): boolean {
  const until = r.segments[model][trim].promoUntil;
  return until !== null && state.time < until;
}

export interface SegmentShares {
  /** Open-market buyers per day this segment brings the player at the given price (if they have stock). */
  demandPerDay: number;
  playerShare: number;
  rivals: { id: string; name: string; color: string; active: boolean; price: number; promo: boolean; share: number }[];
  /** Share taken by unnamed importers standing in for rivals that are not in the segment yet. */
  otherShare: number;
}

/**
 * How a segment's buyers split between the player and the rivals. `playerPresent` = the player has
 * cars on offer (when false, rivals and importers share the whole segment).
 */
export function segmentShares(
  state: GameState,
  model: ModelId,
  trim: TrimId,
  opts: { price?: number; finish?: FinishId; playerPresent?: boolean } = {},
): SegmentShares {
  const C = BALANCE.competition;
  const mc = state.product.models[model];
  const t = trimSpec(model, trim);
  const finish = opts.finish ?? mc.finish[trim];
  const price = opts.price ?? mc.price[trim];
  const present = opts.playerPresent ?? true;
  const aPlayer = present
    ? attractiveness(t.appeal + BALANCE.finishes[finish].appealAdd, state.reputation, price / segmentReference(model, trim, finish))
    : 0;
  let activeCount = 0;
  let sumRivals = 0;
  const rivals = state.market.rivals.map((r) => {
    const spec = rivalSpec(r.id);
    const active = r.segments[model][trim].active;
    const a = active ? attractiveness(t.appeal + spec.appealAdj, r.reputation, rivalPriceIndex(state, r, model, trim)) : 0;
    if (active) activeCount++;
    sumRivals += a;
    return { id: r.id, name: spec.name, color: spec.color, active, price: rivalPrice(state, r, model, trim), promo: rivalOnPromo(state, r, model, trim), a };
  });
  // Missing competitors are stood in for by generic importers at parity (attractiveness 1).
  const filler = Math.max(0, C.marketSizeCompanies - 1 - activeCount);
  const denom = aPlayer + sumRivals + filler || 1;
  const playerShare = aPlayer / denom;
  return {
    demandPerDay: t.baseDemandPerDay * C.marketSizeCompanies * playerShare,
    playerShare,
    rivals: rivals.map(({ a, ...rest }) => ({ ...rest, share: a / denom })),
    otherShare: filler / denom,
  };
}

/** Player's share of open-market units over the last `days` closed days (null without history). */
export function recentMarketShare(state: GameState, days = 7): { player: number; rivals: Record<string, number> } | null {
  const hist = state.market.history.slice(-days);
  let total = 0;
  let player = 0;
  const rivals: Record<string, number> = {};
  for (const d of hist) {
    player += d.player;
    total += d.player;
    for (const [id, n] of Object.entries(d.rivals)) {
      rivals[id] = (rivals[id] ?? 0) + n;
      total += n;
    }
  }
  if (total <= 0) return null;
  for (const id of Object.keys(rivals)) rivals[id] /= total;
  return { player: player / total, rivals };
}

function demandPerDay(state: GameState, model: ModelId, trim: TrimId, price: number, finish: FinishId): number {
  return segmentShares(state, model, trim, { price, finish }).demandPerDay;
}

/** Internal variant used by the engine for a specific vehicle finish. */
export function marketDemandForFinish(
  state: GameState,
  model: ModelId,
  trim: TrimId,
  price: number,
  finish: FinishId,
): number {
  return demandPerDay(state, model, trim, price, finish);
}

export function marketDemandPerDay(state: GameState, model: ModelId, trim: TrimId, price?: number): number {
  const mc = state.product.models[model];
  return demandPerDay(state, model, trim, price ?? mc.price[trim], mc.finish[trim]);
}

/** Estimated vehicles per day at the bottleneck station (ignores staffing, materials and changeovers). */
export function estimatedDailyThroughput(state: GameState, model: ModelId, trim: TrimId): number {
  const finish = state.product.models[model].finish[trim];
  let worst = 0;
  for (const id of STATION_IDS) {
    const per = cycleMinutes(id, model, trim, finish) / state.stations[id].slots.length;
    if (per > worst) worst = per;
  }
  return worst > 0 ? MPD / worst : 0;
}

export function estimateUnitCost(
  state: GameState,
  model: ModelId,
  trim: TrimId,
): { materials: number; byComponent: Partial<Record<ComponentId, number>>; laborOverhead: number; total: number } {
  const finish = state.product.models[model].finish[trim];
  const qty: Partial<Record<ComponentId, number>> = {};
  for (const id of STATION_IDS) {
    const r = recipeFor(model, trim, id, finish);
    for (const c of COMPONENT_IDS) {
      const q = r[c];
      if (q) qty[c] = (qty[c] ?? 0) + q;
    }
  }
  const byComponent: Partial<Record<ComponentId, number>> = {};
  let materials = 0;
  for (const c of COMPONENT_IDS) {
    const q = qty[c];
    if (!q) continue;
    const v = Math.round(q * avgUnitCost(state, c));
    byComponent[c] = v;
    materials += v;
  }
  const throughput = estimatedDailyThroughput(state, model, trim);
  const laborOverhead = throughput > 0 ? Math.round(projectedDailyCosts(state).total / throughput) : 0;
  return { materials, byComponent, laborOverhead, total: materials + laborOverhead };
}

export function estimatedProfitPerVehicle(state: GameState, model: ModelId, trim: TrimId, price?: number): number {
  const p = price ?? state.product.models[model].price[trim];
  return Math.round(p - estimateUnitCost(state, model, trim).total);
}

const PRODUCTION_STAGES: ReadonlySet<VehicleStage> = new Set<VehicleStage>([...STATION_IDS, 'rework']);

export function isInProduction(v: Vehicle): boolean {
  return PRODUCTION_STAGES.has(v.stage);
}

export function inventoryValue(state: GameState): {
  raw: number;
  incoming: number;
  wip: number;
  finished: number;
  total: number;
} {
  let raw = 0;
  for (const c of COMPONENT_IDS) raw += state.inventory[c].value;
  let incoming = 0;
  for (const s of state.shipments) incoming += s.qty * s.unitCost;
  let wip = 0;
  let finished = 0;
  for (const v of Object.values(state.vehicles)) {
    if (isInProduction(v)) wip += v.cost;
    else if (v.stage === 'finished') finished += v.cost;
  }
  raw = Math.round(raw);
  wip = Math.round(wip);
  finished = Math.round(finished);
  return { raw, incoming, wip, finished, total: raw + incoming + wip + finished };
}

export function receivables(state: GameState): number {
  let n = 0;
  for (const o of state.orders) if (o.status === 'delivered') n += o.invoiceAmount ?? 0;
  return n;
}

export function outstandingOrderValue(state: GameState): number {
  let n = 0;
  for (const o of state.orders) if (o.status === 'accepted') n += o.quantity * o.unitPrice;
  return n + receivables(state);
}

export function financeSummary(state: GameState): {
  revenue: number;
  cogs: number;
  grossProfit: number;
  opexTotal: number;
  operatingProfit: number;
  capex: number;
  materialsPurchased: number;
} {
  const f = state.finance;
  let opexTotal = 0;
  for (const k of Object.keys(f.opex) as (keyof typeof f.opex)[]) opexTotal += f.opex[k];
  const grossProfit = f.revenue - f.cogs;
  return {
    revenue: f.revenue,
    cogs: f.cogs,
    grossProfit,
    opexTotal,
    operatingProfit: grossProfit - opexTotal,
    capex: f.capex,
    materialsPurchased: f.materialsPurchased,
  };
}

/** Results over the recent delivered/sold vehicles still kept in state (older ones are pruned). */
export function actualTrimResults(
  state: GameState,
  model: ModelId,
  trim: TrimId,
): { unitsSold: number; avgPrice: number; avgCost: number; avgMargin: number } {
  let n = 0;
  let price = 0;
  let cost = 0;
  for (const v of Object.values(state.vehicles)) {
    if (v.model !== model || v.trim !== trim || (v.stage !== 'delivered' && v.stage !== 'sold')) continue;
    n++;
    price += v.salePrice ?? 0;
    cost += v.cost;
  }
  if (n === 0) return { unitsSold: 0, avgPrice: 0, avgCost: 0, avgMargin: 0 };
  const avgPrice = Math.round(price / n);
  const avgCost = Math.round(cost / n);
  return { unitsSold: n, avgPrice, avgCost, avgMargin: avgPrice - avgCost };
}

// ───────────────────────────── orders ─────────────────────────────

export function orderProgress(
  state: GameState,
  order: SalesOrder,
): {
  reserved: number;
  inProduction: number;
  scheduled: number;
  shortfall: number;
  ready: boolean;
  late: boolean;
  minutesLeft: number;
} {
  const reserved = order.reserved.length;
  let inProduction = 0;
  let scheduled = 0;
  const active = order.status === 'accepted' || order.status === 'offered';
  if (order.status === 'accepted') {
    for (const v of Object.values(state.vehicles)) {
      if (v.plannedForOrderId === order.id && isInProduction(v)) inProduction++;
    }
    for (const j of state.plan) if (j.orderId === order.id) scheduled += Math.max(0, j.quantity - j.started);
  }
  const shortfall = order.status === 'accepted' ? Math.max(0, order.quantity - reserved - inProduction - scheduled) : 0;
  const ready = order.status === 'accepted' && reserved >= order.quantity;
  const late = active ? state.time > order.deadline : order.lateDays > 0;
  return { reserved, inProduction, scheduled, shortfall, ready, late, minutesLeft: order.deadline - state.time };
}

export function ledgerReconciliation(state: GameState): { expected: number; actual: number; ok: boolean } {
  const f = state.finance;
  let sum = 0;
  for (const e of f.ledger) sum += e.amount;
  const expected = f.startingCash + f.ledgerCarriedForward + sum;
  return { expected, actual: state.cash, ok: Math.abs(expected - state.cash) < 0.5 };
}

// ───────────────────────────── upgrades ─────────────────────────────

export function nextUpgradeCost(state: GameState, kind: 'capacity' | 'reliability', station: StationId): number | null {
  const st = state.stations[station];
  const costs = BALANCE.upgrades[kind].costs;
  const level = kind === 'capacity' ? st.capacityLevel : st.reliabilityLevel;
  return level < costs.length ? costs[level] : null;
}

export function nextWarehouseCost(state: GameState): number | null {
  const costs = BALANCE.upgrades.warehouse.costs;
  return state.warehouseLevel < costs.length ? costs[state.warehouseLevel] : null;
}

// ───────────────────────────── vehicles ─────────────────────────────

export function vehiclesInStage(state: GameState, stage: VehicleStage): Vehicle[] {
  if (stage === 'finished') {
    return state.yard.map((id) => state.vehicles[String(id)]).filter((v): v is Vehicle => !!v);
  }
  return Object.values(state.vehicles)
    .filter((v) => v.stage === stage)
    .sort((a, b) => a.id - b.id);
}

// ───────────────────────────── alerts ─────────────────────────────

function canRepair(state: GameState, id: StationId): boolean {
  const st = state.stations[id];
  return st.broken && !st.service && freeTechnicians(state) > 0 && state.cash >= BALANCE.equipment.repair.cost;
}

function canMaintain(state: GameState, id: StationId): boolean {
  const st = state.stations[id];
  return !st.broken && !st.service && freeTechnicians(state) > 0 && state.cash >= BALANCE.equipment.maintenance.cost;
}

function techOrCashActions(state: GameState, cost: number): { label: string; action: AlertAction }[] {
  const out: { label: string; action: AlertAction }[] = [];
  if (freeTechnicians(state) <= 0) {
    if (state.cash >= BALANCE.staff.technician.hireFee) {
      out.push({ label: 'Hire technician', action: { kind: 'command', command: { type: 'hire', role: 'technician', count: 1 } } });
    } else {
      out.push({ label: 'Open Staff', action: { kind: 'openTab', tab: 'staff' } });
    }
  }
  if (state.cash < cost) out.push({ label: 'Open Finances', action: { kind: 'openTab', tab: 'finances' } });
  return out;
}

const SEVERITY_RANK: Record<Alert['severity'], number> = { critical: 0, warning: 1, info: 2 };

export function getAlerts(state: GameState): Alert[] {
  const alerts: Alert[] = [];
  const E = BALANCE.equipment;

  if (state.gameOver) {
    alerts.push({
      id: 'game-over',
      severity: 'critical',
      title: 'Company insolvent — game over',
      cause: state.gameOverReason ?? 'The company ran out of money.',
      actions: [{ label: 'Open Finances', action: { kind: 'openTab', tab: 'finances' } }],
    });
  }

  // Insolvency countdown
  if (state.insolventSince !== null && !state.gameOver) {
    const left = BALANCE.finance.insolvencyGraceMinutes - (state.time - state.insolventSince);
    alerts.push({
      id: 'insolvency',
      severity: 'critical',
      title: `Bankruptcy in ${formatDuration(left)}`,
      cause: `Cash is ${formatMoney(state.cash)}. Get back above $0 (deliver orders, sell cars, cut staff) before the grace period ends.`,
      actions: [
        { label: 'Open Finances', action: { kind: 'openTab', tab: 'finances' } },
        { label: 'Open Orders', action: { kind: 'openTab', tab: 'orders' } },
      ],
    });
  } else if (!state.gameOver) {
    const costs = projectedDailyCosts(state);
    if (state.cash < costs.total) {
      alerts.push({
        id: 'cash-low',
        severity: 'warning',
        title: "Cash won't cover tonight's bills",
        cause: `Midnight payroll, overhead and energy ≈ ${formatMoney(costs.total)} but cash is ${formatMoney(
          state.cash,
        )}. Negative cash starts a ${formatDuration(BALANCE.finance.insolvencyGraceMinutes)} bankruptcy countdown.`,
        actions: [{ label: 'Open Finances', action: { kind: 'openTab', tab: 'finances' } }],
      });
    }
  }

  const yardFull = state.yard.length >= yardCapacity(state);

  for (const id of STATION_IDS) {
    const st = state.stations[id];
    const name = stationName(id);
    if (st.service) {
      alerts.push({
        id: `service-${id}`,
        severity: 'info',
        title: `${name}: ${st.service.kind === 'repair' ? 'repair' : 'maintenance'} in progress`,
        cause: `A technician is working on it — ${formatDuration(st.service.remaining)} left. Production is paused here.`,
        actions: [{ label: 'View station', action: { kind: 'openStation', station: id } }],
      });
      continue;
    }
    if (st.broken) {
      const actions: { label: string; action: AlertAction }[] = [];
      if (canRepair(state, id)) {
        actions.push({ label: `Repair (${formatMoney(E.repair.cost)})`, action: { kind: 'command', command: { type: 'repair', station: id } } });
      } else {
        actions.push(...techOrCashActions(state, E.repair.cost));
      }
      actions.push({ label: 'View station', action: { kind: 'openStation', station: id } });
      alerts.push({
        id: `broken-${id}`,
        severity: 'critical',
        title: `${name} has broken down`,
        cause: `Worn equipment failed (condition ${Math.round(st.condition)}%). Production is stopped until a technician repairs it.`,
        actions,
      });
      continue;
    }
    if (breakdownRisk(state, id) === 'high') {
      const actions: { label: string; action: AlertAction }[] = [];
      if (canMaintain(state, id)) {
        actions.push({
          label: `Schedule maintenance (${formatMoney(E.maintenance.cost)})`,
          action: { kind: 'command', command: { type: 'scheduleMaintenance', station: id } },
        });
      } else {
        actions.push(...techOrCashActions(state, E.maintenance.cost));
      }
      actions.push({ label: 'View station', action: { kind: 'openStation', station: id } });
      alerts.push({
        id: `risk-${id}`,
        severity: 'warning',
        title: `${name}: high breakdown risk`,
        cause: `Condition is ${Math.round(st.condition)}% (~${(breakdownHazardPerHour(state, id) * 100).toFixed(1)}% chance of failure per working hour). Maintenance restores it to 100%.`,
        actions,
      });
    }

    const materials = st.issues.find((i) => i.kind === 'materials');
    if (materials) {
      const comps = materials.components ?? [];
      const incoming = comps.reduce((n, c) => n + incomingOf(state, c), 0);
      alerts.push({
        id: `materials-${id}`,
        severity: 'warning',
        title: `${name} is waiting for parts`,
        cause: materials.text + (incoming > 0 ? ` — ${incoming} unit(s) already on the way.` : ' — nothing on order.'),
        actions: [{ label: 'Buy parts', action: { kind: 'openTab', tab: 'suppliers' } }],
      });
    }

    const sf = staffFactor(state, id);
    if (sf < 1 && stationHasWork(state, id)) {
      const have = stationStaff(state, id);
      const need = stationRequiredStaff(state, id);
      const actions: { label: string; action: AlertAction }[] = [];
      if (id === 'inspection') {
        if (state.cash >= BALANCE.staff.inspector.hireFee) {
          actions.push({
            label: `Hire inspector (${formatMoney(BALANCE.staff.inspector.hireFee)})`,
            action: { kind: 'command', command: { type: 'hire', role: 'inspector', count: 1 } },
          });
        }
      } else if (unassignedOperators(state) > 0) {
        actions.push({ label: 'Assign operator', action: { kind: 'command', command: { type: 'assignOperator', station: id, delta: 1 } } });
      }
      actions.push({ label: 'Open Staff', action: { kind: 'openTab', tab: 'staff' } });
      const role = id === 'inspection' ? 'inspectors' : 'operators';
      alerts.push({
        id: `staff-${id}`,
        severity: sf === 0 ? 'warning' : 'info',
        title: sf === 0 ? `${name} has no ${role}` : `${name} is understaffed`,
        cause:
          sf === 0
            ? `Vehicles are waiting but nobody works here (needs ${need} ${role}).`
            : `${have}/${need} ${role} — running at ${Math.round(sf * 100)}% speed.`,
        actions,
      });
    }

    const downstream = st.issues.find((i) => i.kind === 'downstream');
    if (downstream && !(id === 'inspection' && yardFull)) {
      alerts.push({
        id: `blocked-${id}`,
        severity: 'warning',
        title: `${name} output blocked`,
        cause: `${downstream.text}. Finished work can't move on, so this station stops.`,
        actions: [{ label: 'View station', action: { kind: 'openStation', station: id } }],
      });
    }
  }

  // Rework bay
  const reworkCash = state.rework.issues.find((i) => i.kind === 'cash');
  if (reworkCash) {
    alerts.push({
      id: 'rework-cash',
      severity: 'warning',
      title: 'Rework bay waiting for cash',
      cause: `${reworkCash.text}. Each rework costs ${formatMoney(BALANCE.quality.reworkCost)}.`,
      actions: [{ label: 'Open Finances', action: { kind: 'openTab', tab: 'finances' } }],
    });
  }

  // Yard
  const ycap = yardCapacity(state);
  if (yardFull) {
    alerts.push({
      id: 'yard-full',
      severity: 'warning',
      title: 'Finished-vehicle yard is full',
      cause: `${state.yard.length}/${ycap} spaces used — inspection cannot release cars. Deliver orders, list cars on the market or lower prices.`,
      actions: [
        { label: 'Open Orders', action: { kind: 'openTab', tab: 'orders' } },
        { label: 'Open Vehicles', action: { kind: 'openTab', tab: 'vehicles' } },
      ],
    });
  }

  // Orders
  let offers = 0;
  for (const o of state.orders) {
    if (o.status === 'offered') {
      offers++;
      continue;
    }
    if (o.status !== 'accepted') continue;
    const p = orderProgress(state, o);
    const label = `Order #${o.id} (${o.dealer})`;
    if (p.ready) {
      alerts.push({
        id: `ready-${o.id}`,
        severity: p.late ? 'warning' : 'info',
        title: `${label} ready to deliver`,
        cause: `All ${o.quantity} ${vehicleLabel(state, o.model, o.trim)} cars are in the yard${p.late ? ' — it is already late, deliver now' : ''}.`,
        actions: [{ label: 'Deliver', action: { kind: 'command', command: { type: 'deliverOrder', orderId: o.id } } }],
      });
      continue;
    }
    if (p.shortfall > 0) {
      alerts.push({
        id: `shortfall-${o.id}`,
        severity: p.late ? 'critical' : 'warning',
        title: p.late ? `${label} is late and under-scheduled` : `${label} needs ${p.shortfall} more car(s) scheduled`,
        cause: `${p.reserved} ready, ${p.inProduction} in production, ${p.scheduled} scheduled of ${o.quantity}. ${
          p.late ? `Deadline passed ${formatDuration(-p.minutesLeft)} ago.` : `Due in ${formatDuration(p.minutesLeft)}.`
        }`,
        actions: [
          { label: `Schedule ${p.shortfall} build(s)`, action: { kind: 'command', command: { type: 'scheduleForOrder', orderId: o.id } } },
          { label: 'Open Orders', action: { kind: 'openTab', tab: 'orders' } },
        ],
      });
      continue;
    }
    if (p.late) {
      const cancelIn = o.deadline + o.cancelAfterLateMinutes - state.time;
      alerts.push({
        id: `late-${o.id}`,
        severity: 'critical',
        title: `${label} is late`,
        cause: `${p.reserved}/${o.quantity} cars ready. The dealer cancels in ${formatDuration(cancelIn)} (fee ${formatMoney(o.cancelFee)}).`,
        actions: [{ label: 'Open Orders', action: { kind: 'openTab', tab: 'orders' } }],
      });
    }
  }
  if (offers > 0) {
    alerts.push({
      id: 'offers',
      severity: 'info',
      title: offers === 1 ? '1 new order offer' : `${offers} new order offers`,
      cause: 'Dealers are waiting for an answer. Offers expire if you ignore them.',
      actions: [{ label: 'Open Orders', action: { kind: 'openTab', tab: 'orders' } }],
    });
  }

  // Nothing scheduled
  const stamping = state.stations.stamping;
  const hasPlan = state.plan.some((j) => j.started < j.quantity);
  if (!hasPlan && stamping.slots.every((s) => s === null) && !state.gameOver) {
    const model = unlockedModels(state)[0] ?? 'sedan';
    alerts.push({
      id: 'idle',
      severity: 'info',
      title: 'No production scheduled',
      cause: 'Stamping is idle because the production plan is empty. Schedule builds for orders or for the market.',
      actions: [
        { label: 'Open Orders', action: { kind: 'openTab', tab: 'orders' } },
        {
          label: `Build 1 ${vehicleLabel(state, model, 'economy')}`,
          action: { kind: 'command', command: { type: 'scheduleBuild', model, trim: 'economy', quantity: 1 } },
        },
      ],
    });
  }

  // Rivals out-selling the player's stock
  for (const m of MODEL_IDS) {
    const mc = state.product.models[m];
    if (!mc.unlocked) continue;
    for (const t of ['economy', 'premium'] as TrimId[]) {
      if (!mc.marketListed[t]) continue;
      const stock = state.yard.filter((id) => {
        const v = state.vehicles[String(id)];
        return v && v.orderId === null && v.model === m && v.trim === t;
      }).length;
      if (stock < 2) continue;
      const seg = segmentShares(state, m, t);
      // Alert when the unreserved stock would take more than 3 days to clear at today's demand.
      const daysToClear = seg.demandPerDay > 0 ? stock / seg.demandPerDay : Infinity;
      if (daysToClear <= 3) continue;
      const cheaper = seg.rivals.filter((r) => r.active && r.price < mc.price[t]).sort((a, b) => a.price - b.price);
      const target = cheaper[0];
      const actions: { label: string; action: AlertAction }[] = [{ label: 'Open Market', action: { kind: 'openTab', tab: 'market' } }];
      if (target) {
        const base = trimSpec(m, t).baseValue;
        const price = Math.min(base * 3, Math.max(Math.round(base * 0.3), Math.round(target.price / 100) * 100));
        actions.unshift({
          label: `Match ${target.name} (${formatMoney(price)})`,
          action: { kind: 'command', command: { type: 'setPrice', model: m, trim: t, price } },
        });
      }
      alerts.push({
        id: `losing-${m}-${t}`,
        severity: 'warning',
        title: `${vehicleLabel(state, m, t)} isn't selling`,
        cause: `${stock} unreserved in the yard, ~${seg.demandPerDay.toFixed(1)} buyers/day at ${formatMoney(mc.price[t])} (${Math.round(
          seg.playerShare * 100,
        )}% share) — about ${Number.isFinite(daysToClear) ? Math.round(daysToClear) : '∞'} days to sell${
          target ? `. ${target.name} sells at ${formatMoney(target.price)}` : ''
        }.`,
        actions,
      });
    }
  }

  // New model tooling within reach (only once the first order is paid, so it doesn't distract the tutorial).
  if (state.stats.ordersPaid > 0 && !state.gameOver) {
    for (const m of MODEL_IDS) {
      if (state.product.models[m].unlocked || unlockBlocker(state, m) !== null) continue;
      const spec = BALANCE.models[m];
      // Only nudge when the tooling leaves a healthy cash buffer.
      if (state.cash < spec.unlockCost * 1.5) continue;
      alerts.push({
        id: `unlock-${m}`,
        severity: 'info',
        title: `${spec.className} tooling available`,
        cause: `You can afford to tool up for the ${modelName(state, m)} ${spec.className} (${formatMoney(
          spec.unlockCost,
        )}). New models bring new dealer orders and market demand.`,
        actions: [{ label: 'Open Vehicles', action: { kind: 'openTab', tab: 'vehicles' } }],
      });
    }
  }

  // Warehouse
  const wcap = warehouseCapacity(state);
  const used = stockOnHand(state) + incomingUnits(state);
  if (used >= wcap * 0.9) {
    alerts.push({
      id: 'warehouse',
      severity: 'info',
      title: 'Warehouse nearly full',
      cause: `${used}/${wcap} component spaces used (including deliveries on the way). New purchases need free space.`,
      actions: [
        { label: 'Open Suppliers', action: { kind: 'openTab', tab: 'suppliers' } },
        { label: 'Open Upgrades', action: { kind: 'openTab', tab: 'upgrades' } },
      ],
    });
  }

  alerts.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return alerts;
}

// ───────────────────────────── tutorial ─────────────────────────────

export function tutorialSteps(state: GameState): TutorialStep[] {
  const s = state.stats;
  const offered = state.orders.find((o) => o.status === 'offered');
  const shortOrder = state.orders.find((o) => o.status === 'accepted' && orderProgress(state, o).shortfall > 0);
  const readyOrder = state.orders.find((o) => o.status === 'accepted' && o.reserved.length >= o.quantity);
  const unassigned = unassignedOperators(state);
  const paint = state.stations.paint.assigned;
  const final = state.stations.final.assigned;
  const scheduledForOrder = s.vehiclesStarted > 0 || state.plan.some((j) => j.orderId !== null);

  let staffAction: TutorialStep['action'] = { label: 'Open Staff', action: { kind: 'openTab', tab: 'staff' } };
  if (unassigned > 0 && paint === 0) {
    staffAction = { label: 'Assign to Paint', action: { kind: 'command', command: { type: 'assignOperator', station: 'paint', delta: 1 } } };
  } else if (unassigned > 0 && final < BALANCE.stations.final.staffPerSlot) {
    staffAction = { label: 'Assign to Final', action: { kind: 'command', command: { type: 'assignOperator', station: 'final', delta: 1 } } };
  }

  const steps: TutorialStep[] = [
    {
      id: 'accept-order',
      title: 'Accept your first order',
      text: 'Open the Orders tab and accept the dealer order. Accepted orders have a deadline — late deliveries lose money and reputation.',
      done: s.ordersAccepted > 0,
      action: offered
        ? { label: `Accept order #${offered.id}`, action: { kind: 'command', command: { type: 'acceptOrder', orderId: offered.id } } }
        : { label: 'Open Orders', action: { kind: 'openTab', tab: 'orders' } },
    },
    {
      id: 'buy-components',
      title: 'Buy components',
      text: 'Each Economy car needs 2 steel, 1 paint, a powertrain, an interior and a wheel set. Buy what is missing from a supplier — deliveries take a few hours.',
      done: s.purchases > 0,
      action: { label: 'Open Suppliers', action: { kind: 'openTab', tab: 'suppliers' } },
    },
    {
      id: 'staff-stations',
      title: 'Staff Paint & Final Assembly',
      text: 'Paint and Final Assembly have no operators. Hire operators and assign them so cars can flow through the whole line.',
      done: paint > 0 && final > 0,
      action: staffAction,
    },
    {
      id: 'schedule',
      title: 'Schedule production for the order',
      text: 'Add a production job for the order so Stamping starts building the cars.',
      done: scheduledForOrder,
      action: shortOrder
        ? { label: 'Schedule builds', action: { kind: 'command', command: { type: 'scheduleForOrder', orderId: shortOrder.id } } }
        : { label: 'Open Orders', action: { kind: 'openTab', tab: 'orders' } },
    },
    {
      id: 'build',
      title: 'Build & inspect cars',
      text: 'Cars move Stamping → Body → Paint → Final → Inspection. Inspection catches defects and sends them to the rework bay. Watch for bottlenecks.',
      done: s.vehiclesBuilt > 0,
      action: { label: 'View Inspection', action: { kind: 'openStation', station: 'inspection' } },
    },
    {
      id: 'deliver',
      title: 'Deliver the order',
      text: 'When every car for the order is in the yard, deliver it before the deadline.',
      done: s.ordersDelivered > 0,
      action: readyOrder
        ? { label: 'Deliver now', action: { kind: 'command', command: { type: 'deliverOrder', orderId: readyOrder.id } } }
        : { label: 'Open Orders', action: { kind: 'openTab', tab: 'orders' } },
    },
    {
      id: 'collect',
      title: 'Collect payment',
      text: 'The dealer pays when the payment terms run out. Track cash, receivables and profit in Finances.',
      done: s.ordersPaid > 0,
      action: { label: 'Open Finances', action: { kind: 'openTab', tab: 'finances' } },
    },
  ];
  return steps;
}
