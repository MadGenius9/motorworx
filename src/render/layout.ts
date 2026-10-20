/**
 * Factory floor layout in world units (≈ CSS px at zoom 1).
 * Pure functions of the (read-only) game state: recomputed every frame, cheap.
 */
import { BALANCE, COMPONENT_IDS, STATION_IDS } from '../config/balance';
import type { ComponentId, FinishId, ModelId, StationId, TrimId } from '../config/balance';
import type { GameState, WorkSlot } from '../sim/types';
import { queueCapacity, yardCapacity } from '../sim/selectors';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StationLayout {
  id: StationId;
  /** Station machine box (header + slot rows). */
  box: Rect;
  /** Header area inside the box (name, status, staff, condition). */
  header: Rect;
  /** One rect per work slot (row inside the box). */
  slots: Rect[];
  /** Input queue column in front of the box (null for stamping). */
  queue: Rect | null;
  /** One rect per queue space, front of queue first (index 0 nearest the conveyor). */
  queueSpots: Rect[];
}

export interface ReworkLayout {
  box: Rect;
  queueSpots: Rect[];
  slot: Rect;
}

export interface YardLayout {
  box: Rect;
  spots: Rect[];
  cols: number;
}

export interface WarehouseLayout {
  box: Rect;
  bars: { component: ComponentId; rect: Rect }[];
}

export interface DockLayout {
  box: Rect;
  /** Truck lanes (one shipment per lane, soonest first). */
  lanes: Rect[];
}

export interface PlanLayout {
  box: Rect;
  rows: Rect[];
}

export interface FactoryLayout {
  /** World bounds of the whole factory including margin. */
  bounds: Rect;
  /** Floor rect (inside bounds). */
  floor: Rect;
  stations: Record<StationId, StationLayout>;
  rework: ReworkLayout;
  yard: YardLayout;
  warehouse: WarehouseLayout;
  dock: DockLayout;
  plan: PlanLayout;
  sign: Rect;
  /** y of the main conveyor centre line (row 0 of every station). */
  conveyorY: number;
  /** Walkway line y positions (safety-yellow). */
  walkwaysY: number[];
}

// ---- Geometry constants (world units) ----
export const G = {
  margin: 20,
  topY: 20,
  topH: 150,
  lineTop: 214,
  header: 72,
  rowH: 62,
  boxW: 132,
  queueW: 70,
  queueGap: 6,
  stationGap: 18,
  queueSpotH: 44,
  yardSpotW: 66,
  yardSpotH: 40,
  yardHeader: 26,
  maxSlots: 3,
  /** Vehicle nominal length at scale 1. */
  carLen: 72,
} as const;

const MAX_QUEUE = BALANCE.queue.baseCapacity + BALANCE.queue.perCapacityLevel * (G.maxSlots - 1);

