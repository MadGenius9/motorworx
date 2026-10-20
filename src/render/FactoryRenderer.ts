/**
 * Canvas 2D factory renderer. Owns one canvas, a camera (pan/zoom) and a rAF loop that
 * reads `controller.state` fresh every frame. Never mutates game state.
 */
import { BALANCE, STATION_IDS } from '../config/balance';
import type { ComponentId, StationId } from '../config/balance';
import type { IGameController } from '../game/types';
import type { GameState, StationIssue, StationState, WorkSlot } from '../sim/types';
import type { PanelTab, StationStatus } from '../sim/selectors';
import {
  breakdownRisk,
  formatDuration,
  formatTime,
  incomingUnits,
  stationRequiredStaff,
  stationStaff,
  stationStatus,
  staffFactor,
  stockOnHand,
  warehouseCapacity,
  yardCapacity,
} from '../sim/selectors';
import { computeLayout, orderColor, rectContains, vehicleTargets } from './layout';
import type { FactoryLayout, Rect, StationLayout, VehicleLook } from './layout';
import { drawVehicle, drawWrenchIcon, roundRectPath, shade } from './drawVehicle';

export interface FactoryRendererCallbacks {
  onSelectStation(id: StationId | null): void;
  onOpenTab(tab: PanelTab): void;
}

export type HitTarget = { kind: 'station'; id: StationId } | { kind: 'tab'; tab: PanelTab };

interface Hit {
  rect: Rect;
  target: HitTarget;
}

export const COLORS = {
  bg: '#1b1d20',
  floor: '#24272b',
  grid: '#2a2e33',
  panel: '#2b2f34',
  panelDark: '#212428',
  steel: '#3a3f45',
  steelLight: '#8a939c',
  text: '#e6e8ea',
  textDim: '#9aa3ab',
  accent: '#f07c1e',
  safety: '#e8c21a',
  running: '#3fb950',
  idle: '#8a939c',
  blocked: '#e3a008',
  broken: '#e5484d',
  service: '#3b82f6',
};

export const STATUS_COLOR: Record<StationStatus, string> = {
  running: COLORS.running,
  idle: COLORS.idle,
  blocked: COLORS.blocked,
  understaffed: COLORS.blocked,
  broken: COLORS.broken,
  repair: COLORS.service,
  maintenance: COLORS.service,
};

const STATUS_LABEL: Record<StationStatus, string> = {
  running: 'RUNNING',
  idle: 'IDLE',
  blocked: 'BLOCKED',
  understaffed: 'UNDERSTAFFED',
  broken: 'BROKEN',
  repair: 'REPAIR',
  maintenance: 'MAINTENANCE',
};

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const CLICK_SLOP = 5;
const MAX_ZOOM = 3.5;

interface Banner {
  text: string;
  color: string;
  textColor: string;
  wrench?: boolean;
}

