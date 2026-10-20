import { COMPONENT_IDS, MODEL_IDS, STATION_IDS } from '../config/balance';
import { defaultModelConfig } from './initialState';
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
  if (isObj(data.product)) {
    const models = data.product.models;
    if (!isObj(models) || MODEL_IDS.some((m) => !isObj(models[m]))) problems.push('product.models');
  }
  for (const k of ['product', 'inventory', 'stations', 'rework', 'vehicles', 'staff', 'finance', 'stats', 'tutorial']) {
    if (!isObj(data[k])) problems.push(k);
  }
  if (problems.length === 0) {
    const stations = data.stations as Record<string, unknown>;
    for (const id of STATION_IDS) {
      const st = stations[id];
      if (!isObj(st) || !Array.isArray(st.slots) || !Array.isArray(st.queue) || !isNum(st.condition)) {
        problems.push(`stations.${id}`);
      }
    }
    const inv = data.inventory as Record<string, unknown>;
    for (const c of COMPONENT_IDS) {
      const s = inv[c];
      if (!isObj(s) || !isNum(s.qty) || !isNum(s.value) || !isNum(s.qualitySum)) problems.push(`inventory.${c}`);
    }
    const fin = data.finance as Record<string, unknown>;
    if (!Array.isArray(fin.ledger) || !isNum(fin.startingCash) || !isObj(fin.opex) || !isObj(fin.today)) {
      problems.push('finance');
    }
    const rw = data.rework as Record<string, unknown>;
    if (!Array.isArray(rw.queue)) problems.push('rework');
  }
  if (problems.length > 0) {
    throw new Error(`The save file is damaged or incomplete (bad fields: ${problems.slice(0, 5).join(', ')}).`);
  }
  const state = data as unknown as GameState;
  if (typeof state.gameOver !== 'boolean') state.gameOver = false;
  if (state.gameOverReason === undefined) state.gameOverReason = null;
  if (state.insolventSince === undefined) state.insolventSince = null;
  return state;
}
