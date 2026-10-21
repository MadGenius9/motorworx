/**
 * Player commands. `applyCommand` validates, mutates state and returns a player-facing result.
 * Commands never advance time, so they work while paused.
 */
import { BALANCE, COMPONENT_IDS, FINISH_IDS, STATION_IDS, TRIM_IDS, WAGE_LEVELS } from '../config/balance';
import type { Command, CommandResult } from './commandTypes';
import { allocateReservations, deliverOrderNow } from './engine';
import { newPlant } from './initialState';
import { logEvent, postCash } from './ledger';
import {
  componentName,
  formatMoney,
  formatTime,
  freeTechnicians,
  incomingUnits,
  nextUpgradeCost,
  nextWarehouseCost,
  orderProgress,
  assignedInspectors,
  buildPlantBlocker,
  nextPlantSite,
  plantOf,
  plantPrefix,
  stationOf,
  unassignedFor,
  unassignedInspectors,
  researchBlocker,
  stationName,
  isModel,
  kitCost,
  loanBlocker,
  loanPayment,
  supplierOnStrike,
  supplierUnitPrice,
  technicianTimeMult,
  trainingBlocker,
  trainingCost,
  kitShortfall,
  modelName,
  stockOnHand,
  trimSpec,
  unassignedOperators,
  unlockBlocker,
  vehicleLabel,
  warehouseCapacity,
} from './selectors';
import type { GameState, SalesOrder, StaffRole, StationId } from './types';

const ok = (message?: string): CommandResult => ({ ok: true, message });
const fail = (message: string): CommandResult => ({ ok: false, message });

const ROLES: StaffRole[] = ['operator', 'inspector', 'technician'];

function isStation(id: unknown): id is StationId {
  return typeof id === 'string' && (STATION_IDS as readonly string[]).includes(id);
}

/** Resolves an optional plant index; returns an error message for a bad or unbuilt plant. */
function resolvePlant(state: GameState, plant: number | undefined): { plant: number; at: string } | string {
  const p = plant ?? 0;
  if (!Number.isInteger(p) || p < 0 || p >= state.plants.length) return 'Unknown plant.';
  return { plant: p, at: plantPrefix(state, p) };
}

/** Assigns `n` inspectors to the plants that need them most (operating plants first). */
function autoAssignInspectors(state: GameState, n: number): void {
  for (let k = 0; k < n; k++) {
    const order = [...state.plants].sort((a, b) => {
      const op = Number(a.constructionRemaining > 0) - Number(b.constructionRemaining > 0);
      if (op !== 0) return op;
      const ra = a.stations.inspection.assigned / (BALANCE.stations.inspection.staffPerSlot * a.stations.inspection.slots.length);
      const rb = b.stations.inspection.assigned / (BALANCE.stations.inspection.staffPerSlot * b.stations.inspection.slots.length);
      return ra - rb || a.id - b.id;
    });
    order[0].stations.inspection.assigned += 1;
  }
}

function findOrder(state: GameState, orderId: number): SalesOrder | undefined {
  return state.orders.find((o) => o.id === orderId);
}

function isPositiveInt(n: unknown, max: number): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= max;
}

function needCash(state: GameState, cost: number, what: string): CommandResult | null {
  if (state.cash < cost) {
    return fail(`Not enough cash for ${what}: need ${formatMoney(cost)}, have ${formatMoney(state.cash)}.`);
  }
  return null;
}

function renumberPriorities(state: GameState): SalesOrder[] {
  const accepted = state.orders
    .filter((o) => o.status === 'accepted')
    .sort((a, b) => a.priority - b.priority || a.id - b.id);
  accepted.forEach((o, i) => (o.priority = i + 1));
  return accepted;
}

