/**
 * Blockari — Control. A read-only view of who is playing, how well, on what.
 *
 * The whole page comes from `/api/admin/overview` in one call, so every
 * number on it agrees with every other. Plain DOM and hand-drawn SVG: there
 * are four chart shapes here and a library is a megabyte to draw them. No
 * React, nothing shared with the game — this page is its own Vite input and
 * the game's bundle never learns it exists.
 *
 * The endpoint's shape is 21 Wild's, so a combined dashboard can read both.
 */

import './admin.css';

const STORE_TOKEN = 'blockari.admin.token';
const REFRESH_MS = 30_000;

/* ------------------------------------------------------------------ types -- */

interface Rank {
  index: number;
  name: string;
  tier: number;
}

interface Overview {
  totals: {
    players: number;
    guests: number;
    gamesPlayed: number;
    bestScore: number;
    avgScore: number;
    bestLevel: number;
    xpAwarded: number;
    chainStaked: number;
  };
  gamesPerDay: { day: string; games: number; players: number }[];
  howGamesEnd: { timeout: number; stuck: number; forfeit: number };
  scoreSpread: { label: string; games: number }[];
  levelsReached: { level: string; games: number }[];
  ranks: { rank: string; players: number }[];
  challengePool: { fee: number; open: number; taken: number; complete: number; expired: number }[];
  leaderboard: {
    username: string;
    rank: Rank;
    score: number;
    level: number;
    where: string | null;
    endedAt: string;
  }[];
  recentGames: {
    username: string;
    score: number;
    level: number;
    lines: number;
    endReason: string;
    fee: number | null;
    endedAt: string;
  }[];
  where: { country: string; region: string | null; players: number }[];
  devices: { name: string; players: number }[];
  systems: { name: string; players: number }[];
  browsers: { name: string; players: number }[];
  live: { sessions: number };
  generatedAt: string;
}

/* -------------------------------------------------------------- utilities -- */

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const svg = (tag: string, attrs: Record<string, string | number>): SVGElement => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

const fmt = (n: number): string => n.toLocaleString('en-GB');

const ago = (iso: string): string => {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '—';
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

const clock = (iso: string): string => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—';
};

/** A flag from a two-letter code; the region name when the code is unknown. */
const flag = (code: string): string =>
  /^[A-Za-z]{2}$/.test(code)
    ? String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65))
    : '';

/** How a game ended, as the sim names it — a state, so a status hue *and* a word. */
const END: Record<string, { label: string; tone: 'mint' | 'amber' | 'rose' }> = {
  timeout: { label: 'Clock ran out', tone: 'mint' },
  stuck: { label: 'No room left', tone: 'amber' },
  forfeit: { label: 'Forfeit', tone: 'rose' },
};

/** Score buckets, as the phone has room for them. Same order as the server's. */
const SPREAD_SHORT = ['<1k', '1–3k', '3–6k', '6–10k', '10k+'];

/* ---------------------------------------------------------------- tooltip -- */

const tip = el('div', 'tip');
document.body.append(tip);

function showTip(event: MouseEvent, lines: [string, string][], title: string): void {
  tip.replaceChildren(el('b', undefined, title));
  for (const [k, v] of lines) {
    tip.append(el('br'), el('span', 'tip__key', `${k} `), document.createTextNode(v));
  }
  tip.dataset['show'] = 'true';
  const w = tip.offsetWidth + 24;
  const x = event.clientX + w > window.innerWidth ? event.clientX - w : event.clientX;
  tip.style.left = `${x}px`;
  tip.style.top = `${event.clientY}px`;
}

const hideTip = (): void => {
  tip.dataset['show'] = 'false';
};

/* ----------------------------------------------------------------- charts -- */

/** A bar rounded at its far end only, so it reads as anchored to the axis. */
function barPath(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.min(r, w / 2, Math.max(h, 0));
  return [
    `M${x} ${y + h}`,
    `V${y + radius}`,
    `a${radius} ${radius} 0 0 1 ${radius} ${-radius}`,
    `h${w - radius * 2}`,
    `a${radius} ${radius} 0 0 1 ${radius} ${radius}`,
    `V${y + h}`,
    'Z',
  ].join(' ');
}

interface Column {
  readonly value: number;
  readonly caption: string;
  /** Used instead of `caption` when the column is too narrow for it. */
  readonly short?: string;
  readonly title: string;
  readonly lines: [string, string][];
  readonly colour?: string;
}

/**
 * Vertical bars over a shared baseline. Drawn at the container's real pixel
 * width (and redrawn when it changes) so the text is real 12 px text rather
 * than a viewBox scaled down to nothing on a phone. A zero is a short tick on
 * the baseline rather than nothing, so an empty day is visibly a day. Every
 * column carries a full-height hit target and a readout.
 */
