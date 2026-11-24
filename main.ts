// Pump.fun Paper Sprint — launch-snipe bot (own design).
//
// Idea, from the dev-window data (24h, 2-3 Nov 2026, 1,222 coins):
//   * Blindly buying launches loses on every delay/hold combo; the pump is in the
//     first ~500 slots and then the median coin dumps ~-16% to end of window.
//   * The only profile near breakeven is a launch snipe: buy within a few slots of
//     create, filter out bundled/ruggy launches, exit fast on a small take-profit
//     or a tight stop. The shipped sniper baseline scores about -0.42 SOL on the
//     dev window with the guardrails met; this bot keeps that shape but adds a
//     partial take-profit + trailing stop so a rare runner is not capped at +15%.
//   * Buying coins that already crossed 30 SOL of real reserves does NOT work:
//     the 2-slot fill latency eats the move (verified: the apparent +11.8 SOL edge
//     collapses to -6.3 SOL once buys are priced 2 slots after the signal).
//   * No completion filter predicts a migration (33% base rate; "hot" coins do
//     worse), so this bot does not chase completions.
//
// Protocol: the harness sends hello, then one batch per slot, then done. Each
// batch carries that slot's events, marks for held/pending curves, fills, and
// the account. Orders decided on the batch for slot s fill at slot s + 2.
// Replies are one JSON line per batch with the orders for that slot.

import { runBot, LAMPORTS_PER_SOL, type BotState, type Batch, type OrderInput } from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- config
// All tuning lives here. The sweep varies takeProfitBps / stopLossBps /
// maxHoldSlots / tp1Bps / trailArmBps; the flat region wins, not the best cell.
const CFG = {
  stakeLamports: 20_000_000n, // 0.02 SOL target stake per coin (swept: smaller is less negative)
  maxAgeSlots: 3, // buy only while first seen within 3 slots of create
  buyWindowSlots: 6, // keep topping the stake up for this many slots after create
  minRealSol: 0.3, // real SOL seen at first sight: skip dust launches ...
  maxRealSol: 30, // ... and skip coins that already ran far
  maxDevBuySol: 2.5, // creator's own buys so far (SOL); more smells like a bundle
  maxBuyers: 1, // distinct non-creator buyers so far; more smells like a bundle (swept: 1 beats 2 and 3)
  maxRunupBps: 1_000_000, // vs create price at first sight; huge = filter off
  takeProfitBps: 1500, // sell all at +15% vs cost basis
  stopLossBps: 1200, // sell all at -12% vs cost basis
  maxHoldSlots: 10, // sell all this many slots after the position opened
  tp1Bps: 0, // 0 = off; sell a slice at this gain, then trail the rest
  tp1SellBps: 5000, // slice sold at tp1 (50% of tokens)
  trailArmBps: 0, // 0 = off; arm the trailing stop once price is up this much
  trailDropBps: 1000, // once armed, sell all if price falls this much from peak
  maxSlippageBps: 500,
  maxOpenPositions: 5,
} as const;

const SOL = 1_000_000_000n;

// ---------------------------------------------------------------- per-coin tracking
// BotState.curves knows reserves but not who traded, so we track launch quality
// ourselves from the batch events (hello/batch/orders/slot flow below).
interface Coin {
  mint: string;
  createdSlot: number;
  createPrice: number; // virtual quote / virtual token at create
  devBuyLamports: bigint;
  devSold: boolean;
  buyers: Set<string>;
  firstSeenSlot: number;
  firstRealSol: number;
  spentLamports: bigint; // buys sent (incl. pending) toward the stake target
  entrySlot: number; // slot the position first appeared, 0 = not open yet
  peakPrice: number; // highest price seen while holding (for the trailing stop)
  tp1Done: boolean;
  trailingArmed: boolean;
  exited: boolean; // bought and sold (or completed): never re-enter
}

const coins = new Map<string, Coin>();

