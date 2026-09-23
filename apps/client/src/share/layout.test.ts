import { rankFor, type ScoreBreakdown } from '@solitaire-plus/sim';
import { describe, expect, it } from 'vitest';
import {
  CAP_MID_EM,
  CARD_ART,
  CARD_PX,
  displayUrl,
  endLabel,
  layoutCard,
  potCopy,
  rankLine,
  resultCopy,
  shareText,
  statTiles,
  takeCode,
  takeUrl,
  type CardChallenge,
  type CardInput,
  type CardOp,
  type CoinOp,
  type PanelOp,
  type TextOp,
} from './layout.js';

/** The owner's screenshot: 9,520 with a 4X streak, 23 lines, level 8, time's up. */
const B: ScoreBreakdown = {
  base: 8770,
  streakBonus: 750,
  colorBonus: 0,
  total: 9520,
  bestStreak: 4,
  colorLines: 0,
  linesCleared: 23,
  placements: 73,
  elapsedMs: 180_000,
  endReason: 'timeout',
  levelReached: 8,
};

const USER = { username: 'guest_x', xpLevel: 2, rank: rankFor(2) };
const HOST = 'blockari.testnet.chaingames.io';
const ORIGIN = `https://${HOST}`;

/** The three states a card tells: the dare, the win, the loss (solo is `challenge: undefined`). */
const OPEN: CardChallenge = { status: 'open', code: 'AGB2BS', entryFee: 100 };
const WON: CardChallenge = {
  status: 'complete',
  code: 'AGB2BS',
  entryFee: 100,
  result: { won: true, payout: 200, opponent: { username: 'mason', score: 8470 } },
};
const LOST: CardChallenge = {
  status: 'complete',
  code: 'AGB2BS',
  entryFee: 100,
  result: { won: false, payout: 0, opponent: { username: 'mason', score: 12_400 } },
};

function input(over: Partial<CardInput> = {}): CardInput {
  return {
    size: 'story',
    breakdown: B,
    user: USER,
    challenge: OPEN,
    newBest: true,
    host: HOST,
    origin: ORIGIN,
    ...over,
  };
}

const texts = (ops: CardOp[]) => ops.filter((o): o is TextOp => o.kind === 'text');
const byId = (ops: CardOp[], id: string) => texts(ops).find((t) => t.id === id);
const one = <K extends CardOp['kind']>(ops: CardOp[], kind: K) =>
  ops.find((o): o is Extract<CardOp, { kind: K }> => o.kind === kind)!;
const panelById = (ops: CardOp[], id: string) =>
  ops.find((o): o is PanelOp => o.kind === 'panel' && o.id === id)!;
/** The coin whose vertical centre is on line `y`. */
const coinOn = (ops: CardOp[], y: number) =>
  ops.find((o): o is CoinOp => o.kind === 'coin' && Math.abs(o.y + o.size / 2 - y) < 1);
const inside = (o: { x: number; y: number; w: number; h: number }, box: typeof o) =>
  o.x >= box.x && o.y >= box.y && o.x + o.w <= box.x + box.w && o.y + o.h <= box.y + box.h;

