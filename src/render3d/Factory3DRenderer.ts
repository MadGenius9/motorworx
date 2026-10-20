/**
 * WebGL factory view (three.js). Builds a lit, shadowed 3D hall from the same floor-plan layout as the 2D view
 * (2D x → world x, 2D y → world z, y is up) and animates it from the game state every frame.
 * Never mutates game state. Camera: drag to pan, right-drag (or shift-drag) to orbit, wheel to zoom.
 */
import * as THREE from 'three';
import { BALANCE, COMPONENT_IDS, STATION_IDS } from '../config/balance';
import type { ComponentId, StationId } from '../config/balance';
import type { IGameController } from '../game/types';
import { COLORS, STATUS_COLOR, type HitTarget } from '../render/FactoryRenderer';
import { computeLayout, vehicleTargets, type FactoryLayout, type Rect } from '../render/layout';
import {
  breakdownRisk,
  formatDuration,
  formatTime,
  incomingUnits,
  modelName,
  plantOf,
  queueCapacity,
  stationName,
  stationRequiredStaff,
  stationStaff,
  stationStatus,
  staffFactor,
  stockOnHand,
  unlockedModels,
  vehicleLabel,
  warehouseCapacity,
  yardCapacity,
  type PanelTab,
  type StationStatus,
} from '../sim/selectors';
import type { GameState, StationIssue, StationState } from '../sim/types';
import { buildCar, disposeCar, updateCar, updateCarTag, type CarRig } from './cars';
import { CanvasTex, FONT, Label, roundRect } from './canvasTexture';

export interface Factory3DCallbacks {
  onSelectStation(id: StationId | null): void;
  onOpenTab(tab: PanelTab): void;
}

const STATUS_TEXT: Record<StationStatus, string> = {
  running: 'RUNNING',
  idle: 'IDLE',
  blocked: 'BLOCKED',
  understaffed: 'UNDERSTAFFED',
  broken: 'BROKEN',
  repair: 'REPAIR',
  maintenance: 'MAINTENANCE',
};

const COMPONENT_COLOR: Record<ComponentId, string> = {
  steel: '#9aa3ab',
  powertrain: '#c0612a',
  interior: '#6a5a8c',
  wheels: '#2b2f34',
  paint: '#3f8f6a',
};

const PLATFORM_H = 4;
/** Default camera: a slight three-quarter angle reads as 3D far better than straight on. */
const DEFAULT_AZ = -0.32;
const DEFAULT_EL = 0.72;

/** Shared geometry: a unit box (scaled per mesh). */
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

function boxMesh(mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, shadows = true): THREE.Mesh {
  const m = new THREE.Mesh(UNIT_BOX, mat);
  m.scale.set(w, h, d);
  m.position.set(x, y + h / 2, z);
  m.castShadow = shadows;
  m.receiveShadow = true;
  return m;
}

