/**
 * Read-only helpers used by the UI and renderer. All functions are pure (never mutate state).
 */
import { BALANCE, COMPONENT_IDS, MODEL_IDS, STATION_IDS } from '../config/balance';
import type { ComponentId as CId, ResearchEffect, ScenarioSpec, StaffRole, TrimSpec } from '../config/balance';
import type { Command } from './commandTypes';
import type {
  ComponentId,
  FinishId,
  GameState,
  Incident,
  ModelId,
  PlantState,
  RivalState,
  SalesOrder,
  StationId,
  StationState,
  TrimId,
  Vehicle,
  VehicleStage,
} from './types';

export type PanelTab = 'orders' | 'vehicles' | 'market' | 'suppliers' | 'staff' | 'finances' | 'research' | 'upgrades' | 'goals';
export type StationStatus = 'running' | 'idle' | 'blocked' | 'understaffed' | 'broken' | 'repair' | 'maintenance';
export type AlertAction =
  | { kind: 'openTab'; tab: PanelTab }
  | { kind: 'openStation'; station: StationId; plant?: number }
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

// ───────────────────────────── research ─────────────────────────────

export interface ResearchEffects {
  cycleMult: Record<StationId, number>;
  changeoverMult: number;
  wearMult: number;
  componentDefectMult: number;
  baseDefectMult: number;
  detectionAdd: number;
  appealAdd: number;
  premiumAppealAdd: number;
  steelSaved: number;
  offerChanceMult: number;
}

/** Combined effects of a list of completed projects (multipliers multiply, additions add). */
export function combineEffects(ids: readonly string[]): ResearchEffects {
  const out: ResearchEffects = {
    cycleMult: { stamping: 1, body: 1, paint: 1, final: 1, inspection: 1 },
    changeoverMult: 1,
    wearMult: 1,
    componentDefectMult: 1,
    baseDefectMult: 1,
    detectionAdd: 0,
    appealAdd: 0,
    premiumAppealAdd: 0,
    steelSaved: 0,
    offerChanceMult: 1,
  };
  for (const id of ids) {
    const e: ResearchEffect | undefined = BALANCE.research.projects[id]?.effect;
    if (!e) continue;
    for (const [st, m] of Object.entries(e.cycleMult ?? {})) out.cycleMult[st as StationId] *= m ?? 1;
    out.changeoverMult *= e.changeoverMult ?? 1;
    out.wearMult *= e.wearMult ?? 1;
    out.componentDefectMult *= e.componentDefectMult ?? 1;
    out.baseDefectMult *= e.baseDefectMult ?? 1;
    out.detectionAdd += e.detectionAdd ?? 0;
    out.appealAdd += e.appealAdd ?? 0;
    out.premiumAppealAdd += e.premiumAppealAdd ?? 0;
    out.steelSaved += e.steelSaved ?? 0;
    out.offerChanceMult *= e.offerChanceMult ?? 1;
  }
  return out;
}

/** Effects of everything the player has researched. */
export function researchEffects(state: GameState | undefined): ResearchEffects {
  return combineEffects(state?.research?.completed ?? []);
}

/** Appeal bonus research gives a trim. */
export function researchAppeal(state: GameState, trim: TrimId): number {
  const e = researchEffects(state);
  return e.appealAdd + (trim === 'premium' ? e.premiumAppealAdd : 0);
}

export type ResearchStatus = 'done' | 'active' | 'available' | 'locked';

export function researchStatus(state: GameState, id: string): ResearchStatus {
  const r = state.research;
  if (r.completed.includes(id)) return 'done';
  if (r.active?.id === id) return 'active';
  const p = BALANCE.research.projects[id];
  return p && p.requires.every((x) => r.completed.includes(x)) ? 'available' : 'locked';
}

/** Why a project can't be started right now, or null. */
export function researchBlocker(state: GameState, id: string): string | null {
  const p = BALANCE.research.projects[id];
  if (!p) return 'Unknown project.';
  const st = researchStatus(state, id);
  if (st === 'done') return 'Already researched.';
  if (st === 'active') return 'Already in progress.';
  if (st === 'locked') {
    const missing = p.requires.filter((x) => !state.research.completed.includes(x)).map((x) => BALANCE.research.projects[x]?.name ?? x);
    return `Research ${missing.join(' and ')} first.`;
  }
  if (state.research.active) return `The lab is busy with ${BALANCE.research.projects[state.research.active.id]?.name}.`;
  if (state.cash < p.cost) return `Needs ${formatMoney(p.cost)} cash (you have ${formatMoney(state.cash)}).`;
  return null;
}

