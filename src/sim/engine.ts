/**
 * The simulation tick. `step(state)` advances exactly one game minute, deterministically
 * (all randomness via state.rng), in the order documented in docs/DESIGN.md.
 */
import { BALANCE, COMPONENT_IDS, MODEL_IDS, STATION_IDS, TRIM_IDS } from '../config/balance';
import { addReputation, logEvent, postCash } from './ledger';
import { chance, pick, randInt, randRange } from './rng';
import { checkGoals, eventsMidnight, expireIncidents, trainingTick } from './events';
import { rivalLaunchDay } from './initialState';
import {
  changeoverMinutes,
  componentName,
  describeEffect,
  cycleMinutes,
  dailyPayroll,
  dayOf,
  detectionRate,
  formatMoney,
  formatTime,
  hazardPerActiveMinute,
  incidentDemandMult,
  incidentOfferMult,
  plantOnStrike,
  scenarioSpec,
  supplierOnStrike,
  workforceDefectMult,
  workSpeed,
  operatingPlants,
  plantOf,
  plantPrefix,
  stationOf,
  isInProduction,
  marketDemandForFinish,
  modelColorHex,
  queueCapacity,
  recipeFor,
  researchEffects,
  rivalName,
  rivalPriceIndex,
  segmentShares,
  staffFactor,
  stationName,
  trimSpec,
  unlockedModels,
  vehicleLabel,
  yardCapacity,
} from './selectors';
import type {
  ComponentId,
  GameState,
  ModelId,
  SalesOrder,
  StationId,
  StationIssue,
  StationState,
  Vehicle,
  WorkSlot,
} from './types';

const MPD = BALANCE.time.minutesPerDay;
/** Delivered/sold vehicles kept in state for history. */
export const CLOSED_VEHICLE_HISTORY = 150;
/** Finished (paid/declined/expired/cancelled) orders kept in state. */
export const CLOSED_ORDER_HISTORY = 60;

const NEXT_STATION: Partial<Record<StationId, StationId>> = {
  stamping: 'body',
  body: 'paint',
  paint: 'final',
  final: 'inspection',
};

// ───────────────────────────── helpers ─────────────────────────────

export function getVehicle(state: GameState, id: number): Vehicle | undefined {
  return state.vehicles[String(id)];
}

function addIssue(issues: StationIssue[], issue: StationIssue): void {
  if (!issues.some((i) => i.kind === issue.kind && i.text === issue.text)) issues.push(issue);
}

function missingMaterials(
  state: GameState,
  need: Partial<Record<ComponentId, number>>,
): { text: string; components: ComponentId[] } | null {
  const parts: string[] = [];
  const comps: ComponentId[] = [];
  for (const c of COMPONENT_IDS) {
    const q = need[c];
    if (!q) continue;
    const have = state.inventory[c].qty;
    if (have < q) {
      parts.push(`${componentName(c)} (need ${q}, have ${have})`);
      comps.push(c);
    }
  }
  if (comps.length === 0) return null;
  return { text: `Missing ${parts.join(', ')}`, components: comps };
}

/** Deduct components at average cost/quality. Caller must have checked availability. */
function consume(state: GameState, need: Partial<Record<ComponentId, number>>): { value: number; quality: number } {
  let value = 0;
  let qSum = 0;
  let units = 0;
  for (const c of COMPONENT_IDS) {
    const q = need[c];
    if (!q) continue;
    const s = state.inventory[c];
    const avgCost = s.qty > 0 ? s.value / s.qty : 0;
    const avgQ = s.qty > 0 ? s.qualitySum / s.qty : 1;
    const v = avgCost * q;
    s.qty -= q;
    if (s.qty <= 0) {
      // Avoid floating dust when the last units leave.
      s.qty = 0;
      value += s.value;
      s.value = 0;
      s.qualitySum = 0;
    } else {
      s.value -= v;
      s.qualitySum -= avgQ * q;
      value += v;
    }
    qSum += avgQ * q;
    units += q;
  }
  return { value, quality: units > 0 ? qSum / units : 1 };
}

function newSlot(vehicleId: number, required: number, componentQuality: number, changeover = 0): WorkSlot {
  return { vehicleId, progress: 0, required: required + changeover, done: false, componentQuality, outcome: null, changeover };
}

/** Start work on a vehicle of `model` at a station: adds retooling time if the station last ran a different model. */
function startSlot(
  state: GameState,
  plant: number,
  id: StationId,
  st: StationState,
  v: Vehicle,
  componentQuality: number,
): WorkSlot {
  const changeover = changeoverMinutes(state, id, v.model, plant);
  if (changeover > 0) {
    const from = st.lastModel as ModelId;
    logEvent(
      state,
      'info',
      `${plantPrefix(state, plant)}${stationName(id)} is retooling from ${BALANCE.models[from].className} to ${BALANCE.models[v.model].className} (+${changeover}m).`,
    );
  }
  st.lastModel = v.model;
  return newSlot(v.id, cycleMinutes(id, v.model, v.trim, v.finish, state), componentQuality, changeover);
}

