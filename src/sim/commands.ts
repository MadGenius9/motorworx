/**
 * Player commands. `applyCommand` validates, mutates state and returns a player-facing result.
 * Commands never advance time, so they work while paused.
 */
import { BALANCE, COMPONENT_IDS, FINISH_IDS, STATION_IDS, TRIM_IDS } from '../config/balance';
import type { Command, CommandResult } from './commandTypes';
import { allocateReservations, deliverOrderNow } from './engine';
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
  researchBlocker,
  stationName,
  isModel,
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
      const unit = Math.round(BALANCE.components[cmd.component].basePrice * sup.priceMult);
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
      return ok(
        `Hired ${cmd.count} ${cmd.count === 1 ? info.name.toLowerCase() : info.plural.toLowerCase()} (${formatMoney(cost)} fee, ${formatMoney(
          info.dailyWage * cmd.count,
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
      const note = cmd.role === 'inspector' && state.staff.inspector === 0 ? ' Inspection is now unstaffed — no cars can pass it.' : '';
      return ok(`Dismissed one ${info.name.toLowerCase()} (severance ${formatMoney(severance)}).${note}`);
    }
    case 'assignOperator': {
      if (!isStation(cmd.station)) return fail('Unknown station.');
      if (cmd.station === 'inspection') return fail('Quality Inspection is staffed by inspectors, not operators.');
      const st = state.stations[cmd.station];
      if (cmd.delta === 1) {
        if (unassignedOperators(state) <= 0) return fail('No free operators. Hire more or unassign one elsewhere.');
        st.assigned += 1;
        return ok(`${stationName(cmd.station)} now has ${st.assigned} operator(s).`);
      }
      if (cmd.delta === -1) {
        if (st.assigned <= 0) return fail(`${stationName(cmd.station)} has no operators to remove.`);
        st.assigned -= 1;
        return ok(`${stationName(cmd.station)} now has ${st.assigned} operator(s).`);
      }
      return fail('Invalid assignment change.');
    }

    // ─────────────── Equipment ───────────────
    case 'scheduleMaintenance': {
      if (!isStation(cmd.station)) return fail('Unknown station.');
      const st = state.stations[cmd.station];
      const M = BALANCE.equipment.maintenance;
      if (st.broken) return fail(`${stationName(cmd.station)} is broken — it needs a repair, not maintenance.`);
      if (st.service) return fail(`${stationName(cmd.station)} is already being serviced.`);
      if (freeTechnicians(state) <= 0) return fail('No free technician. Hire one or wait for the current job to finish.');
      const noCash = needCash(state, M.cost, 'maintenance');
      if (noCash) return noCash;
      postCash(state, 'maintenance', `Maintenance: ${stationName(cmd.station)}`, -M.cost);
      st.service = { kind: 'maintenance', remaining: M.minutes, total: M.minutes, cost: M.cost };
      logEvent(state, 'info', `Maintenance started on ${stationName(cmd.station)} (${Math.round(M.minutes / 60)}h).`);
      return ok(`Maintenance started on ${stationName(cmd.station)} — production pauses there for ${M.minutes} minutes.`);
    }
    case 'repair': {
      if (!isStation(cmd.station)) return fail('Unknown station.');
      const st = state.stations[cmd.station];
      const R = BALANCE.equipment.repair;
      if (!st.broken) return fail(`${stationName(cmd.station)} is not broken.`);
      if (st.service) return fail(`${stationName(cmd.station)} is already being repaired.`);
      if (freeTechnicians(state) <= 0) return fail('No free technician. Hire one or wait for the current job to finish.');
      const noCash = needCash(state, R.cost, 'the repair');
      if (noCash) return noCash;
      postCash(state, 'repair', `Repair: ${stationName(cmd.station)}`, -R.cost);
      st.service = { kind: 'repair', remaining: R.minutes, total: R.minutes, cost: R.cost };
      logEvent(state, 'info', `Repair started on ${stationName(cmd.station)} (${Math.round(R.minutes / 60)}h).`);
      return ok(`Repair started on ${stationName(cmd.station)} — back in ${Math.round(R.minutes / 60)}h.`);
    }

    // ─────────────── Upgrades ───────────────
    case 'upgradeCapacity': {
      if (!isStation(cmd.station)) return fail('Unknown station.');
      const cost = nextUpgradeCost(state, 'capacity', cmd.station);
      if (cost === null) return fail(`${stationName(cmd.station)} capacity is already at the maximum level.`);
      const noCash = needCash(state, cost, 'the capacity upgrade');
      if (noCash) return noCash;
      const st = state.stations[cmd.station];
      postCash(state, 'upgrade', `Capacity upgrade: ${stationName(cmd.station)} level ${st.capacityLevel + 1}`, -cost);
      st.capacityLevel += 1;
      st.slots.push(null);
      logEvent(state, 'good', `${stationName(cmd.station)} expanded to ${st.slots.length} work slots.`);
      return ok(
        `${stationName(cmd.station)} now has ${st.slots.length} work slots — staff it with ${
          BALANCE.stations[cmd.station].staffPerSlot * st.slots.length
        } ${cmd.station === 'inspection' ? 'inspectors' : 'operators'} for full speed.`,
      );
    }
    case 'upgradeReliability': {
      if (!isStation(cmd.station)) return fail('Unknown station.');
      const cost = nextUpgradeCost(state, 'reliability', cmd.station);
      if (cost === null) return fail(`${stationName(cmd.station)} reliability is already at the maximum level.`);
      const noCash = needCash(state, cost, 'the reliability upgrade');
      if (noCash) return noCash;
      const st = state.stations[cmd.station];
      postCash(state, 'upgrade', `Reliability upgrade: ${stationName(cmd.station)} level ${st.reliabilityLevel + 1}`, -cost);
      st.reliabilityLevel += 1;
      logEvent(state, 'good', `${stationName(cmd.station)} reliability upgraded to level ${st.reliabilityLevel}.`);
      return ok(`${stationName(cmd.station)} reliability is now level ${st.reliabilityLevel}: less wear, fewer breakdowns.`);
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
