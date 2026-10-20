import { BALANCE, type ComponentId, type ModelId, type StationId, type TrimId } from '../config/balance';
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

/** Units of a component one vehicle of `model`/`trim` consumes, given its finish. */
export function componentsPerVehicle(
  model: ModelId,
  trim: TrimId,
  finishId: keyof typeof BALANCE.finishes,
  c: ComponentId,
): number {
  const recipe = BALANCE.models[model].trims[trim].recipe;
  let total = 0;
  for (const st of Object.keys(recipe) as StationId[]) {
    const q = recipe[st]?.[c] ?? 0;
    total += st === 'paint' ? q * BALANCE.finishes[finishId].paintMult : q;
  }
  return total;
}

/** True when a keyboard event originated in an editable control. */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}