/** Warranty cost and reputation hit for a vehicle leaving the plant with an undetected defect. */
function handleEscapedDefect(state: GameState, v: Vehicle): void {
  if (!v.defect) return;
  const Q = BALANCE.quality;
  postCash(state, 'warranty', `Warranty claim: ${v.serial} (${v.defectNotes.join(', ') || 'defect'})`, -Q.escapedDefectWarrantyCost);
  addReputation(state, Q.escapedDefectReputation);
  state.stats.defectsEscaped++;
  logEvent(
    state,
    'bad',
    `Customer found a defect in ${v.serial} (${v.defectNotes.join(', ') || 'unknown'}) — warranty ${formatMoney(
      Q.escapedDefectWarrantyCost,
    )}, reputation ${Q.escapedDefectReputation}.`,
  );
}

function recognizeSale(state: GameState, v: Vehicle, price: number, stage: 'delivered' | 'sold'): void {
  const f = state.finance;
  f.cogs += v.cost;
  f.today.cogs += v.cost;
  v.stage = stage;
  v.closedAt = state.time;
  v.salePrice = price;
  const idx = state.yard.indexOf(v.id);
  if (idx >= 0) state.yard.splice(idx, 1);
}

// ───────────────────────────── reservations & orders ─────────────────────────────

/** Reserve the oldest unreserved yard vehicles to accepted orders, by priority. Never steals reservations. */
export function allocateReservations(state: GameState): void {
  const accepted = state.orders
    .filter((o) => o.status === 'accepted')
    .sort((a, b) => a.priority - b.priority || a.id - b.id);
  for (const o of accepted) {
    if (o.reserved.length >= o.quantity) continue;
    for (const vid of state.yard) {
      if (o.reserved.length >= o.quantity) break;
      const v = getVehicle(state, vid);
      if (!v || v.orderId !== null || v.model !== o.model || v.trim !== o.trim) continue;
      v.orderId = o.id;
      o.reserved.push(v.id);
    }
    if (o.reserved.length >= o.quantity) {
      logEvent(state, 'good', `Order #${o.id} for ${o.dealer} is complete — ready to deliver.`);
    }
  }
}

export function collectPayment(state: GameState, o: SalesOrder): void {
  if (o.status !== 'delivered') return;
  const amount = o.invoiceAmount ?? 0;
  postCash(state, 'sales', `Payment: order #${o.id} (${o.dealer})`, amount);
  o.status = 'paid';
  o.paidAt = state.time;
  state.stats.ordersPaid++;
  logEvent(state, 'good', `${o.dealer} paid ${formatMoney(amount)} for order #${o.id}.`, 'paid');
}

export function cancelOrder(state: GameState, o: SalesOrder): void {
  for (const vid of o.reserved) {
    const v = getVehicle(state, vid);
    if (v && v.orderId === o.id) v.orderId = null;
  }
  o.reserved = [];
  o.status = 'cancelled';
  for (const j of state.plan) if (j.orderId === o.id) j.orderId = null;
  for (const v of Object.values(state.vehicles)) {
    if (v.plannedForOrderId === o.id && isInProduction(v)) v.plannedForOrderId = null;
  }
  postCash(state, 'penalty', `Cancellation fee: order #${o.id} (${o.dealer})`, -o.cancelFee);
  addReputation(state, BALANCE.orders.repCancel);
  state.stats.ordersCancelled++;
  logEvent(
    state,
    'bad',
    `${o.dealer} cancelled late order #${o.id}. Fee ${formatMoney(o.cancelFee)}, reputation ${BALANCE.orders.repCancel}.`,
  );
  allocateReservations(state);
}