/** Plain-language list of a project's effects. */
export function describeEffect(e: ResearchEffect): string[] {
  const out: string[] = [];
  const pctFaster = (m: number) => `${Math.round((1 - m) * 100)}%`;
  for (const [st, m] of Object.entries(e.cycleMult ?? {})) {
    if (m !== undefined) out.push(`${BALANCE.stations[st as StationId].name} ${pctFaster(m)} faster`);
  }
  if (e.changeoverMult !== undefined) out.push(`Retooling between models ${pctFaster(e.changeoverMult)} shorter`);
  if (e.wearMult !== undefined) out.push(`Equipment wears ${pctFaster(e.wearMult)} slower`);
  if (e.componentDefectMult !== undefined) out.push(`Defects from part quality −${Math.round((1 - e.componentDefectMult) * 100)}%`);
  if (e.baseDefectMult !== undefined) out.push(`Base defect rate −${Math.round((1 - e.baseDefectMult) * 100)}%`);
  if (e.detectionAdd !== undefined) out.push(`Inspection catches +${Math.round(e.detectionAdd * 100)} points more defects`);
  if (e.appealAdd !== undefined) out.push(`+${e.appealAdd} appeal on every model and trim`);
  if (e.premiumAppealAdd !== undefined) out.push(`+${e.premiumAppealAdd} appeal on Premium trims`);
  if (e.steelSaved !== undefined) out.push(`${e.steelSaved} steel coil less per vehicle`);
  if (e.offerChanceMult !== undefined) out.push(`${Math.round((e.offerChanceMult - 1) * 100)}% more dealer offers`);
  return out;
}

// ───────────────────────────── plants ─────────────────────────────

/** Plant by index (default: the starting plant). */
export function plantOf(state: GameState, plant = 0): PlantState {
  return state.plants[plant] ?? state.plants[0];
}

export function stationOf(state: GameState, id: StationId, plant = 0): StationState {
  return plantOf(state, plant).stations[id];
}

export function plantOperating(state: GameState, plant = 0): boolean {
  return plantOf(state, plant).constructionRemaining <= 0;
}

/** Indices of plants that are built and running. */
export function operatingPlants(state: GameState): number[] {
  return state.plants.filter((p) => p.constructionRemaining <= 0).map((p) => p.id);
}

/** "Riverside" with one plant; "Riverside · Paint" style labels need the plant only when there are several. */
export function plantPrefix(state: GameState, plant: number): string {
  return state.plants.length > 1 ? `${plantOf(state, plant).name} ` : '';
}

/** Next site that can be bought, or null when all are built. */
export function nextPlantSite(state: GameState): { index: number; name: string; cost: number; minReputation: number } | null {
  const i = state.plants.length;
  const site = BALANCE.plants.sites[i];
  return site ? { index: i, ...site } : null;
}

export function buildPlantBlocker(state: GameState): string | null {
  const site = nextPlantSite(state);
  if (!site) return 'Every plant site is already built.';
  if (state.plants.some((p) => p.constructionRemaining > 0)) return 'A plant is already under construction.';
  if (state.reputation < site.minReputation) {
    return `Needs reputation ${site.minReputation} (you have ${Math.floor(state.reputation)}).`;
  }
  if (state.cash < site.cost) return `Needs ${formatMoney(site.cost)} cash (you have ${formatMoney(state.cash)}).`;
  return null;
}

// ───────────────────────────── stations ─────────────────────────────

export function stationStaff(state: GameState, id: StationId, plant = 0): number {
  return stationOf(state, id, plant).assigned;
}

export function stationRequiredStaff(state: GameState, id: StationId, plant = 0): number {
  return BALANCE.stations[id].staffPerSlot * stationOf(state, id, plant).slots.length;
}

export function staffFactor(state: GameState, id: StationId, plant = 0): number {
  if (plantOnStrike(state, plant)) return 0;
  const req = stationRequiredStaff(state, id, plant);
  if (req <= 0) return 0;
  return Math.max(0, Math.min(1, stationStaff(state, id, plant) / req));
}

/** True if the station has any vehicle in a slot or queue (or, for stamping, work it is allowed to start). */
export function stationHasWork(state: GameState, id: StationId, plant = 0): boolean {
  const st = stationOf(state, id, plant);
  if (st.slots.some((s) => s !== null) || st.queue.length > 0) return true;
  if (id === 'stamping') {
    const allowed = plantOf(state, plant).allowedModels;
    return plantOperating(state, plant) && state.plan.some((j) => j.started < j.quantity && allowed.includes(j.model));
  }
  return false;
}

export function stationStatus(state: GameState, id: StationId, plant = 0): StationStatus {
  const st = stationOf(state, id, plant);
  if (st.service) return st.service.kind === 'repair' ? 'repair' : 'maintenance';
  if (st.broken) return 'broken';
  if (st.issues.some((i) => i.kind === 'downstream' || i.kind === 'materials' || i.kind === 'cash')) return 'blocked';
  const sf = staffFactor(state, id, plant);
  if (sf < 1 && (sf === 0 || st.issues.some((i) => i.kind === 'staff') || stationHasWork(state, id, plant))) {
    return 'understaffed';
  }
  if (st.slots.some((s) => s !== null && !s.done)) return 'running';
  return 'idle';
}

