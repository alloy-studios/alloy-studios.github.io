"use strict";
/**
 * ABYSSAL DREDGING - Alloy Accounts validator.   Site id: abyssal-dredging.
 *
 * The save is AbyssalDredging.cloudPayload() in index.html:
 *   { v, inv: {itemName: count}, up: {winch, lures, capacity},
 *     life, cores, desc, disc: [itemName] }
 *     inv   - the cargo hold. The five Common items ARE the scrap balance.
 *     up    - upgrade levels.
 *     life  - lifetimeScrapEarned: scrap gained this dive. Pays Pressure Cores
 *             on Descend, then resets to 0.
 *     cores - pressureCores: permanent, +1% luck each. Never resets.
 *     desc  - totalDescents: permanent, sets the rank title. Never resets.
 *     disc  - the Curator's Collection: every non-Common item ever pulled.
 * UI preferences (docks, toggles, auto-scrap setting) stay in local storage
 * and are never sent - they are per-device.
 *
 * DESCEND IS AN HONEST RESET. confirmDescend() zeroes inv, up and life, so
 * those three may fall freely (gain), exactly like Redwater's New Game. Only
 * cores, desc and disc only ever go up (grow / union).
 *
 * ---------------------------------------------------------------------------
 * RATES - derived from index.html, not from feel.
 *
 * Dredges. startDredge() returns while isDredging is true, and a dredge lasts
 *   currentCooldown = getUpgradeValue('winch') = max(500, 5000 - 300 * lvl) ms,
 *   lvl <= 15, so >= 500 ms. stepDredge() compares performance.now() against it
 *   and only calls finishDredge() once p >= 1, so that is 500 ms of REAL time
 *   (a backgrounded tab only slows it).                  => <= 2 dredges / s.
 * Items. rollHaul() runs once per dredge (rolledThisDive) and rolls
 *   getUpgradeValue('capacity') = 1 + lvl <= 11 items.     => <= 22 items / s.
 * Value. Luck only moves PROBABILITY. What an item is worth is fixed: a Common
 *   is 1 scrap, anything else is its tier's crushYield, at most 50,000,000
 *   (ABSOLUTE). Even at infinite luck - every single pull The Depth Itself -
 *   the hold cannot gain value faster than 22 * 50M:
 *                                                => <= 1.1e9 net worth / s.
 *   This is a genuine physical ceiling, not a guess: all three inputs are
 *   constants of the game. It is also far above honest play (max lures and no
 *   Pressure Cores is ~1.9e5 / s), but a long enough prestige run really does
 *   approach it, so it is the right bound and not an inflated one.
 *   What that means in practice: it stops ABSURD jumps (1e15 scrap between two
 *   saves), not small forgeries. Every upgrade maxed costs ~17M and a single
 *   honest Absolute pull pays 50M, so "all upgrades, one second later" is a
 *   legitimate save and is accepted. Nothing tighter is honest.
 *
 * NET WORTH is what is actually checked, not the scrap balance:
 *   net worth = sum(Common counts) + sum(item count * crushYield)
 *             + scrap already spent on the current upgrade levels.
 *   Crushing an item moves crushYield from the item into Rusted Scrap, and
 *   buyUpgrade() moves getUpgradeCost() from scrap into a level, so both leave
 *   net worth exactly unchanged. Only dredging raises it and only Descend
 *   lowers it. So it rises at <= 1.1e9 / s, whatever mix of scrap, items and
 *   upgrades the player holds it in.
 *
 * life only rises in recalcScrap(), when the Common total goes up: +1 per
 *   Common dredged, +crushYield per crush. So it can gain at most the value of
 *   the items the last save held (they may be crushed now) plus whatever was
 *   dredged since, at the net worth rate.
 *
 * desc. Descend needs every upgrade maxed (isFullyUpgraded), which needs scrap,
 *   and confirmDescend() wipes the hold - so after a Descend the next one needs
 *   a dredge to FINISH first. Finishes are >= 500 ms apart, but the one that
 *   was in flight at the Descend can land straight away.
 *                                     => <= 2 per second, plus 2.
 *
 * cores. Each Descend pays floor(sqrt(life / 400)) and resets life. Between
 *   two saves, E seconds apart:
 *   - the FIRST Descend cashes a dive that may have begun long before the last
 *     save: life <= prev.life + prev's items (crushable now) + dredged since.
 *     A 10-hour dive cashed in one interval is honest and must not be clamped.
 *   - every LATER Descend cashes a dive that began inside the interval, one per
 *     dredge finish (<= 2E + 1 of them), each worth <= 0.5 s at the net worth
 *     rate plus the dredge that was in flight (11 * 50M). sqrt is concave, so
 *     many short dives beat few long ones, and the most any one can pay is
 *       sqrt((1.1e9 * 0.5 + 5.5e8) / 400) = 1658.3 cores.
 *   => cores <= prev + floor(sqrt(bank / 400)) + 1659 * (2E + 1).
 *
 * SLACK. elapsedSec is SERVER time between accepted saves. A save's data is
 *   captured when the client flushes it and lands one round-trip later, so a
 *   slow request followed by a fast one can deliver more play than elapsedSec
 *   shows. Every rate below is allowed 10 s of play on top of elapsedSec, and
 *   one full net (11 * 50M) for the dredge in flight when the last save was cut.
 *
 * ABSOLUTE CAPS (the first cloud save, which cannot be rate-checked): one
 *   century of continuous play at the physical ceilings above.
 *
 * ---------------------------------------------------------------------------
 * CLAMP, DON'T REJECT. A rejected save never replaces `prev`, so any Reject an
 * honest save can reach is a silent permanent lockout (see speed-simulator.js).
 * Reject fires only when the save, `inv` or `up` is not a plain object - no
 * build of the game can send that. A single unusable count is dropped; a bad
 * life/cores/desc falls back to the last accepted value; anything merely too
 * big is clamped. Honest paths that must survive: a long offline or guest
 * session followed by sign-in, a very long dive cashed in one Descend, a
 * stale second tab (cores/desc/disc can only be raised back to prev, never
 * lowered), and saving up scrap to spend it all at once.
 *
 * IDEMPOTENT. For every honest save, clean() returns exactly what was sent.
 * The game relies on that: it only adopts a reply that differs from a payload
 * it sent, so an unchanged reply never rolls back play made while in flight.
 */