describe('share text', () => {
  it('dares with the code for an open challenge and states the run for solo', () => {
    expect(shareText(9520, OPEN, HOST)).toBe(
      'I scored 9,520 in Blockari. Same pieces, 3 minutes — beat me: AGB2BS',
    );
    expect(shareText(9520, null, HOST)).toBe('I scored 9,520 in Blockari. Same pieces, 3 minutes.');
    expect(shareText(120, undefined, HOST)).toBe(
      'I scored 120 in Blockari. Same pieces, 3 minutes.',
    );
  });

  it('tells the result of a settled challenge and never its code', () => {
    expect(shareText(9520, WON, HOST)).toBe(
      `I scored 9,520 on Blockari and won 200 $CHAIN — play free: ${HOST}`,
    );
    // A loss keeps to the score: the card says the rest.
    expect(shareText(9520, LOST, HOST)).toBe(`I scored 9,520 on Blockari — play free: ${HOST}`);
    for (const c of [WON, LOST]) expect(shareText(9520, c, HOST)).not.toContain('AGB2BS');
    expect(takeCode(OPEN)).toBe('AGB2BS');
    expect(takeCode(WON)).toBeNull();
    expect(takeCode(undefined)).toBeNull();
  });

  it('labels how the run ended, the stats, the account line and the pot', () => {
    expect(endLabel(B, true)).toBe("TIME'S UP");
    expect(endLabel({ ...B, endReason: 'stuck' }, false)).toBe('OUT OF MOVES');
    expect(endLabel({ ...B, endReason: 'forfeit' }, false)).toBe('RUN OVER');
    expect(endLabel({ ...B, endReason: 'forfeit' }, true)).toBe('FORFEITED');
    expect(statTiles(B).map((t) => `${t.label} ${t.value}`)).toEqual([
      'LINES 23',
      'BEST STREAK 4X',
      'LEVEL LV 8',
    ]);
    expect(statTiles(B)[2]!.tone).toBe('mint');
    expect(rankLine(USER)).toBe('PEBBLE II · XP LV 2');
    expect(rankLine({ username: 'm', xpLevel: 12, rank: rankFor(12) })).toBe('MASON II · XP LV 12');
    expect(potCopy(100, 9520)).toEqual({
      eyebrow: 'BEAT 9,520 TO WIN',
      value: '200',
      unit: '$CHAIN',
      sub: 'Stake 100 to play',
      tone: 'amber',
      coin: true,
    });
    expect(resultCopy(WON.result, 100)).toEqual({
      eyebrow: 'YOU WON',
      value: '+200',
      unit: '$CHAIN',
      sub: 'vs mason · 8,470',
      tone: 'mint',
      coin: true,
    });
    // The loss is the stake, with a real minus sign and no coin.
    expect(resultCopy(LOST.result, 100)).toEqual({
      eyebrow: 'YOU LOST',
      value: '\u2212100',
      unit: '$CHAIN',
      sub: 'vs mason · 12,400',
      tone: 'rose',
      coin: false,
    });
    expect(resultCopy({ won: true, payout: 20 }, 10).sub).toBe('');
    expect(takeUrl(ORIGIN, 'AGB2BS')).toBe(`${ORIGIN}/take?code=AGB2BS`);
    expect(takeUrl(ORIGIN, null)).toBe(ORIGIN);
    expect(displayUrl(HOST, 'AGB2BS')).toBe(`${HOST}/take?code=AGB2BS`);
    expect(displayUrl(HOST, null)).toBe(HOST);
  });
});

