"use strict";
/**
 * Foil & Fortune: Second Print — Alloy Accounts validator.
 * Game id: tcg-cardshop-simulator   (game file: index.html)
 *
 * THE CLOUD SAVE is a compact copy of the game's state `S`, built by
 * cloudPack() in index.html. Transient things (customers on the floor, litter,
 * the player's position, the open sign) are not synced. Cards travel as
 * tuples, 19 fields each, in this order:
 *
 *   0 id    1 set    2 seed   3 rarity(0-4)  4 element(0-4)  5 chase(0/1)
 *   6 frame 7 finish 8 type(1-12) 9 atk  10 def  11 text(-1..9) 12 flavor(-1..9)
 *   13 power(1-99)  14 cond*100  15 grade(0|6-10)  16 qty  17 day  18 name
 *
 * CLAMP, DON'T REJECT. Reject only fires on data no build of the game can
 * produce: a save that is not an object. Everything else that is out of range
 * is clamped, and a malformed card is dropped. A reachable Reject would be a
 * silent permanent lockout (see speed-simulator.js).
 *
 * NEW GAME is an honest path ("New shop", "Burn it down", eviction) that puts
 * every field back to its starting value, so nothing here is grow(): values
 * may fall freely and only their RISE is rate-limited.
 *
 * ------------------------------------------------------------------ RATES
 * All derived from index.html. Times are real seconds; the game clock only
 * moves inside sim(), which is paused while any modal is open, and each frame's
 * dt is capped at 0.05 s — so game time can run slower than real time, never
 * faster.
 *
 * played   sim() adds the frame's dt, so it rises at most 1 per real second.
 *          => 1 / s, burst 30 (clock slop between client and server).
 *
 * day      Only nextDay() advances it, only from the day report, and the report
 *          only opens from endDay(): at DAY_END, or "Close up early", which
 *          needs tmin >= 12:00. Days start at 8:00 and the clock runs
 *          MIN_PER_SEC = 3.0 game-min/s, x1.6 with the sign turned to closed,
 *          = 4.8 game-min/s. 240 game minutes / 4.8 = 50 s.
 *          => 1 / 50 s, burst 2 (a save loaded at 12:00 can close at once).
 *
 * cash     Money reaches the till three ways.
 *   1. Customers buying stock. spawnGap() is clamped to >= 2.2 s and scaled by
 *      rnd(1.25, 0.8), so arrivals are >= 1.76 s apart = 0.568 / s. Tournaments
 *      add 5 grinders each; an event needs a free table (<= 4), lasts 70 s, and
 *      a new day clears them, which takes >= 50 s: <= 4 events / 50 s = 20
 *      grinders / 50 s = 0.4 / s. Total <= 0.97 customers / s.
 *      A customer cannot spend past their budget. The largest is a whale:
 *      1000 * (0.7 + rep 100 / 120) = 1533. Fast-checkout tips are 5% x the
 *      archetype's tip factor (<= 1.5) = 7.5%. 1533 * 1.075 * 0.97 = 1598
 *      => 1600 / s. Burst: the floor can already hold crowdCap() + 2 = 11
 *      customers when the last save was taken: 11 * 1533 * 1.075 = 18,127
 *      => 18,200.
 *   2. Converting stock the player already owned. A whale pays 1.25x a card's
 *      value, the buylist 0.62x, and a speculator up to 1.28x a sealed carton.
 *      So the allowance also grows by 1.25x the value of every card that left
 *      the save and 1.28x the value of every vault carton that left it, priced
 *      with the same cardValue() the game uses.
 *   3. Packs opened since the last save, whose pulls may already have been
 *      sold before any save saw them. The best a fresh pull can be is a
 *      Golden Relics Secret chase, Deco showcase, Leaf foil, power 99, mint, at
 *      hype 3.2: 150 * 1.964 * 1.85 * 3.2 * 4.4 * 3.6 * 1.8 * 1.05 = 52,213,
 *      = 19,055 after the game's soft knee above 1200; the buylist pays 0.62x
 *      = 11,814 (a whale's budget cannot reach it). The other four cards in a
 *      pack are worth under $50. => $12,000 per opened pack. The auto sorter's
 *      commons are inside that.
 *
 * cards    A card only enters the save from a pack ripped out of the back room
 *          (5 per pack), a walk-in trade (tradeTimer >= 55 s apart), or a
 *          grading return (it was already in `grading`). Packs only reach the
 *          back room from orders or unsealed vault cartons, and orders cost
 *          money: the cheapest pack there is is a Toploaders carton at hype
 *          0.35, 20 * (0.74 + 0.32 * 0.35) / 22 = $0.77 a pack. Orders only
 *          arrive on a day change, so packs bought after the last save count
 *          only when a day has passed, and only as far as its cash allowed.
 *          A pack is "opened" if it left the back room without going onto a
 *          shelf (restocked-then-sold packs count too, which errs generous).
 *          A card already in the save can never change what it IS (set,
 *          seed, rarity, finish...), only its quantity, and its grade once, on
 *          its way back from the grader.
 *
 * hype     Only endDay() changes it: a drift of x0.96..1.05 and, every third
 *          day, a meta shift of x1.4..1.85 up or x0.58..0.8 down. Per day that
 *          is at most x1.9425 up and x0.557 down, inside [0.35, 3.2].
 *
 * level    Needs level*110 XP. XP comes from sales (4 + total/9 per checkout,
 *          so <= 1600/9 + 4*0.97 = 182 / s) plus one-off clicks: a pack (6), an
 *          event (22), a license (28). => 400 XP / s, burst 3,000.
 *
 * ---------------------------------------------------------------- LIMITS
 * Card contents are the one thing a server cannot verify: a pack's pulls come
 * from Math.random() on the player's machine. The checks above bound HOW MANY
 * cards appear and stop a card changing into a better one, but a forged save
 * can still claim its packs were lucky. That only affects the forger's own
 * game — events and leaderboards never read saves.
 */