const { Reject, int, grow, gain } = require("./lib");

/* ------------------------------------------------------------------------
 * The game's own tables, copied from index.html (RARITIES, UPGRADES_DEF)
 * ---------------------------------------------------------------------- */
const COMMON = ["Rusted Scrap", "Dead Kelp", "Waterlogged Boot", "Barnacle Cluster", "Silt Core"];

const TIERS = [
  [50000000, ["The Depth Itself"]],                                                  // ABSOLUTE
  [5000000,  ["Tear of the Abyss", "The Sunken Moon", "Echo of the Genesis"]],       // UNFATHOMABLE
  [1000000,  ["The Drowned Crown", "Whispering Obelisk", "Abyssal Leviathan Spine"]], // ELDRITCH
  [250000,   ["The Heart of the Trench", "Cursed Figurehead", "Phantom Lighthouse"]], // MYTHIC
  [50000,    ["Deep-Trench Pearl", "Petrified Kraken Eye", "Ghost Ship Wheel", "Sunken Throne", "Gilded Megalodon Scale"]], // LEGENDARY
  [8000,     ["Abyssal Angler Lure", "Drowned Sailor's Watch", "Kraken Ink Sac", "Sunken Reliquary", "Cursed Pirate Cutlass", "Bioluminescent Jelly"]], // EPIC
  [1000,     ["Leviathan Tooth", "Glowing Isopod", "Intact Captain's Log", "Phosphorescent Algae"]], // RARE
  [150,      ["Waterlogged Bone", "Sunken Coin", "Blind Cave Fish", "Rusted Anchor", "Tarnished Compass"]], // UNCOMMON
];

/** name -> scrap value. Commons are worth 1: they are the balance itself. */
const VALUE = Object.create(null);
for (const name of COMMON) VALUE[name] = 1;
for (const [y, names] of TIERS) for (const name of names) VALUE[name] = y;

/** Non-Common items, most valuable first - the order a forged hold is cut in. */
const RARE_BY_VALUE = TIERS.flatMap(([, names]) => names);
const RARE = new Set(RARE_BY_VALUE);

const UPGRADES = {
  winch:    { baseCost: 50,  costMult: 1.45, maxLevel: 15 },
  lures:    { baseCost: 60,  costMult: 1.25, maxLevel: 50 },
  capacity: { baseCost: 250, costMult: 1.80, maxLevel: 10 },
};
const UP_IDS = ["winch", "lures", "capacity"];

/** SPENT[id][n] = scrap paid for levels 0..n-1, with getUpgradeCost()'s exact arithmetic. */
const SPENT = {};
for (const id of UP_IDS) {
  const u = UPGRADES[id];
  const acc = [0];
  for (let lvl = 0; lvl < u.maxLevel; lvl++) {
    acc.push(acc[lvl] + Math.floor(u.baseCost * Math.pow(u.costMult, lvl)));
  }
  SPENT[id] = acc;
}