/** Deliver an accepted, fully reserved order. Returns an error message or null on success. */
export function deliverOrderNow(state: GameState, o: SalesOrder): string | null {
  if (o.status === 'delivered' || o.status === 'paid') return `Order #${o.id} was already delivered.`;
  if (o.status !== 'accepted') return `Order #${o.id} is ${o.status} and cannot be delivered.`;
  if (o.reserved.length < o.quantity) {
    return `Order #${o.id} is not ready: ${o.reserved.length}/${o.quantity} cars in the yard.`;
  }
  const vehicles: Vehicle[] = [];
  for (const vid of o.reserved) {
    const v = getVehicle(state, vid);
    if (!v || v.stage !== 'finished' || !state.yard.includes(vid)) {
      return `Order #${o.id} cannot be delivered: vehicle ${v?.serial ?? vid} is not in the yard.`;
    }
    vehicles.push(v);
  }
  const O = BALANCE.orders;
  const lateDays = Math.ceil(Math.max(0, state.time - o.deadline) / MPD);
  const invoice = Math.round(o.quantity * o.unitPrice * (1 - Math.min(o.latePenaltyMax, lateDays * o.latePenaltyPerDay)));
  state.finance.revenue += invoice;
  state.finance.today.revenue += invoice;
  for (const v of vehicles) {
    recognizeSale(state, v, invoice / o.quantity, 'delivered');
  }
  for (const v of vehicles) handleEscapedDefect(state, v);
  if (lateDays > 0) {
    addReputation(state, O.repLate);
    state.stats.ordersLate++;
  } else {
    addReputation(state, O.repOnTime);
  }
  o.status = 'delivered';
  o.deliveredAt = state.time;
  o.invoiceAmount = invoice;
  o.lateDays = lateDays;
  o.paymentDueAt = state.time + o.paymentTermsMinutes;
  state.stats.ordersDelivered++;
  // Remaining jobs for this order become regular market builds.
  for (const j of state.plan) if (j.orderId === o.id) j.orderId = null;
  logEvent(
    state,
    lateDays > 0 ? 'warn' : 'good',
    `Delivered order #${o.id} to ${o.dealer}: invoice ${formatMoney(invoice)}${
      lateDays > 0 ? ` (${lateDays} day(s) late, penalty applied)` : ''
    }${o.paymentTermsMinutes > 0 ? `, payment due ${formatTime(o.paymentDueAt)}` : ''}.`, 'delivered');
  if (o.paymentTermsMinutes <= 0) collectPayment(state, o);
  return null;
}

function round50(n: number): number {
  return Math.round(n / 50) * 50;
}

/** Weighted pick among unlocked models (no RNG draw when only one is unlocked). */
function pickModel(state: GameState): ModelId {
  const models = unlockedModels(state);
  if (models.length <= 1) return models[0] ?? 'sedan';
  const total = models.reduce((n, m) => n + BALANCE.models[m].orderWeight, 0);
  let r = randRange(state, 0, total);
  for (const m of models) {
    r -= BALANCE.models[m].orderWeight;
    if (r < 0) return m;
  }
  return models[models.length - 1];
}

function generateOffer(state: GameState): void {
  const O = BALANCE.orders;
  const open = state.orders.filter((o) => o.status === 'offered').length;
  if (open >= O.maxOpenOffers) return;
  const rep = state.reputation;
  if (!chance(state, (O.baseChance + rep * O.chancePerReputation) * researchEffects(state).offerChanceMult * incidentOfferMult(state))) return;
  const model = pickModel(state);
  const trim = chance(state, O.premiumShareBase + rep * O.premiumSharePerRep) ? 'premium' : 'economy';
  const qty = randInt(state, O.minQty, O.maxQtyBase + Math.floor(rep / O.repPerExtraQty));
  const terms = pick(state, O.paymentTerms);
  const spread = randRange(state, O.priceSpread[0], O.priceSpread[1]);
  // Dealers pay more where rivals price high and less where they undercut.
  const active = state.market.rivals.filter((r) => r.segments[model][trim].active);
  const avgIdx = active.length ? active.reduce((n, r) => n + rivalPriceIndex(state, r, model, trim), 0) / active.length : 1;
  const follow = 1 + BALANCE.competition.offerPriceFollow * (avgIdx - 1);
  const unitPrice = round50(trimSpec(model, trim).baseValue * spread * (0.92 + rep / 600) * terms.priceMult * follow);
  const slack = randRange(state, O.deadlineSlackMinutes[0], O.deadlineSlackMinutes[1]);
  const deadline = Math.round(state.time + O.deadlineBaseMinutes + qty * O.deadlineMinutesPerVehicle + slack);
  const dealer = pick(state, O.dealers);
  const order: SalesOrder = {
    id: state.nextId++,
    dealer,
    model,
    trim,
    quantity: qty,
    unitPrice,
    createdAt: state.time,
    offerExpiresAt: state.time + O.offerLifetimeMinutes,
    deadline,
    paymentTermsLabel: terms.label,
    paymentTermsMinutes: terms.minutes,
    latePenaltyPerDay: O.latePenaltyPerDay,
    latePenaltyMax: O.latePenaltyMax,
    cancelAfterLateMinutes: O.cancelAfterLateMinutes,
    cancelFee: Math.round(qty * unitPrice * O.cancelFeePct),
    status: 'offered',
    priority: 0,
    reserved: [],
    acceptedAt: null,
    deliveredAt: null,
    paymentDueAt: null,
    invoiceAmount: null,
    paidAt: null,
    lateDays: 0,
    lateWarned: false,
    contested: true,
    lostTo: null,
  };
  state.orders.push(order);
  logEvent(
    state,
    'info',
    `New offer #${order.id}: ${dealer} wants ${qty} ${vehicleLabel(state, model, trim)} @ ${formatMoney(unitPrice)} (due ${formatTime(deadline)}, ${terms.label}).`, 'offer');
}