const { Reject, int, num, bool, str, gain } = require("./lib");

// ------------------------------------------------------- tables (index.html)
const SETS = {                     // id -> [power, carton, packs, tier, showcase mult]
  ember: [1.00, 40, 16, 0, 3.80],
  tide:  [1.10, 56, 16, 1, 3.90],
  root:  [1.18, 72, 16, 2, 3.90],
  gloom: [1.34, 96, 15, 3, 4.20],
  spark: [1.52, 132, 14, 4, 4.60],
  relic: [1.85, 196, 13, 5, 4.40],
};
const SUPPLIES = {                 // id -> [carton, packs, tier]
  sleeve: [26, 20, 0], toploader: [20, 22, 1], binderbox: [44, 18, 2],
};
const ALL_IDS = [...Object.keys(SETS), ...Object.keys(SUPPLIES)];
const TIER = (id) => (SETS[id] ? SETS[id][3] : SUPPLIES[id] ? SUPPLIES[id][2] : 99);
const PACKS = (id) => (SETS[id] ? SETS[id][2] : SUPPLIES[id] ? SUPPLIES[id][1] : 0);
const CARTON = (id) => (SETS[id] ? SETS[id][1] : SUPPLIES[id] ? SUPPLIES[id][0] : 0);

const RARITY_BASE = [0.12, 0.6, 3.0, 24, 150];
const FRAME_MULT = { standard: 1, retro: 1.35, extended: 1.70, borderless: 2.40, showcase: 0 };
const FINISH_MULT = { none: 1, foil: 1.9, relief: 2.4, ripple: 2.7, crackedice: 3.0,
                      moire: 3.1, firework: 3.4, leaf: 3.6 };
const GRADE_MULT = { 6: 0.55, 7: 0.85, 8: 1.25, 9: 2.1, 10: 4.4 };
const TUT_STEPS = 9;

// ------------------------------------------------------------------ rates
const PLAYED_PER_S = 1, PLAYED_BURST = 30;
const DAY_PER_S = 1 / 50, DAY_BURST = 2;
const CASH_PER_S = 1600, CASH_BURST = 18200;
const WHALE_MULT = 1.25, SPEC_MULT = 1.28, PULL_PER_PACK = 12000;
const CHEAPEST_PACK = 0.77, PACK_SLACK = 16;
const START_CASH = 650, START_PACKS = 10;   // newGame(): $650, 6 Ember + 4 Sleeves
const TRADE_EVERY_S = 55;
const XP_PER_S = 400, XP_BURST = 3000;
const HYPE_UP = 1.9425, HYPE_DOWN = 0.557, HYPE_MIN = 0.35, HYPE_MAX = 3.2;