export function applyCommand(state: GameState, cmd: Command): CommandResult {
  if (!cmd || typeof cmd !== 'object' || typeof (cmd as { type?: unknown }).type !== 'string') {
    return fail('Unknown command.');
  }
  const tutorialCmd = cmd.type === 'dismissTutorial' || cmd.type === 'showTutorial';
  if (state.gameOver && !tutorialCmd) {
    return fail('The company is bankrupt — start a new game or load a save.');
  }

  switch (cmd.type) {
    // ─────────────── Orders ───────────────
    case 'acceptOrder': {
      const o = findOrder(state, cmd.orderId);
      if (!o) return fail('That order no longer exists.');
      if (o.status !== 'offered') return fail(`Order #${o.id} is ${o.status}; only open offers can be accepted.`);
      if (state.time >= o.offerExpiresAt) return fail(`The offer from ${o.dealer} has expired.`);
      const maxPrio = state.orders.filter((x) => x.status === 'accepted').reduce((m, x) => Math.max(m, x.priority), 0);
      o.status = 'accepted';
      o.acceptedAt = state.time;
      o.priority = maxPrio + 1;
      state.stats.ordersAccepted++;
      logEvent(state, 'info', `Accepted order #${o.id}: ${o.quantity} ${vehicleLabel(state, o.model, o.trim)} for ${o.dealer}, due ${formatTime(o.deadline)}.`);
      allocateReservations(state);
      return ok(`Accepted order #${o.id} — ${o.quantity} ${vehicleLabel(state, o.model, o.trim)} due ${formatTime(o.deadline)}.`);
    }
    case 'declineOrder': {
      const o = findOrder(state, cmd.orderId);
      if (!o) return fail('That order no longer exists.');
      if (o.status !== 'offered') return fail(`Order #${o.id} is ${o.status}; only open offers can be declined.`);
      o.status = 'declined';
      return ok(`Declined the offer from ${o.dealer}.`);
    }
    case 'moveOrderPriority': {
      const o = findOrder(state, cmd.orderId);
      if (!o || o.status !== 'accepted') return fail('Only accepted orders have a priority.');
      if (cmd.dir !== -1 && cmd.dir !== 1) return fail('Invalid direction.');
      const list = renumberPriorities(state);
      const i = list.indexOf(o);
      const j = i + cmd.dir;
      if (j < 0 || j >= list.length) return fail(cmd.dir < 0 ? 'Already the top priority.' : 'Already the lowest priority.');
      const tmp = list[i].priority;
      list[i].priority = list[j].priority;
      list[j].priority = tmp;
      allocateReservations(state);
      return ok(`Order #${o.id} is now priority ${o.priority}.`);
    }
    case 'deliverOrder': {
      const o = findOrder(state, cmd.orderId);
      if (!o) return fail('That order no longer exists.');
      const err = deliverOrderNow(state, o);
      if (err) return fail(err);
      return ok(`Delivered order #${o.id}: invoice ${formatMoney(o.invoiceAmount ?? 0)}.`);
    }
    case 'scheduleForOrder': {
      const o = findOrder(state, cmd.orderId);
      if (!o || o.status !== 'accepted') return fail('Only accepted orders can be scheduled.');
      const p = orderProgress(state, o);
      if (p.shortfall <= 0) return fail(`Order #${o.id} is already fully covered (ready, in production or scheduled).`);
      // Order builds go ahead of unstarted market builds.
      const idx = state.plan.findIndex((j) => j.orderId === null && j.started === 0);
      const job = { id: state.nextId++, model: o.model, trim: o.trim, quantity: p.shortfall, started: 0, orderId: o.id };
      if (idx >= 0) state.plan.splice(idx, 0, job);
      else state.plan.push(job);
      return ok(`Scheduled ${p.shortfall} ${vehicleLabel(state, o.model, o.trim)} for order #${o.id}.`);
    }

    // ─────────────── Production plan ───────────────
    case 'scheduleBuild': {
      if (!isModel(cmd.model)) return fail('Unknown model.');
      if (!TRIM_IDS.includes(cmd.trim)) return fail('Unknown trim.');
      if (!state.product.models[cmd.model].unlocked) {
        return fail(`${modelName(state, cmd.model)} is not in production yet — buy its tooling in the Vehicles tab first.`);
      }
      if (!isPositiveInt(cmd.quantity, 50)) return fail('Quantity must be a whole number from 1 to 50.');
      state.plan.push({ id: state.nextId++, model: cmd.model, trim: cmd.trim, quantity: cmd.quantity, started: 0, orderId: null });
      return ok(`Scheduled ${cmd.quantity} ${vehicleLabel(state, cmd.model, cmd.trim)} for stock / market sale.`);
    }
    case 'moveJob': {
      const i = state.plan.findIndex((j) => j.id === cmd.jobId);
      if (i < 0) return fail('That production job no longer exists.');
      const j = i + (cmd.dir === -1 ? -1 : 1);
      if (j < 0 || j >= state.plan.length) return fail('The job cannot move further.');
      const tmp = state.plan[i];
      state.plan[i] = state.plan[j];
      state.plan[j] = tmp;
      return ok('Production plan reordered.');
    }
    case 'cancelJob': {
      const i = state.plan.findIndex((j) => j.id === cmd.jobId);
      if (i < 0) return fail('That production job no longer exists.');
      const job = state.plan[i];
      state.plan.splice(i, 1);
      const left = job.quantity - job.started;
      return ok(`Cancelled ${left} unstarted ${vehicleLabel(state, job.model, job.trim)} build(s)${job.started > 0 ? '; started cars keep flowing' : ''}.`);
    }

    // ─────────────── Suppliers ───────────────
    case 'purchase': {
      const sup = BALANCE.suppliers.find((s) => s.id === cmd.supplierId);
      if (!sup) return fail('Unknown supplier.');
      if (!COMPONENT_IDS.includes(cmd.component)) return fail('Unknown component.');
      if (!isPositiveInt(cmd.quantity, 999)) return fail('Quantity must be a whole number from 1 to 999.');
      if (supplierOnStrike(state, sup.id)) return fail(`${sup.name} is on strike and not taking orders. Try another supplier.`);
      const unit = supplierUnitPrice(sup.id, cmd.component, state) ?? 0;
      const cost = unit * cmd.quantity;
      const cap = warehouseCapacity(state);
      const used = stockOnHand(state) + incomingUnits(state);
      if (used + cmd.quantity > cap) {
        return fail(`Not enough warehouse space: ${used}/${cap} used (incl. deliveries on the way), room for ${Math.max(0, cap - used)} more.`);
      }
      const noCash = needCash(state, cost, `${cmd.quantity} × ${componentName(cmd.component)}`);
      if (noCash) return noCash;
      postCash(state, 'purchase', `${cmd.quantity} × ${componentName(cmd.component)} from ${sup.name}`, -cost);
      state.shipments.push({
        id: state.nextId++,
        supplierId: sup.id,
        component: cmd.component,
        qty: cmd.quantity,
        unitCost: unit,
        quality: sup.quality,
        orderedAt: state.time,
        arrivesAt: state.time + sup.leadMinutes,
      });
      state.stats.purchases++;
      logEvent(
        state,
        'info',
        `Ordered ${cmd.quantity} × ${componentName(cmd.component)} from ${sup.name} for ${formatMoney(cost)} — arrives ${formatTime(
          state.time + sup.leadMinutes,
        )}.`,
      );
      return ok(`Ordered ${cmd.quantity} × ${componentName(cmd.component)} (${formatMoney(cost)}), arriving ${formatTime(state.time + sup.leadMinutes)}.`);
    }

    case 'purchaseKit': {
      const sup = BALANCE.suppliers.find((s) => s.id === cmd.supplierId);
      if (!sup) return fail('Unknown supplier.');
      if (!isModel(cmd.model) || !TRIM_IDS.includes(cmd.trim)) return fail('Unknown model or trim.');
      if (!isPositiveInt(cmd.cars, 99)) return fail('Cars must be a whole number from 1 to 99.');
      if (supplierOnStrike(state, sup.id)) return fail(`${sup.name} is on strike and not taking orders. Try another supplier.`);
      const kit = kitShortfall(state, cmd.model, cmd.trim, cmd.cars);
      const units = COMPONENT_IDS.reduce((n, c) => n + (kit[c] ?? 0), 0);
      const label = `${cmd.cars} ${vehicleLabel(state, cmd.model, cmd.trim)}`;
      if (units === 0) return fail(`You already have (or have ordered) every part for ${label}.`);
      const cap = warehouseCapacity(state);
      const used = stockOnHand(state) + incomingUnits(state);
      if (used + units > cap) {
        return fail(`Not enough warehouse space for ${units} units: ${used}/${cap} used, room for ${Math.max(0, cap - used)} more.`);
      }
      const cost = kitCost(sup.id, kit, state);
      const noCash = needCash(state, cost, `parts for ${label}`);
      if (noCash) return noCash;
      // Validated as a whole above, so every component purchase below succeeds.
      for (const c of COMPONENT_IDS) {
        const q = kit[c];
        if (q) applyCommand(state, { type: 'purchase', supplierId: sup.id, component: c, quantity: q });
      }
      return ok(`Ordered ${units} parts for ${label} from ${sup.name} (${formatMoney(cost)}), arriving ${formatTime(state.time + sup.leadMinutes)}.`);
    }

    // ─────────────── Staff ───────────────
    case 'hire': {
      if (!ROLES.includes(cmd.role)) return fail('Unknown role.');
      if (!isPositiveInt(cmd.count, 20)) return fail('Hire between 1 and 20 people at a time.');
      const info = BALANCE.staff[cmd.role];
      const cost = info.hireFee * cmd.count;
      const noCash = needCash(state, cost, 'hiring fees');
      if (noCash) return noCash;
      postCash(state, 'hiring', `Hired ${cmd.count} ${cmd.count === 1 ? info.name : info.plural}`, -cost);
      state.staff[cmd.role] += cmd.count;
      // New inspectors go straight to the inspection line that needs them most.
      if (cmd.role === 'inspector') autoAssignInspectors(state, cmd.count);
      return ok(
        `Hired ${cmd.count} ${cmd.count === 1 ? info.name.toLowerCase() : info.plural.toLowerCase()} (${formatMoney(cost)} fee, ${formatMoney(
          Math.round(info.dailyWage * cmd.count * BALANCE.workforce.wages[state.workforce.wage].payMult),
        )}/day wages).`,
      );
    }
    case 'fire': {
      if (!ROLES.includes(cmd.role)) return fail('Unknown role.');
      const info = BALANCE.staff[cmd.role];
      if (state.staff[cmd.role] <= 0) return fail(`You have no ${info.plural.toLowerCase()} to dismiss.`);
      if (cmd.role === 'operator' && unassignedOperators(state) <= 0) {
        return fail('All operators are assigned to stations. Unassign one first.');
      }
      if (cmd.role === 'technician' && freeTechnicians(state) <= 0) {
        return fail('All technicians are busy on service jobs. Wait until a job finishes.');
      }
      const severance = info.dailyWage * BALANCE.staff.severanceDays;
      const noCash = needCash(state, severance, 'severance pay');
      if (noCash) return noCash;
      postCash(state, 'severance', `Severance: ${info.name}`, -severance);
      state.staff[cmd.role] -= 1;
      state.workforce.morale = Math.max(0, state.workforce.morale - BALANCE.workforce.firingMoraleHit);
      if (cmd.role === 'inspector' && unassignedInspectors(state) <= 0 && assignedInspectors(state) > state.staff.inspector) {
        // Take an inspector off the plant that has the most.
        const from = [...state.plants].sort((a, b) => b.stations.inspection.assigned - a.stations.inspection.assigned)[0];
        from.stations.inspection.assigned -= 1;
      }
      const note = cmd.role === 'inspector' && state.staff.inspector === 0 ? ' Inspection is now unstaffed — no cars can pass it.' : '';
      return ok(`Dismissed one ${info.name.toLowerCase()} (severance ${formatMoney(severance)}, morale −${BALANCE.workforce.firingMoraleHit}).${note}`);
    }
    case 'assignOperator': {
      if (!isStation(cmd.station)) return fail('Unknown station.');
      const pr = resolvePlant(state, cmd.plant);
      if (typeof pr === 'string') return fail(pr);
      const st = stationOf(state, cmd.station, pr.plant);
      const where = `${pr.at}${stationName(cmd.station)}`;
      const role = cmd.station === 'inspection' ? 'inspector' : 'operator';
      if (cmd.delta === 1) {
        if (unassignedFor(state, cmd.station) <= 0) {
          return fail(`No free ${role}s. Hire more or move one from another station or plant.`);
        }
        st.assigned += 1;
        return ok(`${where} now has ${st.assigned} ${role}(s).`);
      }
      if (cmd.delta === -1) {
        if (st.assigned <= 0) return fail(`${where} has no ${role}s to remove.`);
        st.assigned -= 1;
        return ok(`${where} now has ${st.assigned} ${role}(s).`);
      }
      return fail('Invalid assignment change.');
    }

    // ─────────────── Equipment ───────────────
    case 'scheduleMaintenance': {
      if (!isStation(cmd.station)) return fail('Unknown station.');
      const pr = resolvePlant(state, cmd.plant);
      if (typeof pr === 'string') return fail(pr);
      const st = stationOf(state, cmd.station, pr.plant);
      const sname = `${pr.at}${stationName(cmd.station)}`;
      const M = BALANCE.equipment.maintenance;
      if (st.broken) return fail(`${sname} is broken — it needs a repair, not maintenance.`);
      if (st.service) return fail(`${sname} is already being serviced.`);
      if (freeTechnicians(state) <= 0) return fail('No free technician. Hire one or wait for the current job to finish.');
      const noCash = needCash(state, M.cost, 'maintenance');
      if (noCash) return noCash;
      postCash(state, 'maintenance', `Maintenance: ${sname}`, -M.cost);
      const mm = Math.max(1, Math.round(M.minutes * technicianTimeMult(state)));
      st.service = { kind: 'maintenance', remaining: mm, total: mm, cost: M.cost };
      logEvent(state, 'info', `Maintenance started on ${sname} (${Math.round(mm / 60)}h).`);
      return ok(`Maintenance started on ${sname} — production pauses there for ${mm} minutes.`);
    }
    case 'repair': {
      if (!isStation(cmd.station)) return fail('Unknown station.');
      const pr = resolvePlant(state, cmd.plant);
      if (typeof pr === 'string') return fail(pr);
      const st = stationOf(state, cmd.station, pr.plant);
      const sname = `${pr.at}${stationName(cmd.station)}`;
      const R = BALANCE.equipment.repair;
      if (!st.broken) return fail(`${sname} is not broken.`);
      if (st.service) return fail(`${sname} is already being repaired.`);
      if (freeTechnicians(state) <= 0) return fail('No free technician. Hire one or wait for the current job to finish.');
      const noCash = needCash(state, R.cost, 'the repair');
      if (noCash) return noCash;
      postCash(state, 'repair', `Repair: ${sname}`, -R.cost);
      const rm = Math.max(1, Math.round(R.minutes * technicianTimeMult(state)));
      st.service = { kind: 'repair', remaining: rm, total: rm, cost: R.cost };
      logEvent(state, 'info', `Repair started on ${sname} (${Math.round(rm / 60)}h).`);
      return ok(`Repair started on ${sname} — back in ${Math.round(rm / 60)}h.`);
    }

    // ─────────────── Upgrades ───────────────
    case 'upgradeCapacity': {
      if (!isStation(cmd.station)) return fail('Unknown station.');
      const pr = resolvePlant(state, cmd.plant);
      if (typeof pr === 'string') return fail(pr);
      const sname = `${pr.at}${stationName(cmd.station)}`;
      const cost = nextUpgradeCost(state, 'capacity', cmd.station, pr.plant);
      if (cost === null) return fail(`${sname} capacity is already at the maximum level.`);
      const noCash = needCash(state, cost, 'the capacity upgrade');
      if (noCash) return noCash;
      const st = stationOf(state, cmd.station, pr.plant);
      postCash(state, 'upgrade', `Capacity upgrade: ${sname} level ${st.capacityLevel + 1}`, -cost);
      st.capacityLevel += 1;
      st.slots.push(null);
      logEvent(state, 'good', `${sname} expanded to ${st.slots.length} work slots.`);
      return ok(
        `${sname} now has ${st.slots.length} work slots — staff it with ${
          BALANCE.stations[cmd.station].staffPerSlot * st.slots.length
        } ${cmd.station === 'inspection' ? 'inspectors' : 'operators'} for full speed.`,
      );
    }
    case 'upgradeReliability': {
      if (!isStation(cmd.station)) return fail('Unknown station.');
      const pr = resolvePlant(state, cmd.plant);
      if (typeof pr === 'string') return fail(pr);
      const sname = `${pr.at}${stationName(cmd.station)}`;
      const cost = nextUpgradeCost(state, 'reliability', cmd.station, pr.plant);
      if (cost === null) return fail(`${sname} reliability is already at the maximum level.`);
      const noCash = needCash(state, cost, 'the reliability upgrade');
      if (noCash) return noCash;
      const st = stationOf(state, cmd.station, pr.plant);
      postCash(state, 'upgrade', `Reliability upgrade: ${sname} level ${st.reliabilityLevel + 1}`, -cost);
      st.reliabilityLevel += 1;
      logEvent(state, 'good', `${sname} reliability upgraded to level ${st.reliabilityLevel}.`);
      return ok(`${sname} reliability is now level ${st.reliabilityLevel}: less wear, fewer breakdowns.`);
    }
    case 'upgradeWarehouse': {
      const cost = nextWarehouseCost(state);
      if (cost === null) return fail('The warehouse is already at the maximum level.');
      const noCash = needCash(state, cost, 'the warehouse expansion');
      if (noCash) return noCash;
      postCash(state, 'upgrade', `Warehouse expansion level ${state.warehouseLevel + 1}`, -cost);
      state.warehouseLevel += 1;
      logEvent(state, 'good', `Warehouse expanded: ${warehouseCapacity(state)} component spaces.`);
      return ok(`Warehouse expanded to ${warehouseCapacity(state)} component spaces and a bigger yard.`);
    }

    // ─────────────── Plants ───────────────
    case 'buildPlant': {
      const site = nextPlantSite(state);
      const blocker = buildPlantBlocker(state);
      if (!site || blocker) return fail(blocker ?? 'No site available.');
      postCash(state, 'upgrade', `New plant: ${site.name}`, -site.cost);
      state.plants.push(newPlant(site.index, site.name, BALANCE.plants.constructionMinutes));
      logEvent(
        state,
        'good',
        `Construction started on the ${site.name} plant — ready in ${Math.round(BALANCE.plants.constructionMinutes / 1440)} days.`,
      );
      return ok(`Building the ${site.name} plant (${formatMoney(site.cost)}). Hire staff for it while it is built.`);
    }
    case 'setPlantModel': {
      const pr = resolvePlant(state, cmd.plant);
      if (typeof pr === 'string') return fail(pr);
      if (!isModel(cmd.model)) return fail('Unknown model.');
      const p = plantOf(state, pr.plant);
      const has = p.allowedModels.includes(cmd.model);
      if (cmd.allowed && !has) p.allowedModels.push(cmd.model);
      if (!cmd.allowed && has) {
        if (p.allowedModels.length <= 1) return fail(`${p.name} must be allowed to build at least one model.`);
        p.allowedModels = p.allowedModels.filter((m) => m !== cmd.model);
      }
      return ok(`${p.name} ${cmd.allowed ? 'will' : 'will not'} start ${modelName(state, cmd.model)} builds.`);
    }

    // ─────────────── Product ───────────────
    case 'unlockModel': {
      if (!isModel(cmd.model)) return fail('Unknown model.');
      const blocker = unlockBlocker(state, cmd.model);
      if (blocker) return fail(blocker);
      const spec = BALANCE.models[cmd.model];
      const name = modelName(state, cmd.model);
      postCash(state, 'upgrade', `Tooling for ${name} ${spec.className}`, -spec.unlockCost);
      state.product.models[cmd.model].unlocked = true;
      logEvent(state, 'good', `${name} ${spec.className} tooling installed — schedule builds and watch for dealer orders.`);
      return ok(`${name} ${spec.className} is now in production. Stations retool when they switch models, so batch builds.`);
    }
    case 'setProductName': {
      if (!isModel(cmd.model)) return fail('Unknown model.');
      const name = typeof cmd.name === 'string' ? cmd.name.trim() : '';
      if (name.length < 1 || name.length > 24) return fail('Model name must be 1–24 characters.');
      state.product.models[cmd.model].name = name;
      return ok(`${BALANCE.models[cmd.model].className} renamed to ${name}.`);
    }
    case 'setColor': {
      if (!isModel(cmd.model)) return fail('Unknown model.');
      const c = BALANCE.colors.find((x) => x.id === cmd.colorId);
      if (!c) return fail('Unknown colour.');
      state.product.models[cmd.model].colorId = c.id;
      return ok(`New ${modelName(state, cmd.model)} cars will be painted ${c.name}.`);
    }
    case 'setFinish': {
      if (!isModel(cmd.model)) return fail('Unknown model.');
      if (!TRIM_IDS.includes(cmd.trim)) return fail('Unknown trim.');
      if (!FINISH_IDS.includes(cmd.finish)) return fail('Unknown finish.');
      state.product.models[cmd.model].finish[cmd.trim] = cmd.finish;
      return ok(
        `New ${vehicleLabel(state, cmd.model, cmd.trim)} cars will get a ${BALANCE.finishes[cmd.finish].name.toLowerCase()} finish.`,
      );
    }
    case 'setPrice': {
      if (!isModel(cmd.model)) return fail('Unknown model.');
      if (!TRIM_IDS.includes(cmd.trim)) return fail('Unknown trim.');
      if (typeof cmd.price !== 'number' || !Number.isFinite(cmd.price)) return fail('Price must be a number.');
      const price = Math.round(cmd.price);
      const base = trimSpec(cmd.model, cmd.trim).baseValue;
      const min = Math.round(base * 0.3);
      const max = Math.round(base * 3);
      if (price < min || price > max) return fail(`Price must be between ${formatMoney(min)} and ${formatMoney(max)}.`);
      state.product.models[cmd.model].price[cmd.trim] = price;
      return ok(`${vehicleLabel(state, cmd.model, cmd.trim)} market price set to ${formatMoney(price)}.`);
    }
    case 'setMarketListed': {
      if (!isModel(cmd.model)) return fail('Unknown model.');
      if (!TRIM_IDS.includes(cmd.trim)) return fail('Unknown trim.');
      state.product.models[cmd.model].marketListed[cmd.trim] = !!cmd.listed;
      const label = vehicleLabel(state, cmd.model, cmd.trim);
      return ok(
        cmd.listed ? `Unreserved ${label} cars are now for sale on the open market.` : `${label} cars are no longer offered on the open market.`,
      );
    }

    // ─────────────── Research ───────────────
    case 'startResearch': {
      const p = BALANCE.research.projects[cmd.project];
      if (!p) return fail('Unknown research project.');
      const blocker = researchBlocker(state, cmd.project);
      if (blocker) return fail(blocker);
      postCash(state, 'research', `Research: ${p.name}`, -p.cost);
      state.research.active = { id: cmd.project, remaining: p.minutes, total: p.minutes };
      logEvent(state, 'info', `R&D started ${p.name} — done in ${Math.round(p.minutes / 60)}h.`);
      return ok(`Started ${p.name} (${formatMoney(p.cost)}). The lab finishes it in ${Math.round(p.minutes / 60)} game hours.`);
    }
    case 'cancelResearch': {
      const a = state.research.active;
      if (!a) return fail('The R&D lab has no active project.');
      const name = BALANCE.research.projects[a.id]?.name ?? a.id;
      state.research.active = null;
      logEvent(state, 'warn', `R&D project ${name} cancelled; its cost is not refunded.`);
      return ok(`Cancelled ${name}. Its cost is not refunded.`);
    }

    // ─────────────── Tutorial ───────────────
    // ─────────────── Loans ───────────────
    case 'takeLoan': {
      const offer = BALANCE.loans.offers[cmd.offer];
      const blocked = loanBlocker(state, cmd.offer);
      if (!offer || blocked) return fail(blocked ?? 'Unknown loan.');
      const payment = loanPayment(offer.amount, offer.dailyRate, offer.days);
      state.loans.push({
        id: state.nextId++,
        name: offer.name,
        principal: offer.amount,
        balance: offer.amount,
        dailyRate: offer.dailyRate,
        dailyPayment: payment,
        takenAt: state.time,
      });
      postCash(state, 'loan', `Loan received: ${offer.name}`, offer.amount);
      logEvent(state, 'info', `Took a ${offer.name.toLowerCase()} of ${formatMoney(offer.amount)}: ${formatMoney(payment)} a day for ${offer.days} days.`, 'loan');
      return ok(`Received ${formatMoney(offer.amount)}. Repayments of ${formatMoney(payment)} are taken every midnight.`);
    }
    case 'repayLoan': {
      const loan = state.loans.find((l) => l.id === cmd.loanId);
      if (!loan) return fail('That loan no longer exists.');
      const noCash = needCash(state, loan.balance, 'repaying the loan');
      if (noCash) return noCash;
      postCash(state, 'loan', `Early repayment: ${loan.name}`, -loan.balance);
      state.loans = state.loans.filter((l) => l !== loan);
      logEvent(state, 'good', `Repaid the ${loan.name.toLowerCase()} early.`, 'loan');
      return ok(`${loan.name} repaid. No more interest on it.`);
    }

    // ─────────────── Workforce ───────────────
    case 'setWage': {
      if (!WAGE_LEVELS.includes(cmd.level)) return fail('Unknown wage level.');
      if (state.workforce.wage === cmd.level) return fail('Wages are already at that level.');
      state.workforce.wage = cmd.level;
      const w = BALANCE.workforce.wages[cmd.level];
      logEvent(state, 'info', `Wages set to ${w.label.toLowerCase()}. Morale will drift toward ${w.moraleTarget} over the next days.`);
      return ok(`Wages: ${w.label}. Morale heads toward ${w.moraleTarget}.`);
    }
    case 'startTraining': {
      if (!ROLES.includes(cmd.role)) return fail('Unknown role.');
      const blocked = trainingBlocker(state, cmd.role);
      if (blocked) return fail(blocked);
      const cost = trainingCost(state, cmd.role)!;
      const lvl = state.workforce.training[cmd.role];
      const minutes = BALANCE.workforce.training.minutes[lvl];
      postCash(state, 'hiring', `Training course: ${BALANCE.staff[cmd.role].plural} level ${lvl + 1}`, -cost);
      state.workforce.course = { role: cmd.role, remaining: minutes, total: minutes };
      return ok(`Training started: ${BALANCE.staff[cmd.role].plural} level ${lvl + 1}, ${Math.round(minutes / 60)}h.`);
    }

    case 'dismissTutorial':
      state.tutorial.dismissed = true;
      return ok();
    case 'showTutorial':
      state.tutorial.dismissed = false;
      return ok();

    default: {
      const t = (cmd as { type: string }).type;
      return fail(`Unknown command "${t}".`);
    }
  }
}
