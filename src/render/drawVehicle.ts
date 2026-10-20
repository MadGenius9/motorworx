/**
 * Side-view sedan drawing that visibly changes with build progress.
 * Local coordinates: anchor (0,0) = bottom-centre (ground), car faces right, ~72 long, ~28 tall at scale 1.
 */
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

function bodyPath(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  ctx.moveTo(-36, -6.5);
  ctx.lineTo(-36.2, -13.5);
  ctx.quadraticCurveTo(-35.5, -17, -30, -17.6);
  ctx.lineTo(-20, -18.6);
  ctx.quadraticCurveTo(-15, -27, -9, -27.6);
  ctx.lineTo(5, -27.6);
  ctx.quadraticCurveTo(10, -27.2, 18, -18.8);
  ctx.lineTo(31, -16.6);
  ctx.quadraticCurveTo(36, -15.2, 36.6, -11);
  ctx.lineTo(36.6, -6.5);
  ctx.lineTo(WHEEL_X + 7, -6.5);
  ctx.arc(WHEEL_X, WHEEL_Y, 7, 0, Math.PI, true);
  ctx.lineTo(-WHEEL_X + 7, -6.5);
  ctx.arc(-WHEEL_X, WHEEL_Y, 7, 0, Math.PI, true);
  ctx.closePath();
}

function windowPath(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  ctx.moveTo(-18, -19.4);
  ctx.quadraticCurveTo(-13.5, -25.6, -8.6, -26);
  ctx.lineTo(4.6, -26);
  ctx.quadraticCurveTo(9, -25.4, 15.2, -19.6);
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

function drawPanels(ctx: CanvasRenderingContext2D, p: number): void {
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
    bodyPath(ctx);
    ctx.fillStyle = 'rgba(181,189,197,' + (0.4 + 0.6 * Math.min(1, (p - 0.5) * 2)).toFixed(2) + ')';
    ctx.fill();
    ctx.restore();
  }
}

/** Bare body-in-white shell; `form` 0..1 controls how much is welded together. */
function drawShell(ctx: CanvasRenderingContext2D, form: number): void {
  drawSkid(ctx, 64);
  ctx.save();
  ctx.translate(0, -3);
  // Floor pan always present.
  ctx.fillStyle = '#6f777f';
  ctx.fillRect(-34, -7, 68, 3);
  // Body side panels fill in.
  bodyPath(ctx);
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
    windowPath(ctx);
    ctx.fillStyle = '#2a2e33';
    ctx.fill();
  }
  // Cross members / pillars appear as welding proceeds.
  ctx.strokeStyle = '#5c646c';
  ctx.lineWidth = 1.6;
  const members: [number, number, number, number, number][] = [
    [-30, -8, -30, -16.5, 0.15],
    [30, -8, 30, -15.5, 0.25],
    [-3, -7, -3, -26, 0.45],
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
  // Primer base.
  bodyPath(ctx);
  ctx.fillStyle = BIW;
  ctx.fill();
  if (paintFrac > 0) {
    ctx.save();
    bodyPath(ctx);
    ctx.clip();
    const edge = -37 + 74 * paintFrac;
    const grad = ctx.createLinearGradient(0, -28, 0, -6);
    grad.addColorStop(0, shade(look.color, 0.18));
    grad.addColorStop(0.55, look.color);
    grad.addColorStop(1, shade(look.color, -0.35));
    ctx.fillStyle = grad;
    ctx.fillRect(-37, -30, edge + 37, 26);
    if (look.finish === 'metallic' && paintFrac > 0.2) {
      // Subtle sheen band.
      const sheen = ctx.createLinearGradient(-30, -28, 30, -8);
      sheen.addColorStop(0, 'rgba(255,255,255,0)');
      sheen.addColorStop(0.45, 'rgba(255,255,255,0.28)');
      sheen.addColorStop(0.55, 'rgba(255,255,255,0.05)');
      sheen.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sheen;
      ctx.fillRect(-37, -30, edge + 37, 26);
    }
    ctx.restore();
  }
  bodyPath(ctx);
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 0.9;
  ctx.stroke();
  ctx.restore();
}

function drawComplete(ctx: CanvasRenderingContext2D, look: VehicleLook, assembly: number): void {
  const premium = look.trim === 'premium';
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
  windowPath(ctx);
  ctx.fillStyle = '#23272b';
  ctx.fill();
  if (assembly >= 0.15) {
    ctx.fillStyle = premium ? '#7a5a3c' : '#3c4248';
    ctx.fillRect(-12, -22, 3, 4);
    ctx.fillRect(1, -22, 3, 4);
  }
  if (assembly >= 0.32) {
    windowPath(ctx);
    const g = ctx.createLinearGradient(-15, -26, 12, -19);
    g.addColorStop(0, shade(GLASS, 0.25));
    g.addColorStop(1, GLASS);
    ctx.fillStyle = g;
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;
    // B-pillar
    ctx.fillStyle = shade(look.color, -0.45);
    ctx.fillRect(-3.4, -26, 1.8, 6.8);
  }
  // Door lines.
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.moveTo(-2.5, -19);
  ctx.lineTo(-2.5, -8);
  ctx.moveTo(-17, -18.5);
  ctx.lineTo(-16, -8);
  ctx.moveTo(14.5, -18.5);
  ctx.lineTo(13.5, -8);
  ctx.stroke();
  if (assembly >= 0.82) {
    // Lights.
    ctx.fillStyle = '#fff3c4';
    ctx.fillRect(33.4, -14.6, 3, 2.4);
    ctx.fillStyle = '#e5484d';
    ctx.fillRect(-36.2, -15.6, 2.4, 2.6);
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
      ctx.fillRect(-33, -12.8, 63, 1.3);
      windowPath(ctx);
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
      drawPanels(ctx, p);
      break;
    case 'body':
      drawShell(ctx, p);
      break;
    case 'paint':
      drawSkid(ctx, 64);
      drawPaintedBody(ctx, look, p, 3);
      ctx.save();
      ctx.translate(0, -3);
      windowPath(ctx);
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
    drawTag(ctx, tagX, -30, '#e5484d', '', true);
    tagX += 16;
  }
  if (look.orderTag != null) {
    drawTag(ctx, tagX + 4, -30, orderColor(look.orderTag), `#${look.orderTag}`, false);
  }
  ctx.restore();
}