/* ------------------------------------------------------------------------
 * Rates (see the header for the working)
 * ---------------------------------------------------------------------- */
const MIN_DREDGE_SEC = 0.5;                                   // winch floor
const MAX_NET = 11;                                           // capacity 1 + 10
const TOP_VALUE = 50000000;                                   // ABSOLUTE crushYield
const DREDGES_PER_SEC = 1 / MIN_DREDGE_SEC;                   // 2
const ITEMS_PER_SEC = MAX_NET * DREDGES_PER_SEC;              // 22
const WORTH_PER_SEC = ITEMS_PER_SEC * TOP_VALUE;              // 1.1e9
const IN_FLIGHT = MAX_NET * TOP_VALUE;                        // 5.5e8, one full net
const SLACK_SEC = 10;
const WORTH_BURST = IN_FLIGHT + WORTH_PER_SEC * SLACK_SEC;    // 1.155e10
const DESCENTS_PER_SEC = DREDGES_PER_SEC;                     // 2
const DESCENT_BURST = 2 + DESCENTS_PER_SEC * SLACK_SEC;       // 22
const CORES_PER_SHORT_DIVE =
  Math.sqrt((WORTH_PER_SEC * MIN_DREDGE_SEC + IN_FLIGHT) / 400); // 1658.3

/* One century of continuous play at those ceilings - the first-save caps. */
const CENTURY = 100 * 365.25 * 24 * 3600;
const MAX_WORTH = WORTH_PER_SEC * CENTURY;                    // ~3.5e18
const MAX_ITEMS = ITEMS_PER_SEC * CENTURY;                    // ~6.9e10 of any one item
const MAX_DESC = Math.floor(DESCENTS_PER_SEC * CENTURY);
const MAX_CORES = Math.floor(Math.sqrt(MAX_WORTH / 400) + CORES_PER_SHORT_DIVE * (DREDGES_PER_SEC * CENTURY + 1));

/* ------------------------------------------------------------------------ */

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** A finite, non-negative whole number, or null for anything unusable. */
function whole(v) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return Math.floor(v);
}

/** Known items only, count >= 1, capped. Keeps the sender's key order. */
function cleanInv(v) {
  const out = {};
  for (const name of Object.keys(v).slice(0, 64)) {
    if (!(name in VALUE)) continue;
    const n = whole(v[name]);
    if (n === null || n < 1) continue;
    out[name] = Math.min(n, RARE.has(name) ? MAX_ITEMS : MAX_WORTH);
  }
  return out;
}

function cleanUp(v) {
  const out = {};
  for (const id of UP_IDS) out[id] = int(v[id], 0, UPGRADES[id].maxLevel, 0);
  return out;
}

function worth(inv, up) {
  let w = 0;
  for (const name of Object.keys(inv)) w += inv[name] * VALUE[name];
  for (const id of UP_IDS) w += SPENT[id][up[id]];
  return w;
}

/** What the hold's non-Common items would pay if crushed right now. */
function crushable(inv) {
  let w = 0;
  for (const name of Object.keys(inv)) if (RARE.has(name)) w += inv[name] * VALUE[name];
  return w;
}

/**
 * Bring net worth down to `ceiling`. Only a forged save reaches this: the
 * scrap balance goes first (where a forged number lands), then items gained
 * since the last save, most valuable first, then upgrade levels bought since.
 * Nothing is cut below what the last accepted save already held, and that
 * save was itself within its ceiling, so this always terminates within it.
 */
function fitWorth(inv, up, prevInv, prevUp, ceiling) {
  let over = worth(inv, up) - ceiling;
  if (!(over > 0)) return;
  for (const name of COMMON) {
    if (over <= 0) break;
    const have = inv[name] || 0;
    const keep = Math.max(0, have - Math.ceil(over));
    over -= have - keep;
    if (keep > 0) inv[name] = keep; else delete inv[name];
  }
  for (const name of RARE_BY_VALUE) {
    if (over <= 0) break;
    const extra = (inv[name] || 0) - (prevInv[name] || 0);
    if (extra <= 0) continue;
    const cut = Math.min(extra, Math.ceil(over / VALUE[name]));
    inv[name] -= cut;
    over -= cut * VALUE[name];
    if (inv[name] <= 0) delete inv[name];
  }
  for (const id of ["lures", "capacity", "winch"]) {
    while (over > 0 && up[id] > (prevUp[id] || 0)) {
      over -= SPENT[id][up[id]] - SPENT[id][up[id] - 1];
      up[id] -= 1;
    }
  }
}