// --------------------------------------------------------------- helpers
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const list = (v) => (Array.isArray(v) ? v : []);
const r2 = (n) => Math.round(n * 100) / 100;

/** The game's own cardValue(), on a cleaned card. */
function cardValue(c, hype) {
  const set = SETS[c.set];
  let v = RARITY_BASE[c.r] * (0.55 + c.power / 70) * set[0] * hype;
  v *= c.frame === "showcase" ? set[4] : FRAME_MULT[c.frame];
  v *= FINISH_MULT[c.finish];
  if (c.chase) v *= 1.8;
  v *= c.grade ? GRADE_MULT[c.grade] : 0.7 + (c.cond / 100) * 0.35;
  if (v > 1200) v = 1200 + (v - 1200) * 0.35;
  return Math.max(0.25, v);
}

/** One card tuple -> a cleaned card object, or null if it is not a card. */
function readCard(t) {
  if (!Array.isArray(t) || t.length < 19) return null;
  const id = str(t[0], 24);
  if (!id || !SETS[t[1]] || FRAME_MULT[t[6]] === undefined || FINISH_MULT[t[7]] === undefined) return null;
  const r = int(t[3], 0, 4, 0);
  const g = int(t[15], 0, 10, 0);
  let name = t[18];
  if (typeof name === "string") name = name.slice(0, 40);
  else name = int(name, -1, 1199, 0);
  return {
    id, set: t[1], seed: int(t[2], 0, 4294967295, 0), r,
    el: int(t[4], 0, 4, 0),
    chase: r === 4 && (t[5] === 1 || t[5] === true) ? 1 : 0,     // makeCard: chase only on a Secret
    frame: t[6],
    finish: t[7] === "leaf" && t[6] !== "showcase" ? "moire" : t[7], // rollFinish: leaf only on showcase
    type: int(t[8], 1, 12, 12), atk: int(t[9], 0, 9, 0), def: int(t[10], 0, 10, 0),
    text: int(t[11], -1, 9, 0), flavor: int(t[12], -1, 9, 0),
    power: int(t[13], 1, 99, 1), cond: int(t[14], 0, 100, 55),
    grade: g >= 6 ? g : 0, qty: int(t[16], 1, 9999, 1), day: int(t[17], 1, 1e6, 1), name,
  };
}
const IDENTITY = ["set", "seed", "r", "el", "chase", "frame", "finish", "type", "atk", "def",
                  "text", "flavor", "power", "cond", "day", "name"];
const writeCard = (c) => [c.id, c.set, c.seed, c.r, c.el, c.chase, c.frame, c.finish, c.type,
  c.atk, c.def, c.text, c.flavor, c.power, c.cond, c.grade, c.qty, c.day, c.name];

/** Every card unit in a save, by id: binder and grader together. */
function unitsOf(cards, grading) {
  const m = new Map();
  for (const c of cards) m.set(c.id, { c, n: (m.get(c.id)?.n || 0) + c.qty });
  for (const g of grading) m.set(g.c.id, { c: g.c, n: (m.get(g.c.id)?.n || 0) + g.c.qty });
  return m;
}
const packsIn = (back) => Object.values(back).reduce((a, b) => a + b, 0);