export function computeLayout(state: GameState): FactoryLayout {
  const stations = {} as Record<StationId, StationLayout>;
  let x = G.margin;
  const rowsTop = G.lineTop + G.header;
  const conveyorY = rowsTop + G.rowH / 2;

  for (const id of STATION_IDS) {
    const st = state.stations[id];
    const nSlots = Math.max(1, Math.min(G.maxSlots, st.slots.length));
    let queue: Rect | null = null;
    const queueSpots: Rect[] = [];
    if (id !== 'stamping') {
      const cap = Math.max(0, Math.min(MAX_QUEUE + 4, queueCapacity(state, id)));
      const spotsTop = conveyorY - G.queueSpotH / 2;
      queue = { x, y: spotsTop - 20, w: G.queueW, h: 20 + Math.max(1, cap) * G.queueSpotH + 4 };
      for (let i = 0; i < cap; i++) {
        queueSpots.push({ x: x + 3, y: spotsTop + i * G.queueSpotH, w: G.queueW - 6, h: G.queueSpotH - 2 });
      }
      x += G.queueW + G.queueGap;
    }
    const box: Rect = { x, y: G.lineTop, w: G.boxW, h: G.header + nSlots * G.rowH + 8 };
    const header: Rect = { x, y: G.lineTop, w: G.boxW, h: G.header };
    const slots: Rect[] = [];
    for (let i = 0; i < nSlots; i++) {
      slots.push({ x: x + 6, y: rowsTop + i * G.rowH + 2, w: G.boxW - 12, h: G.rowH - 4 });
    }
    stations[id] = { id, box, header, slots, queue, queueSpots };
    x += G.boxW + G.stationGap;
  }

  // Rework bay: below inspection, fixed y so it does not jump when slots change.
  const insp = stations.inspection;
  const maxBoxBottom = G.lineTop + G.header + G.maxSlots * G.rowH + 8;
  // One extra spot: the sim may briefly hold capacity + 1 cars to avoid a rework/inspection gridlock.
  const rwW = 300 + 64;
  const rwX = insp.box.x + insp.box.w - rwW;
  const rwY = maxBoxBottom + 22;
  const rwBox: Rect = { x: rwX, y: rwY, w: rwW, h: 96 };
  const rwQueue: Rect[] = [];
  for (let i = 0; i < BALANCE.quality.reworkQueueCapacity + 1; i++) {
    rwQueue.push({ x: rwX + 8 + i * 64, y: rwY + 30, w: 60, h: 56 });
  }
  const rwSlot: Rect = { x: rwX + rwW - 100, y: rwY + 26, w: 92, h: 62 };

  // Yard: right of inspection.
  const ycap = Math.max(1, yardCapacity(state));
  const cols = ycap > 18 ? 4 : 3;
  const rows = Math.ceil(ycap / cols);
  const yardX = x + 2;
  const yardBox: Rect = {
    x: yardX,
    y: G.lineTop,
    w: cols * G.yardSpotW + 14,
    h: G.yardHeader + rows * G.yardSpotH + 10,
  };
  const spots: Rect[] = [];
  for (let i = 0; i < ycap; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    spots.push({
      x: yardX + 7 + c * G.yardSpotW,
      y: G.lineTop + G.yardHeader + r * G.yardSpotH,
      w: G.yardSpotW - 4,
      h: G.yardSpotH - 4,
    });
  }

  // Top band: warehouse, dock, plan board, sign.
  const lineRight = Math.max(yardBox.x + yardBox.w, insp.box.x + insp.box.w);
  const whBox: Rect = { x: G.margin, y: G.topY, w: 330, h: G.topH };
  const bars = COMPONENT_IDS.map((component, i) => ({
    component,
    rect: { x: whBox.x + 96, y: whBox.y + 46 + i * 20, w: whBox.w - 150, h: 12 },
  }));
  const dockBox: Rect = { x: whBox.x + whBox.w + 16, y: G.topY, w: 330, h: G.topH };
  const lanes: Rect[] = [];
  for (let i = 0; i < 4; i++) lanes.push({ x: dockBox.x + 8, y: dockBox.y + 30 + i * 28, w: dockBox.w - 70, h: 26 });
  const planX = dockBox.x + dockBox.w + 16;
  const signW = 200;
  const planW = Math.max(240, lineRight - planX - signW - 16);
  const planBox: Rect = { x: planX, y: G.topY, w: planW, h: G.topH };
  const planRows: Rect[] = [];
  for (let i = 0; i < 5; i++) planRows.push({ x: planX + 10, y: planBox.y + 32 + i * 22, w: planW - 20, h: 20 });
  const sign: Rect = { x: planX + planW + 16, y: G.topY, w: Math.max(signW, lineRight - planX - planW - 16), h: G.topH };

  const right = Math.max(sign.x + sign.w, lineRight) + G.margin;
  const bottom = Math.max(rwBox.y + rwBox.h, yardBox.y + yardBox.h, maxBoxBottom) + G.margin;
  const floor: Rect = { x: 0, y: 0, w: right, h: bottom };

  return {
    bounds: { x: 0, y: 0, w: right, h: bottom },
    floor,
    stations,
    rework: { box: rwBox, queueSpots: rwQueue, slot: rwSlot },
    yard: { box: yardBox, spots, cols },
    warehouse: { box: whBox, bars },
    dock: { box: dockBox, lanes },
    plan: { box: planBox, rows: planRows },
    sign,
    conveyorY,
    walkwaysY: [G.topY + G.topH + 7, G.topY + G.topH + 19],
  };
}

// ---- Vehicle targets ----

/** Visual build state of a vehicle. */
export type BuildPhase = 'stamping' | 'body' | 'paint' | 'final' | 'complete';