/** A rival wins an offer the player has left waiting. Prefers rivals active in the segment. */
function maybeLoseOffer(state: GameState, o: SalesOrder): boolean {
  const C = BALANCE.competition;
  if (!o.contested || state.time % 60 !== 0 || state.time - o.createdAt < C.offerSnipeAfterMinutes) return false;
  if (!chance(state, C.offerSnipeChancePerHour * scenarioSpec(state).offerSnipeMult)) return false;
  const inSegment = state.market.rivals.filter((r) => r.segments[o.model][o.trim].active);
  const winner = pick(state, inSegment.length ? inSegment : state.market.rivals);
  o.status = 'lost';
  o.lostTo = winner.id;
  logEvent(state, 'warn', `${rivalName(winner.id)} won offer #${o.id} from ${o.dealer} (${o.quantity} ${vehicleLabel(state, o.model, o.trim)}) while it waited.`);
  return true;
}

function ordersTick(state: GameState): void {
  if (state.time % BALANCE.orders.checkEveryMinutes === 0) generateOffer(state);
  for (const o of state.orders) {
    if (o.status === 'offered') {
      if (maybeLoseOffer(state, o)) continue;
      if (state.time >= o.offerExpiresAt) {
        o.status = 'expired';
        logEvent(state, 'info', `Offer #${o.id} from ${o.dealer} expired.`);
      }
    } else if (o.status === 'accepted') {
      if (state.time > o.deadline && !o.lateWarned) {
        o.lateWarned = true;
        logEvent(
          state,
          'warn',
          `Order #${o.id} for ${o.dealer} is late (${o.reserved.length}/${o.quantity} ready). Invoice shrinks ${Math.round(
            o.latePenaltyPerDay * 100,
          )}% per day; cancellation in ${Math.round(o.cancelAfterLateMinutes / 60)}h.`,
        );
      }
      if (state.time >= o.deadline + o.cancelAfterLateMinutes) cancelOrder(state, o);
    } else if (o.status === 'delivered') {
      if (o.paymentDueAt !== null && state.time >= o.paymentDueAt) collectPayment(state, o);
    }
  }
}

// ───────────────────────────── stations ─────────────────────────────

function tryRoute(state: GameState, plant: number, id: StationId, slot: WorkSlot): string | null {
  const P = plantOf(state, plant);
  const v = getVehicle(state, slot.vehicleId);
  if (!v) return null; // vehicle vanished (should never happen) — drop the slot
  if (id === 'inspection') {
    if (slot.outcome === 'rework') {
      const rb = P.rework;
      const cap = BALANCE.quality.reworkQueueCapacity;
      // Gridlock breaker: the rework bay's finished car is waiting for space in the (full) inspection queue
      // while inspection is waiting for space in the (full) rework queue. Allow one extra so the loop drains.
      const gridlock =
        rb.slot !== null && rb.slot.done && P.stations.inspection.queue.length >= queueCapacity(state, 'inspection', plant);
      if (rb.queue.length < cap || (gridlock && rb.queue.length < cap + 1)) {
        rb.queue.push(v.id);
        v.stage = 'rework';
        return null;
      }
      return 'Output blocked: Rework bay queue full';
    }
    if (state.yard.length < yardCapacity(state)) {
      state.yard.push(v.id);
      v.stage = 'finished';
      v.finishedAt = state.time;
      state.stats.vehiclesBuilt++;
      state.stats.builtToday++;
      allocateReservations(state);
      return null;
    }
    return 'Output blocked: finished-vehicle yard full';
  }
  const next = NEXT_STATION[id]!;
  const dest = P.stations[next];
  if (dest.queue.length < queueCapacity(state, next, plant)) {
    dest.queue.push(v.id);
    v.stage = next;
    return null;
  }
  return `Output blocked: ${stationName(next)} queue full`;
}

