/**
 * Side-view vehicle drawing (sedan, SUV, pickup) that visibly changes with build progress.
 * Local coordinates: anchor (0,0) = bottom-centre (ground), vehicle faces right, ~72 long, ~28–32 tall at scale 1.
 */
import type { ModelId } from '../config/balance';
import type { VehicleLook } from './layout';
import { orderColor } from './layout';

const STEEL = '#8a939c';
const STEEL_LIGHT = '#b5bdc5';
const BIW = '#9aa2aa';
const GLASS = '#5d7a94';
const TIRE = '#141518';

/** Mix a hex colour with black (amt<0) or white (amt>0). */
export function shade(hex: string, amt: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  const t = amt < 0 ? 0 : 255;
  const p = Math.min(1, Math.abs(amt));
  r = Math.round(r + (t - r) * p);
  g = Math.round(g + (t - g) * p);
  b = Math.round(b + (t - b) * p);
  return `rgb(${r},${g},${b})`;
}

const WHEEL_X = 22;
const WHEEL_Y = -6;
const WHEEL_R = 5.6;

/** Per-model detail positions (x of door seams, seats, pillar; y of tail/head lights; roof height). */
const GEO: Record<
  ModelId,
  { doors: number[]; seats: number[]; pillar: number | null; tailY: number; headY: number; roofY: number; trimLen: number }
> = {
  sedan: { doors: [-17, -2.5, 14.5], seats: [-12, 1], pillar: -3.4, tailY: -15.6, headY: -14.6, roofY: -27.6, trimLen: 63 },
  suv: { doors: [-17, -2.5, 15], seats: [-25, -12, 1], pillar: -3.4, tailY: -23.5, headY: -17.2, roofY: -31.6, trimLen: 64 },
  pickup: { doors: [-4.5, 14], seats: [1], pillar: null, tailY: -17, headY: -16.4, roofY: -31.4, trimLen: 30 },
};

function wheelArches(ctx: CanvasRenderingContext2D): void {
  ctx.lineTo(WHEEL_X + 7, -6.5);
  ctx.arc(WHEEL_X, WHEEL_Y, 7, 0, Math.PI, true);
  ctx.lineTo(-WHEEL_X + 7, -6.5);
  ctx.arc(-WHEEL_X, WHEEL_Y, 7, 0, Math.PI, true);
  ctx.closePath();
}

function bodyPath(ctx: CanvasRenderingContext2D, model: ModelId): void {
  ctx.beginPath();
  ctx.moveTo(-36, -6.5);
  if (model === 'suv') {
    // Tall boxy cabin, long roof, near-vertical tailgate.
    ctx.lineTo(-36.4, -26);
    ctx.quadraticCurveTo(-36, -31, -31, -31.4);
    ctx.lineTo(4, -31.6);
    ctx.quadraticCurveTo(9, -31.2, 16, -21.5);
    ctx.lineTo(31, -19.5);
    ctx.quadraticCurveTo(36.4, -18.4, 36.8, -13);
    ctx.lineTo(36.8, -6.5);
  } else if (model === 'pickup') {
    // Open cargo bed at the rear, short cab, long hood.
    ctx.lineTo(-36.4, -18.5);
    ctx.lineTo(-6.5, -18.5);
    ctx.lineTo(-6.5, -30);
    ctx.quadraticCurveTo(-6, -31.4, -3.5, -31.4);
    ctx.lineTo(6, -31.4);
    ctx.quadraticCurveTo(9, -31, 15, -20.5);
    ctx.lineTo(31, -18.5);
    ctx.quadraticCurveTo(36.4, -17.4, 36.8, -12);
    ctx.lineTo(36.8, -6.5);
  } else {
    ctx.lineTo(-36.2, -13.5);
    ctx.quadraticCurveTo(-35.5, -17, -30, -17.6);
    ctx.lineTo(-20, -18.6);
    ctx.quadraticCurveTo(-15, -27, -9, -27.6);
    ctx.lineTo(5, -27.6);
    ctx.quadraticCurveTo(10, -27.2, 18, -18.8);
    ctx.lineTo(31, -16.6);
    ctx.quadraticCurveTo(36, -15.2, 36.6, -11);
    ctx.lineTo(36.6, -6.5);
  }
  wheelArches(ctx);
}