export interface VehicleLook {
  phase: BuildPhase;
  /** 0..1 progress within the phase (1 = phase finished). */
  progress: number;
  color: string;
  finish: FinishId;
  model: ModelId;
  trim: TrimId;
  /** Draw scale relative to G.carLen. */
  scale: number;
  /** Detected defect awaiting / in rework (only shown once inspection caught it). */
  reworkTag: boolean;
  /** Order reservation id (yard only) or null. */
  orderTag: number | null;
}

export interface VehicleTarget {
  /** Anchor = bottom-centre of the vehicle (ground contact), world units. */
  x: number;
  y: number;
  look: VehicleLook;
}

const PHASE_AFTER: Record<StationId, BuildPhase> = {
  stamping: 'stamping',
  body: 'body',
  paint: 'paint',
  final: 'final',
  inspection: 'complete',
};

/** Phase of a vehicle waiting in the queue of `id` (i.e. finished the previous station). */
const QUEUE_PHASE: Record<StationId, BuildPhase> = {
  stamping: 'stamping',
  body: 'stamping',
  paint: 'body',
  final: 'paint',
  inspection: 'complete',
};

/** Build progress of the vehicle itself (retooling time at the start of a slot doesn't advance it). */
function slotProgress(s: WorkSlot): number {
  if (s.done) return 1;
  const c = s.changeover ?? 0;
  const work = s.required - c;
  return work > 0 ? Math.max(0, Math.min(1, (s.progress - c) / work)) : 0;
}

export function vehicleTargets(state: GameState, layout: FactoryLayout): Map<number, VehicleTarget> {
  const out = new Map<number, VehicleTarget>();
  const put = (vid: number, x: number, y: number, phase: BuildPhase, progress: number, scale: number) => {
    const v = state.vehicles[String(vid)];
    if (!v) return;
    out.set(vid, {
      x,
      y,
      look: {
        phase,
        progress,
        color: v.color,
        finish: v.finish,
        model: v.model,
        trim: v.trim,
        scale,
        reworkTag: v.defectDetected,
        orderTag: v.stage === 'finished' ? v.orderId : null,
      },
    });
  };

  for (const id of STATION_IDS) {
    const st = state.stations[id];
    const sl = layout.stations[id];
    st.slots.forEach((slot, i) => {
      if (!slot) return;
      const r = sl.slots[Math.min(i, sl.slots.length - 1)];
      put(slot.vehicleId, r.x + r.w / 2 - 6, r.y + 44, PHASE_AFTER[id], id === 'inspection' ? 1 : slotProgress(slot), 1);
    });
    st.queue.forEach((vid, i) => {
      const spot = sl.queueSpots[i];
      const qx = spot ? spot.x + spot.w / 2 : (sl.queue ? sl.queue.x + sl.queue.w / 2 : sl.box.x - 30);
      const qy = spot ? spot.y + spot.h - 8 : sl.box.y + sl.box.h + 20 + (i - sl.queueSpots.length) * 10;
      put(vid, qx, qy, QUEUE_PHASE[id], 1, 0.82);
    });
  }

  const rw = layout.rework;
  state.rework.queue.forEach((vid, i) => {
    const spot = rw.queueSpots[Math.min(i, rw.queueSpots.length - 1)];
    put(vid, spot.x + spot.w / 2, spot.y + spot.h - 12, 'complete', 1, 0.76);
  });
  if (state.rework.slot) {
    put(state.rework.slot.vehicleId, rw.slot.x + rw.slot.w / 2, rw.slot.y + 40, 'complete', 1, 0.95);
  }

  const ys = layout.yard.spots;
  state.yard.forEach((vid, i) => {
    const spot = ys[i];
    const x = spot ? spot.x + spot.w / 2 : layout.yard.box.x + layout.yard.box.w / 2;
    const y = spot ? spot.y + spot.h - 6 : layout.yard.box.y + layout.yard.box.h + 10;
    put(vid, x, y, 'complete', 1, 0.78);
  });

  return out;
}

export function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/** Stable, distinct colour for an order id (reservation tags). */
export function orderColor(orderId: number): string {
  const hue = (orderId * 137.508) % 360;
  return `hsl(${hue.toFixed(0)}, 72%, 58%)`;
}