function fillSlots(state: GameState, plant: number, id: StationId, st: StationState): void {
  for (let i = 0; i < st.slots.length; i++) {
    if (st.slots[i] !== null) continue;
    if (id === 'stamping') {
      const allowed = plantOf(state, plant).allowedModels;
      const jobIdx = state.plan.findIndex((j) => j.started < j.quantity && allowed.includes(j.model));
      if (jobIdx < 0) {
        const other = state.plan.some((j) => j.started < j.quantity);
        addIssue(st.issues, {
          kind: 'idle',
          text: other ? 'Planned jobs are for models this plant does not build' : 'No production scheduled',
        });
        return;
      }
      const job = state.plan[jobIdx];
      const finish = state.product.models[job.model].finish[job.trim];
      const need = recipeFor(job.model, job.trim, 'stamping', finish, state);
      const missing = missingMaterials(state, need);
      if (missing) {
        addIssue(st.issues, { kind: 'materials', text: missing.text, components: missing.components });
        return;
      }
      const used = consume(state, need);
      const color = modelColorHex(state, job.model);
      state.stats.vehiclesStarted++;
      const v: Vehicle = {
        id: state.nextId++,
        serial: `MX-${String(state.stats.vehiclesStarted).padStart(4, '0')}`,
        plant,
        model: job.model,
        trim: job.trim,
        finish,
        color,
        stage: 'stamping',
        cost: used.value,
        defect: false,
        defectNotes: [],
        defectDetected: false,
        reworkCount: 0,
        orderId: null,
        plannedForOrderId: job.orderId,
        startedAt: state.time,
        finishedAt: null,
        closedAt: null,
        salePrice: null,
      };
      state.vehicles[String(v.id)] = v;
      job.started++;
      if (job.started >= job.quantity) state.plan.splice(jobIdx, 1);
      st.slots[i] = startSlot(state, plant, 'stamping', st, v, used.quality);
    } else {
      if (st.queue.length === 0) {
        addIssue(st.issues, { kind: 'idle', text: 'Waiting for vehicles' });
        return;
      }
      const v = getVehicle(state, st.queue[0]);
      if (!v) {
        st.queue.shift();
        i--;
        continue;
      }
      const need = recipeFor(v.model, v.trim, id, v.finish, state);
      const missing = missingMaterials(state, need);
      if (missing) {
        addIssue(st.issues, { kind: 'materials', text: missing.text, components: missing.components });
        return;
      }
      const used = consume(state, need);
      v.cost += used.value;
      st.queue.shift();
      st.slots[i] = startSlot(state, plant, id, st, v, used.quality);
    }
  }
}

function completeSlot(state: GameState, plant: number, id: StationId, st: StationState, slot: WorkSlot): void {
  slot.done = true;
  st.completedTotal++;
  const v = getVehicle(state, slot.vehicleId);
  if (!v) return;
  const Q = BALANCE.quality;
  if (id === 'inspection') {
    if (v.defect) {
      if (chance(state, detectionRate(state, plant))) {
        slot.outcome = 'rework';
        v.defectDetected = true;
        state.stats.defectsCaught++;
        logEvent(state, 'warn', `Inspection caught a defect on ${v.serial} (${v.defectNotes.join(', ')}) — sent to rework.`);
      } else {
        slot.outcome = 'pass';
      }
    } else {
      slot.outcome = 'pass';
    }
    return;
  }
  const fx = researchEffects(state);
  const p =
    Q.baseDefect * fx.baseDefectMult +
    (1 - slot.componentQuality) * Q.componentWeight * fx.componentDefectMult +
    (1 - st.condition / 100) * Q.conditionWeight;
  if (chance(state, p * workforceDefectMult(state))) {
    v.defect = true;
    v.defectNotes.push(stationName(id));
  }
}

function breakDown(state: GameState, plant: number, id: StationId, st: StationState): void {
  st.broken = true;
  state.stats.breakdowns++;
  const R = BALANCE.equipment.repair;
  logEvent(
    state,
    'bad',
    `${plantPrefix(state, plant)}${stationName(id)} broke down! Production there is stopped — repair costs ${formatMoney(R.cost)} and takes ${Math.round(
      R.minutes / 60,
    )}h.`, 'breakdown');
}

function tickStation(state: GameState, plant: number, id: StationId): void {
  const st = stationOf(state, id, plant);
  const at = plantPrefix(state, plant);
  st.issues = [];
  const E = BALANCE.equipment;

  if (st.service) {
    const svc = st.service;
    svc.remaining -= 1;
    if (svc.remaining <= 0) {
      if (svc.kind === 'maintenance') {
        st.condition = 100;
        logEvent(state, 'good', `Maintenance finished: ${at}${stationName(id)} is back to 100% condition.`);
      } else {
        st.broken = false;
        st.condition = Math.max(st.condition, E.repair.restoreCondition);
        logEvent(state, 'good', `Repair finished: ${at}${stationName(id)} is running again (${Math.round(st.condition)}% condition).`);
      }
      st.service = null;
    } else {
      st.issues.push({
        kind: 'service',
        text: `${svc.kind === 'repair' ? 'Repair' : 'Maintenance'} in progress — ${svc.remaining}m left`,
      });
    }
    return;
  }
  if (st.broken) {
    st.issues.push({ kind: 'broken', text: 'Breakdown — production stopped. Repair needed.' });
    return;
  }

  // 1. Route finished work downstream.
  for (let i = 0; i < st.slots.length; i++) {
    const slot = st.slots[i];
    if (!slot || !slot.done) continue;
    const blocked = tryRoute(state, plant, id, slot);
    if (blocked) addIssue(st.issues, { kind: 'downstream', text: blocked });
    else st.slots[i] = null;
  }

  // 2. Fill empty slots.
  const sf = staffFactor(state, id, plant);
  if (sf <= 0) {
    const strike = plantOnStrike(state, plant);
    addIssue(st.issues, {
      kind: 'staff',
      text: strike ? 'Workers on strike' : id === 'inspection' ? 'No inspectors on staff' : 'No operators assigned',
    });
  } else {
    fillSlots(state, plant, id, st);
  }

  // 3. Work.
  let worked = false;
  if (sf > 0) {
    const S = BALANCE.stations[id];
    const wear = S.wearPerActiveMinute * Math.pow(E.reliabilityWearMult, st.reliabilityLevel) * researchEffects(state).wearMult * sf;
    const speed = sf * workSpeed(state, id);
    for (const slot of st.slots) {
      if (!slot || slot.done) continue;
      worked = true;
      slot.progress += speed;
      st.condition = Math.max(0, st.condition - wear);
      st.energyAccrued += S.energyPerActiveHour / 60;
      st.activeMinutesTotal++;
      if (slot.progress >= slot.required - 1e-9) completeSlot(state, plant, id, st, slot);
    }
    if (sf < 1 && st.slots.some((s) => s !== null)) {
      const have = id === 'inspection' ? state.staff.inspector : st.assigned;
      const need = S.staffPerSlot * st.slots.length;
      addIssue(st.issues, {
        kind: 'staff',
        text: `Understaffed: ${have}/${need} ${id === 'inspection' ? 'inspectors' : 'operators'} (${Math.round(sf * 100)}% speed)`,
      });
    }
  }

  // 4. Breakdown roll.
  if (worked) {
    if (st.condition <= 0) breakDown(state, plant, id, st);
    else if (st.condition < E.hazardThreshold && chance(state, hazardPerActiveMinute(state, id, plant))) breakDown(state, plant, id, st);
  }
}

