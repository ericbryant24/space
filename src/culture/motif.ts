import { roll } from '../core/rng.ts';

/**
 * A planet's motif: one primitive glyph that recurs everywhere its culture touches -- as a window
 * silhouette, a banner, a plaza outline, the north point of a compass rose.
 *
 * It is the cheapest possible cross-scale signature. One number, chosen once per world, and a building
 * six levels down can carry it in a shape the eye recognises without being told.
 */
export type Motif =
  | 'chevron'
  | 'ringInRing'
  | 'trefoil'
  | 'comb'
  | 'spiral'
  | 'splitLozenge'
  | 'crossBar'
  | 'eye'
  | 'wave'
  | 'ladder'
  | 'sixStar'
  | 'crescentPair';

export const MOTIFS: readonly Motif[] = [
  'chevron', 'ringInRing', 'trefoil', 'comb', 'spiral', 'splitLozenge',
  'crossBar', 'eye', 'wave', 'ladder', 'sixStar', 'crescentPair',
];

export function motifOf(planetId: number): Motif {
  return MOTIFS[(roll(planetId, 'motif') >>> 8) % MOTIFS.length]!;
}

/**
 * Trace the motif into the current path, centred on the origin at unit scale. The caller decides
 * whether to fill or stroke it, so the same outline serves a window, a banner and a plaza.
 */
export function motifPath(ctx: CanvasRenderingContext2D, motif: Motif, r: number): void {
  const tau = Math.PI * 2;
  switch (motif) {
    case 'chevron':
      ctx.moveTo(-r, r * 0.5);
      ctx.lineTo(0, -r * 0.6);
      ctx.lineTo(r, r * 0.5);
      ctx.lineTo(r * 0.55, r * 0.5);
      ctx.lineTo(0, -r * 0.05);
      ctx.lineTo(-r * 0.55, r * 0.5);
      ctx.closePath();
      return;
    case 'ringInRing':
      ctx.moveTo(r, 0);
      ctx.arc(0, 0, r, 0, tau);
      ctx.moveTo(r * 0.45, 0);
      ctx.arc(0, 0, r * 0.45, 0, tau, true);
      return;
    case 'trefoil':
      for (let i = 0; i < 3; i++) {
        const a = -Math.PI / 2 + (i / 3) * tau;
        ctx.moveTo(Math.cos(a) * r * 0.5 + r * 0.5, Math.sin(a) * r * 0.5);
        ctx.arc(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5, r * 0.5, 0, tau);
      }
      return;
    case 'comb':
      ctx.moveTo(-r, r * 0.6);
      ctx.lineTo(r, r * 0.6);
      ctx.lineTo(r, r * 0.3);
      ctx.lineTo(-r, r * 0.3);
      ctx.closePath();
      for (let i = 0; i < 4; i++) {
        const x = -r + (r * 2 * (i + 0.5)) / 4;
        ctx.moveTo(x - r * 0.09, r * 0.3);
        ctx.lineTo(x + r * 0.09, r * 0.3);
        ctx.lineTo(x + r * 0.09, -r * 0.7);
        ctx.lineTo(x - r * 0.09, -r * 0.7);
        ctx.closePath();
      }
      return;
    case 'spiral': {
      const turns = 2.4;
      ctx.moveTo(0, 0);
      for (let i = 0; i <= 48; i++) {
        const t = i / 48;
        const a = t * turns * tau;
        const rad = r * t;
        ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
      }
      return;
    }
    case 'splitLozenge':
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.62, 0);
      ctx.lineTo(0, r);
      ctx.lineTo(-r * 0.62, 0);
      ctx.closePath();
      ctx.moveTo(-r * 0.62, 0);
      ctx.lineTo(r * 0.62, 0);
      return;
    case 'crossBar':
      ctx.rect(-r * 0.16, -r, r * 0.32, r * 2);
      ctx.rect(-r, -r * 0.16, r * 2, r * 0.32);
      return;
    case 'eye':
      ctx.moveTo(-r, 0);
      ctx.quadraticCurveTo(0, -r * 0.85, r, 0);
      ctx.quadraticCurveTo(0, r * 0.85, -r, 0);
      ctx.closePath();
      ctx.moveTo(r * 0.3, 0);
      ctx.arc(0, 0, r * 0.3, 0, tau, true);
      return;
    case 'wave':
      ctx.moveTo(-r, r * 0.25);
      for (let i = 0; i < 2; i++) {
        const x = -r + r * i;
        ctx.quadraticCurveTo(x + r * 0.25, -r * 0.6, x + r * 0.5, r * 0.25);
        ctx.quadraticCurveTo(x + r * 0.75, r * 0.8, x + r, r * 0.25);
      }
      ctx.lineTo(r, r * 0.7);
      ctx.lineTo(-r, r * 0.7);
      ctx.closePath();
      return;
    case 'ladder':
      ctx.rect(-r * 0.7, -r, r * 0.18, r * 2);
      ctx.rect(r * 0.52, -r, r * 0.18, r * 2);
      for (let i = 0; i < 3; i++) {
        const y = -r * 0.55 + (i * r * 1.1) / 2;
        ctx.rect(-r * 0.7, y, r * 1.4, r * 0.14);
      }
      return;
    case 'sixStar':
      for (let i = 0; i < 12; i++) {
        const a = -Math.PI / 2 + (i / 12) * tau;
        const rad = i % 2 === 0 ? r : r * 0.42;
        const x = Math.cos(a) * rad;
        const y = Math.sin(a) * rad;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      return;
    case 'crescentPair':
      for (const sign of [-1, 1]) {
        ctx.moveTo(sign * r * 0.15, -r);
        ctx.quadraticCurveTo(sign * r, 0, sign * r * 0.15, r);
        ctx.quadraticCurveTo(sign * r * 0.55, 0, sign * r * 0.15, -r);
        ctx.closePath();
      }
      return;
  }
}
