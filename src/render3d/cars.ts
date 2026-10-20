/**
 * 3D vehicles built from simple solids. One rig per vehicle; `updateCar` reshapes it to the build stage:
 * stamped panels → bare grey body shell → paint coverage → glass, wheels and lights → finished car.
 * Local frame: origin on the floor at the car's centre, +x = front, +y = up, width along z.
 */
import * as THREE from 'three';
import type { ModelId } from '../config/balance';
import type { VehicleLook } from '../render/layout';
import { orderColor } from '../render/layout';
import { Label } from './canvasTexture';

/** Car width (z) per model. */
const WIDTH: Record<ModelId, number> = { sedan: 26, suv: 28, pickup: 28 };
const WHEEL_X = 22;
const WHEEL_R = 5.8;

/** Side profiles (y up, x forward) matching the 2D drawings, with wheel arches cut out. */
function profile(model: ModelId): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(-36, 6.5);
  if (model === 'suv') {
    s.lineTo(-36.4, 26);
    s.quadraticCurveTo(-36, 31, -31, 31.4);
    s.lineTo(4, 31.6);
    s.quadraticCurveTo(9, 31.2, 16, 21.5);
    s.lineTo(31, 19.5);
    s.quadraticCurveTo(36.4, 18.4, 36.8, 13);
    s.lineTo(36.8, 6.5);
  } else if (model === 'pickup') {
    s.lineTo(-36.4, 18.5);
    s.lineTo(-6.5, 18.5);
    s.lineTo(-6.5, 30);
    s.quadraticCurveTo(-6, 31.4, -3.5, 31.4);
    s.lineTo(6, 31.4);
    s.quadraticCurveTo(9, 31, 15, 20.5);
    s.lineTo(31, 18.5);
    s.quadraticCurveTo(36.4, 17.4, 36.8, 12);
    s.lineTo(36.8, 6.5);
  } else {
    s.lineTo(-36.2, 13.5);
    s.quadraticCurveTo(-35.5, 17, -30, 17.6);
    s.lineTo(-20, 18.6);
    s.quadraticCurveTo(-15, 27, -9, 27.6);
    s.lineTo(5, 27.6);
    s.quadraticCurveTo(10, 27.2, 18, 18.8);
    s.lineTo(31, 16.6);
    s.quadraticCurveTo(36, 15.2, 36.6, 11);
    s.lineTo(36.6, 6.5);
  }
  // Wheel arches (front then rear), traced from the right-hand side of each arch over the top.
  for (const wx of [WHEEL_X, -WHEEL_X]) {
    s.lineTo(wx + 7.2, 6.5);
    for (let i = 1; i < 12; i++) {
      const a = (i / 12) * Math.PI;
      s.lineTo(wx + 7.2 * Math.cos(a), 6 + 7.2 * Math.sin(a));
    }
    s.lineTo(wx - 7.2, 6.5);
  }
  s.lineTo(-36, 6.5);
  return s;
}

function windowProfile(model: ModelId): THREE.Shape {
  const s = new THREE.Shape();
  if (model === 'suv') {
    s.moveTo(-33, 22.6);
    s.lineTo(-33, 29.2);
    s.lineTo(3.6, 29.4);
    s.quadraticCurveTo(8, 29, 13.6, 22.4);
  } else if (model === 'pickup') {
    s.moveTo(-4.5, 21);
    s.lineTo(-4.5, 29.2);
    s.lineTo(5.4, 29.2);
    s.quadraticCurveTo(8.6, 28.8, 13.2, 21);
  } else {
    s.moveTo(-18, 19.4);
    s.quadraticCurveTo(-13.5, 25.6, -8.6, 26);
    s.lineTo(4.6, 26);
    s.quadraticCurveTo(9, 25.4, 15.2, 19.6);
  }
  s.closePath();
  return s;
}

function extrude(shape: THREE.Shape, width: number, bevel: number): THREE.ExtrudeGeometry {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: width - bevel * 2,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    bevelSegments: 2,
    curveSegments: 8,
  });
  g.translate(0, 0, -(width - bevel * 2) / 2);
  return g;
}

/** Geometries are shared per model (created on first use). */
const geoCache = new Map<string, THREE.BufferGeometry>();
function cached(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    geoCache.set(key, g);
  }
  return g;
}

