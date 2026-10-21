import { BALANCE, COMPONENT_IDS, MODEL_IDS, STATION_IDS } from '../config/balance';
import { checkGoals } from './events';
import { createMarket, defaultModelConfig, newWorkforce } from './initialState';
import type { GameState, ModelConfig, ModelId } from './types';
import { SAVE_VERSION } from './types';

export function serialize(state: GameState): string {
  return JSON.stringify(state);
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * v1 → v2: vehicle models. Everything that existed in v1 was the sedan; the single product
 * config becomes the sedan's settings and the other models start locked.
 */
function migrateV1(data: Record<string, unknown>): void {
  const asList = (x: unknown) => (Array.isArray(x) ? (x as Record<string, unknown>[]) : []);
  if (isObj(data.vehicles)) for (const v of Object.values(data.vehicles)) if (isObj(v)) v.model = 'sedan';
  for (const o of asList(data.orders)) if (isObj(o)) o.model = 'sedan';
  for (const j of asList(data.plan)) if (isObj(j)) j.model = 'sedan';
  if (isObj(data.stations)) {
    for (const st of Object.values(data.stations)) {
      if (!isObj(st)) continue;
      const busy = asList(st.slots).some((x) => isObj(x)) || asList(st.queue).length > 0;
      st.lastModel = busy || (typeof st.completedTotal === 'number' && st.completedTotal > 0) ? 'sedan' : null;
      for (const slot of asList(st.slots)) if (isObj(slot)) slot.changeover = 0;
    }
  }
  if (isObj(data.rework) && isObj(data.rework.slot)) data.rework.slot.changeover = 0;
  const old = isObj(data.product) ? data.product : {};
  const models = {} as Record<ModelId, ModelConfig>;
  for (const m of MODEL_IDS) models[m] = defaultModelConfig(m, m === 'sedan');
  const sedan = models.sedan;
  if (typeof old.name === 'string') sedan.name = old.name;
  if (typeof old.colorId === 'string') sedan.colorId = old.colorId;
  if (isObj(old.finish)) Object.assign(sedan.finish, old.finish);
  if (isObj(old.price)) Object.assign(sedan.price, old.price);
  if (isObj(old.marketListed)) Object.assign(sedan.marketListed, old.marketListed);
  data.product = { models };
  data.version = 2;
}

/** v2 → v3: rival manufacturers. Rivals start fresh; existing offers are not contested. */
function migrateV2(data: Record<string, unknown>): void {
  const time = typeof data.time === 'number' ? data.time : 0;
  data.market = createMarket(time);
  if (Array.isArray(data.orders)) {
    for (const o of data.orders) {
      if (!isObj(o)) continue;
      o.contested = false;
      o.lostTo = null;
    }
  }
  data.version = 3;
}

/**
 * v4 → v5: multiple plants. The old single factory becomes plant 0 ("Riverside"); every inspector is
 * assigned to it (inspection used to take all inspectors); every vehicle belongs to it.
 */
function migrateV4(data: Record<string, unknown>): void {
  const stations = data.stations;
  if (isObj(stations) && isObj(stations.inspection) && isObj(data.staff)) {
    stations.inspection.assigned = typeof data.staff.inspector === 'number' ? data.staff.inspector : 0;
  }
  data.plants = [
    {
      id: 0,
      name: BALANCE.plants.sites[0].name,
      stations,
      rework: data.rework,
      allowedModels: [...MODEL_IDS],
      constructionRemaining: 0,
    },
  ];
  delete data.stations;
  delete data.rework;
  if (isObj(data.vehicles)) for (const v of Object.values(data.vehicles)) if (isObj(v)) v.plant = 0;
  data.version = 5;
}

/**
 * v5 → v6: goals, random events, loans and the workforce. Old games play the standard scenario; milestones
 * already reached are recorded quietly after loading.
 */
function migrateV5(data: Record<string, unknown>): void {
  data.goals = { scenario: 'standard', completed: {}, wonAt: null, catchUp: true };
  data.incidents = [];
  data.loans = [];
  data.workforce = newWorkforce();
  if (isObj(data.finance) && isObj(data.finance.opex)) data.finance.opex.interest = 0;
  data.version = 6;
}

/** Parse and validate a saved game. Throws an Error with a readable message on bad data. */
export function deserialize(json: string): GameState {
  if (typeof json !== 'string' || json.trim() === '') throw new Error('The save is empty.');
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('The save file is corrupted (not valid JSON).');
  }
  if (!isObj(data)) throw new Error('The save file does not contain a MotorWorx game.');
  if (data.version === 1) migrateV1(data);
  if (data.version === 2) migrateV2(data);
  if (data.version === 3) {
    // v3 → v4: research lab. Nothing researched yet; the new expense category starts at 0.
    data.research = { completed: [], active: null };
    if (isObj(data.finance) && isObj(data.finance.opex)) data.finance.opex.research = 0;
    data.version = 4;
  }
  if (data.version === 4) migrateV4(data);
  if (data.version === 5) migrateV5(data);
  if (data.version !== SAVE_VERSION) {
    throw new Error(
      `This save was made by an incompatible version of MotorWorx (save version ${String(
        data.version ?? 'unknown',
      )}, expected ${SAVE_VERSION}).`,
    );
  }
  const problems: string[] = [];
  for (const k of ['time', 'rng', 'nextId', 'cash', 'reputation', 'warehouseLevel']) {
    if (!isNum(data[k])) problems.push(k);
  }
  for (const k of ['shipments', 'yard', 'orders', 'plan', 'events']) {
    if (!Array.isArray(data[k])) problems.push(k);
  }
  if (!isObj(data.research) || !Array.isArray(data.research.completed)) problems.push('research');
  if (!isObj(data.market) || !Array.isArray(data.market.rivals) || !isObj(data.market.today)) problems.push('market');
  if (isObj(data.product)) {
    const models = data.product.models;
    if (!isObj(models) || MODEL_IDS.some((m) => !isObj(models[m]))) problems.push('product.models');
  }
  if (!Array.isArray(data.plants) || data.plants.length === 0) problems.push('plants');
  if (!isObj(data.goals) || !isObj(data.goals.completed) || !(typeof data.goals.scenario === 'string' && data.goals.scenario in BALANCE.scenarios)) problems.push('goals');
  if (!Array.isArray(data.incidents)) problems.push('incidents');
  if (!Array.isArray(data.loans)) problems.push('loans');
  if (!isObj(data.workforce) || !isNum(data.workforce.morale) || !isObj(data.workforce.training)) problems.push('workforce');
  for (const k of ['product', 'inventory', 'vehicles', 'staff', 'finance', 'stats', 'tutorial']) {
    if (!isObj(data[k])) problems.push(k);
  }
  if (problems.length === 0) {
    (data.plants as unknown[]).forEach((p, i) => {
      if (!isObj(p) || !isObj(p.stations) || !isObj(p.rework) || !Array.isArray(p.rework.queue) || !Array.isArray(p.allowedModels)) {
        problems.push(`plants.${i}`);
        return;
      }
      const stations = p.stations;
      for (const id of STATION_IDS) {
        const st = stations[id];
        if (!isObj(st) || !Array.isArray(st.slots) || !Array.isArray(st.queue) || !isNum(st.condition)) {
          problems.push(`plants.${i}.stations.${id}`);
        }
      }
    });
    const inv = data.inventory as Record<string, unknown>;
    for (const c of COMPONENT_IDS) {
      const s = inv[c];
      if (!isObj(s) || !isNum(s.qty) || !isNum(s.value) || !isNum(s.qualitySum)) problems.push(`inventory.${c}`);
    }
    const fin = data.finance as Record<string, unknown>;
    if (!Array.isArray(fin.ledger) || !isNum(fin.startingCash) || !isObj(fin.opex) || !isObj(fin.today)) {
      problems.push('finance');
    }
  }
  if (problems.length > 0) {
    throw new Error(`The save file is damaged or incomplete (bad fields: ${problems.slice(0, 5).join(', ')}).`);
  }
  const state = data as unknown as GameState;
  if (typeof state.gameOver !== 'boolean') state.gameOver = false;
  if (state.gameOverReason === undefined) state.gameOverReason = null;
  if (state.insolventSince === undefined) state.insolventSince = null;
  const goals = state.goals as typeof state.goals & { catchUp?: boolean };
  if (goals.catchUp) {
    delete goals.catchUp;
    checkGoals(state, true);
  }
  return state;
}