describe('card layout', () => {
  it.each(['story', 'link'] as const)(
    '%s: the art runs full-bleed and every word sits on the plate',
    (size) => {
      const L = layoutCard(input({ size }));
      expect({ w: L.w, h: L.h }).toEqual(CARD_PX[size]);
      const art = one(L.ops, 'art');
      expect(art).toEqual({ kind: 'art', src: CARD_ART[size], x: 0, y: 0, w: L.w, h: L.h });
      expect(L.ops[0]).toBe(art);
      const plate = one(L.ops, 'plate');
      expect(L.ops[1]).toBe(plate);
      expect(inside(plate, { x: 0, y: 0, w: L.w, h: L.h })).toBe(true);
      for (const op of L.ops) {
        if (op.kind === 'art' || op.kind === 'plate') continue;
        if (op.kind === 'text') {
          expect(op.y - op.size / 2).toBeGreaterThanOrEqual(plate.y);
          expect(op.y + op.size / 2).toBeLessThanOrEqual(plate.y + plate.h);
          expect(op.x).toBeGreaterThanOrEqual(plate.x);
          expect(op.x).toBeLessThanOrEqual(plate.x + plate.w);
        } else {
          const w = 'w' in op ? op.w : op.size;
          const h = 'h' in op ? op.h : op.size;
          expect(inside({ x: op.x, y: op.y, w, h }, plate)).toBe(true);
        }
      }
    },
  );

  it('story: the plate covers the painted board and leaves the logo, Fuji and the pagoda clear', () => {
    const plate = one(layoutCard(input()).ops, 'plate');
    expect(plate.y).toBeGreaterThanOrEqual(1000);
    expect(plate.y - plate.fade).toBeGreaterThan(830);
    expect(plate.x).toBe(48);
    expect(plate.x + plate.w).toBe(1032);
    expect(plate.r).toBe(40);
  });

  it('link: the plate runs along the bottom under the logo', () => {
    const plate = one(layoutCard(input({ size: 'link' })).ops, 'plate');
    expect(plate).toMatchObject({ x: 32, y: 338, w: 1136, h: 260, r: 32 });
  });

  it.each(['story', 'link'] as const)(
    '%s: the three largest runs are the score, the pot and the code, in that order',
    (size) => {
      const L = layoutCard(input({ size }));
      const sizes = [
        ...texts(L.ops).map((t) => ({ id: t.id, size: t.size })),
        { id: 'code', size: one(L.ops, 'slab').size },
      ].sort((a, b) => b.size - a.size);
      expect(sizes.slice(0, 3).map((s) => s.id)).toEqual(['score', 'pot', 'code']);
      expect(byId(L.ops, 'pot')!.size).toBeGreaterThanOrEqual(size === 'story' ? 96 : 60);
    },
  );

  it('story: reads SCORE → hero → tiles → pill → the stake → code + QR → url, top to bottom', () => {
    const L = layoutCard(input());
    const score = byId(L.ops, 'score')!;
    expect(score.text).toBe('9,520');
    expect(score.size).toBe(180);
    expect(score.tone).toBe('mint');
    expect(score.glow).toBeGreaterThan(0);
    expect(score.x).toBe(L.w / 2);
    // The header is one eyebrow: no "TIME'S UP", no "NEW BEST".
    expect(byId(L.ops, 'eyebrow')).toMatchObject({ text: 'SCORE', tone: 'dim', size: 32 });
    expect(byId(L.ops, 'best')).toBeUndefined();
    expect(texts(L.ops).some((t) => /TIME|NEW BEST/.test(t.text))).toBe(false);
    const order = [
      'eyebrow',
      'score',
      'tile-0-value',
      'name',
      'pot-eyebrow',
      'pot',
      'pot-sub',
      'link',
    ];
    const ys = order.map((id) => byId(L.ops, id)!.y);
    for (let i = 1; i < ys.length; i++) expect(ys[i]!).toBeGreaterThan(ys[i - 1]!);
    const qr = one(L.ops, 'qr');
    expect(one(L.ops, 'slab').y).toBeGreaterThan(byId(L.ops, 'pot-sub')!.y);
    expect(byId(L.ops, 'link')!.y).toBeGreaterThan(qr.y + qr.size);
    // A long score never spills past the plate's padding.
    const big = byId(layoutCard(input({ breakdown: { ...B, total: 12_345_678 } })).ops, 'score')!;
    expect(big.size).toBeLessThan(180);
    expect(byId(L.ops, 'footer')).toBeUndefined();
  });

  it('story: three equal glass tiles in one row, then the identity pill, on one axis (40 / 32 / 40)', () => {
    const L = layoutCard(input());
    const plate = one(L.ops, 'plate');
    const tiles = [0, 1, 2].map((i) => panelById(L.ops, `tile-${i}`));
    for (const t of tiles)
      expect(t).toMatchObject({ kind: 'panel', tone: 'text', fill: 0.05, edge: 0.08, r: 24 });
    expect(new Set(tiles.map((t) => t.w)).size).toBe(1);
    expect(new Set(tiles.map((t) => t.y)).size).toBe(1);
    expect(tiles[1]!.x - (tiles[0]!.x + tiles[0]!.w)).toBe(24);
    expect(tiles[0]!.x).toBe(plate.x + 48);
    expect(tiles[2]!.x + tiles[2]!.w).toBe(plate.x + plate.w - 48);
    for (let i = 0; i < 3; i++) {
      const label = byId(L.ops, `tile-${i}-label`)!;
      const value = byId(L.ops, `tile-${i}-value`)!;
      expect(label.size).toBe(26);
      expect(value.size).toBe(56);
      expect(label.y).toBeLessThan(value.y);
      expect(label.x).toBe(tiles[i]!.x + tiles[i]!.w / 2);
      expect(value.x).toBe(label.x);
    }
    expect(byId(L.ops, 'tile-1-value')).toMatchObject({ text: '4X', tone: 'text' });
    expect(byId(L.ops, 'tile-2-value')).toMatchObject({ text: 'LV 8', tone: 'mint' });
    // The pill: badge 56 · name 40 · rank line 26, all on one line, centred on the plate.
    const pill = panelById(L.ops, 'pill');
    const badge = one(L.ops, 'badge');
    const name = byId(L.ops, 'name')!;
    const rank = byId(L.ops, 'rank')!;
    expect(pill).toMatchObject({ tone: 'text', fill: 0.05, edge: 0.08 });
    expect(pill.h).toBeGreaterThanOrEqual(76);
    expect(Math.abs(pill.x + pill.w / 2 - L.w / 2)).toBeLessThan(0.01);
    expect(badge.size).toBeGreaterThanOrEqual(52);
    expect(name.size).toBe(40);
    expect(rank.size).toBe(26);
    expect(rank.tone).toBe('rank');
    expect(name.y).toBe(rank.y);
    expect(Math.abs(badge.y + badge.size / 2 - name.y)).toBeLessThan(0.01);
    expect(badge.x).toBe(pill.x + 32);
    expect(name.x).toBeGreaterThan(badge.x + badge.size);
    expect(rank.x).toBeGreaterThan(name.x);
    // The rhythm: score → 40 → tiles → 32 → pill → 40 → pot.
    const pot = panelById(L.ops, 'pot');
    expect(pill.y - (tiles[0]!.y + tiles[0]!.h)).toBe(32);
    expect(pot.y - (pill.y + pill.h)).toBe(40);
    // The score's glyph bottom is an estimate here (~0.35 em under the middle baseline).
    const scoreBottom = byId(L.ops, 'score')!.y + 0.35 * 180;
    expect(tiles[0]!.y - scoreBottom).toBeGreaterThanOrEqual(32);
    expect(tiles[0]!.y - scoreBottom).toBeLessThanOrEqual(48);
    // Signed out: no pill.
    const anon = layoutCard(input({ user: null }));
    expect(anon.ops.some((o) => o.kind === 'badge')).toBe(false);
    expect(anon.ops.some((o) => o.kind === 'panel' && o.id === 'pill')).toBe(false);
  });

  it('story: the small text survives the phone (×0.36) — the offer reads at 390 px', () => {
    const L = layoutCard(input());
    const scale = 390 / L.w;
    for (const id of ['pot-eyebrow', 'pot-sub', 'link', 'eyebrow'])
      expect(byId(L.ops, id)!.size * scale).toBeGreaterThanOrEqual(10);
    // The tile labels and the pill's rank line are the owner's 26 px: 9.4 px on a phone, the smallest runs.
    for (const id of ['tile-0-label', 'rank'])
      expect(byId(L.ops, id)!.size * scale).toBeGreaterThanOrEqual(9);
    expect(byId(L.ops, 'pot-eyebrow')!.size * scale).toBeGreaterThanOrEqual(13);
    // The pot stands clear of the code (120 over 96).
    expect(byId(L.ops, 'pot')!.size / one(L.ops, 'slab').size).toBeGreaterThanOrEqual(1.2);
  });

  it('story: the pot is a full-width amber block with the coin at the number', () => {
    const L = layoutCard(input());
    const panel = panelById(L.ops, 'pot');
    const plate = one(L.ops, 'plate');
    expect(panel.tone).toBe('amber');
    expect(panel.w).toBeGreaterThan(plate.w * 0.85);
    const pot = byId(L.ops, 'pot')!;
    const unit = byId(L.ops, 'pot-unit')!;
    const stake = byId(L.ops, 'pot-sub')!;
    expect(pot.text).toBe('200');
    expect(pot.tone).toBe('amber');
    expect(unit.text).toBe('$CHAIN');
    expect(unit.x).toBeGreaterThan(pot.x);
    // The unit and the coin centre on the number's cap box (which sits above the em centre).
    expect(unit.y).toBeCloseTo(pot.y - CAP_MID_EM * (pot.size - unit.size), 5);
    expect(stake.text).toBe('Stake 100 to play');
    expect(byId(L.ops, 'pot-eyebrow')!.text).toBe('BEAT 9,520 TO WIN');
    const coin = coinOn(L.ops, pot.y - CAP_MID_EM * pot.size)!;
    expect(coin).toBeDefined();
    expect(coin.x + coin.size).toBeLessThanOrEqual(pot.x);
    for (const id of ['pot-eyebrow', 'pot', 'pot-sub'])
      expect(inside({ x: panel.x, y: byId(L.ops, id)!.y, w: 0, h: 0 }, panel)).toBe(true);
    // No stake known: no pot, just the dare.
    const noFee = layoutCard(input({ challenge: { status: 'open', code: 'AGB2BS' } }));
    expect(noFee.ops.some((o) => o.kind === 'panel' && o.id === 'pot')).toBe(false);
    expect(byId(noFee.ops, 'cta-label')!.text).toBe('BEAT 9,520');
  });

  it.each(['story', 'link'] as const)(
    '%s: the code slab shares its row with a QR of the take link',
    (size) => {
      const L = layoutCard(input({ size }));
      const slab = one(L.ops, 'slab');
      const qr = one(L.ops, 'qr');
      expect(slab.text).toBe('AGB2BS');
      expect(slab.track).toBeGreaterThan(0.2);
      expect(qr.text).toBe(`${ORIGIN}/take?code=AGB2BS`);
      expect(qr.size).toBeGreaterThanOrEqual(size === 'story' ? 160 : 180);
      expect(qr.pad).toBeGreaterThan(0);
      expect(slab.x + slab.w).toBeLessThan(qr.x);
      if (size === 'story')
        expect(Math.abs(slab.y + slab.h / 2 - (qr.y + qr.size / 2))).toBeLessThan(1);
      else
        expect(byId(L.ops, 'scan')).toMatchObject({ text: 'SCAN TO PLAY', x: qr.x + qr.size / 2 });
      // Solo: no code, no pot; the QR points at the front door and the host is named.
      const solo = layoutCard(input({ size, challenge: undefined }));
      expect(solo.ops.some((o) => o.kind === 'slab')).toBe(false);
      expect(solo.ops.some((o) => o.kind === 'panel' && o.id === 'pot')).toBe(false);
      expect(one(solo.ops, 'qr').text).toBe(ORIGIN);
      expect(byId(solo.ops, 'cta-label')!.text).toBe('PLAY FREE AT');
      expect(byId(solo.ops, 'host')!.text).toBe(HOST);
      // The host is on the card once: no dim link line repeating it.
      expect(byId(solo.ops, 'link')).toBeUndefined();
      expect(texts(solo.ops).filter((t) => t.text === HOST)).toHaveLength(1);
      const plate = one(solo.ops, 'plate');
      const sq = one(solo.ops, 'qr');
      if (size === 'story') {
        // The QR centred between the host and the plate's foot (72 / 72), the door
        // as far under the pill as the QR is over the foot.
        const host = byId(solo.ops, 'host')!;
        const label = byId(solo.ops, 'cta-label')!;
        const pill = panelById(solo.ops, 'pill');
        const above = sq.y - (host.y + host.size / 2);
        const below = plate.y + plate.h - (sq.y + sq.size);
        expect(Math.abs(above - below)).toBeLessThanOrEqual(2);
        expect(Math.abs(label.y - label.size / 2 - (pill.y + pill.h) - below)).toBeLessThanOrEqual(
          8,
        );
      } else {
        // The front door centred on the plate's height, between the score and the QR.
        const label = byId(solo.ops, 'cta-label')!;
        const host = byId(solo.ops, 'host')!;
        const mid = (label.y - label.size / 2 + host.y + host.size / 2) / 2;
        expect(Math.abs(mid - (plate.y + plate.h / 2))).toBeLessThanOrEqual(4);
      }
    },
  );

  it.each(['story', 'link'] as const)(
    '%s: the url is one line, shrunk to fit the plate, never wrapped',
    (size) => {
      const L = layoutCard(input({ size }));
      const link = byId(L.ops, 'link')!;
      expect(link.text).toBe(`${HOST}/take?code=AGB2BS`);
      expect(byId(L.ops, 'link-2')).toBeUndefined();
      const plate = one(L.ops, 'plate');
      const longHost = 'a-very-long-subdomain.blockari.testnet.chaingames.io';
      const long = byId(layoutCard(input({ size, host: longHost })).ops, 'link')!;
      expect(long.size).toBeLessThan(link.size + 1);
      // The estimate's width at the chosen size fits the plate.
      expect(long.text.length * long.size * 0.58).toBeLessThanOrEqual(plate.w);
    },
  );

  it('link: score left, pot centre, QR right, the stat and player lines under the score', () => {
    const L = layoutCard(input({ size: 'link' }));
    const score = byId(L.ops, 'score')!;
    const pot = byId(L.ops, 'pot')!;
    const qr = one(L.ops, 'qr');
    const panel = panelById(L.ops, 'pot');
    expect(score.x).toBeLessThan(panel.x);
    expect(panel.x + panel.w).toBeLessThan(qr.x);
    expect(qr.x + qr.size).toBeGreaterThan(L.w * 0.9);
    expect(pot.size).toBeLessThan(score.size);
    // One rhythm: the pot panel and the QR share a top; equal gaps either side of the pot.
    expect(qr.y).toBe(panel.y);
    expect(panel.x - 440).toBe(qr.x - (panel.x + panel.w));
    // The url is centred on the pot column.
    expect(byId(L.ops, 'link')!.x).toBe(panel.x + panel.w / 2);
    // The stat strip under the score, the pill under that, both inside the left column.
    const strip = panelById(L.ops, 'strip');
    const pill = panelById(L.ops, 'pill');
    expect(strip.y).toBeGreaterThan(score.y);
    expect(pill.y).toBeGreaterThan(strip.y + strip.h);
    expect(strip.x).toBe(60);
    expect(strip.x + strip.w).toBe(440);
    expect(pill.x).toBeGreaterThanOrEqual(60);
    expect(pill.x + pill.w).toBeLessThanOrEqual(440);
    expect(byId(L.ops, 'strip-2-value')).toMatchObject({ text: 'LV 8', tone: 'mint' });
    expect(byId(L.ops, 'eyebrow')).toMatchObject({ text: 'SCORE', size: 20 });
    expect(byId(L.ops, 'best')).toBeUndefined();
    // At a 300 px preview the score still stands: ≥ 30 px there.
    expect((score.size * 300) / L.w).toBeGreaterThanOrEqual(30);
  });

  it.each(['story', 'link'] as const)(
    "%s: a settled challenge shares the RESULT in the pot's slot — no code, no dare, the front door",
    (size) => {
      const open = layoutCard(input({ size }));
      const potPanel = panelById(open.ops, 'pot');
      for (const [ch, tone, eyebrow, value] of [
        [WON, 'mint', 'YOU WON', '+200'],
        [LOST, 'rose', 'YOU LOST', '\u2212100'],
      ] as const) {
        const L = layoutCard(input({ size, challenge: ch }));
        // The outcome panel sits exactly where the pot sat, at the pot's weight.
        const panel = panelById(L.ops, 'outcome');
        expect(panel).toMatchObject({
          x: potPanel.x,
          y: potPanel.y,
          w: potPanel.w,
          h: potPanel.h,
          r: potPanel.r,
          tone,
          fill: potPanel.fill,
          edge: potPanel.edge,
        });
        expect(byId(L.ops, 'outcome-eyebrow')).toMatchObject({
          text: eyebrow,
          tone,
          size: byId(open.ops, 'pot-eyebrow')!.size,
          y: byId(open.ops, 'pot-eyebrow')!.y,
        });
        const hero = byId(L.ops, 'outcome')!;
        expect(hero).toMatchObject({ text: value, tone, size: byId(open.ops, 'pot')!.size });
        expect(hero.y).toBe(byId(open.ops, 'pot')!.y);
        expect(hero.glow).toBeGreaterThan(0);
        expect(byId(L.ops, 'outcome-unit')).toMatchObject({ text: '$CHAIN', tone });
        expect(byId(L.ops, 'outcome-unit')!.x).toBeGreaterThan(hero.x);
        const vs = byId(L.ops, 'outcome-sub')!;
        expect(vs).toMatchObject({ tone: 'dim', face: 'body', y: byId(open.ops, 'pot-sub')!.y });
        expect(vs.text).toBe(`vs mason · ${ch === WON ? '8,470' : '12,400'}`);
        // The coin rides the win's number; a loss has none.
        const coin = coinOn(L.ops, hero.y - CAP_MID_EM * hero.size);
        if (ch === WON) {
          expect(coin).toBeDefined();
          expect(coin!.x + coin!.size).toBeLessThanOrEqual(hero.x);
        } else expect(L.ops.some((o) => o.kind === 'coin')).toBe(false);
        // Nothing of the dare survives: no pot, no code slab, no "beat", no take link.
        expect(L.ops.some((o) => o.kind === 'panel' && o.id === 'pot')).toBe(false);
        expect(L.ops.some((o) => o.kind === 'slab')).toBe(false);
        expect(byId(L.ops, 'pot-eyebrow')).toBeUndefined();
        for (const t of texts(L.ops)) {
          expect(t.text).not.toMatch(/BEAT|STAKE|AGB2BS|take\?code/i);
        }
        expect(one(L.ops, 'qr').text).toBe(ORIGIN);
        // The front door, like solo: the label over the host, once — no link line repeating it.
        expect(byId(L.ops, 'cta-label')).toMatchObject({ text: 'PLAY FREE AT', tone: 'amber' });
        expect(byId(L.ops, 'host')).toMatchObject({ text: HOST, tone: 'mint' });
        expect(byId(L.ops, 'host')!.y).toBeGreaterThan(byId(L.ops, 'cta-label')!.y);
        expect(byId(L.ops, 'link')).toBeUndefined();
        expect(texts(L.ops).filter((t) => t.text === HOST)).toHaveLength(1);
        // The result is the second hero: the two largest runs are the score and the outcome.
        const sizes = texts(L.ops)
          .map((t) => ({ id: t.id, size: t.size }))
          .sort((a, b) => b.size - a.size);
        expect(sizes.slice(0, 2).map((s) => s.id)).toEqual(['score', 'outcome']);
        expect(byId(L.ops, 'host')!.size).toBeLessThan(hero.size);
        // The front door sits under the outcome and clear of it.
        expect(byId(L.ops, 'cta-label')!.y - byId(L.ops, 'cta-label')!.size / 2).toBeGreaterThan(
          panel.y + panel.h,
        );
        // No dead band: the bottom block sits centred between the outcome and the plate's foot.
        const plate = one(L.ops, 'plate');
        const foot = plate.y + plate.h;
        const block =
          size === 'story'
            ? { top: one(L.ops, 'qr').y, bottom: one(L.ops, 'qr').y + one(L.ops, 'qr').size }
            : {
                top: byId(L.ops, 'cta-label')!.y - byId(L.ops, 'cta-label')!.size / 2,
                bottom: byId(L.ops, 'host')!.y + byId(L.ops, 'host')!.size / 2,
              };
        expect(
          Math.abs(block.top - (panel.y + panel.h) - (foot - block.bottom)),
        ).toBeLessThanOrEqual(4);
      }
    },
  );

  it("story: the settled card's front door shares the row with the QR, centred on its height", () => {
    const L = layoutCard(input({ challenge: WON }));
    const qr = one(L.ops, 'qr');
    const label = byId(L.ops, 'cta-label')!;
    const host = byId(L.ops, 'host')!;
    const open = layoutCard(input());
    const slab = one(open.ops, 'slab');
    // The row keeps the dare row's column and drops 20 into the link line's space (40 / 41).
    expect(qr.x).toBe(one(open.ops, 'qr').x);
    expect(qr.y).toBe(one(open.ops, 'qr').y + 20);
    // The pair is centred on the slab's box: the label and the host equidistant from its middle.
    const mid = qr.y + qr.size / 2;
    expect(mid - label.y).toBeCloseTo(host.y - mid, 5);
    expect(label.x).toBe(slab.x + slab.w / 2);
    expect(host.x).toBe(label.x);
    expect(label.y - label.size / 2).toBeGreaterThanOrEqual(qr.y);
    expect(host.y + host.size / 2).toBeLessThanOrEqual(qr.y + qr.size);
    // The host never crosses into the QR.
    expect(host.x + (host.text.length * host.size * 0.52) / 2).toBeLessThan(qr.x);
    // On the phone the small runs still read.
    const scale = 390 / L.w;
    for (const id of ['outcome-eyebrow', 'outcome-sub', 'cta-label'])
      expect(byId(L.ops, id)!.size * scale).toBeGreaterThanOrEqual(10);
    expect(byId(L.ops, 'outcome-eyebrow')!.size * scale).toBeGreaterThanOrEqual(13);
  });

  it("link: the settled card's front door takes the slab's slot under the outcome", () => {
    const L = layoutCard(input({ size: 'link', challenge: LOST }));
    const open = layoutCard(input({ size: 'link' }));
    const slab = one(open.ops, 'slab');
    const plate = one(L.ops, 'plate');
    const label = byId(L.ops, 'cta-label')!;
    const host = byId(L.ops, 'host')!;
    expect(label.x).toBe(slab.x + slab.w / 2);
    expect(host.x).toBe(label.x);
    expect(label.y - label.size / 2).toBeGreaterThanOrEqual(slab.y);
    expect(host.y + host.size / 2).toBeLessThanOrEqual(plate.y + plate.h - 20);
    expect(host.y - host.size / 2).toBeGreaterThan(label.y + label.size / 2);
    // The host at its set size fits the column (the estimate shrinks a long one).
    expect(host.text.length * host.size * 0.52).toBeLessThanOrEqual(slab.w + 1);
    expect(byId(L.ops, 'scan')).toMatchObject({ text: 'SCAN TO PLAY' });
    expect(one(L.ops, 'qr').text).toBe(ORIGIN);
  });
});