export function queueCapacity(state: GameState, id: StationId, plant = 0): number {
  if (id === 'stamping') return 0;
  return BALANCE.queue.baseCapacity + BALANCE.queue.perCapacityLevel * stationOf(state, id, plant).capacityLevel;
}

/** Work minutes for one vehicle at a station, excluding any model changeover. Pass `state` to apply research. */
export function cycleMinutes(id: StationId, model: ModelId, trim: TrimId, finish: FinishId, state?: GameState): number {
  const base = BALANCE.stations[id].baseMinutes * BALANCE.trims[trim].timeMult * BALANCE.models[model].timeMult;
  const paint = id === 'paint' ? BALANCE.finishes[finish].paintMinutesAdd : 0;
  return Math.max(1, Math.round((base + paint) * researchEffects(state).cycleMult[id]));
}

/** Retooling minutes the station would add before starting a vehicle of `model` now. */
export function changeoverMinutes(state: GameState, id: StationId, model: ModelId, plant = 0): number {
  const last = stationOf(state, id, plant).lastModel;
  return last !== null && last !== model ? Math.round(BALANCE.changeover.minutes[id] * researchEffects(state).changeoverMult) : 0;
}

/**
 * Components consumed by `station` for one vehicle (paint station quantities × finish.paintMult).
 * Pass `state` to apply research (e.g. steel saved at stamping).
 */
export function recipeFor(
  model: ModelId,
  trim: TrimId,
  station: StationId,
  finish: FinishId,
  state?: GameState,
): Partial<Record<ComponentId, number>> {
  const r = trimSpec(model, trim).recipe[station];
  const out: Partial<Record<ComponentId, number>> = {};
  if (!r) return out;
  const mult = station === 'paint' ? BALANCE.finishes[finish].paintMult : 1;
  for (const c of COMPONENT_IDS) {
    const q = r[c];
    if (q && q > 0) out[c] = q * mult;
  }
  const saved = researchEffects(state).steelSaved;
  if (saved > 0 && out.steel) out.steel = Math.max(1, out.steel - saved);
  return out;
}

/** Breakdown probability per active minute at the station's current condition. */
export function hazardPerActiveMinute(state: GameState, id: StationId, plant = 0): number {
  const st = stationOf(state, id, plant);
  const E = BALANCE.equipment;
  if (st.condition <= 0) return 1;
  if (st.condition >= E.hazardThreshold) return 0;
  const x = (E.hazardThreshold - st.condition) / E.hazardThreshold;
  return E.hazardScale * x * x * Math.pow(E.reliabilityHazardMult, st.reliabilityLevel);
}

export function breakdownHazardPerHour(state: GameState, id: StationId, plant = 0): number {
  const p = hazardPerActiveMinute(state, id, plant);
  if (p >= 1) return 1;
  return 1 - Math.pow(1 - p, 60);
}

export function breakdownRisk(state: GameState, id: StationId, plant = 0): 'low' | 'elevated' | 'high' {
  const c = stationOf(state, id, plant).condition;
  if (c < BALANCE.equipment.dangerCondition) return 'high';
  if (c < BALANCE.equipment.warnCondition) return 'elevated';
  return 'low';
}

/** Probability that a plant's inspection catches a defect (0 when it has no inspectors). */
export function detectionRate(state: GameState, plant = 0): number {
  const n = stationOf(state, 'inspection', plant).assigned;
  if (n <= 0) return 0;
  const Q = BALANCE.quality;
  const trained = (state.workforce?.training.inspector ?? 0) * BALANCE.workforce.training.inspectorDetectionPerLevel;
  return Math.min(Q.detectionMax, Q.detectionBase + Q.detectionPerInspector * (n - 1) + researchEffects(state).detectionAdd + trained);
}

// ───────────────────────────── staff ─────────────────────────────

export function assignedOperators(state: GameState): number {
  let n = 0;
  for (const p of state.plants) for (const id of STATION_IDS) if (id !== 'inspection') n += p.stations[id].assigned;
  return n;
}

export function unassignedOperators(state: GameState): number {
  return Math.max(0, state.staff.operator - assignedOperators(state));
}

export function assignedInspectors(state: GameState): number {
  return state.plants.reduce((n, p) => n + p.stations.inspection.assigned, 0);
}

export function unassignedInspectors(state: GameState): number {
  return Math.max(0, state.staff.inspector - assignedInspectors(state));
}

/** Free workers of the role a station uses. */
export function unassignedFor(state: GameState, id: StationId): number {
  return id === 'inspection' ? unassignedInspectors(state) : unassignedOperators(state);
}

export function busyTechnicians(state: GameState): number {
  let n = 0;
  for (const p of state.plants) n += STATION_IDS.filter((id) => p.stations[id].service !== null).length;
  return n;
}

export function freeTechnicians(state: GameState): number {
  return Math.max(0, state.staff.technician - busyTechnicians(state));
}

// ───────────────────────────── warehouse ─────────────────────────────