/** Known non-Common names, de-duplicated, in the sender's order. */
function cleanDisc(v) {
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  for (const name of v.slice(0, 64)) if (typeof name === "string" && RARE.has(name)) seen.add(name);
  return [...seen];
}

/** A previously accepted save, re-normalised so no rule trusts its shape. */
function normalisePrev(p) {
  if (!isObj(p)) return null;
  const inv = isObj(p.inv) ? cleanInv(p.inv) : {};
  const up = isObj(p.up) ? cleanUp(p.up) : cleanUp({});
  return {
    inv, up,
    life: whole(p.life) ?? 0,
    cores: Math.min(whole(p.cores) ?? 0, MAX_CORES),
    desc: Math.min(whole(p.desc) ?? 0, MAX_DESC),
    disc: cleanDisc(p.disc),
  };
}

module.exports = {
  // Worst case - all 39 items at their century caps plus the full Collection -
  // measures 1,900 bytes of JSON. 8 KB is over 4x headroom.
  maxBytes: 8 * 1024,

  clean(prevRaw, next, ctx) {
    ctx = ctx || {};
    if (!isObj(next)) throw new Reject("save is not an object");
    if (!isObj(next.inv)) throw new Reject("bad inv");
    if (!isObj(next.up)) throw new Reject("bad up");

    const prev = normalisePrev(prevRaw);
    const fresh = !prev || !!ctx.first;
    // A missing elapsedSec would turn every ceiling into NaN - treat it as 0.
    const E = Number.isFinite(ctx.elapsedSec) ? Math.max(0, ctx.elapsedSec) : 0;
    const c = Object.assign({}, ctx, { elapsedSec: E });

    const inv = cleanInv(next.inv);
    const up = cleanUp(next.up);

    // --- net worth: falls freely (Descend), rises at <= 1.1e9 / s ---
    const worthCeiling = fresh
      ? MAX_WORTH
      : Math.min(MAX_WORTH, worth(prev.inv, prev.up) + WORTH_PER_SEC * E + WORTH_BURST);
    fitWorth(inv, up, fresh ? {} : prev.inv, fresh ? {} : prev.up, worthCeiling);

    // --- life: falls freely (Descend), rises by the prev hold's crush value + dredging ---
    const lifeSent = whole(next.life);
    const lifeIn = Math.min(lifeSent === null ? (prev ? prev.life : 0) : lifeSent, MAX_WORTH);
    const life = fresh
      ? lifeIn
      : gain(prev.life, lifeIn, WORTH_PER_SEC, c, WORTH_BURST + crushable(prev.inv));

    // --- desc: only up, <= 2 / s ---
    const descSent = whole(next.desc);
    const descIn = Math.min(descSent === null ? (prev ? prev.desc : 0) : descSent, MAX_DESC);
    const desc = fresh ? descIn : grow(prev.desc, descIn, DESCENTS_PER_SEC, c, DESCENT_BURST);

    // --- cores: only up; one long dive cashed now, plus short dives after it ---
    const coresSent = whole(next.cores);
    const coresIn = Math.min(coresSent === null ? (prev ? prev.cores : 0) : coresSent, MAX_CORES);
    let cores = coresIn;
    if (!fresh) {
      const Es = E + SLACK_SEC;
      const bank = prev.life + crushable(prev.inv) + WORTH_PER_SEC * Es + IN_FLIGHT;
      const ceiling = prev.cores
        + Math.floor(Math.sqrt(bank / 400))
        + Math.ceil(CORES_PER_SHORT_DIVE * (DREDGES_PER_SEC * Es + 1));
      cores = Math.max(prev.cores, Math.min(coresIn, ceiling));
    }

    // --- the Collection: never shrinks (a stale tab gets prev's finds back) ---
    const disc = cleanDisc(next.disc);
    if (prev) for (const name of prev.disc) if (!disc.includes(name)) disc.push(name);

    return { v: 1, inv, up, life, cores, desc, disc };
  },

  // Only timer-bound counts. Scrap, net worth and "rare finds" are left out on
  // purpose: their only ceiling is "every pull is The Depth Itself", which an
  // event would let a cheater claim at 1.1e9 / s. See the RATES header.
  events: {
    dredges:  { perSecond: DREDGES_PER_SEC,  burst: 3 },   // one per >= 500 ms winch
    pulls:    { perSecond: ITEMS_PER_SEC,    burst: 33 },  // <= 11 items per dredge
    descents: { perSecond: DESCENTS_PER_SEC, burst: 2 },   // one per dredge finish
  },

  // exported for tests only
  _internal: { worth, crushable, VALUE, SPENT, MAX_WORTH, MAX_ITEMS, MAX_CORES, MAX_DESC, WORTH_PER_SEC, WORTH_BURST },
};
