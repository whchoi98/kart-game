/**
 * HUD minimap: the track outline is rendered once into an offscreen canvas per
 * (track, size); every frame only blits it and draws karts + projectiles.
 */
import { getCharacter, isCharacterId } from '../../sim/characters.js';
import type { BuiltTrack, CharacterId } from '../../sim/types.js';
import type { HudSnapshot } from '../contracts.js';
import { INK, portraitSvg } from './art/portraits.js';
import { THEME_COLORS, drawOutline, fitOutline, outlineFromBuilt, type Fit, type TrackOutline } from './art/track-draw.js';

const PLAYER_RING = ['#ff3d8b', '#2fb5ff'];
const PROJECTILE_COLOR: Record<string, string> = { banana: '#ffe135', orb: '#38e36b', rocket: '#ff3b3b', skybomb: '#2f6bff' };
/** Time-trial ghost marker: pale lavender, drawn translucent so it never reads as a kart. */
const GHOST_FILL = '#e9e4ff';

const portraitImages = new Map<CharacterId, HTMLImageElement>();
function portraitImage(id: CharacterId): HTMLImageElement {
  let img = portraitImages.get(id);
  if (!img) {
    img = new Image();
    img.decoding = 'async';
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(portraitSvg(id))}`;
    portraitImages.set(id, img);
  }
  return img;
}

export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private track: BuiltTrack | null = null;
  private outline: TrackOutline | null = null;
  private base: HTMLCanvasElement | null = null;
  private fit: Fit | null = null;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private readonly ro: ResizeObserver | null = null;
  private dirty = true;

  constructor(cls = 'hud-map') {
    this.canvas = document.createElement('canvas');
    this.canvas.className = cls;
    this.canvas.setAttribute('aria-hidden', 'true');
    this.ctx = this.canvas.getContext('2d');
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => { this.dirty = true; });
      this.ro.observe(this.canvas);
    }
  }

  setTrack(t: BuiltTrack | null): void {
    if (t === this.track) return;
    this.track = t;
    this.outline = t ? outlineFromBuilt(t, 500) : null;
    this.dirty = true;
  }

  private rebuild(): void {
    this.dirty = false;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.cssW = w;
    this.cssH = h;
    this.dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const bw = Math.max(1, Math.round(w * this.dpr));
    const bh = Math.max(1, Math.round(h * this.dpr));
    if (this.canvas.width !== bw) this.canvas.width = bw;
    if (this.canvas.height !== bh) this.canvas.height = bh;
    this.ctx = this.canvas.getContext('2d');
    if (!this.outline || w < 4 || h < 4) { this.base = null; this.fit = null; return; }
    const pad = Math.max(8, Math.min(w, h) * 0.1);
    this.fit = fitOutline(this.outline, w, h, pad);
    const base = document.createElement('canvas');
    base.width = bw;
    base.height = bh;
    const bctx = base.getContext('2d');
    if (!bctx) { this.base = null; return; }
    bctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const theme = this.track ? THEME_COLORS[this.track.def.theme] ?? THEME_COLORS.meadow : THEME_COLORS.meadow;
    drawOutline(bctx, this.outline, this.fit, {
      edge: 'rgba(20, 8, 48, 0.9)',
      road: theme.road,
      minWidth: Math.max(4, Math.min(w, h) * 0.05),
      border: Math.max(2, Math.min(w, h) * 0.02),
      glow: 'rgba(0,0,0,0.45)',
      startLine: true,
    });
    this.base = base;
  }

  draw(snap: HudSnapshot, focusPlayer: number): void {
    if (this.dirty) this.rebuild();
    const ctx = this.ctx;
    if (!ctx || !this.base || !this.fit) return;
    const { scale, ox, oy } = this.fit;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.base, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const unit = Math.max(3, Math.min(this.cssW, this.cssH) * 0.035);

    for (const p of snap.minimap.projectiles) {
      const x = ox - p.x * scale;
      const y = oy - p.z * scale;
      ctx.beginPath();
      ctx.arc(x, y, unit * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = PROJECTILE_COLOR[p.kind] ?? '#fff';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = INK;
      ctx.stroke();
    }

    // Time-trial ghost: a translucent, dashed "see-through" dot under the karts (never a solid kart marker).
    const ghost = snap.minimap.ghost;
    if (ghost && Number.isFinite(ghost.x) && Number.isFinite(ghost.z)) {
      const x = ox - ghost.x * scale;
      const y = oy - ghost.z * scale;
      const r = unit * 1.55;
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = GHOST_FILL;
      ctx.fill();
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.6;
      ctx.setLineDash([Math.max(2, r * 0.45), Math.max(1.5, r * 0.3)]);
      ctx.strokeStyle = isCharacterId(ghost.charId) ? getCharacter(ghost.charId).colors.body : INK;
      ctx.stroke();
      ctx.setLineDash([]);
      // two "eyes" read as the ghost glyph at any size
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = INK;
      const e = Math.max(0.9, r * 0.2);
      ctx.beginPath();
      ctx.arc(x - r * 0.32, y - r * 0.1, e, 0, Math.PI * 2);
      ctx.arc(x + r * 0.32, y - r * 0.1, e, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // CPUs first (back to front by position), humans last so they stay on top.
    const karts = [...snap.minimap.karts].sort((a, b) => (a.human >= 0 ? 1 : 0) - (b.human >= 0 ? 1 : 0) || b.position - a.position);
    for (const k of karts) {
      const x = ox - k.x * scale;
      const y = oy - k.z * scale;
      if (k.human < 0) {
        ctx.beginPath();
        ctx.arc(x, y, unit, 0, Math.PI * 2);
        ctx.fillStyle = getCharacter(k.charId).colors.body;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = INK;
        ctx.stroke();
        continue;
      }
      const r = unit * (k.human === focusPlayer ? 2.1 : 1.8);
      ctx.beginPath();
      ctx.arc(x, y, r + 2.5, 0, Math.PI * 2);
      ctx.fillStyle = PLAYER_RING[k.human] ?? '#fff';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = INK;
      ctx.stroke();
      const img = portraitImage(k.charId);
      if (img.complete && img.naturalWidth > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = getCharacter(k.charId).colors.body;
        ctx.fill();
      }
    }
  }

  dispose(): void {
    this.ro?.disconnect();
    this.base = null;
  }
}