export class FactoryRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private controller: IGameController;
  private readonly cb: FactoryRendererCallbacks;

  /** Camera: world point shown at the canvas centre, and zoom (CSS px per world unit). */
  private cam = { x: 0, y: 0, zoom: 1 };
  private fitZoom = 1;
  private userMoved = false;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;

  private raf = 0;
  private lastFrame = 0;
  private running = false;
  private destroyed = false;
  private errorLogged = false;

  private displayed = new Map<number, { x: number; y: number }>();
  private lastState: GameState | null = null;
  private layout: FactoryLayout | null = null;
  private hits: Hit[] = [];

  private selected: StationId | null = null;
  private hover: HitTarget | null = null;
  private mouse: { x: number; y: number } | null = null;
  private drag: { sx: number; sy: number; camX: number; camY: number; moved: boolean; id: number } | null = null;

  constructor(canvas: HTMLCanvasElement, controller: IGameController, callbacks: FactoryRendererCallbacks) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;
    this.controller = controller;
    this.cb = callbacks;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerCancel);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.style.touchAction = 'none';
  }

  // ---------------- public API ----------------

  start(): void {
    if (this.running || this.destroyed) return;
    this.running = true;
    this.lastFrame = 0;
    this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  destroy(): void {
    this.stop();
    this.destroyed = true;
    const c = this.canvas;
    c.removeEventListener('pointerdown', this.onPointerDown);
    c.removeEventListener('pointermove', this.onPointerMove);
    c.removeEventListener('pointerup', this.onPointerUp);
    c.removeEventListener('pointercancel', this.onPointerCancel);
    c.removeEventListener('pointerleave', this.onPointerLeave);
    c.removeEventListener('wheel', this.onWheel);
  }

  setController(controller: IGameController): void {
    this.controller = controller;
  }

  setSelected(id: StationId | null): void {
    this.selected = id;
  }

  /** Set the canvas CSS size (from a ResizeObserver); handles devicePixelRatio. */
  resize(cssWidth: number, cssHeight: number): void {
    this.cssW = Math.max(0, Math.floor(cssWidth));
    this.cssH = Math.max(0, Math.floor(cssHeight));
    this.applyBackingSize();
    if (!this.userMoved) this.fitView();
    else this.clampCamera();
  }

  /** Zoom by a factor around the canvas centre (for +/− buttons). */
  zoomBy(factor: number): void {
    this.zoomAt(this.cssW / 2, this.cssH / 2, factor);
  }

  /** Re-fit the whole factory in view. */
  resetView(): void {
    this.userMoved = false;
    this.fitView();
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.cssW / 2) / this.cam.zoom + this.cam.x,
      y: (sy - this.cssH / 2) / this.cam.zoom + this.cam.y,
    };
  }

  /** Hit-test a canvas-relative CSS point. */
  hitTest(sx: number, sy: number): HitTarget | null {
    const w = this.screenToWorld(sx, sy);
    for (let i = this.hits.length - 1; i >= 0; i--) {
      if (rectContains(this.hits[i].rect, w.x, w.y)) return this.hits[i].target;
    }
    return null;
  }

  // ---------------- camera ----------------

  private applyBackingSize(): void {
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.cssW * this.dpr));
    const h = Math.max(1, Math.round(this.cssH * this.dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  private worldBounds(): Rect {
    if (!this.layout) this.layout = computeLayout(this.controller.state);
    return this.layout.bounds;
  }

  private fitView(): void {
    if (this.cssW <= 0 || this.cssH <= 0) return;
    const b = this.worldBounds();
    const pad = 8;
    this.fitZoom = Math.max(0.05, Math.min((this.cssW - pad * 2) / b.w, (this.cssH - pad * 2) / b.h));
    this.cam = { x: b.x + b.w / 2, y: b.y + b.h / 2, zoom: this.fitZoom };
  }

  private minZoom(): number {
    return this.fitZoom * 0.6;
  }

  private clampCamera(): void {
    const b = this.worldBounds();
    if (this.cssW > 0) {
      const b2 = this.worldBounds();
      this.fitZoom = Math.max(0.05, Math.min((this.cssW - 16) / b2.w, (this.cssH - 16) / b2.h));
    }
    this.cam.zoom = Math.max(this.minZoom(), Math.min(MAX_ZOOM, this.cam.zoom));
    this.cam.x = Math.max(b.x, Math.min(b.x + b.w, this.cam.x));
    this.cam.y = Math.max(b.y, Math.min(b.y + b.h, this.cam.y));
  }

  private zoomAt(sx: number, sy: number, factor: number): void {
    if (this.cssW <= 0) return;
    const before = this.screenToWorld(sx, sy);
    const z = Math.max(this.minZoom(), Math.min(MAX_ZOOM, this.cam.zoom * factor));
    this.cam.zoom = z;
    this.cam.x = before.x - (sx - this.cssW / 2) / z;
    this.cam.y = before.y - (sy - this.cssH / 2) / z;
    this.userMoved = true;
    this.clampCamera();
  }

  // ---------------- input ----------------

  private localPoint(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const p = this.localPoint(e);
    this.drag = { sx: p.x, sy: p.y, camX: this.cam.x, camY: this.cam.y, moved: false, id: e.pointerId };
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    const p = this.localPoint(e);
    this.mouse = p;
    const d = this.drag;
    if (d && d.id === e.pointerId) {
      const dx = p.x - d.sx;
      const dy = p.y - d.sy;
      if (!d.moved && Math.hypot(dx, dy) >= CLICK_SLOP) d.moved = true;
      if (d.moved) {
        this.cam.x = d.camX - dx / this.cam.zoom;
        this.cam.y = d.camY - dy / this.cam.zoom;
        this.userMoved = true;
        this.clampCamera();
      }
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const p = this.localPoint(e);
    if (d.moved || Math.hypot(p.x - d.sx, p.y - d.sy) >= CLICK_SLOP) return;
    const t = this.hitTest(p.x, p.y);
    if (!t) this.cb.onSelectStation(null);
    else if (t.kind === 'station') this.cb.onSelectStation(t.id);
    else this.cb.onOpenTab(t.tab);
  };

  private onPointerCancel = (): void => {
    this.drag = null;
  };

  private onPointerLeave = (): void => {
    if (!this.drag) this.mouse = null;
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const p = this.localPoint(e);
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const factor = Math.exp(-dy * 0.0015);
    this.zoomAt(p.x, p.y, factor);
  };

  // ---------------- frame loop ----------------

  private frame = (now: number): void => {
    if (!this.running || this.destroyed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    if ((window.devicePixelRatio || 1) !== this.dpr && this.cssW > 0) this.applyBackingSize();
    if (this.cssW <= 0 || this.cssH <= 0) return;
    try {
      this.draw(now / 1000, dt);
    } catch (err) {
      if (!this.errorLogged) {
        this.errorLogged = true;
        console.error('[FactoryRenderer] draw failed', err);
      }
    }
  };

  private draw(realT: number, dt: number): void {
    const controller = this.controller;
    const state = controller.state;
    if (state !== this.lastState) {
      this.displayed.clear();
      this.lastState = state;
    }
    const layout = computeLayout(state);
    const prevBounds = this.layout?.bounds;
    this.layout = layout;
    if (!this.userMoved && (!prevBounds || prevBounds.w !== layout.bounds.w || prevBounds.h !== layout.bounds.h)) {
      this.fitView();
    }
    const simT = state.time + (controller.tickFraction || 0);
    const paused = controller.paused;

    // Hover
    this.hits = this.buildHits(layout);
    this.hover = this.mouse && !this.drag?.moved ? this.hitTest(this.mouse.x, this.mouse.y) : null;
    this.canvas.style.cursor = this.drag?.moved ? 'grabbing' : this.hover ? 'pointer' : 'grab';

    const ctx = this.ctx;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    const z = this.cam.zoom;
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (this.cssW / 2 - this.cam.x * z), dpr * (this.cssH / 2 - this.cam.y * z));

    this.drawFloor(layout);
    this.drawWarehouse(state, layout);
    this.drawDock(state, layout);
    this.drawPlan(state, layout);
    this.drawSign(state, layout);
    this.drawConveyor(layout, simT);
    for (const id of STATION_IDS) this.drawStation(state, layout.stations[id], realT);
    this.drawRework(state, layout);
    this.drawYard(state, layout);

    // Vehicles (lerped)
    const targets = vehicleTargets(state, layout);
    const k = dt > 0 ? 1 - Math.exp(-dt * 7) : 1;
    for (const id of Array.from(this.displayed.keys())) if (!targets.has(id)) this.displayed.delete(id);
    const list: { x: number; y: number; look: VehicleLook }[] = [];
    targets.forEach((t, id) => {
      let d = this.displayed.get(id);
      if (!d) {
        d = { x: t.x, y: t.y };
        this.displayed.set(id, d);
      } else {
        d.x += (t.x - d.x) * k;
        d.y += (t.y - d.y) * k;
        if (Math.abs(t.x - d.x) < 0.05) d.x = t.x;
        if (Math.abs(t.y - d.y) < 0.05) d.y = t.y;
      }
      list.push({ x: d.x, y: d.y, look: t.look });
    });
    list.sort((a, b) => a.y - b.y);
    for (const v of list) drawVehicle(ctx, v.x, v.y, v.look);

    // Machines on top of vehicles, then banners/overlays.
    for (const id of STATION_IDS) this.drawMachines(state, layout.stations[id], simT, paused);
    for (const id of STATION_IDS) this.drawStationOverlay(state, layout.stations[id], realT);
    this.drawReworkOverlay(state, layout);
  }

  private buildHits(layout: FactoryLayout): Hit[] {
    const hits: Hit[] = [];
    hits.push({ rect: layout.warehouse.box, target: { kind: 'tab', tab: 'suppliers' } });
    hits.push({ rect: layout.dock.box, target: { kind: 'tab', tab: 'suppliers' } });
    hits.push({ rect: layout.plan.box, target: { kind: 'tab', tab: 'orders' } });
    hits.push({ rect: layout.yard.box, target: { kind: 'tab', tab: 'vehicles' } });
    hits.push({ rect: layout.rework.box, target: { kind: 'station', id: 'inspection' } });
    for (const id of STATION_IDS) {
      const sl = layout.stations[id];
      hits.push({ rect: inflate(sl.box, 0, 18, 0, 0), target: { kind: 'station', id } });
      if (sl.queue) hits.push({ rect: sl.queue, target: { kind: 'station', id } });
    }
    return hits;
  }

  private isHovered(t: HitTarget): boolean {
    const h = this.hover;
    if (!h || h.kind !== t.kind) return false;
    return h.kind === 'station' ? t.kind === 'station' && h.id === t.id : t.kind === 'tab' && h.tab === t.tab;
  }

  // ---------------- drawing: environment ----------------

  private drawFloor(layout: FactoryLayout): void {
    const ctx = this.ctx;
    const f = layout.floor;
    ctx.fillStyle = COLORS.floor;
    ctx.fillRect(f.x, f.y, f.w, f.h);
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = f.x + 40; x < f.x + f.w; x += 40) {
      ctx.moveTo(x, f.y);
      ctx.lineTo(x, f.y + f.h);
    }
    for (let y = f.y + 40; y < f.y + f.h; y += 40) {
      ctx.moveTo(f.x, y);
      ctx.lineTo(f.x + f.w, y);
    }
    ctx.stroke();
    // Walkway lane
    const [y1, y2] = layout.walkwaysY;
    ctx.fillStyle = 'rgba(232,194,26,0.05)';
    ctx.fillRect(f.x + 8, y1, f.w - 16, y2 - y1);
    ctx.strokeStyle = COLORS.safety;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(f.x + 8, y1);
    ctx.lineTo(f.x + f.w - 8, y1);
    ctx.moveTo(f.x + 8, y2);
    ctx.lineTo(f.x + f.w - 8, y2);
    ctx.stroke();
    // Walkway chevron markings
    ctx.fillStyle = 'rgba(232,194,26,0.35)';
    for (let x = f.x + 60; x < f.x + f.w - 40; x += 160) {
      ctx.beginPath();
      ctx.moveTo(x, y1 + 2);
      ctx.lineTo(x + 6, (y1 + y2) / 2);
      ctx.lineTo(x, y2 - 2);
      ctx.lineTo(x + 3, (y1 + y2) / 2);
      ctx.closePath();
      ctx.fill();
    }
    // Safety outline around the production zone
    const s0 = layout.stations.stamping.box;
    const ins = layout.stations.inspection.box;
    const zoneBottom = layout.rework.box.y - 10;
    ctx.setLineDash([10, 6]);
    ctx.strokeStyle = 'rgba(232,194,26,0.45)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(s0.x - 8, s0.y - 22, ins.x + ins.w - s0.x + 16, zoneBottom - (s0.y - 22));
    ctx.setLineDash([]);
    // Walls
    ctx.strokeStyle = COLORS.steel;
    ctx.lineWidth = 4;
    ctx.strokeRect(f.x + 2, f.y + 2, f.w - 4, f.h - 4);
  }

  private panel(r: Rect, title: string, target: HitTarget | null, right?: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    roundRectPath(ctx, r.x + 2, r.y + 3, r.w, r.h, 6);
    ctx.fill();
    ctx.fillStyle = COLORS.panel;
    roundRectPath(ctx, r.x, r.y, r.w, r.h, 6);
    ctx.fill();
    const hov = target ? this.isHovered(target) : false;
    ctx.strokeStyle = hov ? COLORS.steelLight : COLORS.steel;
    ctx.lineWidth = hov ? 2 : 1.5;
    ctx.stroke();
    text(ctx, title, r.x + 10, r.y + 16, { size: 12, weight: 700, color: COLORS.text });
    if (right) text(ctx, right, r.x + r.w - 10, r.y + 16, { size: 11, color: COLORS.textDim, align: 'right' });
  }

  private drawWarehouse(state: GameState, layout: FactoryLayout): void {
    const ctx = this.ctx;
    const wh = layout.warehouse;
    const cap = Math.max(1, warehouseCapacity(state));
    const onHand = stockOnHand(state);
    const incoming = incomingUnits(state);
    this.panel(wh.box, 'WAREHOUSE', { kind: 'tab', tab: 'suppliers' }, `${onHand}/${cap}${incoming ? ` (+${incoming})` : ''}`);
    // Total capacity bar
    const tb = { x: wh.box.x + 10, y: wh.box.y + 25, w: wh.box.w - 20, h: 6 };
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(tb.x, tb.y, tb.w, tb.h);
    const fillFrac = Math.min(1, onHand / cap);
    const inFrac = Math.min(1 - fillFrac, incoming / cap);
    ctx.fillStyle = fillFrac > 0.9 ? COLORS.blocked : COLORS.steelLight;
    ctx.fillRect(tb.x, tb.y, tb.w * fillFrac, tb.h);
    ctx.fillStyle = 'rgba(240,124,30,0.55)';
    ctx.fillRect(tb.x + tb.w * fillFrac, tb.y, tb.w * inFrac, tb.h);

    const short = new Set<ComponentId>();
    for (const id of STATION_IDS) {
      for (const is of state.stations[id].issues) if (is.kind === 'materials') is.components?.forEach((c) => short.add(c));
    }
    const incomingBy: Partial<Record<ComponentId, number>> = {};
    for (const s of state.shipments) incomingBy[s.component] = (incomingBy[s.component] ?? 0) + s.qty;

    for (const { component, rect } of wh.bars) {
      const qty = state.inventory[component]?.qty ?? 0;
      const isShort = short.has(component);
      text(ctx, BALANCE.components[component].short, wh.box.x + 12, rect.y + rect.h / 2, {
        size: 11,
        weight: isShort ? 700 : 500,
        color: isShort ? COLORS.broken : COLORS.text,
        baseline: 'middle',
      });
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      const f = Math.min(1, qty / cap);
      const w = qty > 0 ? Math.max(3, rect.w * f) : 0;
      ctx.fillStyle = isShort ? COLORS.broken : qty === 0 ? COLORS.broken : COLORS.accent;
      ctx.fillRect(rect.x, rect.y, w, rect.h);
      const inc = incomingBy[component] ?? 0;
      if (inc > 0) {
        ctx.fillStyle = 'rgba(240,124,30,0.3)';
        ctx.fillRect(rect.x + w, rect.y, Math.max(2, Math.min(rect.w - w, (rect.w * inc) / cap)), rect.h);
      }
      ctx.strokeStyle = COLORS.steel;
      ctx.lineWidth = 1;
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      text(ctx, String(qty), rect.x + rect.w + 8, rect.y + rect.h / 2, {
        size: 11,
        weight: 700,
        color: qty === 0 ? COLORS.broken : COLORS.text,
        baseline: 'middle',
      });
      if (inc > 0) {
        text(ctx, `+${inc}`, rect.x + rect.w + 30, rect.y + rect.h / 2, { size: 10, color: COLORS.accent, baseline: 'middle' });
      }
    }
  }

  private drawDock(state: GameState, layout: FactoryLayout): void {
    const ctx = this.ctx;
    const dk = layout.dock;
    const ships = [...state.shipments].sort((a, b) => a.arrivesAt - b.arrivesAt);
    this.panel(dk.box, 'LOADING DOCK', { kind: 'tab', tab: 'suppliers' }, ships.length ? `${ships.length} inbound` : '');
    // Dock doors on the right edge
    const doorX = dk.box.x + dk.box.w - 14;
    for (let i = 0; i < 4; i++) {
      const y = dk.lanes[i].y + 2;
      ctx.fillStyle = COLORS.steel;
      ctx.fillRect(doorX, y, 8, dk.lanes[i].h - 4);
      ctx.fillStyle = COLORS.safety;
      ctx.fillRect(doorX - 2, y, 2, dk.lanes[i].h - 4);
    }
    if (ships.length === 0) {
      text(ctx, 'No inbound shipments', dk.box.x + dk.box.w / 2 - 10, dk.box.y + dk.box.h / 2 + 6, {
        size: 11,
        color: COLORS.textDim,
        align: 'center',
      });
      return;
    }
    ships.slice(0, dk.lanes.length).forEach((s, i) => {
      const lane = dk.lanes[i];
      // Road
      ctx.fillStyle = '#202326';
      ctx.fillRect(lane.x, lane.y + 4, lane.w, lane.h - 8);
      ctx.strokeStyle = 'rgba(232,194,26,0.25)';
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(lane.x, lane.y + lane.h / 2);
      ctx.lineTo(lane.x + lane.w, lane.y + lane.h / 2);
      ctx.stroke();
      ctx.setLineDash([]);
      const span = Math.max(1, s.arrivesAt - s.orderedAt);
      const prog = Math.max(0, Math.min(1, (state.time - s.orderedAt) / span));
      const tw = 96;
      const tx = lane.x + prog * (lane.w - tw);
      drawTruck(ctx, tx, lane.y + 3, tw, lane.h - 6, `${BALANCE.components[s.component].short} ×${s.qty}`);
      const eta = Math.max(0, s.arrivesAt - state.time);
      text(ctx, eta <= 0 ? 'now' : formatDuration(eta), lane.x + lane.w + 6, lane.y + lane.h / 2, {
        size: 10,
        weight: 600,
        color: COLORS.textDim,
        baseline: 'middle',
      });
    });
    if (ships.length > dk.lanes.length) {
      text(ctx, `+${ships.length - dk.lanes.length} more`, dk.box.x + dk.box.w - 24, dk.box.y + 16, {
        size: 10,
        color: COLORS.accent,
        align: 'right',
      });
    }
  }

  private drawPlan(state: GameState, layout: FactoryLayout): void {
    const ctx = this.ctx;
    const pl = layout.plan;
    const remaining = state.plan.reduce((a, j) => a + Math.max(0, j.quantity - j.started), 0);
    this.panel(pl.box, 'PRODUCTION PLAN', { kind: 'tab', tab: 'orders' }, remaining ? `${remaining} to start` : '');
    if (state.plan.length === 0) {
      text(ctx, 'Nothing scheduled', pl.box.x + pl.box.w / 2, pl.box.y + pl.box.h / 2, {
        size: 12,
        weight: 600,
        color: COLORS.blocked,
        align: 'center',
      });
      text(ctx, 'Click to open Orders', pl.box.x + pl.box.w / 2, pl.box.y + pl.box.h / 2 + 18, {
        size: 10,
        color: COLORS.textDim,
        align: 'center',
      });
      return;
    }
    const rows = pl.rows;
    const shown = state.plan.slice(0, rows.length - (state.plan.length > rows.length ? 1 : 0));
    shown.forEach((job, i) => {
      const r = rows[i];
      ctx.fillStyle = i === 0 ? 'rgba(240,124,30,0.12)' : COLORS.panelDark;
      ctx.fillRect(r.x, r.y, r.w, r.h - 2);
      if (job.orderId != null) {
        ctx.fillStyle = orderColor(job.orderId);
        ctx.fillRect(r.x, r.y, 3, r.h - 2);
      }
      const trim = BALANCE.trims[job.trim].name;
      text(ctx, `${i + 1}. ${trim} ×${job.quantity}`, r.x + 8, r.y + r.h / 2 - 1, {
        size: 11,
        weight: 600,
        color: COLORS.text,
        baseline: 'middle',
      });
      const right =
        (job.started > 0 ? `${job.started}/${job.quantity} started` : 'queued') +
        (job.orderId != null ? ` · #${job.orderId}` : ' · stock');
      text(ctx, right, r.x + r.w - 6, r.y + r.h / 2 - 1, { size: 10, color: COLORS.textDim, align: 'right', baseline: 'middle' });
    });
    if (state.plan.length > shown.length) {
      const r = rows[rows.length - 1];
      text(ctx, `+${state.plan.length - shown.length} more jobs`, r.x + 8, r.y + r.h / 2, {
        size: 10,
        color: COLORS.textDim,
        baseline: 'middle',
      });
    }
  }

  private drawSign(state: GameState, layout: FactoryLayout): void {
    const ctx = this.ctx;
    const r = layout.sign;
    ctx.fillStyle = '#16181b';
    roundRectPath(ctx, r.x, r.y, r.w, r.h, 6);
    ctx.fill();
    ctx.strokeStyle = COLORS.steel;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = COLORS.accent;
    ctx.fillRect(r.x, r.y + 10, 4, 34);
    text(ctx, 'MOTORWORX', r.x + 14, r.y + 30, { size: 22, weight: 800, color: COLORS.accent });
    text(ctx, `PLANT 01 · ${state.product.name.toUpperCase()}`, r.x + 14, r.y + 48, { size: 10, weight: 600, color: COLORS.textDim });
    text(ctx, formatTime(state.time), r.x + 14, r.y + 78, { size: 15, weight: 700, color: COLORS.text });
    text(ctx, `Built today: ${state.stats.builtToday}`, r.x + 14, r.y + 100, { size: 11, color: COLORS.textDim });
    text(ctx, `Total built: ${state.stats.vehiclesBuilt}`, r.x + 14, r.y + 116, { size: 11, color: COLORS.textDim });
    if (this.controller.paused) {
      text(ctx, 'PAUSED', r.x + r.w - 12, r.y + 78, { size: 11, weight: 800, color: COLORS.blocked, align: 'right' });
    }
  }

  private drawConveyor(layout: FactoryLayout, simT: number): void {
    const ctx = this.ctx;
    const s0 = layout.stations.stamping.box;
    const y = layout.conveyorY + 9;
    const h = 10;
    const x0 = s0.x + 10;
    const x1 = layout.yard.box.x + 4;
    ctx.fillStyle = '#17191c';
    ctx.fillRect(x0, y, x1 - x0, h);
    ctx.fillStyle = COLORS.steel;
    ctx.fillRect(x0, y - 2, x1 - x0, 2);
    ctx.fillRect(x0, y + h, x1 - x0, 2);
    // Chevrons move with SIM time → freeze when paused.
    const spacing = 16;
    const off = (((simT * 2.5) % spacing) + spacing) % spacing;
    ctx.strokeStyle = 'rgba(240,124,30,0.55)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let x = x0 - spacing + off; x < x1 - 4; x += spacing) {
      if (x < x0) continue;
      ctx.moveTo(x, y + 2);
      ctx.lineTo(x + 4, y + h / 2);
      ctx.lineTo(x, y + h - 2);
    }
    ctx.stroke();

    // Inspection ⇄ rework connectors
    const ins = layout.stations.inspection;
    const rw = layout.rework.box;
    ctx.strokeStyle = 'rgba(229,72,77,0.6)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.lineDashOffset = -((simT * 2) % 10);
    const downX = ins.box.x + ins.box.w - 20;
    ctx.beginPath();
    ctx.moveTo(downX, ins.box.y + ins.box.h);
    ctx.lineTo(downX, rw.y);
    ctx.stroke();
    const upX = rw.x + 4;
    const qBottom = ins.queue ? ins.queue.y + ins.queue.h : rw.y - 10;
    ctx.strokeStyle = 'rgba(63,185,80,0.5)';
    ctx.beginPath();
    ctx.moveTo(upX, rw.y);
    ctx.lineTo(upX, rw.y - 8);
    if (ins.queue) {
      const qx = ins.queue.x + ins.queue.w / 2;
      ctx.lineTo(qx, rw.y - 8);
      ctx.lineTo(qx, qBottom);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    arrowHead(ctx, downX, rw.y, Math.PI / 2, 'rgba(229,72,77,0.8)');
    if (ins.queue) arrowHead(ctx, ins.queue.x + ins.queue.w / 2, qBottom, -Math.PI / 2, 'rgba(63,185,80,0.8)');
  }

  // ---------------- stations ----------------

  private drawStation(state: GameState, sl: StationLayout, realT: number): void {
    const ctx = this.ctx;
    const id = sl.id;
    const st = state.stations[id];
    const status = stationStatus(state, id);
    const sc = STATUS_COLOR[status];
    const target: HitTarget = { kind: 'station', id };
    const hov = this.isHovered(target);
    const sel = this.selected === id;

    // Queue column
    if (sl.queue) {
      const q = sl.queue;
      ctx.fillStyle = 'rgba(27,29,32,0.75)';
      roundRectPath(ctx, q.x, q.y, q.w, q.h, 4);
      ctx.fill();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = sel ? COLORS.accent : hov ? COLORS.steelLight : COLORS.steel;
      ctx.lineWidth = sel ? 2 : 1.2;
      ctx.stroke();
      ctx.setLineDash([]);
      const cap = sl.queueSpots.length;
      const full = st.queue.length >= cap && cap > 0;
      text(ctx, `QUEUE ${st.queue.length}/${cap}`, q.x + q.w / 2, q.y + 13, {
        size: 9,
        weight: 700,
        color: full ? COLORS.blocked : COLORS.textDim,
        align: 'center',
      });
      for (const s of sl.queueSpots) {
        ctx.strokeStyle = 'rgba(138,147,156,0.25)';
        ctx.lineWidth = 1;
        ctx.strokeRect(s.x + 2, s.y + 2, s.w - 4, s.h - 4);
      }
    }

    // Box
    const b = sl.box;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    roundRectPath(ctx, b.x + 3, b.y + 4, b.w, b.h, 6);
    ctx.fill();
    ctx.fillStyle = COLORS.panel;
    roundRectPath(ctx, b.x, b.y, b.w, b.h, 6);
    ctx.fill();
    if (sel) {
      ctx.save();
      ctx.shadowColor = COLORS.accent;
      ctx.shadowBlur = 12;
      ctx.strokeStyle = COLORS.accent;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.strokeStyle = hov ? COLORS.steelLight : COLORS.steel;
      ctx.lineWidth = hov ? 2 : 1.5;
      ctx.stroke();
    }
    // Status accent strip
    ctx.fillStyle = sc;
    ctx.fillRect(b.x + 6, b.y + 1, b.w - 12, 3);

    // Header
    const hx = b.x + 8;
    text(ctx, BALANCE.stations[id].name, hx, b.y + 19, { size: 13, weight: 700, color: COLORS.text, maxWidth: b.w - 16 });
    // Status chip
    const label = STATUS_LABEL[status];
    ctx.font = font(9, 800);
    const cw = ctx.measureText(label).width + 12;
    ctx.fillStyle = shade(sc, -0.55);
    roundRectPath(ctx, hx, b.y + 26, cw, 14, 7);
    ctx.fill();
    ctx.strokeStyle = sc;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = sc;
    ctx.beginPath();
    ctx.arc(hx + 6, b.y + 33, 2.2, 0, Math.PI * 2);
    ctx.fill();
    text(ctx, label, hx + 10, b.y + 33.5, { size: 9, weight: 800, color: sc, baseline: 'middle' });
    // Level pips (capacity / reliability)
    const lv = `C${st.capacityLevel} R${st.reliabilityLevel}`;
    text(ctx, lv, b.x + b.w - 8, b.y + 33.5, { size: 9, weight: 600, color: COLORS.textDim, align: 'right', baseline: 'middle' });

    // Workers
    const staff = stationStaff(state, id);
    const req = stationRequiredStaff(state, id);
    const icons = Math.min(6, Math.max(req, 1));
    for (let i = 0; i < icons; i++) {
      drawWorker(ctx, hx + 4 + i * 10, b.y + 54, i < staff, staff < req && i >= staff ? COLORS.blocked : COLORS.text);
    }
    const role = id === 'inspection' ? 'insp' : 'ops';
    text(ctx, `${staff}/${req} ${role}${staff > icons ? '' : ''}`, b.x + b.w - 8, b.y + 50, {
      size: 10,
      weight: 600,
      color: staff === 0 && req > 0 ? COLORS.broken : staff < req ? COLORS.blocked : COLORS.textDim,
      align: 'right',
      baseline: 'middle',
    });

    // Condition bar
    const cond = Math.max(0, Math.min(100, st.condition));
    const risk = breakdownRisk(state, id);
    const eq = BALANCE.equipment;
    const cColor =
      cond < eq.dangerCondition || risk === 'high' ? COLORS.broken : cond < eq.warnCondition || risk === 'elevated' ? COLORS.blocked : COLORS.running;
    const barX = hx + (cond < eq.warnCondition ? 14 : 0);
    const barW = b.x + b.w - 40 - barX;
    const barY = b.y + 62;
    if (cond < eq.warnCondition) drawWarning(ctx, hx + 5, barY + 2.5, cond < eq.dangerCondition ? COLORS.broken : COLORS.blocked);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(barX, barY, barW, 5);
    ctx.fillStyle = cColor;
    ctx.fillRect(barX, barY, (barW * cond) / 100, 5);
    text(ctx, `${Math.round(cond)}%`, b.x + b.w - 8, barY + 3, { size: 10, weight: 600, color: cColor, align: 'right', baseline: 'middle' });

    // Slot rows
    const sf = staffFactor(state, id);
    sl.slots.forEach((r, i) => {
      ctx.fillStyle = COLORS.panelDark;
      roundRectPath(ctx, r.x, r.y, r.w, r.h, 4);
      ctx.fill();
      // Floor plate under vehicle
      ctx.fillStyle = '#17191c';
      ctx.fillRect(r.x + 4, r.y + 44, r.w - 8, 3);
      const slot: WorkSlot | null = st.slots[i] ?? null;
      if (!slot) {
        text(ctx, 'empty', r.x + r.w / 2 - 6, r.y + 30, { size: 10, color: 'rgba(138,147,156,0.5)', align: 'center' });
      }
      // Progress bar
      const px = r.x + 6;
      const pw = r.w - 12;
      const py = r.y + r.h - 7;
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(px, py, pw, 4);
      if (slot) {
        const f = slot.done ? 1 : slot.required > 0 ? Math.min(1, slot.progress / slot.required) : 0;
        const frozen = st.broken || !!st.service || sf <= 0;
        ctx.fillStyle = slot.done
          ? slot.outcome === 'rework'
            ? COLORS.broken
            : COLORS.blocked
          : frozen
            ? COLORS.idle
            : COLORS.running;
        ctx.fillRect(px, py, pw * f, 4);
        if (slot.done) {
          const lbl = id === 'inspection' ? (slot.outcome === 'rework' ? 'REWORK' : 'PASS') : 'DONE';
          text(ctx, lbl, r.x + r.w - 6, r.y + 10, {
            size: 8,
            weight: 800,
            color: slot.outcome === 'rework' ? COLORS.broken : id === 'inspection' ? COLORS.running : COLORS.blocked,
            align: 'right',
            baseline: 'middle',
          });
        }
      }
    });

    // Maintenance / repair hazard frame
    if (st.service) {
      hazardFrame(ctx, b, 5);
    }
    if (st.broken) {
      const a = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(realT * 7));
      ctx.save();
      ctx.globalAlpha = a;
      ctx.strokeStyle = COLORS.broken;
      ctx.lineWidth = 4;
      roundRectPath(ctx, b.x - 1, b.y - 1, b.w + 2, b.h + 2, 7);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawMachines(state: GameState, sl: StationLayout, simT: number, paused: boolean): void {
    const ctx = this.ctx;
    const id = sl.id;
    const st = state.stations[id];
    const sf = staffFactor(state, id);
    sl.slots.forEach((r, i) => {
      const slot = st.slots[i] ?? null;
      const active = !!slot && !slot.done && !st.broken && !st.service && sf > 0 && !paused;
      const cx = r.x + r.w / 2 - 6;
      const base = r.y + 44;
      const phase = simT + i * 1.7;
      switch (id) {
        case 'stamping': {
          // Press frame + ram
          ctx.fillStyle = COLORS.steel;
          ctx.fillRect(cx - 36, r.y + 3, 3, base - r.y - 3);
          ctx.fillRect(cx + 33, r.y + 3, 3, base - r.y - 3);
          ctx.fillRect(cx - 36, r.y + 3, 72, 4);
          const stroke = active ? Math.pow(Math.abs(Math.sin((phase * Math.PI) / 6)), 3) : 0;
          const ramY = r.y + 7 + stroke * 8;
          ctx.fillStyle = '#5b636b';
          ctx.fillRect(cx - 4, r.y + 7, 8, ramY - r.y - 7 + 2);
          ctx.fillStyle = active ? COLORS.accent : '#6b737b';
          ctx.fillRect(cx - 26, ramY, 52, 5);
          ctx.fillStyle = 'rgba(0,0,0,0.3)';
          ctx.fillRect(cx - 26, ramY + 4, 52, 1);
          break;
        }
        case 'body': {
          // Welding robot on the right
          const bx = r.x + r.w - 10;
          const sway = active ? Math.sin(phase * 0.9) * 10 : 0;
          const tipX = cx + 14 + sway;
          const tipY = base - 16 + (active ? Math.cos(phase * 1.3) * 3 : -4);
          const elbowX = bx - 2;
          const elbowY = r.y + 10;
          ctx.fillStyle = COLORS.steel;
          ctx.fillRect(bx - 5, base - 6, 10, 6);
          ctx.strokeStyle = COLORS.accent;
          ctx.lineWidth = 3;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(bx, base - 6);
          ctx.lineTo(elbowX, elbowY);
          ctx.lineTo(tipX, tipY);
          ctx.stroke();
          ctx.lineCap = 'butt';
          ctx.fillStyle = '#2b2f34';
          ctx.beginPath();
          ctx.arc(elbowX, elbowY, 2.5, 0, Math.PI * 2);
          ctx.fill();
          if (active) {
            const seed = Math.floor(simT * 6);
            ctx.fillStyle = 'rgba(255,240,180,0.9)';
            ctx.beginPath();
            ctx.arc(tipX, tipY, 2.4, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#ffd36b';
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            for (let k = 0; k < 7; k++) {
              const a = rand(seed * 13 + k * 7 + i) * Math.PI * 2;
              const len = 3 + rand(seed * 5 + k) * 6;
              ctx.moveTo(tipX, tipY);
              ctx.lineTo(tipX + Math.cos(a) * len, tipY + Math.sin(a) * len + 1);
            }
            ctx.stroke();
          }
          break;
        }
        case 'paint': {
          const v = slot ? state.vehicles[String(slot.vehicleId)] : undefined;
          const prog = slot && slot.required > 0 ? Math.min(1, slot.progress / slot.required) : 0;
          // Overhead rail + gun
          ctx.fillStyle = COLORS.steel;
          ctx.fillRect(cx - 38, r.y + 4, 76, 3);
          const gx = slot ? cx - 34 + 68 * (slot.done ? 1 : prog) + (active ? Math.sin(phase * 2) * 3 : 0) : cx;
          ctx.fillStyle = '#6b737b';
          ctx.fillRect(gx - 4, r.y + 6, 8, 5);
          ctx.fillStyle = COLORS.accent;
          ctx.fillRect(gx - 1.5, r.y + 11, 3, 4);
          if (active && v) {
            const seed = Math.floor(simT * 5);
            ctx.save();
            ctx.globalAlpha = 0.35;
            ctx.fillStyle = v.color;
            ctx.beginPath();
            ctx.moveTo(gx - 1.5, r.y + 15);
            ctx.lineTo(gx - 9, base - 18);
            ctx.lineTo(gx + 9, base - 18);
            ctx.closePath();
            ctx.fill();
            for (let k = 0; k < 10; k++) {
              const px = gx + (rand(seed * 11 + k) - 0.5) * 22;
              const py = r.y + 16 + rand(seed * 3 + k * 5) * (base - r.y - 30);
              ctx.beginPath();
              ctx.arc(px, py, 1 + rand(seed + k) * 1.5, 0, Math.PI * 2);
              ctx.fill();
            }
            ctx.restore();
          }
          break;
        }
        case 'final': {
          // Overhead hoist lowering parts
          ctx.fillStyle = COLORS.steel;
          ctx.fillRect(cx - 38, r.y + 3, 76, 3);
          const hx = cx + (active ? Math.sin(phase * 0.5) * 18 : 10);
          const drop = active ? 4 + (0.5 + 0.5 * Math.sin(phase * 1.1)) * 6 : 2;
          ctx.fillStyle = '#6b737b';
          ctx.fillRect(hx - 4, r.y + 5, 8, 3);
          ctx.strokeStyle = '#9aa2aa';
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.moveTo(hx, r.y + 8);
          ctx.lineTo(hx, r.y + 8 + drop);
          ctx.stroke();
          ctx.fillStyle = active ? COLORS.accent : '#5b636b';
          ctx.fillRect(hx - 5, r.y + 8 + drop, 10, 5);
          // Lift posts
          ctx.fillStyle = COLORS.steel;
          ctx.fillRect(cx - 40, base - 20, 3, 20);
          ctx.fillRect(cx + 37, base - 20, 3, 20);
          break;
        }
        case 'inspection': {
          // Scanner arch with sweeping beam
          ctx.fillStyle = COLORS.steel;
          ctx.fillRect(cx - 40, r.y + 4, 3, base - r.y - 4);
          ctx.fillRect(cx + 37, r.y + 4, 3, base - r.y - 4);
          ctx.fillRect(cx - 40, r.y + 4, 80, 3);
          if (active) {
            const bx = cx + Math.sin(phase * 0.8) * 32;
            const g = ctx.createLinearGradient(bx - 6, 0, bx + 6, 0);
            g.addColorStop(0, 'rgba(63,185,80,0)');
            g.addColorStop(0.5, 'rgba(110,231,140,0.55)');
            g.addColorStop(1, 'rgba(63,185,80,0)');
            ctx.fillStyle = g;
            ctx.fillRect(bx - 6, r.y + 7, 12, base - r.y - 7);
            ctx.fillStyle = '#6ee78c';
            ctx.fillRect(bx - 3, r.y + 5, 6, 3);
          } else {
            ctx.fillStyle = '#5b636b';
            ctx.fillRect(cx - 3, r.y + 5, 6, 3);
          }
          break;
        }
      }
    });
  }

  private stationBanner(state: GameState, id: StationId, st: StationState): Banner | null {
    const issues = st.issues ?? [];
    const has = (k: StationIssue['kind']) => issues.find((i) => i.kind === k);
    if (st.broken || has('broken')) return { text: 'BREAKDOWN', color: COLORS.broken, textColor: '#fff' };
    if (st.service) {
      const label = st.service.kind === 'repair' ? 'REPAIR' : 'MAINTENANCE';
      return { text: `${label} · ${formatDuration(Math.max(0, st.service.remaining))}`, color: COLORS.service, textColor: '#fff', wrench: true };
    }
    if (has('downstream')) return { text: 'OUTPUT BLOCKED', color: COLORS.blocked, textColor: '#111' };
    const mat = has('materials');
    if (mat) {
      const comps = mat.components ?? [];
      const first = comps[0] ? BALANCE.components[comps[0]].short.toUpperCase() : 'MATERIALS';
      return { text: `NO ${first}${comps.length > 1 ? ` +${comps.length - 1}` : ''}`, color: COLORS.blocked, textColor: '#111' };
    }
    if (has('staff')) {
      const sf = staffFactor(state, id);
      if (sf <= 0) return { text: id === 'inspection' ? 'NO INSPECTORS' : 'NO OPERATORS', color: COLORS.blocked, textColor: '#111' };
      return { text: 'UNDERSTAFFED', color: COLORS.blocked, textColor: '#111' };
    }
    if (has('cash')) return { text: 'NO CASH', color: COLORS.blocked, textColor: '#111' };
    return null;
  }

  private drawStationOverlay(state: GameState, sl: StationLayout, realT: number): void {
    const ctx = this.ctx;
    const st = state.stations[sl.id];
    const b = sl.box;
    if (st.broken) {
      // Smoke puffs (real time: alarm stays visible when paused)
      for (let i = 0; i < 6; i++) {
        const ph = (realT * 0.45 + i / 6) % 1;
        const x = b.x + b.w - 28 + Math.sin(i * 2.3 + realT * 1.3) * 5 + ph * 14;
        const y = b.y + 18 - ph * 46;
        ctx.fillStyle = `rgba(150,154,160,${(0.8 * (1 - ph)).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(x, y, 5 + ph * 12, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (st.service) {
      // Big wrench over the slot area
      const r = sl.slots[0];
      ctx.fillStyle = 'rgba(59,130,246,0.18)';
      ctx.beginPath();
      ctx.arc(r.x + r.w - 16, r.y + 18, 11, 0, Math.PI * 2);
      ctx.fill();
      drawWrenchIcon(ctx, r.x + r.w - 16, r.y + 18, 8, '#9cc3ff');
    }
    const banner = this.stationBanner(state, sl.id, st);
    if (banner) drawBanner(ctx, b.x + b.w / 2, b.y - 10, banner, st.broken ? 0.75 + 0.25 * Math.sin(realT * 7) : 1);
  }

  // ---------------- rework & yard ----------------

  private drawRework(state: GameState, layout: FactoryLayout): void {
    const ctx = this.ctx;
    const rw = layout.rework;
    const t: HitTarget = { kind: 'station', id: 'inspection' };
    const hov = this.isHovered(t);
    this.panel(rw.box, 'REWORK BAY', null, `${state.rework.queue.length}/${rw.queueSpots.length} waiting`);
    if (hov || this.selected === 'inspection') {
      ctx.strokeStyle = this.selected === 'inspection' ? 'rgba(240,124,30,0.6)' : COLORS.steelLight;
      ctx.lineWidth = 2;
      roundRectPath(ctx, rw.box.x, rw.box.y, rw.box.w, rw.box.h, 6);
      ctx.stroke();
    }
    for (const s of rw.queueSpots) {
      ctx.strokeStyle = 'rgba(229,72,77,0.3)';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.strokeRect(s.x, s.y, s.w, s.h);
      ctx.setLineDash([]);
    }
    const r = rw.slot;
    ctx.fillStyle = COLORS.panelDark;
    roundRectPath(ctx, r.x, r.y, r.w, r.h, 4);
    ctx.fill();
    ctx.strokeStyle = COLORS.steel;
    ctx.lineWidth = 1;
    ctx.stroke();
    const slot = state.rework.slot;
    const py = r.y + r.h - 8;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(r.x + 6, py, r.w - 12, 4);
    if (slot) {
      const f = slot.done ? 1 : slot.required > 0 ? Math.min(1, slot.progress / slot.required) : 0;
      ctx.fillStyle = slot.done ? COLORS.blocked : COLORS.running;
      ctx.fillRect(r.x + 6, py, (r.w - 12) * f, 4);
    } else {
      text(ctx, 'idle', r.x + r.w / 2, r.y + 28, { size: 10, color: 'rgba(138,147,156,0.5)', align: 'center' });
    }
  }

  private drawReworkOverlay(state: GameState, layout: FactoryLayout): void {
    const rb = state.rework.issues ?? [];
    const rw = layout.rework.box;
    let banner: Banner | null = null;
    if (rb.some((i) => i.kind === 'downstream')) banner = { text: 'OUTPUT BLOCKED', color: COLORS.blocked, textColor: '#111' };
    else if (rb.some((i) => i.kind === 'cash')) banner = { text: 'NO CASH', color: COLORS.blocked, textColor: '#111' };
    if (banner) drawBanner(this.ctx, rw.x + 150, rw.y, banner, 1);
  }

  private drawYard(state: GameState, layout: FactoryLayout): void {
    const ctx = this.ctx;
    const y = layout.yard;
    const cap = yardCapacity(state);
    const full = state.yard.length >= cap;
    this.panel(y.box, 'FINISHED YARD', { kind: 'tab', tab: 'vehicles' }, `${state.yard.length}/${cap}`);
    if (full) {
      text(ctx, 'FULL', y.box.x + y.box.w - 50, y.box.y + 16, { size: 10, weight: 800, color: COLORS.broken, align: 'right' });
    }
    ctx.strokeStyle = 'rgba(230,232,234,0.22)';
    ctx.lineWidth = 1;
    for (const s of y.spots) {
      ctx.beginPath();
      ctx.moveTo(s.x, s.y + s.h);
      ctx.lineTo(s.x + s.w, s.y + s.h);
      ctx.moveTo(s.x, s.y + 4);
      ctx.lineTo(s.x, s.y + s.h);
      ctx.moveTo(s.x + s.w, s.y + 4);
      ctx.lineTo(s.x + s.w, s.y + s.h);
      ctx.stroke();
    }
  }
}

// ---------------- helpers ----------------

function font(size: number, weight = 500): string {
  return `${weight} ${size}px ${FONT}`;
}

interface TextOpts {
  size?: number;
  weight?: number;
  color?: string;
  align?: CanvasTextAlign;
  baseline?: CanvasTextBaseline;
  maxWidth?: number;
}

function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, o: TextOpts = {}): void {
  ctx.font = font(o.size ?? 12, o.weight ?? 500);
  ctx.fillStyle = o.color ?? COLORS.text;
  ctx.textAlign = o.align ?? 'left';
  ctx.textBaseline = o.baseline ?? 'alphabetic';
  if (o.maxWidth) ctx.fillText(s, x, y, o.maxWidth);
  else ctx.fillText(s, x, y);
}

function inflate(r: Rect, l: number, t: number, rr: number, b: number): Rect {
  return { x: r.x - l, y: r.y - t, w: r.w + l + rr, h: r.h + t + b };
}

/** Deterministic hash → [0,1). */
function rand(n: number): number {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function arrowHead(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, color: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-7, -4.5);
  ctx.lineTo(-7, 4.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawWorker(ctx: CanvasRenderingContext2D, x: number, y: number, filled: boolean, color: string): void {
  ctx.beginPath();
  ctx.arc(x, y - 7, 2.6, 0, Math.PI * 2);
  ctx.moveTo(x - 4, y + 1);
  ctx.lineTo(x - 4, y - 1);
  ctx.quadraticCurveTo(x - 4, y - 4, x, y - 4);
  ctx.quadraticCurveTo(x + 4, y - 4, x + 4, y - 1);
  ctx.lineTo(x + 4, y + 1);
  ctx.closePath();
  if (filled) {
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawWarning(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - 5.5);
  ctx.lineTo(x + 5.5, y + 4);
  ctx.lineTo(x - 5.5, y + 4);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#111';
  ctx.fillRect(x - 0.6, y - 2.5, 1.2, 3.6);
  ctx.fillRect(x - 0.6, y + 1.8, 1.2, 1.2);
}

function drawBanner(ctx: CanvasRenderingContext2D, cx: number, cy: number, b: Banner, alpha: number): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = font(10, 800);
  const tw = ctx.measureText(b.text).width;
  const w = tw + 16 + (b.wrench ? 12 : 0);
  const h = 16;
  const x = cx - w / 2;
  const y = cy - h / 2;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  roundRectPath(ctx, x + 1.5, y + 2, w, h, 3);
  ctx.fill();
  ctx.fillStyle = b.color;
  roundRectPath(ctx, x, y, w, h, 3);
  ctx.fill();
  let tx = x + 8;
  if (b.wrench) {
    drawWrenchIcon(ctx, x + 10, cy, 4, b.textColor);
    tx += 12;
  }
  ctx.fillStyle = b.textColor;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(b.text, tx, cy + 0.5);
  ctx.restore();
}

/** Yellow/black hazard stripes in a frame of width `t` around rect r. */
function hazardFrame(ctx: CanvasRenderingContext2D, r: Rect, t: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x - 2, r.y - 2, r.w + 4, r.h + 4);
  ctx.rect(r.x + t, r.y + t, r.w - 2 * t, r.h - 2 * t);
  ctx.clip('evenodd');
  ctx.fillStyle = '#111';
  ctx.fillRect(r.x - 2, r.y - 2, r.w + 4, r.h + 4);
  ctx.fillStyle = COLORS.safety;
  const span = r.w + r.h + 8;
  for (let d = -r.h - 8; d < span; d += 12) {
    ctx.beginPath();
    ctx.moveTo(r.x + d, r.y - 4);
    ctx.lineTo(r.x + d + 6, r.y - 4);
    ctx.lineTo(r.x + d + 6 + r.h + 8, r.y + r.h + 4);
    ctx.lineTo(r.x + d + r.h + 8, r.y + r.h + 4);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawTruck(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, label: string): void {
  const cabW = 16;
  const trW = w - cabW - 2;
  // Trailer
  ctx.fillStyle = '#d9dde1';
  roundRectPath(ctx, x, y, trW, h - 4, 2);
  ctx.fill();
  ctx.fillStyle = COLORS.accent;
  ctx.fillRect(x, y + h - 7, trW, 2);
  // Cab (facing right toward the dock)
  ctx.fillStyle = COLORS.accent;
  roundRectPath(ctx, x + trW + 2, y + 3, cabW, h - 7, 3);
  ctx.fill();
  ctx.fillStyle = '#5d7a94';
  ctx.fillRect(x + trW + 10, y + 5, 6, 5);
  // Wheels
  ctx.fillStyle = '#111';
  for (const wx of [x + 8, x + trW - 10, x + trW + 12]) {
    ctx.beginPath();
    ctx.arc(wx, y + h - 3, 2.6, 0, Math.PI * 2);
    ctx.fill();
  }
  text(ctx, label, x + trW / 2, y + (h - 4) / 2 + 0.5, {
    size: 9,
    weight: 700,
    color: '#1b1d20',
    align: 'center',
    baseline: 'middle',
    maxWidth: trW - 4,
  });
}