const BIW = new THREE.Color('#9aa2aa');

// Shared materials (never disposed per car).
const M = {
  steel: new THREE.MeshStandardMaterial({ color: '#b5bdc5', metalness: 0.7, roughness: 0.35 }),
  steelDark: new THREE.MeshStandardMaterial({ color: '#8a939c', metalness: 0.7, roughness: 0.4 }),
  glass: new THREE.MeshStandardMaterial({ color: '#22323f', metalness: 0.5, roughness: 0.08 }),
  tire: new THREE.MeshStandardMaterial({ color: '#141518', roughness: 0.9 }),
  rim: new THREE.MeshStandardMaterial({ color: '#d7dde2', metalness: 0.9, roughness: 0.2 }),
  rimEco: new THREE.MeshStandardMaterial({ color: '#5a6168', metalness: 0.4, roughness: 0.5 }),
  chrome: new THREE.MeshStandardMaterial({ color: '#eef2f5', metalness: 1, roughness: 0.12 }),
  head: new THREE.MeshStandardMaterial({ color: '#fff3c4', emissive: '#fff3c4', emissiveIntensity: 0.9 }),
  tail: new THREE.MeshStandardMaterial({ color: '#e5484d', emissive: '#e5484d', emissiveIntensity: 0.8 }),
  skid: new THREE.MeshStandardMaterial({ color: '#5a4630', roughness: 0.9 }),
};

const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  wheel: new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 4, 20).rotateX(Math.PI / 2),
  rim: new THREE.CylinderGeometry(WHEEL_R * 0.62, WHEEL_R * 0.62, 4.4, 14).rotateX(Math.PI / 2),
};