function tickRework(state: GameState, plant: number): void {
  const rb = plantOf(state, plant).rework;
  rb.issues = [];
  const Q = BALANCE.quality;
  if (rb.slot && rb.slot.done) {
    const insp = stationOf(state, 'inspection', plant);
    if (insp.queue.length < queueCapacity(state, 'inspection', plant)) {
      const v = getVehicle(state, rb.slot.vehicleId);
      if (v) {
        insp.queue.push(v.id);
        v.stage = 'inspection';
      }
      rb.slot = null;
    } else {
      rb.issues.push({ kind: 'downstream', text: 'Output blocked: Quality Inspection queue full' });
    }
  }
  if (!rb.slot && rb.queue.length > 0) {
    const v = getVehicle(state, rb.queue[0]);
    if (!v) {
      rb.queue.shift();
    } else if (state.cash >= Q.reworkCost) {
      postCash(state, 'rework', `Rework ${v.serial}`, -Q.reworkCost);
      rb.queue.shift();
      rb.slot = newSlot(v.id, Q.reworkMinutes, 1);
    } else {
      rb.issues.push({ kind: 'cash', text: `Not enough cash for rework (${formatMoney(Q.reworkCost)} needed)` });
    }
  }
  if (rb.slot && !rb.slot.done) {
    rb.slot.progress += 1;
    if (rb.slot.progress >= rb.slot.required) {
      rb.slot.done = true;
      const v = getVehicle(state, rb.slot.vehicleId);
      if (v) {
        v.defect = false;
        v.defectDetected = false;
        v.defectNotes = [];
        v.reworkCount++;
      }
      state.stats.reworksDone++;
    }
  }
}

// ───────────────────────────── other phases ─────────────────────────────

function receiveShipments(state: GameState): void {
  if (state.shipments.length === 0) return;
  const keep = [];
  for (const s of state.shipments) {
    if (s.arrivesAt <= state.time && !supplierOnStrike(state, s.supplierId)) {
      const inv = state.inventory[s.component];
      inv.qty += s.qty;
      inv.value += s.qty * s.unitCost;
      inv.qualitySum += s.qty * s.quality;
      const sup = BALANCE.suppliers.find((x) => x.id === s.supplierId);
      logEvent(state, 'info', `Delivery arrived: ${s.qty} × ${componentName(s.component)} from ${sup?.name ?? s.supplierId}.`);
    } else {
      keep.push(s);
    }
  }
  state.shipments = keep;
}

function marketSales(state: GameState): void {
  const M = BALANCE.market;
  const C = BALANCE.competition;
  for (const model of MODEL_IDS) {
    const mc = state.product.models[model];
    for (const trim of TRIM_IDS) {
      let v: Vehicle | undefined;
      if (mc.unlocked && mc.marketListed[trim]) {
        for (const vid of state.yard) {
          const c = getVehicle(state, vid);
          if (c && c.orderId === null && c.model === model && c.trim === trim) {
            v = c;
            break;
          }
        }
      }
      // Rivals sell their expected share of the segment this interval (the player competes only with stock on offer).
      const seg = segmentShares(state, model, trim, { playerPresent: !!v, finish: v?.finish });
      const segmentUnits = (trimSpec(model, trim).baseDemandPerDay * C.marketSizeCompanies * incidentDemandMult(state) * M.checkEveryMinutes) / MPD;
      for (const r of seg.rivals) {
        if (r.share > 0) state.market.today.rivals[r.id] = (state.market.today.rivals[r.id] ?? 0) + segmentUnits * r.share;
      }
      if (!v) continue;
      const price = mc.price[trim];
      const p = (marketDemandForFinish(state, model, trim, price, v.finish) * M.checkEveryMinutes) / MPD;
      if (!chance(state, p)) continue;
      const label = vehicleLabel(state, model, trim);
      state.finance.revenue += price;
      state.finance.today.revenue += price;
      recognizeSale(state, v, price, 'sold');
      postCash(state, 'sales', `Market sale: ${v.serial} (${label})`, price);
      addReputation(state, M.repPerSale);
      state.stats.marketSold++;
      state.market.today.player++;
      logEvent(state, 'good', `Sold ${v.serial} (${label}) on the open market for ${formatMoney(price)}.`, 'sale');
      handleEscapedDefect(state, v);
    }
  }
}