function columns(data: Column[], colour = 'var(--series)', showValues = false): HTMLElement {
  const host = el('div', 'chart-host');
  const H = 200;
  const PAD_B = 24;
  const PAD_T = showValues ? 22 : 12;

  const draw = (W: number): void => {
    const node = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, width: W, height: H });
    node.setAttribute('role', 'img');
    const max = Math.max(1, ...data.map((d) => d.value));
    const plot = H - PAD_B - PAD_T;
    const step = W / Math.max(1, data.length);
    // A 2px surface gap between neighbours so bars never fuse into a block.
    const width = Math.max(3, Math.min(step - 4, 56));
    const base = PAD_T + plot;
    // Captions: every column when there is room for a label per column, else
    // a thinned axis (every 5th on a wide strip, every 10th on a phone).
    const every = step >= 44 ? 1 : step >= 18 ? 5 : 10;

    for (const frac of [0.5, 1]) {
      const y = PAD_T + plot - plot * frac;
      node.append(svg('line', { class: 'grid-line', x1: 0, x2: W, y1: y, y2: y }));
    }
    node.append(svg('line', { class: 'baseline', x1: 0, x2: W, y1: base, y2: base }));

    data.forEach((d, i) => {
      const h = (d.value / max) * plot;
      const x = i * step + (step - width) / 2;
      const y = base - h;
      const group = svg('g', { class: 'bar-group' });
      group.append(
        svg('rect', { x: i * step, y: 0, width: step, height: H - PAD_B, fill: 'transparent' }),
      );
      if (d.value > 0) {
        group.append(
          svg('path', { class: 'bar', d: barPath(x, y, width, h, 4), fill: d.colour ?? colour }),
        );
      } else {
        group.append(
          svg('line', { class: 'zero', x1: x + 1, x2: x + width - 1, y1: base, y2: base }),
        );
      }
      if (showValues && d.value > 0) {
        const v = svg('text', {
          class: 'value-text',
          x: i * step + step / 2,
          y: y - 6,
          'text-anchor': 'middle',
        });
        v.textContent = fmt(d.value);
        group.append(v);
      }
      const last = i === data.length - 1;
      const labelled = every === 1 || last || (i % every === 0 && data.length - 1 - i >= every / 2);
      if (labelled) {
        const t = svg('text', {
          class: 'axis-text',
          x: i * step + step / 2,
          y: H - 6,
          'text-anchor': last && every > 1 ? 'end' : i === 0 && every > 1 ? 'start' : 'middle',
        });
        if (last && every > 1) t.setAttribute('x', String(Math.min(W, i * step + step)));
        if (i === 0 && every > 1) t.setAttribute('x', '0');
        t.textContent = step < 84 && d.short ? d.short : d.caption;
        group.append(t);
      }
      group.addEventListener('mousemove', (e) => showTip(e, d.lines, d.title));
      group.addEventListener('mouseleave', hideTip);
      node.append(group);
    });
    host.replaceChildren(node);
  };

  let drawn = 0;
  const ro = new ResizeObserver(() => {
    const w = Math.floor(host.clientWidth);
    if (w > 0 && w !== drawn) {
      drawn = w;
      draw(w);
    }
  });
  ro.observe(host);
  return host;
}

interface RowDatum {
  readonly label: string;
  readonly value: number;
  readonly colour?: string;
  readonly note?: string;
}

/**
 * Horizontal rows: label, count and share, and a bar the width of its share
 * of the largest. DOM, not SVG — labels are text of unpredictable length and
 * text layout is what the browser is for.
 */
function rows(data: RowDatum[], colour = 'var(--series)'): HTMLElement {
  const wrap = el('div', 'rows');
  const max = Math.max(1, ...data.map((d) => d.value));
  const total = data.reduce((s, d) => s + d.value, 0);
  for (const d of data) {
    const row = el('div', 'row');
    const label = el('div', 'row__label');
    const dot = el('span', 'dot');
    dot.style.background = d.colour ?? colour;
    label.append(dot, el('span', undefined, d.label));
    const share = total > 0 ? Math.round((d.value / total) * 100) : 0;
    const count = el('div', 'row__count', fmt(d.value));
    count.append(el('small', undefined, d.note ?? `${share}%`));
    const track = el('div', 'row__track');
    const fill = el('div', 'row__fill');
    fill.style.width = `${(d.value / max) * 100}%`;
    fill.style.background = d.colour ?? colour;
    track.append(fill);
    row.append(label, count, track);
    row.addEventListener('mousemove', (e) =>
      showTip(e, [['count', `${fmt(d.value)} · ${share}%`]], d.label),
    );
    row.addEventListener('mouseleave', hideTip);
    wrap.append(row);
  }
  return wrap;
}