function priceOf(vq: bigint, vt: bigint): number {
  if (vt <= 0n) return 0;
  return Number(vq) / Number(vt);
}

function coinPrice(state: BotState, mint: string): number {
  const c = state.curves.get(mint);
  if (!c) return 0;
  return priceOf(c.virtual_quote_reserves, c.virtual_token_reserves);
}

function solOf(lamports: bigint): number {
  return Number(lamports) / 1e9;
}

// Fold one batch's events into the per-coin launch records. Runs before any
// order decision on that slot, so entry filters see this slot's trades.
function observeEvents(state: BotState, batch: Batch): void {
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      if (!coins.has(e.mint)) {
        coins.set(e.mint, {
          mint: e.mint,
          createdSlot: e.slot,
          createPrice: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
          devBuyLamports: 0n,
          devSold: false,
          buyers: new Set(),
          firstSeenSlot: e.slot,
          firstRealSol: 0,
          spentLamports: 0n,
          entrySlot: 0,
          peakPrice: 0,
          tp1Done: false,
          trailingArmed: false,
          exited: false,
        });
      }
    } else if (e.event === 'TradeEvent') {
      const c = coins.get(e.mint);
      if (!c) continue;
      if (e.user === e.creator) {
        if (e.is_buy) c.devBuyLamports += BigInt(e.sol_amount);
        else c.devSold = true;
      } else if (e.is_buy) {
        c.buyers.add(e.user);
      }
    } else if (e.event === 'CompleteEvent') {
      const c = coins.get(e.mint);
      if (c) c.exited = true;
    }
  }
}

// A coin is buyable only while it is a fresh launch that still looks clean.
function entryFilter(state: BotState, c: Coin, slot: number): boolean {
  if (c.exited) return false;
  if (state.positions.has(c.mint)) return false;
  if (c.spentLamports >= CFG.stakeLamports) return false;
  // The 3-slot age gate applies to the FIRST buy only; topping a partial
  // stake up is allowed until the buy window closes, else the pacing loop
  // could never finish a fill that started at slot 1.
  if (c.spentLamports === 0n && slot - c.createdSlot > CFG.maxAgeSlots) return false;
  if (slot - c.createdSlot > CFG.buyWindowSlots) return false;
  const curve = state.curves.get(c.mint);
  if (!curve || curve.complete) return false;
  const realSol = solOf(curve.real_quote_reserves);
  if (realSol < CFG.minRealSol || realSol > CFG.maxRealSol) return false;
  if (solOf(c.devBuyLamports) > CFG.maxDevBuySol) return false;
  if (c.devSold) return false;
  if (c.buyers.size > CFG.maxBuyers) return false;
  const now = coinPrice(state, c.mint);
  if (c.createPrice > 0 && now > c.createPrice * (1 + CFG.maxRunupBps / 10000)) return false;
  return true;
}

// Buy a slice of the stake target for one coin, capped by the harness rule
// (buys on one mint in one reply may spend at most 1% of its real SOL
// reserve) and by free cash. Returns the order, or null when nothing to buy.
function buyOrder(state: BotState, c: Coin): OrderInput | null {
  const remaining = CFG.stakeLamports - c.spentLamports;
  if (remaining <= 0n) return null;
  const cap = state.maxBuyLamports(c.mint);
  if (cap <= 0n) return null;
  let amount = remaining < cap ? remaining : cap;
  const free = state.freeCashLamports();
  if (free <= 0n) return null;
  if (amount > free) amount = free;
  if (amount < 10_000_000n) return null; // below 0.01 SOL a round trip cannot count
  c.spentLamports += amount;
  return { side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: CFG.maxSlippageBps };
}

// ---------------------------------------------------------------- exits
// One sell per mint per batch at most (a pending sell blocks a second one:
// the harness would reject the oversell as insufficient_tokens anyway).
function hasPendingSell(state: BotState, mint: string): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === 'sell') return true;
  }
  return false;
}