function block(mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(GEO.box, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Positions a unit-box mesh scaled to (w,h,d) with its base at y. */
function place(m: THREE.Mesh, x: number, y: number, z: number, w: number, h: number, d: number): void {
  m.scale.set(w, h, d);
  m.position.set(x, y + h / 2, z);
}

export interface CarRig {
  group: THREE.Group;
  model: ModelId;
  paint: THREE.MeshStandardMaterial;
  body: THREE.Mesh;
  glass: THREE.Mesh;
  wheels: THREE.Mesh[];
  rims: THREE.Mesh[];
  lights: THREE.Mesh[];
  chrome: THREE.Mesh[];
  plates: THREE.Mesh[];
  skid: THREE.Mesh;
  shell: THREE.Group;
  tag: Label | null;
  tagKey: string;
}

export function buildCar(model: ModelId): CarRig {
  const width = WIDTH[model];
  const group = new THREE.Group();
  const shell = new THREE.Group();
  group.add(shell);
  const paint = new THREE.MeshStandardMaterial({ color: BIW.clone(), metalness: 0.35, roughness: 0.45 });

  const body = new THREE.Mesh(cached(`body-${model}`, () => extrude(profile(model), width, 1.4)), paint);
  body.castShadow = true;
  body.receiveShadow = true;
  const glass = new THREE.Mesh(cached(`glass-${model}`, () => extrude(windowProfile(model), width + 0.6, 0)), M.glass);
  shell.add(body, glass);

  const wheels: THREE.Mesh[] = [];
  const rims: THREE.Mesh[] = [];
  for (const x of [-WHEEL_X, WHEEL_X]) {
    for (const z of [-width / 2 + 2, width / 2 - 2]) {
      const w = new THREE.Mesh(GEO.wheel, M.tire);
      w.position.set(x, WHEEL_R, z);
      w.castShadow = true;
      const r = new THREE.Mesh(GEO.rim, M.rimEco);
      r.position.copy(w.position);
      wheels.push(w);
      rims.push(r);
      group.add(w, r);
    }
  }

  const front = model === 'sedan' ? 36.6 : 36.8;
  const headY = model === 'suv' ? 15 : 12.5;
  const tailY = model === 'suv' ? 21 : model === 'pickup' ? 14.5 : 13;
  const lights: THREE.Mesh[] = [];
  for (const z of [-width / 2 + 4.5, width / 2 - 4.5]) {
    const h = block(M.head);
    place(h, front + 0.2, headY, z, 1.2, 2.6, 5);
    const t = block(M.tail);
    place(t, -36.6, tailY, z, 1.2, model === 'suv' ? 4 : 2.6, 5);
    lights.push(h, t);
  }
  shell.add(...lights);

  const chrome: THREE.Mesh[] = [];
  for (const z of [-width / 2 - 0.1, width / 2 + 0.1]) {
    const c = block(M.chrome);
    place(c, model === 'pickup' ? 4 : 0, 11.5, z, model === 'pickup' ? 30 : 58, 1, 0.5);
    chrome.push(c);
  }
  shell.add(...chrome);

  const plates: THREE.Mesh[] = [];
  for (let i = 0; i < 6; i++) {
    const p = block(i % 2 ? M.steel : M.steelDark);
    place(p, (i % 2 ? -1 : 1) * 1.2, 2 + i * 2.2, 0, 56, 1.6, width - 4);
    plates.push(p);
    group.add(p);
  }
  const skid = block(M.skid);
  place(skid, 0, 0, 0, 62, 2.5, width - 2);
  group.add(skid);

  return { group, model, paint, body, glass, wheels, rims, lights, chrome, plates, skid, shell, tag: null, tagKey: '' };
}

const tmp = new THREE.Color();

/** Reshape a car rig for its build phase and progress. */
export function updateCar(rig: CarRig, look: VehicleLook): void {
  const p = Math.max(0, Math.min(1, look.progress));
  rig.group.scale.setScalar(look.scale);

  const stamping = look.phase === 'stamping';
  rig.plates.forEach((m, i) => (m.visible = stamping && i < Math.max(1, Math.ceil(p * 6))));
  rig.shell.visible = !stamping;

  // Body shell rises as it is welded together.
  rig.body.scale.y = look.phase === 'body' ? 0.35 + 0.65 * p : 1;

  // Paint: grey shell → vehicle colour.
  const paintAmt = look.phase === 'body' || stamping ? 0 : look.phase === 'paint' ? p : 1;
  tmp.set(look.color);
  rig.paint.color.copy(BIW).lerp(tmp, paintAmt);
  const metallic = look.finish === 'metallic' && paintAmt > 0.5;
  rig.paint.metalness = paintAmt > 0 ? (metallic ? 0.7 : 0.3) : 0.6;
  rig.paint.roughness = paintAmt > 0 ? (metallic ? 0.25 : 0.45) : 0.45;

  // Final assembly: glass, wheels, lights, chrome.
  const asm = look.phase === 'final' ? p : look.phase === 'complete' ? 1 : 0;
  rig.glass.visible = look.phase === 'complete' || (look.phase === 'final' && p >= 0.32);
  const rear = asm >= 0.5;
  const front = asm >= 0.62;
  rig.wheels.forEach((w, i) => (w.visible = i < 2 ? rear : front));
  const premium = look.trim === 'premium';
  rig.rims.forEach((r, i) => {
    r.visible = i < 2 ? rear : front;
    r.material = premium ? M.rim : M.rimEco;
  });
  rig.lights.forEach((m) => (m.visible = asm >= 0.82));
  rig.chrome.forEach((m) => (m.visible = premium && asm >= 0.94));
  const onWheels = rear && front;
  rig.skid.visible = !onWheels;
  rig.shell.position.y = onWheels ? 0 : -3;
}

/** Floating tag over a car: red wrench for detected defects, coloured order number when reserved. */
export function updateCarTag(rig: CarRig, look: VehicleLook): void {
  const key = `${look.reworkTag}|${look.orderTag ?? ''}`;
  if (key === rig.tagKey) return;
  rig.tagKey = key;
  if (!look.reworkTag && look.orderTag == null) {
    if (rig.tag) rig.tag.sprite.visible = false;
    return;
  }
  if (!rig.tag) {
    rig.tag = new Label(8, { pad: 4 });
    rig.tag.sprite.position.set(0, 34, 0);
    rig.group.add(rig.tag.sprite);
  }
  rig.tag.sprite.visible = true;
  if (look.reworkTag) rig.tag.set([{ text: '🔧 REWORK', color: '#ffffff', size: 12, weight: 800 }], '#e5484d');
  else rig.tag.set([{ text: `#${look.orderTag}`, color: '#111111', size: 12, weight: 800 }], orderColor(look.orderTag!));
}

export function disposeCar(rig: CarRig): void {
  rig.paint.dispose();
  rig.tag?.dispose();
}
