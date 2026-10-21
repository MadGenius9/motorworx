/**
 * Text and small 2D panels drawn into canvases and used as three.js textures (labels, signs, boards).
 * A texture is only redrawn when its content key changes.
 */
import * as THREE from 'three';

export class CanvasTex {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;
  private key = '';

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
  }

  /** Redraw only when `key` differs from the last draw. Returns true when redrawn. */
  draw(key: string, fn: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): boolean {
    if (key === this.key) return false;
    this.key = key;
    this.ctx.clearRect(0, 0, this.width, this.height);
    fn(this.ctx, this.width, this.height);
    this.texture.needsUpdate = true;
    return true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

export const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export interface LabelLine {
  text: string;
  color?: string;
  size?: number;
  weight?: number;
}

/**
 * A camera-facing text label anchored at its bottom centre. The texture is sized to the text, and the sprite
 * keeps a fixed world height per text line so labels stay proportional to the factory.
 */
export class Label {
  readonly sprite: THREE.Sprite;
  private tex: CanvasTex | null = null;
  private key = '';
  /** Unzoomed size; the renderer multiplies it by a zoom factor so labels stay readable. */
  private base = new THREE.Vector2(1, 1);
  private zoom = 1;

  constructor(
    private readonly lineWorldHeight = 11,
    private readonly opts: { bg?: string; border?: string; pad?: number; depthTest?: boolean } = {},
  ) {
    const mat = new THREE.SpriteMaterial({ transparent: true, depthTest: opts.depthTest ?? true, depthWrite: false });
    this.sprite = new THREE.Sprite(mat);
    this.sprite.center.set(0.5, 0);
    this.sprite.renderOrder = 10;
  }

  set(lines: LabelLine[], bg?: string, border?: string): void {
    const key = JSON.stringify([lines, bg, border]);
    if (key === this.key) return;
    this.key = key;
    const scale = 2; // canvas px per CSS px
    const pad = (this.opts.pad ?? 6) * scale;
    const measure = document.createElement('canvas').getContext('2d')!;
    const sizes = lines.map((l) => (l.size ?? 13) * scale);
    let w = 0;
    lines.forEach((l, i) => {
      measure.font = `${l.weight ?? 600} ${sizes[i]}px ${FONT}`;
      w = Math.max(w, measure.measureText(l.text).width);
    });
    const lineH = sizes.map((s) => s * 1.25);
    const h = lineH.reduce((a, b) => a + b, 0);
    const cw = Math.ceil(w + pad * 2);
    const ch = Math.ceil(h + pad * 1.4);
    if (!this.tex || this.tex.width !== cw || this.tex.height !== ch) {
      this.tex?.dispose();
      this.tex = new CanvasTex(cw, ch);
      (this.sprite.material as THREE.SpriteMaterial).map = this.tex.texture;
      (this.sprite.material as THREE.SpriteMaterial).needsUpdate = true;
    }
    const fill = bg ?? this.opts.bg;
    const stroke = border ?? this.opts.border;
    this.tex.draw(key, (ctx, cwid, chei) => {
      if (fill) {
        roundRect(ctx, 1, 1, cwid - 2, chei - 2, 8 * scale);
        ctx.fillStyle = fill;
        ctx.fill();
        if (stroke) {
          ctx.lineWidth = 2 * scale;
          ctx.strokeStyle = stroke;
          ctx.stroke();
        }
      }
      let y = pad * 0.7;
      lines.forEach((l, i) => {
        ctx.font = `${l.weight ?? 600} ${sizes[i]}px ${FONT}`;
        ctx.fillStyle = l.color ?? '#e6e8ea';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(l.text, cwid / 2, y + (lineH[i] - sizes[i]) / 2);
        y += lineH[i];
      });
    });
    const worldH = (lines.length ? lineH.reduce((a, b) => a + b, 0) / (13 * scale * 1.25) : 1) * this.lineWorldHeight * (ch / h);
    this.base.set((worldH * cw) / ch, worldH);
    this.sprite.scale.set(this.base.x * this.zoom, this.base.y * this.zoom, 1);
  }

  /** Scale relative to the label's natural world size (1 = unchanged). */
  setZoom(z: number): void {
    if (Math.abs(z - this.zoom) < 1e-3) return;
    this.zoom = z;
    this.sprite.scale.set(this.base.x * z, this.base.y * z, 1);
  }

  dispose(): void {
    this.tex?.dispose();
    (this.sprite.material as THREE.SpriteMaterial).dispose();
  }
}