function windowPath(ctx: CanvasRenderingContext2D, model: ModelId): void {
  ctx.beginPath();
  if (model === 'suv') {
    ctx.moveTo(-33, -22.6);
    ctx.lineTo(-33, -29.2);
    ctx.lineTo(3.6, -29.4);
    ctx.quadraticCurveTo(8, -29, 13.6, -22.4);
  } else if (model === 'pickup') {
    ctx.moveTo(-4.5, -21);
    ctx.lineTo(-4.5, -29.2);
    ctx.lineTo(5.4, -29.2);
    ctx.quadraticCurveTo(8.6, -28.8, 13.2, -21);
  } else {
    ctx.moveTo(-18, -19.4);
    ctx.quadraticCurveTo(-13.5, -25.6, -8.6, -26);
    ctx.lineTo(4.6, -26);
    ctx.quadraticCurveTo(9, -25.4, 15.2, -19.6);
  }
  ctx.closePath();
}

function drawSkid(ctx: CanvasRenderingContext2D, w = 60): void {
  ctx.fillStyle = '#5a4630';
  ctx.fillRect(-w / 2, -4, w, 3);
  ctx.fillStyle = '#3d3022';
  ctx.fillRect(-w / 2 + 2, -1.5, 5, 1.5);
  ctx.fillRect(-2.5, -1.5, 5, 1.5);
  ctx.fillRect(w / 2 - 7, -1.5, 5, 1.5);
}

function drawPanels(ctx: CanvasRenderingContext2D, p: number, model: ModelId): void {
  drawSkid(ctx, 62);
  const count = 1 + Math.floor(Math.min(1, p) * 5.999);
  for (let i = 0; i < count; i++) {
    const y = -6 - i * 3.2;
    const off = (i % 2 === 0 ? -1 : 1) * 1.5;
    ctx.fillStyle = i % 2 === 0 ? STEEL : STEEL_LIGHT;
    ctx.fillRect(-28 + off, y, 56, 2.6);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(-28 + off, y, 56, 0.7);
  }
  // Freshly pressed panel shape on top once mostly done.
  if (p > 0.5) {
    const top = -6 - count * 3.2;
    ctx.save();
    ctx.translate(0, top + 1);
    ctx.scale(0.62, 0.3);
    bodyPath(ctx, model);
    ctx.fillStyle = 'rgba(181,189,197,' + (0.4 + 0.6 * Math.min(1, (p - 0.5) * 2)).toFixed(2) + ')';
    ctx.fill();
    ctx.restore();
  }
}