module.exports = {
  // A long-time player's binder can run to thousands of distinct cards. At
  // ~95 bytes a card the client packs the most valuable ones first and stops at
  // 240 KB (CLOUD_BUDGET in index.html), so an honest save never reaches this.
  maxBytes: 256 * 1024,

  clean(prev, next, ctx) {
    ctx = ctx || {};
    if (!next || typeof next !== "object" || Array.isArray(next)) throw new Reject("not a save");
    const p = prev && typeof prev === "object" && !ctx.first ? prev : null;
    const t = Number.isFinite(ctx.elapsedSec) ? Math.max(0, ctx.elapsedSec) : 0;
    const rc = Object.assign({}, ctx, { elapsedSec: t });

    // --- time --------------------------------------------------------------
    let played = int(next.played, 0, 1e9, 0);
    if (p) played = gain(int(p.played, 0, 1e9, 0), played, PLAYED_PER_S, rc, PLAYED_BURST);
    let day = int(next.day, 1, 1e6, 1);
    if (p) day = gain(int(p.day, 1, 1e6, 1), day, DAY_PER_S, rc, DAY_BURST);
    const sameRun = !!p && day >= int(p.day, 1, 1e6, 1);   // day only falls on a New Game
    const daysOn = sameRun ? day - int(p.day, 1, 1e6, 1) : day - 1;

    // --- level / xp --------------------------------------------------------
    let level = int(next.level, 1, 1000, 1);
    if (p && level > int(p.level, 1, 1000, 1)) {
      let L = int(p.level, 1, 1000, 1), b = num(p.xp, 0, 1e9, 0) + XP_PER_S * t + XP_BURST;
      while (L < level && b >= L * 110) { b -= L * 110; L++; }
      level = L;
    }
    const xp = num(next.xp, 0, level * 110, 0);

    // --- hype: only endDay() moves it ------------------------------------
    const hypeIn = obj(next.hype), hypeRef = sameRun ? obj(p.hype) : {}, hype = {};
    for (const id of ALL_IDS) {
      let h = num(hypeIn[id], HYPE_MIN, HYPE_MAX, 1);
      if (p) {
        const ref = num(hypeRef[id], HYPE_MIN, HYPE_MAX, 1), d = daysOn + 1;   // +1: see header
        h = Math.min(Math.max(h, ref * Math.pow(HYPE_DOWN, d)), ref * Math.pow(HYPE_UP, d));
      }
      hype[id] = Math.round(h * 1000) / 1000;
    }
    const hypePrevIn = obj(next.hypePrev), hypePrev = {};
    for (const id of ALL_IDS) hypePrev[id] = Math.round(num(hypePrevIn[id], HYPE_MIN, HYPE_MAX, 1) * 1000) / 1000;
    const priceHype = (id) => Math.max(hype[id] || 1, num(obj(p && p.hype)[id], HYPE_MIN, HYPE_MAX, 1));

    // --- licenses: bought at level >= tier; ember and sleeves come free --
    const licenses = [...new Set(["ember", "sleeve", ...list(next.licenses)
      .filter((k) => ALL_IDS.includes(k) && TIER(k) <= level)])];

    // --- the shop itself -------------------------------------------------
    const shelfCount = int(next.shelfCount, 4, 8, 4);
    const tableCount = int(next.tableCount, 1, 4, 1);
    const expansion = int(next.expansion, 0, 3, 0);
    const caseCap = 4 + 2 * expansion;                  // buySpace("case") adds both at once
    const staffIn = obj(next.staff), upgIn = obj(next.upg);
    const staff = { stocker: bool(staffIn.stocker), cashier: bool(staffIn.cashier), janitor: bool(staffIn.janitor) };
    const upg = { lamps: bool(upgIn.lamps), ac: bool(upgIn.ac), mat: bool(upgIn.mat), machine: bool(upgIn.machine) };

    // --- stock: orders, vault, shelves, back room ------------------------
    const pending = list(next.pending).slice(0, 64).map(obj)
      .filter((o) => ALL_IDS.includes(o.set))
      .map((o) => ({ set: o.set, packs: PACKS(o.set), cost: num(o.cost, 0, 1e5, 0),
                     sealed: bool(o.sealed) && !!SETS[o.set] }));
    const vault = list(next.vault).slice(0, 4).map(obj).filter((v) => SETS[v.set]).map((v) => {
      const age = int(v.age, 0, Math.max(0, day - 1), 0);
      const cap = CARTON(v.set) * (0.74 + 0.32 * HYPE_MAX) * (1 + age * 0.035);
      return { set: v.set, packs: PACKS(v.set), age, val: Math.round(num(v.val, 0, cap, 0)) };
    });
    const shelves = list(next.shelves).slice(0, 8).map(obj).map((s) => {
      const prod = licenses.includes(s.prod) ? s.prod : null;
      return { prod, qty: prod ? int(s.qty, 0, 24, 0) : 0, cap: 24,
               price: prod && s.price != null ? r2(num(s.price, 0.5, 1e5, 1)) : null };
    });
    while (shelves.length < 8) shelves.push({ prod: null, qty: 0, cap: 24, price: null });

    const backIn = obj(next.back), back = {};
    for (const id of ALL_IDS) { const n = int(backIn[id], 0, 1e5, 0); if (n) back[id] = n; }

    // Stock that could have reached the back room since the last save, and
    // how many packs left it without going onto a shelf (see header).
    let packsOpened = 0, packsForCards = 0;
    let cashAllowance = CASH_PER_S * t + CASH_BURST;
    if (p) {
      const pb = obj(p.back);
      const prevBack = ALL_IDS.reduce((a, id) => a + int(pb[id], 0, 1e5, 0), 0);
      const shelfQty = (sh) => list(sh).reduce((a, x) => a + int(obj(x).qty, 0, 24, 0), 0);
      const prevShelf = shelfQty(p.shelves), nextShelf = shelfQty(shelves);
      const arrived = (daysOn > 0 ? list(p.pending).reduce((a, o) => a + PACKS(obj(o).set), 0) : 0) +
                      list(p.vault).reduce((a, v) => a + PACKS(obj(v).set), 0) +
                      (sameRun ? 0 : START_PACKS);
      const bought = daysOn > 0 ? Math.max(0, num(p.cash, -1e7, 1e13, 0) + cashAllowance) / CHEAPEST_PACK : 0;
      const cap = prevBack + prevShelf + arrived + bought + PACK_SLACK;
      let total = packsIn(back);
      if (total > cap) {                       // scale every stack down to fit
        const k = cap / total;
        for (const id of Object.keys(back)) back[id] = Math.floor(back[id] * k);
        total = packsIn(back);
      }
      packsOpened = Math.max(0, prevBack + arrived - total - Math.max(0, nextShelf - prevShelf));
      packsForCards = packsOpened + bought + PACK_SLACK;
    }

    // --- cards -----------------------------------------------------------
    const prevCards = p ? list(p.cards).map(readCard).filter(Boolean) : [];
    const prevGrading = p ? list(p.grading).map((g) => ({ c: readCard(list(g)[0]) })).filter((g) => g.c) : [];
    const before = unitsOf(prevCards, prevGrading);
    const wasGrading = new Set(prevGrading.map((g) => g.c.id));

    const lock = (c) => {                      // a card may not turn into a better one
      const old = before.get(c.id);
      if (!old) return c;
      for (const k of IDENTITY) c[k] = old.c[k];
      if (!(wasGrading.has(c.id) && old.c.grade === 0)) c.grade = old.c.grade;
      return c;
    };
    const seen = new Set();
    const once = (c) => (c && !seen.has(c.id) ? (seen.add(c.id), true) : false);
    let cards = list(next.cards).slice(0, 5000).map(readCard).filter(once).map(lock);
    let grading = list(next.grading).slice(0, 64).map((g) => {
      const c = readCard(list(g)[0]);
      return c && once(c) ? { c: lock(Object.assign(c, { grade: 0 })), days: int(list(g)[1], 0, 3, 3) } : null;
    }).filter(Boolean);

    if (p) {
      // New card units since the last save, and what the game could have produced.
      const after = unitsOf(cards, grading);
      const fresh = [];                        // [card, extra units]
      for (const [id, a] of after) {
        const extra = a.n - (before.get(id)?.n || 0);
        if (extra > 0) fresh.push([a.c, extra]);
      }
      let allowance = 5 * packsForCards + wasGrading.size + Math.floor(t / TRADE_EVERY_S) + 1 + 10;
      // Keep the cheapest new units; anything past the allowance goes.
      fresh.sort((x, y) => cardValue(x[0], priceHype(x[0].set)) - cardValue(y[0], priceHype(y[0].set)));
      const cut = new Map();
      for (const [c, extra] of fresh) {
        const keep = Math.min(extra, Math.max(0, allowance));
        allowance -= keep;
        if (keep < extra) cut.set(c.id, extra - keep);
      }
      if (cut.size) {
        for (const c of cards) if (cut.has(c.id)) {
          const k = Math.min(c.qty, cut.get(c.id)); c.qty -= k; cut.set(c.id, cut.get(c.id) - k);
        }
        cards = cards.filter((c) => c.qty > 0);
        grading = grading.filter((g) => !(cut.get(g.c.id) > 0));
      }

      // Stock that left the save may have been sold.
      const now = unitsOf(cards, grading);
      let sold = 0;
      for (const [id, b] of before) {
        const gone = b.n - (now.get(id)?.n || 0);
        if (gone > 0) sold += gone * cardValue(b.c, priceHype(b.c.set)) * WHALE_MULT;
      }
      const vaultGone = Math.max(0, list(p.vault).reduce((a, v) => a + num(obj(v).val, 0, 1e7, 0), 0) -
                                    vault.reduce((a, v) => a + v.val, 0));
      cashAllowance += sold + vaultGone * SPEC_MULT + PULL_PER_PACK * packsOpened;
    }

    const kept = new Set(cards.map((c) => c.id));
    const caseIds = [...new Set(list(next.case).filter((id) => kept.has(id)))].slice(0, caseCap);

    // --- cash --------------------------------------------------------------
    let cash = num(next.cash, -1e7, 1e13, 0);
    // A New Game (eviction included) starts at $650 however deep the debt was.
    if (p) cash = gain(Math.max(num(p.cash, -1e7, 1e13, 0), sameRun ? -1e7 : START_CASH),
                       cash, 0, rc, cashAllowance);
    cash = r2(cash);

    // --- display-only records ----------------------------------------------
    const st = obj(next.stats), lg = obj(next.ledger);
    return {
      v: 1,
      played, day, tmin: int(next.tmin, 480, 1260, 480),
      cash, rep: num(next.rep, 0, 100, 44), clean: num(next.clean, 0, 100, 100),
      level, xp,
      licenses, shelfCount, tableCount, expansion, caseCap, vaultCap: 4, staff, upg,
      hype, hypePrev, back, vault, pending, shelves,
      cards: cards.map(writeCard),
      grading: grading.map((g) => [writeCard(g.c), g.days]),
      case: caseIds,
      stats: {
        sold: int(st.sold, 0, 1e9, 0), lost: int(st.lost, 0, 1e9, 0),
        revenue: r2(num(st.revenue, 0, 1e13, 0)), ripped: int(st.ripped, 0, 1e9, 0),
        best: r2(num(st.best, 0, 1e6, 0)),
      },
      ledger: {
        sales: r2(num(lg.sales, 0, 1e13, 0)), restock: r2(num(lg.restock, 0, 1e13, 0)),
        rent: r2(num(lg.rent, 0, 1e9, 0)), wages: r2(num(lg.wages, 0, 1e9, 0)),
        upkeep: r2(num(lg.upkeep, 0, 1e9, 0)),
      },
      rentDue: int(next.rentDue, 0, 1e8, 64), streak: int(next.streak, 0, 4, 0), over: bool(next.over),
      tut: int(next.tut, 0, TUT_STEPS, 0), tutOff: bool(next.tutOff),
      tutWalk: int(next.tutWalk, 0, 1e7, 0), tutPriced: bool(next.tutPriced),
    };
  },

  // Metrics with a ceiling set by the game's own timers (working in the header
  // and below). Not declared: cash, cards, packs ripped. Money compounds, a
  // pack's contents are random, and ripping is bound by clicks, not a timer.
  events: {
    // Arrivals >= 1.76 s apart (0.568/s) + tournament grinders (0.4/s) = 0.97/s.
    // Burst: a full floor of crowdCap() + 2 = 11 already queued.
    customersServed: { perSecond: 1, burst: 12 },
    // A table runs one event for 70 s and a new day (>= 50 s) clears them; 4 tables.
    tournaments: { perSecond: 4 / 50, burst: 4 },
    // One day per >= 50 s of real time.
    days: { perSecond: 1 / 50, burst: 2 },
  },
};
