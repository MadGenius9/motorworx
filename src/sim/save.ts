import { COMPONENT_IDS, STATION_IDS } from '../config/balance';
import type { GameState } from './types';
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