/** Bare body-in-white shell; `form` 0..1 controls how much is welded together. */
function drawShell(ctx: CanvasRenderingContext2D, form: number, model: ModelId): void {
  drawSkid(ctx, 64);
  ctx.save();
  ctx.translate(0, -3);
  // Floor pan always present.
  ctx.fillStyle = '#6f777f';
  ctx.fillRect(-34, -7, 68, 3);
  // Body side panels fill in.
  bodyPath(ctx, model);
  ctx.fillStyle = `rgba(154,162,170,${(0.15 + 0.75 * form).toFixed(2)})`;
  ctx.fill();
  // Outline drawn progressively.
  ctx.setLineDash([Math.max(1, 230 * form), 400]);
  ctx.strokeStyle = '#c9d0d6';
  ctx.lineWidth = 1.3;
  ctx.stroke();
  ctx.setLineDash([]);
  // Openings (no glass yet).
  if (form > 0.55) {
    windowPath(ctx, model);
    ctx.fillStyle = '#2a2e33';
    ctx.fill();
  }
  // Cross members / pillars appear as welding proceeds.
  ctx.strokeStyle = '#5c646c';
  ctx.lineWidth = 1.6;
  const members: [number, number, number, number, number][] = [
    [-30, -8, -30, -16.5, 0.15],
    [30, -8, 30, -15.5, 0.25],
    [-3, -7, -3, GEO[model].roofY + 1.6, 0.45],
    [-17, -7, -17, -19, 0.6],
    [16, -7, 16, -19, 0.7],
    [-34, -11, 34, -11, 0.85],
  ];
  for (const [x1, y1, x2, y2, at] of members) {
    if (form >= at) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawWheel(ctx: CanvasRenderingContext2D, x: number, premium: boolean): void {
  ctx.beginPath();
  ctx.arc(x, WHEEL_Y, WHEEL_R, 0, Math.PI * 2);
  ctx.fillStyle = TIRE;
  ctx.fill();
  if (premium) {
    ctx.beginPath();
    ctx.arc(x, WHEEL_Y, WHEEL_R * 0.68, 0, Math.PI * 2);
    ctx.fillStyle = '#d7dde2';
    ctx.fill();
    ctx.strokeStyle = '#6b737b';
    ctx.lineWidth = 0.8;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(x, WHEEL_Y);
      ctx.lineTo(x + Math.cos(a) * WHEEL_R * 0.66, WHEEL_Y + Math.sin(a) * WHEEL_R * 0.66);
      ctx.stroke();
    }
  } else {
    ctx.beginPath();
    ctx.arc(x, WHEEL_Y, WHEEL_R * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = '#5a6168';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, WHEEL_Y, WHEEL_R * 0.22, 0, Math.PI * 2);
    ctx.fillStyle = '#9aa2aa';
    ctx.fill();
  }
}

/** Painted body (paintFrac 0..1 of coverage from rear to front). */
function drawPaintedBody(ctx: CanvasRenderingContext2D, look: VehicleLook, paintFrac: number, lift: number): void {
  ctx.save();
  ctx.translate(0, -lift);
  const m = look.model;
  // Primer base.
  bodyPath(ctx, m);
  ctx.fillStyle = BIW;
  ctx.fill();
  if (paintFrac > 0) {
    ctx.save();
    bodyPath(ctx, m);
    ctx.clip();
    const edge = -37 + 74 * paintFrac;
    const grad = ctx.createLinearGradient(0, GEO[m].roofY, 0, -6);
    grad.addColorStop(0, shade(look.color, 0.18));
    grad.addColorStop(0.55, look.color);
    grad.addColorStop(1, shade(look.color, -0.35));
    ctx.fillStyle = grad;
    ctx.fillRect(-37, -34, edge + 37, 30);
    if (look.finish === 'metallic' && paintFrac > 0.2) {
      // Subtle sheen band.
      const sheen = ctx.createLinearGradient(-30, -28, 30, -8);
      sheen.addColorStop(0, 'rgba(255,255,255,0)');
      sheen.addColorStop(0.45, 'rgba(255,255,255,0.28)');
      sheen.addColorStop(0.55, 'rgba(255,255,255,0.05)');
      sheen.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sheen;
      ctx.fillRect(-37, -34, edge + 37, 30);
    }
    ctx.restore();
  }
  bodyPath(ctx, m);
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 0.9;
  ctx.stroke();
  ctx.restore();
}

function drawComplete(ctx: CanvasRenderingContext2D, look: VehicleLook, assembly: number): void {
  const premium = look.trim === 'premium';
  const m = look.model;
  const geo = GEO[m];
  const wheelsRear = assembly >= 0.5;
  const wheelsFront = assembly >= 0.62;
  if (!wheelsRear || !wheelsFront) drawSkid(ctx, 64);
  const lift = wheelsRear && wheelsFront ? 0 : 3;
  if (wheelsRear) drawWheel(ctx, -WHEEL_X, premium);
  if (wheelsFront) drawWheel(ctx, WHEEL_X, premium);
  drawPaintedBody(ctx, look, 1, lift);
  ctx.save();
  ctx.translate(0, -lift);
  // Windows: dark openings first, glass later, interior seat silhouettes in between.
  windowPath(ctx, m);
  ctx.fillStyle = '#23272b';
  ctx.fill();
  if (assembly >= 0.15) {
    // Seat silhouettes, clipped to the window opening so they never sit on the paint.
    ctx.save();
    windowPath(ctx, m);
    ctx.clip();
    ctx.fillStyle = premium ? '#7a5a3c' : '#3c4248';
    for (const sx of geo.seats) ctx.fillRect(sx, m === 'sedan' ? -22 : -25, 3, 4);
    ctx.restore();
  }
  if (assembly >= 0.32) {
    windowPath(ctx, m);
    const g = ctx.createLinearGradient(-15, -26, 12, -19);
    g.addColorStop(0, shade(GLASS, 0.25));
    g.addColorStop(1, GLASS);
    ctx.fillStyle = g;
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;
    if (geo.pillar !== null) {
      // B-pillar
      ctx.fillStyle = shade(look.color, -0.45);
      const top = m === 'sedan' ? -26 : -29.4;
      ctx.fillRect(geo.pillar, top, 1.8, m === 'sedan' ? 6.8 : 7.2);
    }
  }
  // Door seams (and the cab/bed gap on the pickup).
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  for (const dx of geo.doors) {
    ctx.moveTo(dx, -19);
    ctx.lineTo(dx - 0.6, -8);
  }
  if (m === 'pickup') {
    ctx.moveTo(-8, -18.2);
    ctx.lineTo(-8, -8);
  }
  ctx.stroke();
  if (m === 'pickup') {
    // Bed rail highlight.
    ctx.fillStyle = shade(look.color, -0.3);
    ctx.fillRect(-36, -18.6, 28, 1.4);
  }
  if (assembly >= 0.82) {
    // Lights.
    ctx.fillStyle = '#fff3c4';
    ctx.fillRect(33.4, geo.headY, 3, 2.4);
    ctx.fillStyle = '#e5484d';
    ctx.fillRect(-36.2, geo.tailY, 2.4, m === 'suv' ? 4 : 2.6);
  }
  if (assembly >= 0.94) {
    // Handles + bumpers.
    ctx.fillStyle = 'rgba(20,20,20,0.6)';
    ctx.fillRect(-12, -16, 3, 0.9);
    ctx.fillRect(5, -16, 3, 0.9);
    ctx.fillStyle = '#2b2f34';
    ctx.fillRect(33, -8.5, 3.8, 2.2);
    ctx.fillRect(-36.4, -8.5, 3.8, 2.2);
    if (premium) {
      // Chrome trim strip along the side + window surround.
      const cg = ctx.createLinearGradient(0, -13, 0, -11.6);
      cg.addColorStop(0, '#ffffff');
      cg.addColorStop(1, '#9aa3ab');
      ctx.fillStyle = cg;
      ctx.fillRect(m === 'pickup' ? -4 : -33, -12.8, geo.trimLen, 1.3);
      windowPath(ctx, m);
      ctx.strokeStyle = '#dfe4e8';
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawTag(ctx: CanvasRenderingContext2D, x: number, y: number, bg: string, label: string, wrench: boolean): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.font = 'bold 8px system-ui, -apple-system, Segoe UI, sans-serif';
  const tw = wrench ? 9 : ctx.measureText(label).width + 6;
  const w = Math.max(10, tw);
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(-w / 2 + 0.8, -9.2, w, 10);
  ctx.fillStyle = bg;
  roundRectPath(ctx, -w / 2, -10, w, 10, 2);
  ctx.fill();
  // String to the car.
  ctx.strokeStyle = bg;
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 3);
  ctx.stroke();
  if (wrench) {
    drawWrenchIcon(ctx, 0, -5, 3.6, '#ffffff');
  } else {
    ctx.fillStyle = '#111';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 0, -4.8);
  }
  ctx.restore();
}

/** Rounded-rectangle path (begins a new path). */
export function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/** Small wrench glyph centred at (x,y); r ≈ half size. */
export function drawWrenchIcon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-Math.PI / 4);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = r * 0.45;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, r * 0.9);
  ctx.lineTo(0, -r * 0.3);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, -r * 0.55, r * 0.5, Math.PI * 0.15, Math.PI * 0.85, true);
  ctx.lineWidth = r * 0.38;
  ctx.stroke();
  ctx.restore();
}