/** Operating plants beyond the first (each brings its own storage). */
function extraPlants(state: GameState): number {
  return Math.max(0, state.plants.filter((p) => p.constructionRemaining <= 0).length - 1);
}

export function warehouseCapacity(state: GameState): number {
  return (
    BALANCE.start.warehouseCapacity +
    state.warehouseLevel * BALANCE.upgrades.warehouse.componentAdd +
    extraPlants(state) * BALANCE.plants.componentAddPerPlant
  );
}

export function yardCapacity(state: GameState): number {
  return (
    BALANCE.start.yardCapacity + state.warehouseLevel * BALANCE.upgrades.warehouse.yardAdd + extraPlants(state) * BALANCE.plants.yardAddPerPlant
  );
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

/**
 * Components still needed to build `cars` vehicles of a model/trim at the current finish, after counting
 * what is on hand and on the way. Only positive shortfalls are listed.
 */
export function kitShortfall(state: GameState, model: ModelId, trim: TrimId, cars: number): Partial<Record<ComponentId, number>> {
  const finish = state.product.models[model].finish[trim];
  const out: Partial<Record<ComponentId, number>> = {};
  for (const c of COMPONENT_IDS) {
    let need = 0;
    for (const st of STATION_IDS) need += (recipeFor(model, trim, st, finish, state)[c] ?? 0) * cars;
    const short = need - state.inventory[c].qty - incomingOf(state, c);
    if (short > 0) out[c] = short;
  }
  return out;
}

/** Cost of a kit shortfall at a supplier. */
export function kitCost(supplierId: string, kit: Partial<Record<ComponentId, number>>, state?: GameState): number {
  let total = 0;
  for (const c of COMPONENT_IDS) total += (supplierUnitPrice(supplierId, c, state) ?? 0) * (kit[c] ?? 0);
  return total;
}

function referenceSupplier() {
  return BALANCE.suppliers.find((s) => s.id === 'corvan') ?? BALANCE.suppliers[0];
}

/** Price per unit at a supplier today (pass `state` to include price spikes). */
export function supplierUnitPrice(supplierId: string, c: ComponentId, state?: GameState): number | null {
  const sup = BALANCE.suppliers.find((s) => s.id === supplierId);
  if (!sup) return null;
  return Math.round(BALANCE.components[c].basePrice * sup.priceMult * (state ? componentPriceMult(state, c) : 1));
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
  const mult = BALANCE.workforce.wages[state.workforce?.wage ?? 'standard'].payMult;
  return Math.round(
    (state.staff.operator * S.operator.dailyWage +
      state.staff.inspector * S.inspector.dailyWage +
      state.staff.technician * S.technician.dailyWage) *
      mult,
  );
}

/** Energy accrued so far today plus the current active slots running until midnight. */
export function projectedDailyCosts(state: GameState): { payroll: number; overhead: number; energy: number; total: number } {
  const payroll = dailyPayroll(state);
  const overhead = BALANCE.overhead.dailyBase * operatingPlants(state).length;
  const minutesLeft = MPD - (((state.time % MPD) + MPD) % MPD);
  let energy = 0;
  for (const p of state.plants) {
    for (const id of STATION_IDS) {
      const st = p.stations[id];
      energy += st.energyAccrued;
      if (st.broken || st.service) continue;
      const sf = staffFactor(state, id, p.id);
      if (sf <= 0) continue;
      const active = st.slots.filter((s) => s !== null && !s.done).length;
      energy += (active * BALANCE.stations[id].energyPerActiveHour * minutesLeft) / 60;
    }
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
    ? attractiveness(t.appeal + BALANCE.finishes[finish].appealAdd + researchAppeal(state, trim), state.reputation, price / segmentReference(model, trim, finish))
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
    demandPerDay: t.baseDemandPerDay * C.marketSizeCompanies * playerShare * incidentDemandMult(state),
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

/** Estimated vehicles per day across operating plants, from each plant's bottleneck station (ignores staffing, materials and changeovers). */
export function estimatedDailyThroughput(state: GameState, model: ModelId, trim: TrimId): number {
  const finish = state.product.models[model].finish[trim];
  let total = 0;
  for (const plant of operatingPlants(state)) {
    let worst = 0;
    for (const id of STATION_IDS) {
      const per = cycleMinutes(id, model, trim, finish, state) / stationOf(state, id, plant).slots.length / workSpeed(state, id);
      if (per > worst) worst = per;
    }
    if (worst > 0) total += MPD / worst;
  }
  return total;
}

export function estimateUnitCost(
  state: GameState,
  model: ModelId,
  trim: TrimId,
): { materials: number; byComponent: Partial<Record<ComponentId, number>>; laborOverhead: number; total: number } {
  const finish = state.product.models[model].finish[trim];
  const qty: Partial<Record<ComponentId, number>> = {};
  for (const id of STATION_IDS) {
    const r = recipeFor(model, trim, id, finish, state);
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

export function nextUpgradeCost(
  state: GameState,
  kind: 'capacity' | 'reliability',
  station: StationId,
  plant = 0,
): number | null {
  const st = stationOf(state, station, plant);
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

function canRepair(state: GameState, id: StationId, plant: number): boolean {
  const st = stationOf(state, id, plant);
  return st.broken && !st.service && freeTechnicians(state) > 0 && state.cash >= BALANCE.equipment.repair.cost;
}

function canMaintain(state: GameState, id: StationId, plant: number): boolean {
  const st = stationOf(state, id, plant);
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
  /** Stations short of parts; reported as one alert so several plants don't flood the bar. */
  const partsWaits: { id: string; name: string; text: string; components: ComponentId[] }[] = [];

  for (const plant of state.plants) {
  if (plant.constructionRemaining > 0) continue;
  const pi = plant.id;
  const sfx = pi === 0 ? '' : `-p${pi}`;
  const at = plantPrefix(state, pi);
  for (const id of STATION_IDS) {
    const st = plant.stations[id];
    const name = `${at}${stationName(id)}`;
    if (st.service) {
      alerts.push({
        id: `service-${id}${sfx}`,
        severity: 'info',
        title: `${name}: ${st.service.kind === 'repair' ? 'repair' : 'maintenance'} in progress`,
        cause: `A technician is working on it — ${formatDuration(st.service.remaining)} left. Production is paused here.`,
        actions: [{ label: 'View station', action: { kind: 'openStation', station: id, plant: pi } }],
      });
      continue;
    }
    if (st.broken) {
      const actions: { label: string; action: AlertAction }[] = [];
      if (canRepair(state, id, pi)) {
        actions.push({ label: `Repair (${formatMoney(E.repair.cost)})`, action: { kind: 'command', command: { type: 'repair', station: id, plant: pi } } });
      } else {
        actions.push(...techOrCashActions(state, E.repair.cost));
      }
      actions.push({ label: 'View station', action: { kind: 'openStation', station: id, plant: pi } });
      alerts.push({
        id: `broken-${id}${sfx}`,
        severity: 'critical',
        title: `${name} has broken down`,
        cause: `Worn equipment failed (condition ${Math.round(st.condition)}%). Production is stopped until a technician repairs it.`,
        actions,
      });
      continue;
    }
    if (breakdownRisk(state, id, pi) === 'high') {
      const actions: { label: string; action: AlertAction }[] = [];
      if (canMaintain(state, id, pi)) {
        actions.push({
          label: `Schedule maintenance (${formatMoney(E.maintenance.cost)})`,
          action: { kind: 'command', command: { type: 'scheduleMaintenance', station: id, plant: pi } },
        });
      } else {
        actions.push(...techOrCashActions(state, E.maintenance.cost));
      }
      actions.push({ label: 'View station', action: { kind: 'openStation', station: id, plant: pi } });
      alerts.push({
        id: `risk-${id}${sfx}`,
        severity: 'warning',
        title: `${name}: high breakdown risk`,
        cause: `Condition is ${Math.round(st.condition)}% (~${(breakdownHazardPerHour(state, id, pi) * 100).toFixed(1)}% chance of failure per working hour). Maintenance restores it to 100%.`,
        actions,
      });
    }

    const materials = st.issues.find((i) => i.kind === 'materials');
    if (materials) partsWaits.push({ id: `materials-${id}${sfx}`, name, text: materials.text, components: materials.components ?? [] });

    const sf = staffFactor(state, id, pi);
    if (sf < 1 && stationHasWork(state, id, pi)) {
      const have = stationStaff(state, id, pi);
      const need = stationRequiredStaff(state, id, pi);
      const actions: { label: string; action: AlertAction }[] = [];
      if (unassignedFor(state, id) > 0) {
        actions.push({
          label: id === 'inspection' ? 'Assign inspector' : 'Assign operator',
          action: { kind: 'command', command: { type: 'assignOperator', station: id, delta: 1, plant: pi } },
        });
      } else if (id === 'inspection') {
        if (state.cash >= BALANCE.staff.inspector.hireFee) {
          actions.push({
            label: `Hire inspector (${formatMoney(BALANCE.staff.inspector.hireFee)})`,
            action: { kind: 'command', command: { type: 'hire', role: 'inspector', count: 1 } },
          });
        }
      }
      actions.push({ label: 'Open Staff', action: { kind: 'openTab', tab: 'staff' } });
      const role = id === 'inspection' ? 'inspectors' : 'operators';
      alerts.push({
        id: `staff-${id}${sfx}`,
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
        id: `blocked-${id}${sfx}`,
        severity: 'warning',
        title: `${name} output blocked`,
        cause: `${downstream.text}. Finished work can't move on, so this station stops.`,
        actions: [{ label: 'View station', action: { kind: 'openStation', station: id, plant: pi } }],
      });
    }
  }

  // Rework bay
  const reworkCash = plant.rework.issues.find((i) => i.kind === 'cash');
  if (reworkCash) {
    alerts.push({
      id: `rework-cash${sfx}`,
      severity: 'warning',
      title: `${at}rework bay waiting for cash`,
      cause: `${reworkCash.text}. Each rework costs ${formatMoney(BALANCE.quality.reworkCost)}.`,
      actions: [{ label: 'Open Finances', action: { kind: 'openTab', tab: 'finances' } }],
    });
  }
  }

  // Parts shortages
  if (partsWaits.length > 0) {
    const comps = [...new Set(partsWaits.flatMap((w) => w.components))];
    const incoming = comps.reduce((n, c) => n + incomingOf(state, c), 0);
    const onTheWay = incoming > 0 ? ` — ${incoming} unit(s) already on the way.` : ' — nothing on order.';
    const one = partsWaits[0];
    alerts.push(
      partsWaits.length === 1
        ? {
            id: one.id,
            severity: 'warning',
            title: `${one.name} is waiting for parts`,
            cause: one.text + onTheWay,
            actions: [{ label: 'Buy parts', action: { kind: 'openTab', tab: 'suppliers' } }],
          }
        : {
            id: 'materials',
            severity: 'warning',
            title: `${partsWaits.length} stations are waiting for parts`,
            cause: `Short of ${comps.map((c) => componentName(c)).join(', ')} at ${partsWaits.map((w) => w.name).join(', ')}${onTheWay}`,
            actions: [{ label: 'Buy parts', action: { kind: 'openTab', tab: 'suppliers' } }],
          },
    );
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

  // Plan jobs no operating plant is allowed to start
  const blockedModels = new Set(
    state.plan
      .filter((j) => j.started < j.quantity && !operatingPlants(state).some((pi) => plantOf(state, pi).allowedModels.includes(j.model)))
      .map((j) => j.model),
  );
  for (const m of blockedModels) {
    alerts.push({
      id: `plan-blocked-${m}`,
      severity: 'warning',
      title: `No plant may build the ${modelName(state, m)}`,
      cause: `${modelName(state, m)} jobs are waiting in the plan, but every operating plant has that model switched off.`,
      actions: [{ label: 'Allow at Plant 1', action: { kind: 'command', command: { type: 'setPlantModel', plant: 0, model: m, allowed: true } } }],
    });
  }

  // Nothing scheduled
  const hasPlan = state.plan.some((j) => j.started < j.quantity);
  const stampingIdle = operatingPlants(state).every((pi) => stationOf(state, 'stamping', pi).slots.every((x) => x === null));
  if (!hasPlan && stampingIdle && !state.gameOver) {
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

  // Idle R&D lab once the company is established and has spare cash
  if (!state.gameOver && !state.research.active && state.stats.ordersPaid >= 2) {
    const affordable = Object.entries(BALANCE.research.projects)
      .filter(([id]) => researchStatus(state, id) === 'available')
      .sort((a, b) => a[1].cost - b[1].cost)[0];
    if (affordable && state.cash >= affordable[1].cost * 2.5) {
      alerts.push({
        id: 'research-idle',
        severity: 'info',
        title: 'R&D lab is idle',
        cause: `Research gives permanent bonuses. ${affordable[1].name} costs ${formatMoney(affordable[1].cost)}.`,
        actions: [{ label: 'Open R&D', action: { kind: 'openTab', tab: 'research' } }],
      });
    }
  }

  // A new plant within reach (comfortably affordable)
  const site = nextPlantSite(state);
  if (site && !state.gameOver && buildPlantBlocker(state) === null && state.cash >= site.cost * 1.5) {
    alerts.push({
      id: 'plant-available',
      severity: 'info',
      title: `${site.name} plant site available`,
      cause: `You can afford a second production line (${formatMoney(site.cost)}). It doubles capacity once staffed — worth it when orders outrun your line.`,
      actions: [{ label: 'Open Upgrades', action: { kind: 'openTab', tab: 'upgrades' } }],
    });
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
  const paint = stationOf(state, 'paint').assigned;
  const final = stationOf(state, 'final').assigned;
  const scheduledForOrder = s.vehiclesStarted > 0 || state.plan.some((j) => j.orderId !== null);

  // One-click parts for the first accepted order, from the dependable mid-price supplier.
  let buyKitAction: TutorialStep['action'];
  const firstAccepted = state.orders.find((o) => o.status === 'accepted');
  if (firstAccepted) {
    const cars = firstAccepted.quantity - firstAccepted.reserved.length;
    const kit = kitShortfall(state, firstAccepted.model, firstAccepted.trim, cars);
    const cost = kitCost(referenceSupplier().id, kit);
    if (cost > 0 && cost <= state.cash) {
      buyKitAction = {
        label: `Buy parts for ${cars} cars (${formatMoney(cost)})`,
        action: {
          kind: 'command',
          command: { type: 'purchaseKit', supplierId: referenceSupplier().id, model: firstAccepted.model, trim: firstAccepted.trim, cars },
        },
      };
    }
  }

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
      action: buyKitAction ?? { label: 'Open Suppliers', action: { kind: 'openTab', tab: 'suppliers' } },
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

// ───────────────────────────── scenario & goals ─────────────────────────────

export function scenarioSpec(state: GameState): ScenarioSpec {
  return BALANCE.scenarios[state.goals?.scenario ?? 'standard'] ?? BALANCE.scenarios.standard;
}

/** Equipment, plants and tooling at what they cost. */
export function fixedAssets(state: GameState): number {
  return Math.max(0, Math.round(state.finance.capex));
}

/** Cash + stock + receivables + equipment at cost − loans. */
export function netWorth(state: GameState): number {
  return Math.round(state.cash + inventoryValue(state).total + receivables(state) + fixedAssets(state) - totalDebt(state));
}

export interface GoalProgress {
  netWorth: number;
  netWorthTarget: number;
  /** Player share of the open market over the last 7 days (null without history). */
  share: number | null;
  shareTarget: number;
  met: boolean;
}

export function goalProgress(state: GameState): GoalProgress {
  const g = scenarioSpec(state).goal;
  const nw = netWorth(state);
  const share = recentMarketShare(state, 7)?.player ?? null;
  const shareOk = g.marketShare <= 0 || (share !== null && share >= g.marketShare && state.market.history.length >= 7);
  return { netWorth: nw, netWorthTarget: g.netWorth, share, shareTarget: g.marketShare, met: nw >= g.netWorth && shareOk };
}

export type Medal = 'gold' | 'silver' | 'bronze';

export function medalFor(state: GameState, days: number): Medal {
  const par = scenarioSpec(state).goal.parDays;
  if (days <= par) return 'gold';
  if (days <= par * 1.5) return 'silver';
  return 'bronze';
}

/** Whether a milestone's condition holds now. Unknown ids are never met. */
export function milestoneMet(state: GameState, id: string): boolean {
  const st = state.stats;
  switch (id) {
    case 'firstDelivery':
      return st.ordersDelivered >= 1;
    case 'tenBuilt':
      return st.vehiclesBuilt >= 10;
    case 'firstResearch':
      return state.research.completed.length >= 1;
    case 'secondModel':
      return unlockedModels(state).length >= 2;
    case 'onTime10':
      return st.ordersDelivered - st.ordersLate >= 10;
    case 'fiftyBuilt':
      return st.vehiclesBuilt >= 50;
    case 'netWorth500k':
      return netWorth(state) >= 500_000;
    case 'secondPlant':
      return operatingPlants(state).length >= 2;
    case 'reputation75':
      return state.reputation >= 75;
    case 'allModels': {
      const built = new Set(Object.values(state.vehicles).filter((v) => v.finishedAt !== null).map((v) => v.model));
      return MODEL_IDS.every((m) => built.has(m));
    }
    case 'hundredBuilt':
      return st.vehiclesBuilt >= 100;
    case 'thirdPlant':
      return operatingPlants(state).length >= 3;
    default:
      return false;
  }
}

// ───────────────────────────── events (incidents) ─────────────────────────────

export function activeIncidents(state: GameState): Incident[] {
  return (state.incidents ?? []).filter((i) => i.until > state.time);
}

function incidentOf(state: GameState, kind: Incident['kind']): Incident | undefined {
  return activeIncidents(state).find((i) => i.kind === kind);
}

export function incidentDemandMult(state: GameState): number {
  const I = BALANCE.incidents;
  let m = 1;
  if (incidentOf(state, 'recession')) m *= I.recession.demandMult;
  if (incidentOf(state, 'boom')) m *= I.boom.demandMult;
  return m;
}

export function incidentOfferMult(state: GameState): number {
  const I = BALANCE.incidents;
  let m = 1;
  if (incidentOf(state, 'recession')) m *= I.recession.offerMult;
  if (incidentOf(state, 'boom')) m *= I.boom.offerMult;
  return m;
}

export function componentPriceMult(state: GameState, c: CId): number {
  return activeIncidents(state).some((i) => i.kind === 'priceSpike' && i.component === c) ? BALANCE.incidents.priceSpike.mult : 1;
}

export function supplierOnStrike(state: GameState, supplierId: string): Incident | undefined {
  return activeIncidents(state).find((i) => i.kind === 'supplierStrike' && i.supplierId === supplierId);
}

export function plantOnStrike(state: GameState, plant: number): Incident | undefined {
  if (!state.incidents?.length) return undefined;
  return activeIncidents(state).find((i) => i.kind === 'laborStrike' && i.plant === plant);
}

export function incidentTitle(state: GameState, i: Incident): string {
  switch (i.kind) {
    case 'supplierStrike':
      return `${BALANCE.suppliers.find((s) => s.id === i.supplierId)?.name ?? 'Supplier'} on strike`;
    case 'priceSpike':
      return `${i.component ? componentName(i.component) : 'Parts'} prices +${Math.round((BALANCE.incidents.priceSpike.mult - 1) * 100)}%`;
    case 'recession':
      return 'Recession: fewer buyers';
    case 'boom':
      return 'Boom: buyers are back';
    case 'laborStrike':
      return `Strike at ${plantOf(state, i.plant ?? 0).name}`;
  }
}

export function incidentDetail(i: Incident): string {
  const I = BALANCE.incidents;
  switch (i.kind) {
    case 'supplierStrike':
      return 'No new orders from this supplier, and its deliveries wait until the strike ends.';
    case 'priceSpike':
      return 'Buy from stock you have, or pay the higher price.';
    case 'recession':
      return `Market demand ${Math.round((I.recession.demandMult - 1) * 100)}%, dealer offers ${Math.round((I.recession.offerMult - 1) * 100)}%.`;
    case 'boom':
      return `Market demand +${Math.round((I.boom.demandMult - 1) * 100)}%, dealer offers +${Math.round((I.boom.offerMult - 1) * 100)}%.`;
    case 'laborStrike':
      return 'Workers walked out over low morale. The plant is stopped until they return.';
  }
}

// ───────────────────────────── loans ─────────────────────────────

export function totalDebt(state: GameState): number {
  return (state.loans ?? []).reduce((n, l) => n + l.balance, 0);
}

export function creditLimit(state: GameState): number {
  const L = BALANCE.loans;
  return Math.round(L.creditBase + state.reputation * L.creditPerReputation + Math.max(0, operatingPlants(state).length - 1) * L.creditPerPlant);
}

/** Fixed daily instalment that repays `amount` over `days` at `rate` per day. */
export function loanPayment(amount: number, rate: number, days: number): number {
  if (rate <= 0) return Math.ceil(amount / days);
  return Math.ceil((amount * rate) / (1 - Math.pow(1 + rate, -days)));
}

export function loanBlocker(state: GameState, offer: number): string | null {
  const o = BALANCE.loans.offers[offer];
  if (!o) return 'Unknown loan.';
  if (state.loans.length >= BALANCE.loans.maxLoans) return `You can have at most ${BALANCE.loans.maxLoans} loans at once.`;
  const room = creditLimit(state) - totalDebt(state);
  if (o.amount > room) return `Over your credit limit: ${formatMoney(Math.max(0, room))} of ${formatMoney(creditLimit(state))} left.`;
  if (state.insolventSince !== null) return 'Banks will not lend while your cash is negative.';
  return null;
}

export function dailyLoanPayments(state: GameState): number {
  return (state.loans ?? []).reduce((n, l) => n + Math.min(l.dailyPayment, Math.round(l.balance * (1 + l.dailyRate))), 0);
}

// ───────────────────────────── workforce ─────────────────────────────

/** Work speed from morale: speedAtZero at 0, 1.0 at 50, speedAtFull at 100. */
export function moraleSpeed(state: GameState): number {
  const W = BALANCE.workforce;
  const m = state.workforce?.morale ?? 50;
  return m >= 50 ? 1 + ((W.speedAtFull - 1) * (m - 50)) / 50 : W.speedAtZero + ((1 - W.speedAtZero) * m) / 50;
}

/** Multiplier on work done per minute at a station (morale and operator training). */
export function workSpeed(state: GameState, id: StationId): number {
  const train = id === 'inspection' ? 0 : (state.workforce?.training.operator ?? 0) * BALANCE.workforce.training.operatorSpeedPerLevel;
  return moraleSpeed(state) * (1 + train);
}

/** Multiplier on the chance of a build defect (operator training lowers it, low morale raises it). */
export function workforceDefectMult(state: GameState): number {
  const W = BALANCE.workforce;
  const m = state.workforce?.morale ?? 50;
  const moraleMult = m >= 50 ? 1 : 1 + (W.defectAtZero * (50 - m)) / 50;
  return moraleMult * Math.pow(W.training.operatorDefectMultPerLevel, state.workforce?.training.operator ?? 0);
}

/** Multiplier on maintenance and repair time from technician training. */
export function technicianTimeMult(state: GameState): number {
  return Math.pow(BALANCE.workforce.training.technicianTimeMultPerLevel, state.workforce?.training.technician ?? 0);
}

export function trainingCost(state: GameState, role: StaffRole): number | null {
  const T = BALANCE.workforce.training;
  const lvl = state.workforce.training[role];
  if (lvl >= T.maxLevel) return null;
  return T.baseCost[lvl] + T.perHead * state.staff[role];
}

export function trainingBlocker(state: GameState, role: StaffRole): string | null {
  const cost = trainingCost(state, role);
  if (cost === null) return 'Fully trained.';
  if (state.workforce.course) return 'A course is already running.';
  if (state.staff[role] <= 0) return `You have no ${BALANCE.staff[role].plural.toLowerCase()} to train.`;
  if (state.cash < cost) return `Need ${formatMoney(cost)}.`;
  return null;
}

export function moraleLabel(m: number): string {
  if (m >= 75) return 'High';
  if (m >= 50) return 'Steady';
  if (m >= BALANCE.workforce.strike.belowMorale) return 'Low';
  return 'Strike risk';
}