// Decide the exit for one held position. Returns a sell order or null.
// Priority: creator sold -> stop-loss -> take-profit (or its partial) ->
// trailing stop -> max hold. The partial (tp1) sells a slice and arms the
// trailing stop so the rest can ride a runner instead of capping at +15%.
function exitOrder(state: BotState, mint: string, slot: number): OrderInput | null {
  const pos = state.positions.get(mint);
  if (!pos || pos.token_amount <= 0n) return null;
  if (hasPendingSell(state, mint)) return null;
  const c = coins.get(mint);
  const now = coinPrice(state, mint);
  if (now <= 0) return null;
  const entry = Number(pos.cost_lamports) / Number(pos.token_amount);
  if (entry <= 0) return null;
  if (c) {
    if (c.entrySlot === 0) {
      c.entrySlot = slot;
      c.peakPrice = now;
    }
    if (now > c.peakPrice) c.peakPrice = now;
  }
  const sellAll = (): OrderInput => {
    if (c) c.exited = true;
    return { side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: CFG.maxSlippageBps };
  };
  // Creator dumping their own launch is the strongest exit signal.
  if (c && c.devSold) return sellAll();
  if (now <= entry * (1 - CFG.stopLossBps / 10000)) return sellAll();
  if (CFG.tp1Bps > 0 && c && !c.tp1Done && now >= entry * (1 + CFG.tp1Bps / 10000)) {
    c.tp1Done = true;
    c.trailingArmed = true;
    const slice = (pos.token_amount * BigInt(CFG.tp1SellBps)) / 10000n;
    if (slice > 0n && slice < pos.token_amount) {
      return { side: 'sell', mint, token_amount: slice, max_slippage_bps: CFG.maxSlippageBps };
    }
    return sellAll();
  }
  if (now >= entry * (1 + CFG.takeProfitBps / 10000)) return sellAll();
  if (c) {
    if (CFG.trailArmBps > 0 && !c.trailingArmed && now >= entry * (1 + CFG.trailArmBps / 10000)) {
      c.trailingArmed = true;
    }
    if (c.trailingArmed && now <= c.peakPrice * (1 - CFG.trailDropBps / 10000)) return sellAll();
    if (c.entrySlot > 0 && slot - c.entrySlot >= CFG.maxHoldSlots) return sellAll();
  }
  return null;
}

// ---------------------------------------------------------------- the batch loop
// One batch = one slot of market data. Fold its events in, exit what must go,
// then snipe fresh launches while a position slot is free. Everything here is
// a pure function of the hello/batch stream, so two runs on the same data
// produce identical orders.
async function onBatch(state: BotState, batch: Batch): Promise<OrderInput[]> {
  observeEvents(state, batch);
  const orders: OrderInput[] = [];
  const slot = batch.slot;

  for (const mint of state.positions.keys()) {
    const o = exitOrder(state, mint, slot);
    if (o) orders.push(o);
  }

  if (state.committedPositionCount() < CFG.maxOpenPositions) {
    for (const c of coins.values()) {
      if (orders.length >= 16) break;
      if (state.committedPositionCount() >= CFG.maxOpenPositions) break;
      if (!entryFilter(state, c, slot)) continue;
      const o = buyOrder(state, c);
      if (o) orders.push(o);
    }
  }
  return orders;
}

await runBot({
  onHello(state) {
    console.error(
      `hello: capital=${solOf(BigInt(state.hello.capital.lamports))} SOL ` +
        `maxPos=${state.hello.caps.max_open_positions} latency=${state.hello.latency_slots} ` +
        `seed=${state.hello.seed}`,
    );
  },
  onBatch,
  onDone(state) {
    console.error(
      `done: cash=${solOf(state.cash)} SOL positions=${state.positions.size} ` +
        `coinsSeen=${coins.size}`,
    );
  },
});