/**
 * Draw a vehicle at world anchor (x, y) = bottom centre. Never reveals hidden defects:
 * only `look.reworkTag` (defect already detected by inspection) adds the red wrench tag.
 */
export function drawVehicle(ctx: CanvasRenderingContext2D, x: number, y: number, look: VehicleLook): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(look.scale, look.scale);
  // Ground shadow.
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(0, 0, 34, 2.4, 0, 0, Math.PI * 2);
  ctx.fill();

  const p = Math.max(0, Math.min(1, look.progress));
  switch (look.phase) {
    case 'stamping':
      drawPanels(ctx, p, look.model);
      break;
    case 'body':
      drawShell(ctx, p, look.model);
      break;
    case 'paint':
      drawSkid(ctx, 64);
      drawPaintedBody(ctx, look, p, 3);
      ctx.save();
      ctx.translate(0, -3);
      windowPath(ctx, look.model);
      ctx.fillStyle = '#23272b';
      ctx.fill();
      ctx.restore();
      break;
    case 'final':
      drawComplete(ctx, look, p);
      break;
    case 'complete':
      drawComplete(ctx, look, 1);
      break;
  }

  let tagX = -10;
  if (look.reworkTag) {
    drawTag(ctx, tagX, -34, '#e5484d', '', true);
    tagX += 16;
  }
  if (look.orderTag != null) {
    drawTag(ctx, tagX + 4, -34, orderColor(look.orderTag), `#${look.orderTag}`, false);
  }
  ctx.restore();
}
