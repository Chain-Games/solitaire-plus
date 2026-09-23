/**
 * The Chain Games mark (the owner's brand, public/brand/chain-mark.svg) as
 * one SVG path in a `-4.5 0 337 337` viewBox: the outer circle IS the coin,
 * the inner shape is cut out of it so whatever is under shows through. The
 * shell's `Coin` draws it as SVG; the engine bakes it to a canvas for the
 * results' coin burst. One source for both.
 */
export const CHAIN_MARK =
  'M164,4.5C73.4,4.5,0,77.9,0,168.5s73.4,164,164,164s164-73.4,164-164S254.6,4.5,164,4.5z M156,247.7 l-92.9-76.9l92.2-115.4v73.4l-16.9-13.2l-33.9,39.9l51.5,41.1V247.7z M172.5,281.6v-73.5l17.1,13.2l33.9-39.8l-51.7-41.1v-51 l93.1,76.8L172.5,281.6z';

/** The mark's circle: centre and radius in path units. */
export const CHAIN_MARK_CX = 164;
export const CHAIN_MARK_CY = 168.5;
export const CHAIN_MARK_R = 164;

/** The coin's face, rim and well (the shell's `Coin` gradient stops). */
export const COIN_FACE = ['#ffd88f', '#ffb84d', '#d8861a'] as const;
export const COIN_RIM = ['#fff1cf', '#b86f10'] as const;
export const COIN_WELL = '#3a2200';

/**
 * The coin on a 2D canvas, `size` px square at (x, y): rim, dark well, the
 * mark on the amber face — the same three layers as the shell's `Coin`. The
 * share card and the results' coin burst both draw with this.
 */
export function drawCoin(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  const k = size / 337;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  ctx.translate(4.5, 0); // viewBox -4.5 0 337 337
  const rim = ctx.createLinearGradient(0, 0, 0, 337);
  rim.addColorStop(0, COIN_RIM[0]);
  rim.addColorStop(1, COIN_RIM[1]);
  ctx.beginPath();
  ctx.arc(CHAIN_MARK_CX, CHAIN_MARK_CY, CHAIN_MARK_R + 4, 0, Math.PI * 2);
  ctx.fillStyle = rim;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(CHAIN_MARK_CX, CHAIN_MARK_CY, CHAIN_MARK_R - 10, 0, Math.PI * 2);
  ctx.fillStyle = COIN_WELL;
  ctx.fill();
  const face = ctx.createLinearGradient(0, 0, 337, 337);
  face.addColorStop(0, COIN_FACE[0]);
  face.addColorStop(0.55, COIN_FACE[1]);
  face.addColorStop(1, COIN_FACE[2]);
  ctx.fillStyle = face;
  ctx.fill(new Path2D(CHAIN_MARK));
  ctx.restore();
}