/** Daily rival moves: launches, price reactions to their share, promotions and reputation drift. */
function rivalsMidnight(state: GameState): void {
  const C = BALANCE.competition;
  const day = dayOf(state.time);
  const fair = 1 / C.marketSizeCompanies;
  for (const r of state.market.rivals) {
    const spec = BALANCE.competition.rivals.find((x) => x.id === r.id);
    if (!spec) continue;
    const activeSegs: [ModelId, (typeof TRIM_IDS)[number]][] = [];
    for (const m of MODEL_IDS) {
      const launch = rivalLaunchDay(state.goals.scenario, r.id, m);
      for (const t of TRIM_IDS) {
        const seg = r.segments[m][t];
        if (!seg.active && launch !== null && day >= launch) {
          seg.active = true;
          if (t === TRIM_IDS[0]) logEvent(state, 'info', `${spec.name} launched a ${BALANCE.models[m].className} — more competition for buyers.`);
        }
        if (!seg.active) continue;
        activeSegs.push([m, t]);
        const mc = state.product.models[m];
        const share = segmentShares(state, m, t, { playerPresent: mc.unlocked && mc.marketListed[t] }).rivals.find((x) => x.id === r.id)?.share ?? 0;
        if (share < fair * C.fairBand[0]) seg.priceIndex -= C.priceStep;
        else if (share > fair * C.fairBand[1]) seg.priceIndex += C.priceStep;
        else {
          const gap = spec.priceIndex - seg.priceIndex;
          seg.priceIndex += Math.sign(gap) * Math.min(Math.abs(gap), C.priceStep / 2);
        }
        seg.priceIndex = Math.min(C.maxPriceIndex, Math.max(C.minPriceIndex, Math.round(seg.priceIndex * 1000) / 1000));
        if (seg.promoUntil !== null && state.time >= seg.promoUntil) seg.promoUntil = null;
      }
    }
    if (activeSegs.length && chance(state, C.promoChancePerDay)) {
      const [m, t] = pick(state, activeSegs);
      r.segments[m][t].promoUntil = state.time + C.promoDays * MPD;
      logEvent(
        state,
        'info',
        `${spec.name} is running a ${Math.round(C.promoDiscount * 100)}% promotion on its ${BALANCE.trims[t].name} ${
          BALANCE.models[m].className
        } for ${C.promoDays} days.`,
      );
    }
    r.reputation += Math.sign(C.repTarget - r.reputation) * Math.min(C.repDrift, Math.abs(C.repTarget - r.reputation));
  }
  const mk = state.market;
  const closed = { ...mk.today, rivals: Object.fromEntries(Object.entries(mk.today.rivals).map(([k, n]) => [k, Math.round(n * 10) / 10])) };
  mk.history.push(closed);
  if (mk.history.length > C.shareHistoryDays) mk.history.splice(0, mk.history.length - C.shareHistoryDays);
  mk.today = { day, player: 0, rivals: Object.fromEntries(mk.rivals.map((r) => [r.id, 0])) };
}

function researchTick(state: GameState): void {
  const a = state.research.active;
  if (!a) return;
  a.remaining -= 1;
  if (a.remaining > 0) return;
  state.research.completed.push(a.id);
  state.research.active = null;
  const p = BALANCE.research.projects[a.id];
  logEvent(state, 'good', `Research complete: ${p?.name ?? a.id}. ${p ? describeEffect(p.effect).join('; ') : ''}.`, 'research');
}