/* ------------------------------------------------------------------ cards -- */

function card(title: string, note?: string, span = 12): HTMLElement {
  const node = el('section', `card card--${span}`);
  node.append(el('h2', 'card__title', title));
  if (note) node.append(el('p', 'card__note', note));
  return node;
}

function stat(title: string, value: string, sub: string, tone?: 'gold' | 'mint'): HTMLElement {
  const node = card(title, undefined, 2);
  node.append(
    el('div', `stat__value${tone ? ` stat__value--${tone}` : ''}`, value),
    el('div', 'stat__sub', sub),
  );
  return node;
}

const empty = (message: string): HTMLElement => el('div', 'empty', message);

type Cell = HTMLElement | string;

function table(head: string[], body: Cell[][], numeric: number[] = []): HTMLElement {
  const scroll = el('div', 'scroll');
  const t = el('table');
  const thead = el('thead');
  const hr = el('tr');
  head.forEach((h, i) => hr.append(el('th', numeric.includes(i) ? 'num' : undefined, h)));
  thead.append(hr);
  const tbody = el('tbody');
  for (const cells of body) {
    const tr = el('tr');
    cells.forEach((cell, i) => {
      const td = el('td', numeric.includes(i) ? 'num' : undefined);
      if (typeof cell === 'string') td.textContent = cell;
      else td.append(cell);
      tr.append(td);
    });
    tbody.append(tr);
  }
  t.append(thead, tbody);
  scroll.append(t);
  return scroll;
}

/** Tiers within a rank read as the game shows them: Pebble I … Pebble V. */
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

function rankChip(rank: Rank): HTMLElement {
  const chip = el('span', 'rank-chip');
  const dot = el('span', 'dot');
  dot.style.background = `var(--rank-${Math.min(8, Math.max(0, rank.index))})`;
  chip.append(dot, el('span', undefined, `${rank.name} ${ROMAN[rank.tier] ?? rank.tier}`));
  chip.title = `${rank.name}, tier ${rank.tier}`;
  return chip;
}

function endTag(reason: string): HTMLElement {
  const meta = END[reason];
  return meta
    ? el('span', `tag tag--${meta.tone}`, meta.label)
    : el('span', 'tag tag--dim', reason);
}

/* ------------------------------------------------------------------ shell -- */

const root = document.getElementById('admin-root') as HTMLElement;

function token(): string {
  try {
    return localStorage.getItem(STORE_TOKEN) ?? '';
  } catch {
    return '';
  }
}

function setToken(value: string): void {
  try {
    if (value) localStorage.setItem(STORE_TOKEN, value);
    else localStorage.removeItem(STORE_TOKEN);
  } catch {
    /* a session without storage still works; it just asks every time */
  }
}

function titleNode(): HTMLElement {
  const title = el('h1', 'head__title');
  title.append(el('span', undefined, 'Blockari'), el('span', 'head__word', 'Control'));
  return title;
}

function gate(message?: string, kind: 'error' | 'note' = 'error'): void {
  stopTimer();
  root.replaceChildren();
  const box = el('div', 'gate');
  box.append(
    titleNode(),
    el(
      'p',
      undefined,
      'This dashboard carries player scores, devices and rough locations. It needs the admin key.',
    ),
  );
  const input = el('input');
  input.type = 'password';
  input.placeholder = 'Admin key';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Admin key');
  const button = el('button', 'btn btn--primary', 'Unlock');
  const submit = (): void => {
    const v = input.value.trim();
    if (!v) return;
    setToken(v);
    void load();
  };
  button.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  box.append(input, button);
  if (message) box.append(el('div', kind === 'error' ? 'gate__error' : 'gate__note', message));
  root.append(box);
  input.focus();
}

/* ----------------------------------------------------------------- render -- */

