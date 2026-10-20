import { BALANCE, STATION_IDS, type ComponentId, type ModelId, type StationId, type TrimId } from '../config/balance';
import { recipeFor } from '../sim/selectors';
import type { GameState } from '../sim/types';
export { formatMoney, formatDuration, formatTime, clockOf, dayOf, stationName } from '../sim/selectors';

export function pct(x: number, digits = 0): string {
  return `${(x * 100).toFixed(digits)}%`;
}

export function num(n: number, digits = 0): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function trimName(t: TrimId): string {
  return BALANCE.trims[t].name;
}

export function componentName(c: ComponentId): string {
  return BALANCE.components[c].name;
}

export function colorHex(colorId: string): string {
  return BALANCE.colors.find((c) => c.id === colorId)?.hex ?? '#888';
}

export const NEXT_STATION: Record<StationId, string> = {
  stamping: 'Body Assembly',
  body: 'Paint',
  paint: 'Final Assembly',
  final: 'Quality Inspection',
  inspection: 'Yard / Rework',
};

/** Units of a component one vehicle of `model`/`trim` consumes, given its finish (and research, with `state`). */
export function componentsPerVehicle(
  model: ModelId,
  trim: TrimId,
  finishId: keyof typeof BALANCE.finishes,
  c: ComponentId,
  state?: GameState,
): number {
  let total = 0;
  for (const st of STATION_IDS) total += recipeFor(model, trim, st, finishId, state)[c] ?? 0;
  return total;
}

/** True when a keyboard event originated in an editable control. */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}