function midnight(state: GameState): void {
  rivalsMidnight(state);
  eventsMidnight(state);
  const endedDay = dayOf(state.time - 1);
  const payroll = dailyPayroll(state);
  postCash(state, 'payroll', `Payroll — day ${endedDay}`, -payroll);
  let energy = 0;
  for (const p of state.plants) {
    for (const id of STATION_IDS) {
      energy += p.stations[id].energyAccrued;
      p.stations[id].energyAccrued = 0;
    }
  }
  const sites = operatingPlants(state).length;
  const utilities = Math.round(BALANCE.overhead.dailyBase * sites + energy);
  postCash(state, 'utilities', `Site overhead & energy — day ${endedDay}`, -utilities);

  const f = state.finance;
  f.today.cashEnd = state.cash;
  f.today.built = state.stats.builtToday;
  const summary = { ...f.today, revenue: Math.round(f.today.revenue), cogs: Math.round(f.today.cogs) };
  f.history.push(summary);
  if (f.history.length > BALANCE.finance.dailyHistoryDays) f.history.splice(0, f.history.length - BALANCE.finance.dailyHistoryDays);
  f.today = { day: dayOf(state.time), revenue: 0, cogs: 0, expenses: 0, cashEnd: state.cash, built: 0 };
  state.stats.builtToday = 0;
  logEvent(
    state,
    'info',
    `Day ${endedDay} closed: built ${summary.built}, revenue ${formatMoney(summary.revenue)}, payroll ${formatMoney(
      payroll,
    )}, overhead & energy ${formatMoney(utilities)}. Cash ${formatMoney(state.cash)}.`,
  );
}

function insolvencyCheck(state: GameState): void {
  const grace = BALANCE.finance.insolvencyGraceMinutes;
  if (state.cash < 0) {
    if (state.insolventSince === null) {
      state.insolventSince = state.time;
      logEvent(
        state,
        'bad',
        `Cash is negative (${formatMoney(state.cash)})! You have ${Math.round(grace / 60)}h to get back above $0 or the company goes bankrupt.`,
      );
      return;
    }
    const elapsed = state.time - state.insolventSince;
    if (elapsed >= grace) {
      state.gameOver = true;
      state.gameOverReason = `Bankrupt: cash stayed negative for ${Math.round(grace / 60)} hours (${formatMoney(
        state.cash,
      )} on ${formatTime(state.time)}).`;
      logEvent(state, 'bad', state.gameOverReason);
    } else if (elapsed === Math.floor(grace / 2) || elapsed === grace - 120) {
      logEvent(state, 'bad', `Insolvency warning: ${Math.round((grace - elapsed) / 60)}h left to get cash above $0.`);
    }
  } else if (state.insolventSince !== null) {
    state.insolventSince = null;
    logEvent(state, 'good', 'Cash is positive again — bankruptcy averted.');
  }
}

/** Drop old delivered/sold vehicles and finished orders so saves stay small. */
export function pruneHistory(state: GameState): void {
  const protectedIds = new Set<number>();
  for (const o of state.orders) {
    if (o.status === 'accepted' || o.status === 'delivered') for (const id of o.reserved) protectedIds.add(id);
  }
  const closed = Object.values(state.vehicles).filter(
    (v) => (v.stage === 'delivered' || v.stage === 'sold') && !protectedIds.has(v.id),
  );
  if (closed.length > CLOSED_VEHICLE_HISTORY) {
    closed.sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0) || b.id - a.id);
    for (const v of closed.slice(CLOSED_VEHICLE_HISTORY)) delete state.vehicles[String(v.id)];
  }
  const finalStatuses = new Set(['paid', 'declined', 'expired', 'cancelled', 'lost']);
  const finals = state.orders.filter((o) => finalStatuses.has(o.status));
  if (finals.length > CLOSED_ORDER_HISTORY) {
    const drop = new Set(
      finals
        .sort((a, b) => b.id - a.id)
        .slice(CLOSED_ORDER_HISTORY)
        .map((o) => o.id),
    );
    state.orders = state.orders.filter((o) => !drop.has(o.id));
  }
}

// ───────────────────────────── public API ─────────────────────────────

/** Advance the simulation by exactly one tick (one game minute). */
export function step(state: GameState): void {
  if (state.gameOver) return;
  state.time += 1;
  expireIncidents(state);
  receiveShipments(state);
  researchTick(state);
  trainingTick(state);
  for (const p of state.plants) {
    if (p.constructionRemaining > 0) {
      p.constructionRemaining -= 1;
      if (p.constructionRemaining <= 0) {
        p.constructionRemaining = 0;
        logEvent(state, 'good', `${p.name} plant is finished — staff its stations to start building.`, 'plant');
      }
      continue;
    }
    tickStation(state, p.id, 'inspection');
    tickRework(state, p.id);
    tickStation(state, p.id, 'final');
    tickStation(state, p.id, 'paint');
    tickStation(state, p.id, 'body');
    tickStation(state, p.id, 'stamping');
  }
  if (state.time % BALANCE.market.checkEveryMinutes === 0) marketSales(state);
  ordersTick(state);
  if (state.time % MPD === 0) midnight(state);
  insolvencyCheck(state);
  if (state.time % 60 === 0) {
    checkGoals(state);
    pruneHistory(state);
  }
}

/** Run n ticks (stops early on game over). */
export function runTicks(state: GameState, n: number): void {
  for (let i = 0; i < n; i++) {
    if (state.gameOver) return;
    step(state);
  }
}
