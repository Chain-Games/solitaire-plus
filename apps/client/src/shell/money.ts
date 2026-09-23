/**
 * The money visibly moving, in the direction it moves. A stake paid: the
 * balance pill's coin LEAVES — a clone arcs from the pill to the pot card's
 * coin (translate + scale over COIN_FLY_MS, ease-in-out, the mid-point
 * lifted COIN_ARC_PX) while the pill's own coin dims to a ghost (the slot
 * is kept: an empty slot left the number sitting off-centre for the flight
 * — round 53), then the pill pulses and its number counts down. A payout: the toast's coin arcs to the
 * pill, which pulses as its number counts up (App's CountTo tween). DOM
 * only; reduced motion resolves at once.
 */

/** The coin's flight (styles: --coin-fly). */
export const COIN_FLY_MS = 480;
/** The pill's pulse on a landing or a payout (styles: --pill-pulse). */
export const PILL_PULSE_MS = 420;
/** How far above the straight line the flight's mid-point sits. */
const COIN_ARC_PX = 60;
/** The source coin's opacity while its clone is in flight: a dim ghost holding the slot, never a second coin. */
const COIN_GHOST_ALPHA = 0.25;

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The top-bar balance pill, when one is on screen. */
export function balancePill(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.balance');
}

/**
 * Fly a clone of `from` onto `to` along a lifted arc; the source dims to a
 * ghost for the flight (one coin on screen, never two — the ghost only
 * holds the slot). Resolves when it lands (at
 * once without both ends on screen, or under reduced motion). The clone
 * lives on the body above everything, in a fixed box the size of the source.
 */
export function flyCoin(from: Element | null, to: Element | null): Promise<void> {
  if (!from || !to || reducedMotion()) return Promise.resolve();
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  if (a.width === 0 || b.width === 0) return Promise.resolve();
  const clone = from.cloneNode(true) as HTMLElement;
  clone.classList.add('coin-fly');
  clone.setAttribute('aria-hidden', 'true');
  clone.style.left = `${a.left}px`;
  clone.style.top = `${a.top}px`;
  clone.style.width = `${a.width}px`;
  clone.style.height = `${a.height}px`;
  document.body.appendChild(clone);
  const source = from as HTMLElement | SVGElement;
  const sourceOpacity = source.style.opacity;
  source.style.opacity = String(COIN_GHOST_ALPHA);
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  const scale = b.width / a.width;
  const mid = (1 + scale) / 2;
  const anim = clone.animate(
    [
      { transform: 'translate(0, 0) scale(1)' },
      { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - COIN_ARC_PX}px) scale(${mid})` },
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
    ],
    { duration: COIN_FLY_MS, easing: 'cubic-bezier(0.65, 0, 0.35, 1)', fill: 'forwards' },
  );
  return new Promise((resolve) => {
    const done = () => {
      clone.remove();
      source.style.opacity = sourceOpacity;
      resolve();
    };
    anim.addEventListener('finish', done, { once: true });
    anim.addEventListener('cancel', done, { once: true });
  });
}

/** A stake leaving: the pill's coin arcs down to the pot card's coin, then the pill pulses. */
export async function stakeCoin(pot: Element | null): Promise<void> {
  const pill = balancePill();
  await flyCoin(pill?.querySelector('.coin') ?? null, pot);
  if (pill) pulsePill(pill);
}

/** A payout arriving: a coin (the toast's) arcs up to the pill, which pulses as it counts. */
export async function payoutCoin(from: Element | null): Promise<void> {
  const pill = balancePill();
  await flyCoin(from, pill?.querySelector('.coin') ?? null);
  if (pill) pulsePill(pill);
}

/** The pill takes the coin: one scale pulse and an amber lift, then the number moves. */
export function pulsePill(pill: HTMLElement = balancePill() ?? document.body): void {
  if (pill === document.body) return;
  pill.classList.remove('pulse');
  // Restart the animation when it is already running.
  void pill.offsetWidth;
  pill.classList.add('pulse');
  setTimeout(() => pill.classList.remove('pulse'), PILL_PULSE_MS + 40);
}