function render(data: Overview): void {
  root.replaceChildren();
  const wrap = el('div', 'wrap');

  /* head */
  const head = el('header', 'head');
  const left = el('div');
  left.append(titleNode(), el('div', 'head__kicker', 'Live operations'));
  const right = el('div', 'head__right');
  const stamp = el('span', 'stamp');
  const time = el('time', undefined, clock(data.generatedAt));
  time.dateTime = data.generatedAt;
  stamp.append(
    document.createTextNode('generated '),
    time,
    document.createTextNode(` · ${ago(data.generatedAt)}`),
  );
  const refresh = el('button', 'btn', 'Refresh');
  refresh.addEventListener('click', () => {
    refresh.disabled = true;
    void load();
  });
  const out = el('button', 'btn', 'Sign out');
  out.addEventListener('click', () => {
    setToken('');
    gate();
  });
  right.append(stamp, refresh, out);
  head.append(left, right);
  wrap.append(head);

  const grid = el('div', 'grid');
  const t = data.totals;

  /* 1 · live operations */
  const liveCard = card('Live operations', undefined, 2);
  const live = el('div', 'live');
  live.append(
    el('span', 'live__dot'),
    el('span', 'stat__value stat__value--mint', fmt(data.live.sessions)),
  );
  liveCard.append(live, el('div', 'stat__sub', 'sessions in Redis'));
  grid.append(liveCard);

  /* 2 · totals */
  grid.append(
    stat('Players', fmt(t.players), `registered · ${fmt(t.guests)} guests`),
    stat('Games played', fmt(t.gamesPlayed), 'finished with at least one piece placed'),
    stat(
      'Best score',
      fmt(t.bestScore),
      `avg ${fmt(t.avgScore)} · best level ${fmt(t.bestLevel)}`,
      'gold',
    ),
    stat('XP awarded', fmt(t.xpAwarded), 'lifetime, every award'),
    stat('$CHAIN staked', fmt(t.chainStaked), 'entry fees on complete challenges'),
  );

  /* 3 · games per day */
  const dayCard = card('Games per day', 'Last 30 days, UTC. A tick is a day with no games.', 8);
  if (data.gamesPerDay.length > 0) {
    dayCard.append(
      columns(
        data.gamesPerDay.map((d) => {
          const date = new Date(`${d.day}T00:00:00Z`);
          const short = date.toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'short',
            timeZone: 'UTC',
          });
          return {
            value: d.games,
            caption: short,
            title: date.toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'long',
              timeZone: 'UTC',
            }),
            lines: [
              ['games', fmt(d.games)],
              ['players', fmt(d.players)],
            ],
          };
        }),
      ),
    );
  } else dayCard.append(empty('No games recorded yet.'));
  grid.append(dayCard);

  /* 4 · how games end */
  const endCard = card('How games end', 'States, each with its word beside the colour.', 4);
  const ends = (['timeout', 'stuck', 'forfeit'] as const).map((k) => ({
    label: END[k]?.label ?? k,
    value: data.howGamesEnd[k],
    colour: `var(--c-${END[k]?.tone ?? 'mint'})`,
  }));
  endCard.append(ends.some((e) => e.value > 0) ? rows(ends) : empty('No games recorded yet.'));
  grid.append(endCard);

  /* 5 · score spread */
  const spreadCard = card('Score spread', 'Every played game, by final score.', 6);
  spreadCard.append(
    data.scoreSpread.some((b) => b.games > 0)
      ? columns(
          data.scoreSpread.map((b, i) => ({
            value: b.games,
            caption: b.label,
            short: SPREAD_SHORT[i] ?? b.label,
            title: b.label,
            lines: [['games', fmt(b.games)]],
          })),
          'var(--series)',
          true,
        )
      : empty('No games recorded yet.'),
  );
  grid.append(spreadCard);

  /* 6 · levels reached */
  const levelCard = card('Levels reached', 'The in-game level a played game ended on.', 6);
  levelCard.append(
    data.levelsReached.some((l) => l.games > 0)
      ? columns(
          data.levelsReached.map((l) => ({
            value: l.games,
            caption: `L${l.level}`,
            title: `Level ${l.level}`,
            lines: [['games', fmt(l.games)]],
          })),
          'var(--series-2)',
          true,
        )
      : empty('No games recorded yet.'),
  );
  grid.append(levelCard);

  /* 7 · ranks */
  const rankCard = card('Ranks', 'Every account on the ladder, Pebble to Legend.', 6);
  rankCard.append(
    data.ranks.some((r) => r.players > 0)
      ? rows(
          data.ranks.map((r, i) => ({
            label: r.rank,
            value: r.players,
            colour: `var(--rank-${Math.min(8, i)})`,
          })),
        )
      : empty('No players yet.'),
  );
  grid.append(rankCard);

  /* 8 · challenge pool */
  const poolCard = card('Challenge pool', 'Every challenge by entry fee and where it stands.', 6);
  const poolTotal = data.challengePool.reduce(
    (s, p) => s + p.open + p.taken + p.complete + p.expired,
    0,
  );
  poolCard.append(
    poolTotal > 0
      ? table(
          ['Fee', 'Open', 'Taken', 'Complete', 'Expired', 'All'],
          data.challengePool.map((p) => [
            el('span', 'score', `${fmt(p.fee)} $CHAIN`),
            fmt(p.open),
            fmt(p.taken),
            fmt(p.complete),
            fmt(p.expired),
            el('span', 'dim', fmt(p.open + p.taken + p.complete + p.expired)),
          ]),
          [1, 2, 3, 4, 5],
        )
      : empty('No challenges yet.'),
  );
  grid.append(poolCard);

  /* 9 · leaderboard */
  const boardCard = card('Leaderboard', 'Top 20 challenge games by score.', 6);
  boardCard.append(
    data.leaderboard.length > 0
      ? table(
          ['#', 'Player', 'Rank', 'Score', 'Level', 'Where', 'Ended'],
          data.leaderboard.map((r, i) => [
            el('span', `pos${i < 3 ? ` pos--${i + 1}` : ''}`, String(i + 1)),
            r.username,
            rankChip(r.rank),
            el('span', 'score', fmt(r.score)),
            String(r.level),
            r.where ? whereText(r.where) : el('span', 'dim', '—'),
            el('span', 'dim', ago(r.endedAt)),
          ]),
          [3, 4],
        )
      : empty('No games recorded yet.'),
  );
  grid.append(boardCard);

  /* 10 · recent games */
  const recentCard = card('Recent games', 'Newest first, challenge and practice alike.', 6);
  recentCard.append(
    data.recentGames.length > 0
      ? table(
          ['Player', 'Score', 'Level', 'Lines', 'Ended', 'Fee', 'When'],
          data.recentGames.map((g) => [
            g.username,
            el('span', 'score', fmt(g.score)),
            String(g.level),
            fmt(g.lines),
            endTag(g.endReason),
            g.fee === null ? el('span', 'dim', 'practice') : `${fmt(g.fee)} $CHAIN`,
            el('span', 'dim', ago(g.endedAt)),
          ]),
          [1, 2, 3],
        )
      : empty('No games recorded yet.'),
  );
  grid.append(recentCard);

  /* 11 · where + devices / systems / browsers */
  const whereCard = card('Where they play', 'Country and region from the address, never finer.', 6);
  whereCard.append(
    data.where.length > 0
      ? rows(
          data.where.map((w) => ({
            label: `${flag(w.country)} ${w.region ? `${w.region}, ` : ''}${w.country}`.trim(),
            value: w.players,
          })),
          'var(--series-3)',
        )
      : empty('No locations resolved yet.'),
  );
  grid.append(whereCard);

  const hw = el('section', 'card card--6');
  hw.style.display = 'grid';
  hw.style.gap = '18px';
  for (const [title, list, colour] of [
    ['Devices', data.devices, 'var(--series)'],
    ['Systems', data.systems, 'var(--series-2)'],
    ['Browsers', data.browsers, 'var(--series-3)'],
  ] as const) {
    const part = el('div');
    part.append(el('h2', 'card__title', title));
    part.append(
      list.length > 0
        ? rows(
            list.map((d) => ({ label: d.name, value: d.players })),
            colour,
          )
        : empty('No clients noted yet.'),
    );
    hw.append(part);
  }
  grid.append(hw);

  wrap.append(grid);
  wrap.append(el('div', 'foot', `Refreshes every ${REFRESH_MS / 1000} s.`));
  root.append(wrap);
}

function whereText(where: string): string {
  // "Region, CC" or "CC" — the code is the last two letters after the comma.
  const code = where.split(', ').at(-1) ?? '';
  const f = flag(code);
  return f ? `${f} ${where}` : where;
}

/* ------------------------------------------------------------------- load -- */

let timer: ReturnType<typeof setTimeout> | null = null;

function stopTimer(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

async function load(): Promise<void> {
  stopTimer();
  const key = token();
  if (!key) {
    gate();
    return;
  }
  try {
    const res = await fetch('/api/admin/overview', { headers: { authorization: `Bearer ${key}` } });
    if (res.status === 401) {
      setToken('');
      gate('That key was not accepted.');
      return;
    }
    if (res.status === 503) {
      gate('Admin API is not configured on this server.', 'note');
      return;
    }
    if (!res.ok) {
      gate(`The server answered ${res.status}.`);
      return;
    }
    render((await res.json()) as Overview);
  } catch {
    gate('Could not reach the server.');
    return;
  }
  timer = setTimeout(() => void load(), REFRESH_MS);
}

document.addEventListener('visibilitychange', () => {
  // A tab that comes back after an hour should not show an hour-old page.
  if (document.visibilityState === 'visible' && token() && !timer) void load();
});

void load();