function rectOutline(r: Rect, y: number, color: string, dashed = false): THREE.LineSegments {
  const pts = [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x + r.w, r.y + r.h],
    [r.x, r.y + r.h],
  ];
  const pos: number[] = [];
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    pos.push(a[0], y, a[1], b[0], y, b[1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const mat = dashed
    ? new THREE.LineDashedMaterial({ color, dashSize: 6, gapSize: 5 })
    : new THREE.LineBasicMaterial({ color });
  const l = new THREE.LineSegments(g, mat);
  if (dashed) l.computeLineDistances();
  return l;
}

/** Ground plane piece (flat box) for zones like the yard or queues. */
function slab(r: Rect, h: number, color: string, y = 0): THREE.Mesh {
  const m = boxMesh(new THREE.MeshStandardMaterial({ color, roughness: 0.85 }), r.w, h, r.h, r.x + r.w / 2, y, r.y + r.h / 2, false);
  return m;
}

interface Animated {
  /** Called every frame with sim time, real time and whether this part's slot is working. */
  update(simT: number, realT: number, active: boolean): void;
}

interface StationView {
  id: StationId;
  platformMat: THREE.MeshStandardMaterial;
  edge: THREE.LineSegments;
  beaconMat: THREE.MeshStandardMaterial;
  beacon: THREE.Mesh;
  label: Label;
  banner: Label;
  queueLabel: Label | null;
  slotAnims: Animated[][];
  smoke: THREE.Mesh[];
}

interface Truck {
  group: THREE.Group;
  label: Label;
}

const tmpV = new THREE.Vector3();

/** Distance at which labels show at their natural size; closer zooms shrink them, farther grow them. */
const LABEL_REF_DIST = 900;

export class Factory3DRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(32, 1, 5, 20000);
  private readonly raycaster = new THREE.Raycaster();
  private readonly world = new THREE.Group();
  private staticGroup = new THREE.Group();
  private readonly carGroup = new THREE.Group();
  private readonly truckGroup = new THREE.Group();
  private readonly cars = new Map<number, { rig: CarRig; pos: THREE.Vector3; model: string }>();
  private readonly trucks: Truck[] = [];
  private stations: Partial<Record<StationId, StationView>> = {};
  private pickables: THREE.Object3D[] = [];
  private layout: FactoryLayout | null = null;
  private layoutKey = '';
  private stateRef: GameState | null = null;
  private raf = 0;
  private lastFrame = 0;
  private plant = 0;
  private selected: StationId | null = null;
  private hovered: HitTarget | null = null;

  // Camera state.
  private target = new THREE.Vector3();
  private dist = 1500;
  private az = DEFAULT_AZ;
  private el = DEFAULT_EL;
  private userMoved = false;
  private cssW = 1;
  private cssH = 1;

  // Pointer state.
  private down: { x: number; y: number; button: number; shift: boolean } | null = null;
  private dragged = false;
  private last = { x: 0, y: 0 };

  // Dynamic scene parts rebuilt with the layout.
  private conveyorTex: THREE.CanvasTexture | null = null;
  private crates: Partial<Record<ComponentId, THREE.Mesh[]>> = {};
  private rackLabels: Partial<Record<ComponentId, Label>> = {};
  private zoneLabels: { warehouse?: Label; dock?: Label; yard?: Label; rework?: Label } = {};
  private planTex: CanvasTex | null = null;
  private signTex: CanvasTex | null = null;
  private construction: THREE.Group | null = null;
  private constructionLabel: Label | null = null;
  /** Every label in the static scene, rescaled each frame so text stays a readable on-screen size. */
  private labels: Label[] = [];

  private label(lineWorldHeight: number, opts?: ConstructorParameters<typeof Label>[1]): Label {
    const l = new Label(lineWorldHeight, opts);
    this.labels.push(l);
    return l;
  }

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private controller: IGameController,
    private readonly callbacks: Factory3DCallbacks,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.scene.background = new THREE.Color('#15171a');
    this.scene.fog = new THREE.Fog('#15171a', 3200, 7000);
    this.scene.add(this.world);
    this.world.add(this.carGroup, this.truckGroup);
    this.addLights();
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', this.onContext);
  }

  // ─────────────── public API (mirrors the 2D renderer) ───────────────

  start(): void {
    if (this.raf) return;
    this.lastFrame = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      try {
        this.frame(now);
      } catch (err) {
        // Keep the loop alive; log once per distinct message.
        const msg = String(err);
        if (msg !== this.lastError) console.error('3D factory view error:', err);
        this.lastError = msg;
      }
    };
    this.raf = requestAnimationFrame(loop);
  }
  private lastError = '';

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  destroy(): void {
    this.stop();
    const c = this.canvas;
    c.removeEventListener('pointerdown', this.onDown);
    c.removeEventListener('pointermove', this.onMove);
    c.removeEventListener('pointerup', this.onUp);
    c.removeEventListener('pointerleave', this.onLeave);
    c.removeEventListener('wheel', this.onWheel);
    c.removeEventListener('contextmenu', this.onContext);
    for (const v of this.cars.values()) disposeCar(v.rig);
    this.cars.clear();
    this.disposeGroup(this.staticGroup);
    this.renderer.dispose();
  }

  setController(c: IGameController): void {
    this.controller = c;
  }

  setPlant(plant: number): void {
    if (plant === this.plant) return;
    this.plant = plant;
    this.layoutKey = '';
    this.clearCars();
  }

  setSelected(id: StationId | null): void {
    this.selected = id;
  }

  resize(cssW: number, cssH: number): void {
    this.cssW = Math.max(1, cssW);
    this.cssH = Math.max(1, cssH);
    this.renderer.setSize(this.cssW, this.cssH, false);
    this.camera.aspect = this.cssW / this.cssH;
    this.camera.updateProjectionMatrix();
    if (!this.userMoved && this.layout) this.fit(this.layout);
  }

  zoomBy(factor: number): void {
    this.userMoved = true;
    this.dist = THREE.MathUtils.clamp(this.dist / factor, 250, 6000);
  }

  resetView(): void {
    this.userMoved = false;
    this.az = DEFAULT_AZ;
    this.el = DEFAULT_EL;
    if (this.layout) this.fit(this.layout);
  }

  // ─────────────── scene setup ───────────────

  private addLights(): void {
    this.scene.add(new THREE.HemisphereLight('#e8eef5', '#3a3d42', 1.25));
    const sun = new THREE.DirectionalLight('#fff4e5', 2.6);
    sun.position.set(-500, 1100, 700);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6;
    const cam = sun.shadow.camera;
    cam.near = 50;
    cam.far = 3500;
    cam.left = -1300;
    cam.right = 1300;
    cam.top = 1000;
    cam.bottom = -1000;
    this.sun = sun;
    this.scene.add(sun, sun.target);
    const fill = new THREE.DirectionalLight('#9fb7d4', 0.35);
    fill.position.set(800, 500, -600);
    this.scene.add(fill);
  }
  private sun!: THREE.DirectionalLight;

  private disposeGroup(g: THREE.Object3D): void {
    g.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry && mesh.geometry !== UNIT_BOX) mesh.geometry.dispose();
      const mat = (mesh as { material?: THREE.Material | THREE.Material[] }).material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
  }

  /** Frame the whole factory: adjust distance until every corner of the hall projects inside the view. */
  private fit(layout: FactoryLayout): void {
    const b = layout.bounds;
    this.target.set(b.x + b.w / 2, 0, b.y + b.h / 2 + 20);
    const corners: THREE.Vector3[] = [];
    for (const x of [b.x, b.x + b.w]) for (const z of [b.y - 30, b.y + b.h]) for (const y of [0, 110]) corners.push(new THREE.Vector3(x, y, z));
    this.dist = 1500;
    for (let i = 0; i < 6; i++) {
      this.placeCamera();
      this.camera.updateMatrixWorld();
      let ext = 0;
      for (const c of corners) {
        const p = c.clone().project(this.camera);
        ext = Math.max(ext, Math.abs(p.x), Math.abs(p.y));
      }
      this.dist *= ext / 0.94;
    }
  }

  private placeCamera(): void {
    const ce = Math.cos(this.el);
    this.camera.position.set(
      this.target.x + Math.sin(this.az) * ce * this.dist,
      this.target.y + Math.sin(this.el) * this.dist,
      this.target.z + Math.cos(this.az) * ce * this.dist,
    );
    this.camera.lookAt(this.target);
    // Keep the shadow frustum centred on what we look at.
    this.sun.position.set(this.target.x - 500, 1100, this.target.z + 700);
    this.sun.target.position.copy(this.target);
  }

  private layoutSignature(state: GameState, layout: FactoryLayout): string {
    const P = plantOf(state, this.plant);
    return JSON.stringify([
      this.plant,
      layout.bounds,
      STATION_IDS.map((id) => [P.stations[id].slots.length, queueCapacity(state, id, this.plant)]),
      layout.yard.spots.length,
    ]);
  }

  /** Rebuild the static hall: floor, walls, platforms, machines, zones, boards. */
  private buildStatic(state: GameState, layout: FactoryLayout): void {
    this.world.remove(this.staticGroup);
    this.disposeGroup(this.staticGroup);
    this.staticGroup = new THREE.Group();
    this.world.add(this.staticGroup);
    this.pickables = [];
    for (const l of this.labels) l.dispose();
    this.labels = [];
    this.stations = {};
    this.crates = {};
    this.rackLabels = {};
    this.zoneLabels = {};
    this.construction = null;
    for (const t of this.trucks) this.truckGroup.remove(t.group);
    this.trucks.length = 0;
    const g = this.staticGroup;
    const b = layout.bounds;

    // Floor: polished concrete with a faint grid.
    const floorTex = new CanvasTex(256, 256);
    floorTex.draw('floor', (ctx, w, h) => {
      ctx.fillStyle = '#3b3f45';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.lineWidth = 2;
      ctx.strokeRect(0, 0, w, h);
      for (let i = 0; i < 400; i++) {
        ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.025})`;
        ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
      }
    });
    floorTex.texture.wrapS = floorTex.texture.wrapT = THREE.RepeatWrapping;
    const pad = 400;
    floorTex.texture.repeat.set((b.w + pad * 2) / 80, (b.h + pad * 2) / 80);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(b.w + pad * 2, b.h + pad * 2),
      new THREE.MeshStandardMaterial({ map: floorTex.texture, roughness: 0.82, metalness: 0.05 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(b.x + b.w / 2, 0, b.y + b.h / 2);
    floor.receiveShadow = true;
    floor.userData.hit = null;
    g.add(floor);
    this.pickables.push(floor);

    // Hall: back wall with pillars and side walls give depth.
    const wallMat = new THREE.MeshStandardMaterial({ color: '#4b5058', roughness: 0.9 });
    const pillarMat = new THREE.MeshStandardMaterial({ color: '#4a5058', roughness: 0.7, metalness: 0.2 });
    g.add(boxMesh(wallMat, b.w + pad, 140, 10, b.x + b.w / 2, 0, b.y - 30, false));
    for (let x = b.x - pad / 2 + 60; x < b.x + b.w + pad / 2; x += 220) {
      g.add(boxMesh(pillarMat, 18, 150, 18, x, 0, b.y - 22));
    }
    g.add(boxMesh(new THREE.MeshStandardMaterial({ color: '#e8c21a', roughness: 0.6 }), b.w + pad, 6, 11, b.x + b.w / 2, 40, b.y - 30, false));

    // Safety walkways.
    const walkMat = new THREE.MeshBasicMaterial({ color: '#e8c21a' });
    for (const wy of layout.walkwaysY) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(b.w - 20, 2.5), walkMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(b.x + b.w / 2, 0.3, wy);
      g.add(m);
    }

    this.buildConveyor(layout);
    for (const id of STATION_IDS) this.buildStation(state, layout, id);
    this.buildRework(layout);
    this.buildYard(layout);
    this.buildWarehouse(layout);
    this.buildDock(layout);
    this.buildBoards(layout);
  }

  private buildConveyor(layout: FactoryLayout): void {
    const first = layout.stations.stamping.box;
    const x0 = first.x - 10;
    const x1 = layout.yard.box.x;
    const tex = new CanvasTex(128, 32);
    tex.draw('belt', (ctx, w, h) => {
      ctx.fillStyle = '#1c1e21';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(240,124,30,0.55)';
      ctx.lineWidth = 4;
      for (let i = 0; i < 2; i++) {
        const cx = 20 + i * 64;
        ctx.beginPath();
        ctx.moveTo(cx, 6);
        ctx.lineTo(cx + 14, h / 2);
        ctx.lineTo(cx, h - 6);
        ctx.stroke();
      }
    });
    tex.texture.wrapS = THREE.RepeatWrapping;
    tex.texture.repeat.set((x1 - x0) / 64, 1);
    this.conveyorTex = tex.texture;
    const belt = new THREE.Mesh(
      new THREE.BoxGeometry(x1 - x0, 1.2, 20),
      [
        new THREE.MeshStandardMaterial({ color: '#3a3f45' }),
        new THREE.MeshStandardMaterial({ color: '#3a3f45' }),
        new THREE.MeshStandardMaterial({ map: tex.texture, roughness: 0.6 }),
        new THREE.MeshStandardMaterial({ color: '#3a3f45' }),
        new THREE.MeshStandardMaterial({ color: '#3a3f45' }),
        new THREE.MeshStandardMaterial({ color: '#3a3f45' }),
      ],
    );
    belt.position.set((x0 + x1) / 2, 0.6, layout.conveyorY);
    belt.receiveShadow = true;
    this.staticGroup.add(belt);
    // Side rails.
    const railMat = new THREE.MeshStandardMaterial({ color: '#8a939c', metalness: 0.7, roughness: 0.35 });
    for (const dz of [-11, 11]) this.staticGroup.add(boxMesh(railMat, x1 - x0, 2.5, 1.5, (x0 + x1) / 2, 0, layout.conveyorY + dz, false));
  }

  private buildStation(state: GameState, layout: FactoryLayout, id: StationId): void {
    const g = this.staticGroup;
    const sl = layout.stations[id];
    const bx = sl.box;
    const platformMat = new THREE.MeshStandardMaterial({ color: '#4a5058', roughness: 0.65, metalness: 0.3 });
    const platform = boxMesh(platformMat, bx.w, PLATFORM_H, bx.h, bx.x + bx.w / 2, 0, bx.y + bx.h / 2, false);
    platform.userData.hit = { kind: 'station', id } satisfies HitTarget;
    g.add(platform);
    this.pickables.push(platform);
    const edge = rectOutline({ x: bx.x, y: bx.y, w: bx.w, h: bx.h }, PLATFORM_H + 0.3, '#8a939c');
    g.add(edge);

    // Hazard-striped header strip and lighter work lanes.
    const hdr = sl.header;
    g.add(boxMesh(new THREE.MeshStandardMaterial({ color: '#2f3338', roughness: 0.8 }), hdr.w - 6, 0.4, hdr.h - 10, hdr.x + hdr.w / 2, PLATFORM_H, hdr.y + hdr.h / 2, false));
    g.add(
      boxMesh(
        new THREE.MeshStandardMaterial({ map: this.hazardTexture(), roughness: 0.7 }),
        hdr.w - 6,
        0.5,
        5,
        hdr.x + hdr.w / 2,
        PLATFORM_H,
        hdr.y + hdr.h - 7,
        false,
      ),
    );
    const laneMat = new THREE.MeshStandardMaterial({ color: '#5a616a', roughness: 0.55, metalness: 0.2 });
    for (const r of sl.slots) g.add(boxMesh(laneMat, r.w, 0.4, r.h, r.x + r.w / 2, PLATFORM_H, r.y + r.h / 2, false));

    // Gantry frame over the station and low safety walls along its long sides.
    const frameMat = new THREE.MeshStandardMaterial({ color: '#5e6b7a', metalness: 0.55, roughness: 0.4 });
    const gH = 88;
    for (const x of [bx.x + 3, bx.x + bx.w - 3]) for (const z of [bx.y + 3, bx.y + bx.h - 3]) g.add(boxMesh(frameMat, 6, gH, 6, x, PLATFORM_H, z));
    for (const z of [bx.y + 3, bx.y + bx.h - 3]) g.add(boxMesh(frameMat, bx.w, 6, 6, bx.x + bx.w / 2, PLATFORM_H + gH - 6, z));
    for (const x of [bx.x + 3, bx.x + bx.w - 3]) g.add(boxMesh(frameMat, 6, 6, bx.h, x, PLATFORM_H + gH - 6, bx.y + bx.h / 2));
    const wallMat = new THREE.MeshStandardMaterial({ color: '#3a3f45', metalness: 0.4, roughness: 0.5 });
    const capMat = new THREE.MeshStandardMaterial({ color: '#e8c21a', roughness: 0.5 });
    for (const x of [bx.x + 1.5, bx.x + bx.w - 1.5]) {
      // Side walls leave a gap where the conveyor passes through.
      const gapTop = layout.conveyorY - 14;
      const gapBot = layout.conveyorY + 14;
      for (const [z0, z1] of [
        [bx.y + 6, gapTop],
        [gapBot, bx.y + bx.h - 6],
      ]) {
        if (z1 - z0 < 4) continue;
        g.add(boxMesh(wallMat, 3, 12, z1 - z0, x, PLATFORM_H, (z0 + z1) / 2, false));
        g.add(boxMesh(capMat, 3.4, 1.6, z1 - z0, x, PLATFORM_H + 12, (z0 + z1) / 2, false));
      }
    }

    // Control cabinet + status beacon on the header strip.
    const cabMat = new THREE.MeshStandardMaterial({ color: '#4a5058', roughness: 0.55, metalness: 0.3 });
    const cab = boxMesh(cabMat, 22, 26, 14, hdr.x + 18, PLATFORM_H, hdr.y + 14);
    cab.userData.hit = platform.userData.hit;
    this.pickables.push(cab);
    g.add(cab);
    const beaconMat = new THREE.MeshStandardMaterial({ color: '#8a939c', emissive: '#8a939c', emissiveIntensity: 0.6 });
    const beacon = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 4.5, 9, 16), beaconMat);
    beacon.position.set(bx.x + 3, PLATFORM_H + gH + 4.5, bx.y + 3);
    g.add(beacon);

    // Machines per slot.
    const slotAnims: Animated[][] = sl.slots.map((r) => this.buildMachine(id, r));

    // Labels.
    const label = this.label(8.5, { bg: 'rgba(27,29,32,0.88)', border: '#3a3f45' });
    label.sprite.position.set(bx.x + bx.w / 2, PLATFORM_H + gH + 6, bx.y + 6);
    g.add(label.sprite);
    const banner = this.label(8, { pad: 5 });
    banner.sprite.position.set(bx.x + bx.w / 2, PLATFORM_H + gH + 50, bx.y + 6);
    g.add(banner.sprite);
    let queueLabel: Label | null = null;
    if (sl.queue) {
      for (const spot of sl.queueSpots) g.add(rectOutline(spot, 0.4, '#e8c21a', true));
      queueLabel = this.label(6.5, { bg: 'rgba(27,29,32,0.75)' });
      queueLabel.sprite.position.set(sl.queue.x + sl.queue.w / 2, 14, sl.queue.y + 4);
      g.add(queueLabel.sprite);
      const zone = { ...sl.queue, y: sl.queue.y + 18, h: sl.queue.h - 18 };
      const qz = new THREE.Mesh(new THREE.PlaneGeometry(zone.w, zone.h), new THREE.MeshBasicMaterial({ color: '#e8c21a', transparent: true, opacity: 0.05 }));
      qz.rotation.x = -Math.PI / 2;
      qz.position.set(zone.x + zone.w / 2, 0.2, zone.y + zone.h / 2);
      qz.userData.hit = platform.userData.hit;
      this.pickables.push(qz);
      g.add(qz);
    }

    // Smoke puffs (shown on breakdown).
    const smokeMat = new THREE.MeshStandardMaterial({ color: '#6b7076', transparent: true, opacity: 0.5, roughness: 1 });
    const smoke: THREE.Mesh[] = [];
    for (let i = 0; i < 5; i++) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(6, 10, 8), smokeMat);
      s.visible = false;
      g.add(s);
      smoke.push(s);
    }
    this.stations[id] = { id, platformMat, edge, beaconMat, beacon, label, banner, queueLabel, slotAnims, smoke };
    void state;
  }

  /** Station machinery for one work slot. Returns animators driven by the slot's activity. */
  private buildMachine(id: StationId, r: Rect): Animated[] {
    const g = this.staticGroup;
    const cx = r.x + r.w / 2 - 6;
    const cz = r.y + r.h / 2;
    const top = PLATFORM_H;
    const steel = new THREE.MeshStandardMaterial({ color: '#5b636c', metalness: 0.6, roughness: 0.4 });
    const accent = new THREE.MeshStandardMaterial({ color: COLORS.accent, metalness: 0.3, roughness: 0.5 });
    const yellow = new THREE.MeshStandardMaterial({ color: '#e8c21a', roughness: 0.55 });
    const out: Animated[] = [];
    if (id === 'stamping') {
      for (const dz of [-r.h / 2 + 4, r.h / 2 - 4]) g.add(boxMesh(steel, 8, 56, 6, cx, top, cz + dz));
      g.add(boxMesh(accent, 60, 10, r.h - 2, cx, top + 52, cz));
      const ram = boxMesh(steel, 46, 8, r.h - 16, cx, top + 40, cz);
      g.add(ram);
      out.push({
        update: (simT, _realT, active) => {
          const phase = active ? (Math.sin(simT * 0.9) + 1) / 2 : 1;
          ram.position.y = top + 24 + phase * 20;
        },
      });
    } else if (id === 'body') {
      const sparks: THREE.Mesh[] = [];
      for (const side of [-1, 1]) {
        const baseZ = cz + side * (r.h / 2 - 5);
        const bx = cx + side * 18;
        g.add(boxMesh(steel, 10, 6, 10, bx, top, baseZ));
        const pivot = new THREE.Group();
        pivot.position.set(bx, top + 6, baseZ);
        const arm = boxMesh(accent, 4, 26, 4, 0, 0, 0);
        const fore = boxMesh(accent, 3, 16, 3, 0, 24, 0);
        fore.rotation.x = side * 0.9;
        fore.position.z = -side * 6;
        pivot.add(arm, fore);
        g.add(pivot);
        const spark = new THREE.Mesh(
          new THREE.SphereGeometry(2.4, 8, 6),
          new THREE.MeshBasicMaterial({ color: '#ffd27a' }),
        );
        spark.position.set(bx, top + 24, cz + side * 4);
        spark.visible = false;
        g.add(spark);
        sparks.push(spark);
        out.push({
          update: (simT, realT, active) => {
            pivot.rotation.x = active ? -side * (0.35 + Math.sin(simT * 1.3 + side) * 0.25) : -side * 0.2;
            pivot.rotation.y = active ? Math.sin(simT * 0.7 + side) * 0.4 : 0;
            spark.visible = active && Math.sin(realT * 40 + side * 3) > 0.2;
          },
        });
      }
    } else if (id === 'paint') {
      const glass = new THREE.MeshStandardMaterial({ color: '#9fc5e8', transparent: true, opacity: 0.16, roughness: 0.1, depthWrite: false });
      const booth = boxMesh(glass, r.w - 4, 46, r.h - 2, r.x + r.w / 2, top, cz, false);
      g.add(booth);
      g.add(rectOutline({ x: r.x + 2, y: r.y + 1, w: r.w - 4, h: r.h - 2 }, top + 46, '#9fc5e8'));
      const nozzle = boxMesh(accent, 6, 10, r.h - 12, cx, top + 30, cz);
      const mist = new THREE.Mesh(
        new THREE.ConeGeometry(9, 18, 12, 1, true),
        new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.25, depthWrite: false }),
      );
      mist.rotation.x = Math.PI;
      g.add(nozzle, mist);
      out.push({
        update: (simT, _realT, active) => {
          const x = cx + (active ? Math.sin(simT * 1.1) * (r.w / 2 - 18) : 0);
          nozzle.position.x = x;
          mist.position.set(x, top + 22, cz);
          mist.visible = active;
        },
      });
    } else if (id === 'final') {
      for (const dx of [-r.w / 2 + 6, r.w / 2 - 18])
        for (const dz of [-r.h / 2 + 4, r.h / 2 - 4]) g.add(boxMesh(yellow, 3, 48, 3, cx + dx, top, cz + dz));
      g.add(boxMesh(steel, r.w - 6, 4, 4, r.x + r.w / 2 - 6, top + 46, cz));
      const hoist = boxMesh(accent, 10, 8, 10, cx, top + 36, cz);
      g.add(hoist);
      out.push({
        update: (simT, _realT, active) => {
          hoist.position.x = cx + (active ? Math.sin(simT * 0.8) * 22 : 0);
          hoist.position.y = top + (active ? 32 + Math.abs(Math.sin(simT * 1.6)) * 6 : 38);
        },
      });
    } else {
      for (const dz of [-r.h / 2 + 3, r.h / 2 - 3]) g.add(boxMesh(steel, 6, 44, 4, cx, top, cz + dz));
      g.add(boxMesh(steel, 8, 6, r.h - 2, cx, top + 42, cz));
      const scan = new THREE.Mesh(
        new THREE.BoxGeometry(2, 40, r.h - 10),
        new THREE.MeshBasicMaterial({ color: '#3fb950', transparent: true, opacity: 0.55 }),
      );
      scan.position.set(cx, top + 22, cz);
      g.add(scan);
      out.push({
        update: (simT, _realT, active) => {
          scan.visible = active;
          scan.position.x = cx + Math.sin(simT * 1.5) * 30;
        },
      });
    }
    return out;
  }

  private hazardTex: THREE.CanvasTexture | null = null;

  /** Diagonal yellow/black stripes (shared). */
  private hazardTexture(): THREE.CanvasTexture {
    if (this.hazardTex) return this.hazardTex;
    const t = new CanvasTex(64, 64);
    t.draw('hazard', (ctx, w, h) => {
      ctx.fillStyle = '#1f2124';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#c9a516';
      for (let i = -2; i < 6; i++) {
        ctx.beginPath();
        ctx.moveTo(i * 16, 0);
        ctx.lineTo(i * 16 + 8, 0);
        ctx.lineTo(i * 16 + 8 + h, h);
        ctx.lineTo(i * 16 + h, h);
        ctx.fill();
      }
    });
    t.texture.wrapS = t.texture.wrapT = THREE.RepeatWrapping;
    t.texture.repeat.set(6, 0.25);
    this.hazardTex = t.texture;
    return t.texture;
  }

  private buildRework(layout: FactoryLayout): void {
    const g = this.staticGroup;
    const rw = layout.rework;
    const zone = slab(rw.box, 1.5, '#2e2a2b');
    zone.userData.hit = { kind: 'station', id: 'inspection' } satisfies HitTarget;
    this.pickables.push(zone);
    g.add(zone, rectOutline(rw.box, 1.8, '#e5484d', true));
    for (const s of rw.queueSpots) g.add(rectOutline(s, 1.8, '#8a939c', true));
    const booth = boxMesh(
      new THREE.MeshStandardMaterial({ color: '#e5484d', transparent: true, opacity: 0.12, depthWrite: false }),
      rw.slot.w,
      40,
      rw.slot.h,
      rw.slot.x + rw.slot.w / 2,
      1.5,
      rw.slot.y + rw.slot.h / 2,
      false,
    );
    g.add(booth, rectOutline(rw.slot, 41.5, '#e5484d'));
    const l = this.label(8, { bg: 'rgba(27,29,32,0.85)', border: '#e5484d' });
    l.sprite.position.set(rw.box.x + rw.box.w / 2, 44, rw.box.y + 4);
    g.add(l.sprite);
    this.zoneLabels.rework = l;
  }

  private buildYard(layout: FactoryLayout): void {
    const g = this.staticGroup;
    const y = layout.yard;
    const zone = slab(y.box, 1, '#2b2f34');
    zone.userData.hit = { kind: 'tab', tab: 'vehicles' } satisfies HitTarget;
    this.pickables.push(zone);
    g.add(zone);
    for (const s of y.spots) g.add(rectOutline(s, 1.3, '#d8dde2'));
    const l = this.label(8.5, { bg: 'rgba(27,29,32,0.85)', border: '#3a3f45' });
    l.sprite.position.set(y.box.x + y.box.w / 2, 30, y.box.y + 4);
    g.add(l.sprite);
    this.zoneLabels.yard = l;
  }

  private buildWarehouse(layout: FactoryLayout): void {
    const g = this.staticGroup;
    const wh = layout.warehouse.box;
    const zone = slab(wh, 2, '#2b2f34');
    zone.userData.hit = { kind: 'tab', tab: 'suppliers' } satisfies HitTarget;
    this.pickables.push(zone);
    g.add(zone);
    const frameMat = new THREE.MeshStandardMaterial({ color: '#2f6fb3', metalness: 0.4, roughness: 0.5 });
    const shelfMat = new THREE.MeshStandardMaterial({ color: '#e07b2a', metalness: 0.3, roughness: 0.6 });
    const n = COMPONENT_IDS.length;
    const rackW = (wh.w - 30) / n;
    COMPONENT_IDS.forEach((c, i) => {
      const x0 = wh.x + 15 + i * rackW;
      const cx = x0 + rackW / 2;
      const cz = wh.y + wh.h / 2 + 10;
      const depth = 40;
      for (const dx of [-rackW / 2 + 4, rackW / 2 - 4]) for (const dz of [-depth / 2, depth / 2]) g.add(boxMesh(frameMat, 3, 72, 3, cx + dx, 2, cz + dz));
      for (let s = 0; s < 3; s++) g.add(boxMesh(shelfMat, rackW - 6, 2, depth, cx, 2 + 4 + s * 24, cz, false));
      const crateMat = new THREE.MeshStandardMaterial({ color: COMPONENT_COLOR[c], roughness: 0.7, metalness: c === 'steel' ? 0.6 : 0.1 });
      const crates: THREE.Mesh[] = [];
      for (let k = 0; k < 12; k++) {
        const shelf = Math.floor(k / 4);
        const col = k % 4;
        const cw = (rackW - 14) / 2;
        const m = boxMesh(crateMat, cw - 2, 14, depth / 2 - 4, cx - cw / 2 + (col % 2) * cw, 2 + 6 + shelf * 24, cz - depth / 4 + Math.floor(col / 2) * (depth / 2));
        m.visible = false;
        g.add(m);
        crates.push(m);
      }
      this.crates[c] = crates;
      const lbl = this.label(6.5, { bg: 'rgba(27,29,32,0.8)' });
      lbl.sprite.position.set(cx, 80, cz);
      g.add(lbl.sprite);
      this.rackLabels[c] = lbl;
    });
    const l = this.label(9, { bg: 'rgba(27,29,32,0.88)', border: '#3a3f45' });
    l.sprite.position.set(wh.x + wh.w / 2, 104, wh.y + wh.h / 2);
    g.add(l.sprite);
    this.zoneLabels.warehouse = l;
  }

  private buildDock(layout: FactoryLayout): void {
    const g = this.staticGroup;
    const dk = layout.dock;
    const zone = slab(dk.box, 1, '#1f2124');
    zone.userData.hit = { kind: 'tab', tab: 'suppliers' } satisfies HitTarget;
    this.pickables.push(zone);
    g.add(zone);
    const stripe = new THREE.MeshBasicMaterial({ color: '#e8c21a' });
    for (const lane of dk.lanes) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(lane.w, 1.2), stripe);
      m.rotation.x = -Math.PI / 2;
      m.position.set(lane.x + lane.w / 2, 1.2, lane.y + lane.h);
      g.add(m);
    }
    // Dock doors on the right.
    const doorMat = new THREE.MeshStandardMaterial({ color: '#8a939c', metalness: 0.5, roughness: 0.4 });
    g.add(boxMesh(new THREE.MeshStandardMaterial({ color: '#3a3f45' }), 8, 60, dk.box.h - 10, dk.box.x + dk.box.w - 6, 0, dk.box.y + dk.box.h / 2));
    for (const lane of dk.lanes) g.add(boxMesh(doorMat, 2, 22, lane.h - 4, dk.box.x + dk.box.w - 11, 1, lane.y + lane.h / 2, false));
    const l = this.label(9, { bg: 'rgba(27,29,32,0.88)', border: '#3a3f45' });
    l.sprite.position.set(dk.box.x + dk.box.w / 2, 70, dk.box.y + 8);
    g.add(l.sprite);
    this.zoneLabels.dock = l;
    for (let i = 0; i < dk.lanes.length; i++) {
      const group = new THREE.Group();
      const cab = boxMesh(new THREE.MeshStandardMaterial({ color: '#f07c1e', roughness: 0.5 }), 18, 18, 18, 39, 2, 0);
      const trailer = boxMesh(new THREE.MeshStandardMaterial({ color: '#e6e8ea', roughness: 0.6 }), 60, 22, 20, 0, 2, 0);
      const wheelMat = new THREE.MeshStandardMaterial({ color: '#141518' });
      for (const x of [-20, 20, 40]) for (const z of [-10, 10]) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 3, 12).rotateX(Math.PI / 2), wheelMat);
        w.position.set(x, 4, z);
        group.add(w);
      }
      group.add(cab, trailer);
      const label = this.label(6.5, { bg: 'rgba(27,29,32,0.85)' });
      label.sprite.position.set(0, 30, 0);
      group.add(label.sprite);
      group.scale.setScalar(0.85);
      group.visible = false;
      this.truckGroup.add(group);
      this.trucks.push({ group, label });
    }
  }

  private buildBoards(layout: FactoryLayout): void {
    const g = this.staticGroup;
    const board = (r: Rect, tex: CanvasTex, hit: HitTarget | null) => {
      const w = r.w - 20;
      const h = (w * tex.height) / tex.width;
      const legMat = new THREE.MeshStandardMaterial({ color: '#4a5058', metalness: 0.4, roughness: 0.5 });
      const cz = r.y + r.h / 2;
      for (const dx of [-w / 2 + 10, w / 2 - 10]) g.add(boxMesh(legMat, 4, 30, 4, r.x + r.w / 2 + dx, 0, cz));
      const back = boxMesh(new THREE.MeshStandardMaterial({ color: '#1b1d20' }), w + 6, h + 6, 4, r.x + r.w / 2, 27, cz);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex.texture, roughness: 0.6, emissive: '#ffffff', emissiveMap: tex.texture, emissiveIntensity: 0.35 }));
      face.position.set(r.x + r.w / 2, 30 + h / 2, cz + 2.2);
      face.userData.hit = hit;
      back.userData.hit = hit;
      if (hit) this.pickables.push(face, back);
      g.add(back, face);
    };
    this.planTex = new CanvasTex(640, 300);
    board(layout.plan.box, this.planTex, { kind: 'tab', tab: 'orders' });
    this.signTex = new CanvasTex(420, 300);
    board(layout.sign, this.signTex, null);
  }

  private buildConstruction(layout: FactoryLayout): void {
    const g = new THREE.Group();
    const boxes = STATION_IDS.flatMap((id) => {
      const sl = layout.stations[id];
      return sl.queue ? [sl.box, sl.queue] : [sl.box];
    });
    const x0 = Math.min(...boxes.map((b) => b.x)) - 14;
    const z0 = Math.min(...boxes.map((b) => b.y)) - 14;
    const x1 = Math.max(...boxes.map((b) => b.x + b.w)) + 14;
    const z1 = Math.max(...boxes.map((b) => b.y + b.h)) + 14;
    const tape = new CanvasTex(64, 16);
    tape.draw('tape', (ctx, w, h) => {
      for (let i = -2; i < 8; i++) {
        ctx.fillStyle = i % 2 ? '#e3a008' : '#1b1d20';
        ctx.beginPath();
        ctx.moveTo(i * 10, 0);
        ctx.lineTo(i * 10 + 10, 0);
        ctx.lineTo(i * 10 + 10 + h, h);
        ctx.lineTo(i * 10 + h, h);
        ctx.fill();
      }
      void w;
    });
    tape.texture.wrapS = THREE.RepeatWrapping;
    const fence = (len: number, x: number, z: number, rotY: number) => {
      const t = tape.texture.clone();
      t.needsUpdate = true;
      t.repeat.set(len / 30, 1);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(len, 8), new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide }));
      m.position.set(x, 26, z);
      m.rotation.y = rotY;
      g.add(m);
    };
    fence(x1 - x0, (x0 + x1) / 2, z0, 0);
    fence(x1 - x0, (x0 + x1) / 2, z1, 0);
    fence(z1 - z0, x0, (z0 + z1) / 2, Math.PI / 2);
    fence(z1 - z0, x1, (z0 + z1) / 2, Math.PI / 2);
    const scaffold = new THREE.MeshStandardMaterial({ color: '#b5bdc5', metalness: 0.6, roughness: 0.4 });
    for (let x = x0; x <= x1; x += 60) for (const z of [z0, z1]) g.add(boxMesh(scaffold, 2.5, 90, 2.5, x, 0, z));
    for (const z of [z0, z1]) for (const y of [30, 60, 88]) g.add(boxMesh(scaffold, x1 - x0, 2, 2, (x0 + x1) / 2, y, z));
    const lbl = this.label(16, { bg: 'rgba(27,29,32,0.9)', border: '#e3a008', depthTest: false });
    lbl.sprite.position.set((x0 + x1) / 2, 110, (z0 + z1) / 2);
    g.add(lbl.sprite);
    this.constructionLabel = lbl;
    this.construction = g;
    this.staticGroup.add(g);
  }

  // ─────────────── per-frame update ───────────────

  private frame(now: number): void {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const state = this.controller.state;
    if (state !== this.stateRef) {
      this.stateRef = state;
      this.layoutKey = '';
      this.clearCars();
    }
    if (this.plant >= state.plants.length) this.plant = 0;
    const layout = computeLayout(state, this.plant);
    const key = this.layoutSignature(state, layout);
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      this.buildStatic(state, layout);
      if (!this.userMoved) this.fit(layout);
    }
    this.layout = layout;
    const P = plantOf(state, this.plant);
    if (P.constructionRemaining > 0 && !this.construction) this.buildConstruction(layout);
    if (P.constructionRemaining <= 0 && this.construction) {
      this.staticGroup.remove(this.construction);
      this.disposeGroup(this.construction);
      this.construction = null;
    }

    const simT = (state.time + this.controller.tickFraction) / 6;
    const realT = now / 1000;
    const paused = this.controller.paused;
    if (this.conveyorTex && !paused) this.conveyorTex.offset.x = -(simT * 0.35) % 1;

    for (const id of STATION_IDS) this.updateStation(state, layout, id, simT, realT, paused);
    this.updateCars(state, layout, dt);
    this.updateZones(state, layout);
    this.updateTrucks(state, layout);
    this.updateBoards(state);
    if (this.construction && this.constructionLabel) {
      this.constructionLabel.set(
        [
          { text: `${P.name.toUpperCase()} PLANT UNDER CONSTRUCTION`, color: '#e3a008', size: 15, weight: 800 },
          { text: `Ready in ${formatDuration(P.constructionRemaining)} — hire staff now`, size: 11, weight: 500 },
        ],
      );
    }

    this.placeCamera();
    const z = THREE.MathUtils.clamp(this.dist / LABEL_REF_DIST, 0.55, 2.4);
    for (const l of this.labels) l.setZoom(z);
    for (const v of this.cars.values()) v.rig.tag?.setZoom(z);
    this.renderer.render(this.scene, this.camera);
  }

  private updateStation(state: GameState, layout: FactoryLayout, id: StationId, simT: number, realT: number, paused: boolean): void {
    const v = this.stations[id];
    if (!v) return;
    const st = plantOf(state, this.plant).stations[id];
    const status = stationStatus(state, id, this.plant);
    const color = STATUS_COLOR[status];
    const blink = status === 'broken' ? (Math.sin(realT * 8) > 0 ? 1 : 0.15) : 1;
    v.beaconMat.color.set(color);
    v.beaconMat.emissive.set(color);
    v.beaconMat.emissiveIntensity = 0.9 * blink;
    if (status === 'repair' || status === 'maintenance') v.beacon.rotation.y = realT * 4;
    (v.edge.material as THREE.LineBasicMaterial).color.set(this.selected === id ? COLORS.accent : color);
    const hov = this.hovered?.kind === 'station' && this.hovered.id === id;
    v.platformMat.emissive.set(this.selected === id ? COLORS.accent : '#ffffff');
    v.platformMat.emissiveIntensity = this.selected === id ? 0.18 : hov ? 0.06 : 0;

    const staff = stationStaff(state, id, this.plant);
    const need = stationRequiredStaff(state, id, this.plant);
    const risk = breakdownRisk(state, id, this.plant);
    v.label.set(
      [
        { text: stationName(id), size: 13, weight: 700 },
        { text: STATUS_TEXT[status], color, size: 10, weight: 800 },
        {
          text: `${staff}/${need} ${id === 'inspection' ? 'insp' : 'ops'} · ${Math.round(st.condition)}%${risk === 'high' ? ' ⚠' : ''}`,
          color: risk === 'high' ? COLORS.broken : risk === 'elevated' ? COLORS.blocked : '#9aa3ab',
          size: 10,
          weight: 600,
        },
      ],
      undefined,
      this.selected === id ? COLORS.accent : undefined,
    );

    const banner = this.banner(state, id, st);
    v.banner.sprite.visible = !!banner;
    if (banner) v.banner.set([{ text: banner.text, color: banner.fg, size: 11, weight: 800 }], banner.bg);
    if (v.queueLabel) v.queueLabel.set([{ text: `QUEUE ${st.queue.length}/${queueCapacity(state, id, this.plant)}`, size: 9, color: '#e8c21a', weight: 700 }]);

    const sf = staffFactor(state, id, this.plant);
    v.slotAnims.forEach((anims, i) => {
      const slot = st.slots[i];
      const active = !!slot && !slot.done && !st.broken && !st.service && sf > 0 && !paused;
      for (const a of anims) a.update(simT, realT, active);
    });

    // Smoke while broken.
    const sl = layout.stations[id];
    v.smoke.forEach((s, i) => {
      s.visible = st.broken && !st.service;
      if (!s.visible) return;
      const t = (realT * 0.6 + i / v.smoke.length) % 1;
      s.position.set(sl.box.x + 30 + Math.sin(i * 2.1) * 10, 40 + t * 70, sl.box.y + sl.box.h / 2 + Math.cos(i) * 8);
      s.scale.setScalar(0.6 + t * 1.6);
      (s.material as THREE.MeshStandardMaterial).opacity = 0.55 * (1 - t);
    });
  }

  private banner(state: GameState, id: StationId, st: StationState): { text: string; bg: string; fg: string } | null {
    const has = (k: StationIssue['kind']) => st.issues.find((i) => i.kind === k);
    if (st.service) {
      return { text: `🔧 ${st.service.kind === 'repair' ? 'REPAIR' : 'MAINTENANCE'} · ${formatDuration(st.service.remaining)}`, bg: COLORS.service, fg: '#fff' };
    }
    if (st.broken) return { text: '⚠ BREAKDOWN', bg: COLORS.broken, fg: '#fff' };
    if (has('downstream')) return { text: 'OUTPUT BLOCKED', bg: COLORS.blocked, fg: '#111' };
    const mat = has('materials');
    if (mat) {
      const comps = mat.components ?? [];
      const first = comps[0] ? BALANCE.components[comps[0]].short.toUpperCase() : 'PARTS';
      return { text: `NO ${first}${comps.length > 1 ? ` +${comps.length - 1}` : ''}`, bg: COLORS.blocked, fg: '#111' };
    }
    if (has('staff')) {
      const sf = staffFactor(state, id, this.plant);
      return { text: sf <= 0 ? (id === 'inspection' ? 'NO INSPECTORS' : 'NO OPERATORS') : 'UNDERSTAFFED', bg: COLORS.blocked, fg: '#111' };
    }
    const retool = st.slots.find((x) => x && !x.done && (x.changeover ?? 0) > x.progress);
    if (retool) return { text: '🔧 RETOOLING', bg: COLORS.service, fg: '#fff' };
    return null;
  }

  private clearCars(): void {
    for (const v of this.cars.values()) {
      this.carGroup.remove(v.rig.group);
      disposeCar(v.rig);
    }
    this.cars.clear();
  }

  private updateCars(state: GameState, layout: FactoryLayout, dt: number): void {
    const targets = vehicleTargets(state, layout, this.plant);
    for (const [id, v] of this.cars) {
      if (!targets.has(id)) {
        this.carGroup.remove(v.rig.group);
        disposeCar(v.rig);
        this.cars.delete(id);
      }
    }
    const k = 1 - Math.exp(-dt * 7);
    const inStation = (x: number, z: number) =>
      STATION_IDS.some((id) => {
        const b = layout.stations[id].box;
        return x >= b.x && x <= b.x + b.w && z >= b.y && z <= b.y + b.h;
      });
    targets.forEach((t, id) => {
      const z = t.y - 14 * t.look.scale;
      const y = inStation(t.x, z) ? PLATFORM_H : t.look.scale < 0.8 ? 1 : 0.6;
      let v = this.cars.get(id);
      if (!v || v.model !== t.look.model) {
        if (v) {
          this.carGroup.remove(v.rig.group);
          disposeCar(v.rig);
        }
        const rig = buildCar(t.look.model);
        this.carGroup.add(rig.group);
        v = { rig, pos: new THREE.Vector3(t.x, y, z), model: t.look.model };
        this.cars.set(id, v);
      } else {
        v.pos.lerp(tmpV.set(t.x, y, z), k);
      }
      v.rig.group.position.copy(v.pos);
      updateCar(v.rig, t.look);
      updateCarTag(v.rig, t.look);
    });
  }

  private updateZones(state: GameState, layout: FactoryLayout): void {
    const cap = Math.max(1, warehouseCapacity(state));
    const onHand = stockOnHand(state);
    const incoming = incomingUnits(state);
    this.zoneLabels.warehouse?.set([
      { text: 'WAREHOUSE', size: 12, weight: 800 },
      { text: `${onHand}/${cap} units${incoming ? ` · +${incoming} inbound` : ''}`, size: 10, color: '#9aa3ab' },
    ]);
    const perCrate = Math.max(1, Math.round(cap / COMPONENT_IDS.length / 12));
    for (const c of COMPONENT_IDS) {
      const qty = state.inventory[c].qty;
      const inc = state.shipments.filter((s) => s.component === c).reduce((a, s) => a + s.qty, 0);
      const n = Math.min(12, Math.ceil(qty / perCrate));
      this.crates[c]?.forEach((m, i) => (m.visible = i < n));
      this.rackLabels[c]?.set([
        { text: `${BALANCE.components[c].short} ${qty}${inc ? ` +${inc}` : ''}`, size: 10, weight: 700, color: qty === 0 ? COLORS.broken : '#e6e8ea' },
      ]);
    }
    const ships = state.shipments.length;
    this.zoneLabels.dock?.set([{ text: 'LOADING DOCK', size: 12, weight: 800 }, { text: ships ? `${ships} inbound` : 'No inbound shipments', size: 10, color: '#9aa3ab' }]);
    const ycap = yardCapacity(state);
    const full = state.yard.length >= ycap;
    this.zoneLabels.yard?.set(
      [
        { text: 'FINISHED YARD', size: 12, weight: 800 },
        { text: `${state.yard.length}/${ycap}${full ? ' · FULL' : ''}`, size: 10, color: full ? COLORS.broken : '#9aa3ab', weight: 700 },
      ],
      undefined,
      full ? COLORS.broken : undefined,
    );
    const rw = plantOf(state, this.plant).rework;
    this.zoneLabels.rework?.set([{ text: `REWORK BAY · ${rw.queue.length}/${BALANCE.quality.reworkQueueCapacity} waiting`, size: 10, weight: 700, color: '#ffb3b5' }]);
    void layout;
  }

  private updateTrucks(state: GameState, layout: FactoryLayout): void {
    const ships = [...state.shipments].sort((a, b) => a.arrivesAt - b.arrivesAt);
    this.trucks.forEach((t, i) => {
      const s = ships[i];
      const lane = layout.dock.lanes[i];
      t.group.visible = !!s && !!lane;
      if (!s || !lane) return;
      const span = Math.max(1, s.arrivesAt - s.orderedAt);
      const prog = Math.max(0, Math.min(1, (state.time - s.orderedAt) / span));
      t.group.position.set(lane.x + 40 + prog * (lane.w - 90), 0, lane.y + lane.h / 2);
      t.label.set([{ text: `${BALANCE.components[s.component].short} ×${s.qty} · ${formatDuration(Math.max(0, s.arrivesAt - state.time))}`, size: 9, weight: 700 }]);
    });
  }

  private updateBoards(state: GameState): void {
    const plan = state.plan.slice(0, 6);
    const planKey = JSON.stringify([plan.map((j) => [j.model, j.trim, j.quantity, j.started, j.orderId]), state.plan.length, state.product]);
    this.planTex?.draw(planKey, (ctx, w, h) => {
      ctx.fillStyle = '#16181b';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = COLORS.accent;
      ctx.fillRect(0, 0, w, 6);
      ctx.font = `800 30px ${FONT}`;
      ctx.fillStyle = '#e6e8ea';
      ctx.fillText('PRODUCTION PLAN', 20, 46);
      if (plan.length === 0) {
        ctx.font = `600 24px ${FONT}`;
        ctx.fillStyle = COLORS.blocked;
        ctx.fillText('Nothing scheduled', 20, 100);
        return;
      }
      plan.forEach((j, i) => {
        const y = 70 + i * 36;
        ctx.fillStyle = i === 0 ? 'rgba(240,124,30,0.18)' : 'rgba(255,255,255,0.04)';
        roundRect(ctx, 14, y, w - 28, 30, 6);
        ctx.fill();
        ctx.font = `700 20px ${FONT}`;
        ctx.fillStyle = '#e6e8ea';
        ctx.fillText(`${i + 1}. ${vehicleLabel(state, j.model, j.trim)} ×${j.quantity}`, 24, y + 22);
        ctx.font = `500 17px ${FONT}`;
        ctx.fillStyle = '#9aa3ab';
        ctx.textAlign = 'right';
        ctx.fillText(`${j.started}/${j.quantity} started${j.orderId != null ? ` · #${j.orderId}` : ' · stock'}`, w - 24, y + 21);
        ctx.textAlign = 'left';
      });
      if (state.plan.length > plan.length) {
        ctx.fillStyle = '#9aa3ab';
        ctx.font = `500 17px ${FONT}`;
        ctx.fillText(`+${state.plan.length - plan.length} more jobs`, 24, h - 12);
      }
    });
    const P = plantOf(state, this.plant);
    const lab = state.research.active;
    const lineup = unlockedModels(state);
    const signKey = JSON.stringify([Math.floor(state.time), P.name, state.stats.builtToday, state.stats.vehiclesBuilt, lab?.id, lab ? Math.floor((1 - lab.remaining / lab.total) * 100) : 0, lineup, this.controller.paused]);
    this.signTex?.draw(signKey, (ctx, w, h) => {
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#202327');
      grad.addColorStop(1, '#16181b');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = COLORS.accent;
      ctx.fillRect(18, 22, 8, 64);
      ctx.font = `900 46px ${FONT}`;
      ctx.fillStyle = COLORS.accent;
      ctx.fillText('MOTORWORX', 38, 70);
      ctx.font = `600 18px ${FONT}`;
      ctx.fillStyle = '#9aa3ab';
      const models = lineup.length === 1 ? modelName(state, lineup[0]).toUpperCase() : `${lineup.length} MODELS`;
      ctx.fillText(`PLANT ${String(P.id + 1).padStart(2, '0')} · ${P.name.toUpperCase()} · ${models}`, 38, 100);
      ctx.font = `700 30px ${FONT}`;
      ctx.fillStyle = '#e6e8ea';
      ctx.fillText(formatTime(state.time), 38, 150);
      if (this.controller.paused) {
        ctx.fillStyle = COLORS.blocked;
        ctx.font = `800 20px ${FONT}`;
        ctx.textAlign = 'right';
        ctx.fillText('PAUSED', w - 20, 150);
        ctx.textAlign = 'left';
      }
      ctx.font = `500 20px ${FONT}`;
      ctx.fillStyle = '#9aa3ab';
      ctx.fillText(`Built today ${state.stats.builtToday} · total ${state.stats.vehiclesBuilt}`, 38, 190);
      if (lab) {
        const name = BALANCE.research.projects[lab.id]?.name ?? lab.id;
        ctx.fillStyle = COLORS.service;
        ctx.fillText(`R&D: ${name} ${Math.floor((1 - lab.remaining / lab.total) * 100)}%`, 38, 226);
      }
    });
  }

  // ─────────────── input ───────────────

  private pick(clientX: number, clientY: number): { target: HitTarget | null; floor: boolean } {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickables, false);
    for (const h of hits) {
      const t = h.object.userData.hit as HitTarget | null | undefined;
      if (t) return { target: t, floor: false };
      if (t === null) return { target: null, floor: true };
    }
    return { target: null, floor: hits.length > 0 };
  }

  private onDown = (e: PointerEvent): void => {
    this.down = { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey };
    this.last = { x: e.clientX, y: e.clientY };
    this.dragged = false;
    this.canvas.setPointerCapture(e.pointerId);
  };

  private onMove = (e: PointerEvent): void => {
    if (this.down) {
      const dx = e.clientX - this.last.x;
      const dy = e.clientY - this.last.y;
      this.last = { x: e.clientX, y: e.clientY };
      if (!this.dragged && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) < 5) return;
      this.dragged = true;
      this.userMoved = true;
      if (this.down.button === 2 || this.down.shift) {
        this.az -= dx * 0.006;
        this.az = THREE.MathUtils.clamp(this.az, -1.1, 1.1);
        this.el = THREE.MathUtils.clamp(this.el + dy * 0.004, 0.3, 1.45);
      } else {
        const scale = (2 * this.dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / this.cssH;
        const right = new THREE.Vector3(Math.cos(this.az), 0, -Math.sin(this.az));
        const fwd = new THREE.Vector3(-Math.sin(this.az), 0, -Math.cos(this.az));
        this.target.addScaledVector(right, -dx * scale);
        this.target.addScaledVector(fwd, (dy * scale) / Math.max(0.35, Math.sin(this.el)));
        if (this.layout) {
          const b = this.layout.bounds;
          this.target.x = THREE.MathUtils.clamp(this.target.x, b.x - 200, b.x + b.w + 200);
          this.target.z = THREE.MathUtils.clamp(this.target.z, b.y - 200, b.y + b.h + 200);
        }
      }
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    const { target } = this.pick(e.clientX, e.clientY);
    this.hovered = target;
    this.canvas.style.cursor = target ? 'pointer' : 'grab';
  };

  private onUp = (e: PointerEvent): void => {
    const d = this.down;
    this.down = null;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (!d || this.dragged || d.button !== 0) {
      this.canvas.style.cursor = 'grab';
      return;
    }
    const { target } = this.pick(e.clientX, e.clientY);
    if (!target) this.callbacks.onSelectStation(null);
    else if (target.kind === 'station') this.callbacks.onSelectStation(target.id);
    else this.callbacks.onOpenTab(target.tab);
  };

  private onLeave = (): void => {
    if (!this.down) this.hovered = null;
  };

  /** Zoom toward the floor point under the cursor so what you point at stays put. */
  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.userMoved = true;
    const before = this.dist;
    this.dist = THREE.MathUtils.clamp(this.dist * Math.exp(e.deltaY * 0.0012), 250, 6000);
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const ground = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), ground)) {
      this.target.lerp(new THREE.Vector3(ground.x, 0, ground.z), 1 - this.dist / before);
    }
  };

  private onContext = (e: Event): void => e.preventDefault();
}
