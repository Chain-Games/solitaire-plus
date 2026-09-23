import { CARD_RADIUS, bakeCardSheet } from './render/card-art.js';

/**
 * Dev-only: /card-preview.html bakes the real card atlas and lays a few
 * cards out on the felt, for eyeballing the card look without a game.
 */
async function main(): Promise<void> {
  const dpr = Number(new URLSearchParams(location.search).get('dpr') ?? 2);
  const cardW = Number(new URLSearchParams(location.search).get('w') ?? 96);
  const sheet = await bakeCardSheet(Math.round(cardW * dpr));
  const cv = document.getElementById('c') as HTMLCanvasElement;
  const W = 1200;
  const H = 760;
  cv.width = W * dpr;
  cv.height = H * dpr;
  cv.style.width = `${W}px`;
  cv.style.height = `${H}px`;
  const ctx = cv.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const felt = ctx.createRadialGradient(W / 2, H * 0.45, 40, W / 2, H / 2, W * 0.7);
  felt.addColorStop(0, '#1f4a3e');
  felt.addColorStop(1, '#07120f');
  ctx.fillStyle = felt;
  ctx.fillRect(0, 0, W, H);
  const ch = (cardW * sheet.cellH) / sheet.cellW;
  const card = (i: number, x: number, y: number) => {
    // Contact shadow: soft, biased down-right (the key is top-left).
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = 'rgba(0,0,0,1)';
    ctx.beginPath();
    ctx.roundRect(x + 1, y + 1, cardW - 2, ch - 2, cardW * CARD_RADIUS);
    ctx.fill();
    ctx.restore();
    const o = sheet.origin(i);
    ctx.drawImage(sheet.canvas, o.x, o.y, sheet.cellW, sheet.cellH, x, y, cardW, ch);
  };
  // A fan of every rank in hearts and spades, then a tableau column overlapping.
  const top = 40;
  const ranks = [0, 4, 8, 9, 10, 11, 12];
  ranks.forEach((r, i) => card(26 + r, 40 + i * (cardW + 14), top));
  ranks.forEach((r, i) => card(39 + r, 40 + i * (cardW + 14), top + ch + 24));
  // A tableau column: two backs, then K♣ Q♦ J♠ 10♥ 9♣ overlapping.
  const cx = 40 + 7 * (cardW + 14) + 30;
  let y = top;
  card(52, cx, y);
  y += ch * 0.1;
  card(52, cx, y);
  y += ch * 0.1;
  for (const c of [12, 13 + 11, 39 + 10, 26 + 9, 8, 13 + 7]) {
    card(c, cx, y);
    y += ch * 0.2;
  }
  const cx2 = cx + cardW + 24;
  card(0, cx2, top);
  card(13, cx2, top + ch + 24);
  card(52, cx2 + cardW + 24, top);
  document.title = 'ready';
}
void main();
