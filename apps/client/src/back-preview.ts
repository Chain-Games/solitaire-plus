import { BACK_THEMES, CARD_RADIUS, bakeBackPreview, bakeCardSheet, type BackThemeId } from './render/card-art.js';

/** Dev-only: /back-preview.html — every back colourway beside a face, on the felt. */
async function main(): Promise<void> {
  const dpr = 2;
  const cardW = 150;
  const cv = document.getElementById('c') as HTMLCanvasElement;
  const W = 1200;
  const H = 520;
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
  const sheet = await bakeCardSheet(Math.round(cardW * dpr));
  const ch = (cardW * sheet.cellH) / sheet.cellW;
  const shadow = (x: number, y: number) => {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetX = 3;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.roundRect(x + 1, y + 1, cardW - 2, ch - 2, cardW * CARD_RADIUS);
    ctx.fill();
    ctx.restore();
  };
  const ids = Object.keys(BACK_THEMES) as BackThemeId[];
  let x = 40;
  ctx.font = '600 16px Rajdhani, sans-serif';
  ctx.textAlign = 'center';
  for (const id of ids) {
    const back = await bakeBackPreview(Math.round(cardW * dpr), id);
    shadow(x, 60);
    ctx.drawImage(back, x, 60, cardW, ch);
    ctx.fillStyle = '#cfe8dd';
    ctx.fillText(id.toUpperCase(), x + cardW / 2, 40);
    x += cardW + 40;
  }
  const o = sheet.origin(12 + 13 * 2); // K♥
  shadow(x + 10, 60);
  ctx.drawImage(sheet.canvas, o.x, o.y, sheet.cellW, sheet.cellH, x + 10, 60, cardW, ch);
  document.title = 'ready';
}
void main();
