import { starLightOf } from '../../cosmic/spectral.ts';
import { css, shade, type Hsl } from '../color.ts';
import { outlineWidth } from '../bands.ts';

/**
 * Some levels of the ladder are OBJECTS with a surface (a planet, a building) and some are REGIONS OF
 * SPACE that merely contain things (a field, a cluster, a star system). Drawing the second kind as an
 * opaque disc is a visible lie: it hides its own contents and implies a substance that is not there.
 *
 * So containers get a soft interior wash and a faint boundary, and their children are the content.
 */
export function drawContainer(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  colour: Hsl,
  strength = 1,
): void {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, css(colour, 0.5 * strength));
  g.addColorStop(0.62, css(colour, 0.26 * strength));
  g.addColorStop(1, css(colour, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  // A boundary faint enough to read as a survey annotation rather than a wall.
  const w = outlineWidth(r, 1);
  if (w > 0) {
    ctx.lineWidth = w;
    ctx.strokeStyle = css(colour, 0.22 * strength);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/**
 * A star system is ~10 AU across but its star is a few million km, so the system's own extent is
 * almost entirely empty. Draw the star, not the extent -- and draw it in its spectral colour, which is
 * the cue that carries the star's identity all the way down to the shading of a single wall.
 */
export function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, systemRadiusPx: number, id: number): void {
  const light = starLightOf(id);
  const r = Math.max(0.8, systemRadiusPx * 0.055 * light.cls.discScale);

  // The second and last sanctioned gradient in the project: a star's bloom.
  // A tighter bloom. An expansive one turns interplanetary space into warm haze and hides the
  // starfield that should be visible right through it.
  const bloom = r * (2.2 + light.cls.rel * 1.4);
  const g = ctx.createRadialGradient(cx, cy, r * 0.5, cx, cy, bloom);
  g.addColorStop(0, css(light.colour, 0.34 * light.cls.rel));
  g.addColorStop(1, css(light.colour, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, bloom, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = css({ ...light.colour, l: Math.min(0.97, light.colour.l + 0.2) });
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  if (light.cls.key === 'RG' || light.cls.key === 'C') {
    // Swollen stars get a cooler rim so they read as bloated rather than merely large.
    ctx.lineWidth = Math.max(1, r * 0.16);
    ctx.strokeStyle = css(shade(light.colour, light.shadowHue, 0.5), 0.7);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}
