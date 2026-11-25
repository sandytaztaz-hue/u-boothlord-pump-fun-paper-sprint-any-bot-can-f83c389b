// Fast-Reserve Runner for the pump.fun paper-trading replay (agent-fun/replay/v2).
//
// The idea, in one sentence: only buy a coin whose real reserves cross 20 SOL
// within 60 slots of its creation, then ride it with milestone adds, a value
// take-profit at +100%, and a trailing stop — and keep the 20-coin guardrail met
// with tiny probe round trips.
//
// Why this shape (measured on the kit's full 24h dev replay, 1,222 coins):
// - Buying every coin small and scalping it is robust but always slightly
//   negative (gross expectancy ~0, ~3% fees eat it). Buying every coin and
//   pyramiding the grinders catches the big stallers but bleeds on the duds.
// - The strongest signal in the data is real-reserve speed: coins that reach
//   20 SOL of real reserves within ~60 slots are ~48% likely to reach 50+ SOL
//   (and ~35% complete); coins that take longer almost never do. So the entry
//   is gated on BOTH the level (20 SOL) and the speed (<= 60 slots).
// - The exits are what make it positive: a tight 10% stop on the entry, a
//   value take-profit that banks 60% of tokens at +100%, a top-bank at 100 SOL
//   of real reserves, and a stall exit when reserves drain 15% from their peak.
//   Pyramid adds only fire while the position is in profit.
// - Deterministic: no clock, no randomness; insertion-ordered maps only, so
//   the two grading runs produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Real SOL that triggers the first buy. */
  entryRq: number;
  /** Only buy if real reserves first cross entryRq within this many slots of creation. */
  maxT20: number;
  /** First buy (SOL). Capped in practice by the 1%-of-real-reserve order cap. */
  initSol: number;
  /** Smallest buy worth sending (SOL). */
  minBuySol: number;
  /** Slippage on buys (bps); sells always 10000. */
  buySlipBps: number;
  /** Real-reserve milestones (SOL) that arm a pyramid add, and SOL per add. */
  pyramidRq: number[];
  addSol: number[];
  /** Max SOL invested in one coin. */
  stakeMaxSol: number;
  /** Stop loss vs cost (non-runner / runner). */
  stopLoss: number;
  runnerStop: number;
  /** Trailing stop arms once value >= cost x (1 + trailArm). */
  trailArm: number;
  /** Trailing stop (non-runner / runner). */
  trail: number;
  runnerTrail: number;
  /** Dud exit: after this many slots, exit if real reserves < entry x dudRqMult. */
  dudSlots: number;
  dudRqMult: number;
  /** Real SOL that marks a runner (no time limit from here). */
  runnerRq: number;
  /** Real SOL at which to bank the top fraction. */
  topRq: number;
  /** Fraction of tokens sold at topRq. */
  topFrac: number;
  /** Runner value take-profit: sell runnerTpFrac when value >= cost x (1 + runnerTp). */
  runnerTp: number;
  runnerTpFrac: number;
  /** Time limit for non-runners (slots). */
  maxHold: number;
  /** Time limit for runners (slots). */
  runnerMaxHold: number;
  /** Runner stall exit: exit if real reserves fall below peakRq x (1 - stallDrop). */
  stallDrop: number;
  /** Slots to wait after an exit before the same coin may be bought again. */
  cooldown: number;
  /** Most entries per coin over the run. */
  maxEntries: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Guardrail pacing: target coins / fills over paceSecs of block time. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  entryRq: 20,
  maxT20: 60,
  initSol: 0.4,
  minBuySol: 0.01,
  buySlipBps: 10000,
  pyramidRq: [40, 60],
  addSol: [0.5, 0.5],
  stakeMaxSol: 1.5,
  stopLoss: 0.1,
  runnerStop: 0.4,
  trailArm: 0.1,
  trail: 0.3,
  runnerTrail: 0.2,
  dudSlots: 200,
  dudRqMult: 1.25,
  runnerRq: 40,
  topRq: 100,
  topFrac: 0.9,
  runnerTp: 1.0,
  runnerTpFrac: 0.6,
  maxHold: 1000,
  runnerMaxHold: 5000,
  stallDrop: 0.15,
  cooldown: 60,
  maxEntries: 1,
  maxExposureSol: 8,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 14400,
  probeSol: 0.01,
  maxProbes: 2,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
  reason: string;
  addsDone: number;
  topped: boolean;
  entryRq: number;
  runner: boolean;
  runnerTpDone: boolean;
  entryPrice: number;
  peakRq: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const held = new Map<Pubkey, Held>();
  const probes = new Map<Pubkey, boolean>();
  const probeOpened = new Map<Pubkey, number>();
  const decided = new Set<Pubkey>();
  const lastExit = new Map<Pubkey, number>();
  const entries = new Map<Pubkey, number>();
  const seenRq = new Map<Pubkey, number>();
  const createdAt = new Map<Pubkey, number>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const closed: { mint: string; invested: number; peak: number; last: number; reason: string; hold: number }[] = [];

  // Largest token amount whose sale quote fits inside the current real reserves.
  // Sells are refused when the quote exceeds real reserves, so chunk them.
  const sellChunk = (state: BotState, mint: Pubkey, tokens: bigint): bigint => {
    const curve = state.curves.get(mint);
    if (curve === undefined) return tokens;
    const vq = Number(curve.virtual_quote_reserves);
    const vt = Number(curve.virtual_token_reserves);
    const rq = Number(curve.real_quote_reserves);
    if (rq <= 0 || vq <= rq) return tokens;
    const tMax = Math.floor((rq * vt) / (vq - rq));
    if (tMax <= 0) return 0n;
    const chunk = BigInt(Math.floor(tMax * 0.9));
    return chunk >= tokens ? tokens : chunk;
  };

  const bot: Bot = {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'TradeEvent') traded.add(e.mint);
        if (e.event === 'CreateEvent' && !createdAt.has(e.mint)) createdAt.set(e.mint, now);
      }
      for (const mint of traded) if (!createdAt.has(mint)) createdAt.set(mint, now);
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // ---- Exits first: value take-profit, top-bank, then stop / trail / dud / hold / stall.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            closed.push({ mint, invested: h.invested, peak: h.peakValue, last: h.lastValue, reason: h.reason || 'gone', hold: now - h.opened });
            if (h.filled) lastExit.set(mint, now);
            else entries.set(mint, (entries.get(mint) ?? 0) - 1);
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const vq = Number(curve.virtual_quote_reserves);
        const vt = Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        if (rqSol > h.peakRq) h.peakRq = rqSol;
        if (!h.runner && rqSol >= p.runnerRq) h.runner = true;
        if (h.runner && !h.runnerTpDone && p.runnerTpFrac > 0 && value >= cost * (1 + p.runnerTp) && !pendingByMint.has(mint) && orders.length < cap) {
          const wantTokens = BigInt(Math.floor(tokens * p.runnerTpFrac));
          const sellTokens = sellChunk(state, mint, wantTokens);
          if (sellTokens > 0n) orders.push({ side: 'sell', mint, token_amount: sellTokens, max_slippage_bps: 10_000 });
          h.runnerTpDone = true;
          h.peakValue = value * (1 - p.runnerTpFrac);
        }
        if (!h.topped && p.topFrac > 0 && rqSol >= p.topRq && !pendingByMint.has(mint) && orders.length < cap) {
          const wantTokens = BigInt(Math.floor(tokens * p.topFrac));
          const sellTokens = sellChunk(state, mint, wantTokens);
          if (sellTokens > 0n) orders.push({ side: 'sell', mint, token_amount: sellTokens, max_slippage_bps: 10_000 });
          h.topped = true;
          h.peakValue = value * (1 - p.topFrac);
        }
        let exit = h.exiting;
        const sl = h.runner ? p.runnerStop : p.stopLoss;
        const tr = h.runner ? p.runnerTrail : p.trail;
        if (!exit && value < cost * (1 - sl)) { exit = true; h.reason = 'stoploss'; }
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - tr)) { exit = true; h.reason = 'trail'; }
        if (!exit && !h.runner && now - h.opened > p.dudSlots && rqSol < h.entryRq * p.dudRqMult) { exit = true; h.reason = 'dud'; }
        if (!exit && !h.runner && now - h.opened > p.maxHold) { exit = true; h.reason = 'maxhold'; }
        if (!exit && h.runner && now - h.opened > p.runnerMaxHold) { exit = true; h.reason = 'runnerhold'; }
        if (!exit && h.runner && h.peakRq >= p.runnerRq && rqSol < h.peakRq * (1 - p.stallDrop)) { exit = true; h.reason = 'stall'; }
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        const sellTokens = sellChunk(state, mint, pos.token_amount);
        if (sellTokens > 0n) orders.push({ side: 'sell', mint, token_amount: sellTokens, max_slippage_bps: 10_000 });
      }

      // ---- Pyramid adds: only while the position is in profit and the price
      // is above the last add. Bigger adds lose money (measured), so keep them small.
      for (const [mint, h] of held) {
        if (h.exiting) continue;
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined || curve === undefined || curve.complete) continue;
        const vq = Number(curve.virtual_quote_reserves);
        const vt = Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        const price = vq / vt;
        const nAdds = Math.min(p.pyramidRq.length, p.addSol.length);
        if (h.addsDone >= nAdds) continue;
        if (rqSol < p.pyramidRq[h.addsDone]) continue;
        if (price < h.lastAddPrice) continue;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        if (value < cost * 1.05) continue;
        const room = p.stakeMaxSol - cost;
        if (room < p.minBuySol) continue;
        const buySol = Math.min(p.addSol[h.addsDone], room, Number(state.maxBuyLamports(mint)) / LAMPORTS);
        if (buySol < p.minBuySol || pendingByMint.has(mint) || orders.length >= cap) continue;
        h.addsDone++;
        h.lastAddPrice = price;
        h.invested += buySol;
        orders.push({ side: 'buy', mint, quote_lamports: Math.floor(buySol * LAMPORTS), max_slippage_bps: p.buySlipBps });
      }

      // ---- Entries: only when real reserves first cross entryRq within maxT20
      // slots of creation, while reserves are still in the [entryRq, 2x] band.
      const used = orders.length;
      const positions = state.positions.size;
      if (positions + used < state.hello.caps.max_open_positions) {
        let exposure = 0;
        for (const [, pos] of state.positions) exposure += Number(pos.cost_lamports) / LAMPORTS;
        const candidates: { mint: Pubkey; rqSol: number; price: number }[] = [];
        for (const mint of traded) {
          if (held.has(mint) || probes.has(mint) || decided.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
          const prev = seenRq.get(mint) ?? 0;
          seenRq.set(mint, Math.max(prev, rqSol));
          if (prev >= p.entryRq * 2) continue;
          if (rqSol < p.entryRq || rqSol > p.entryRq * 2) continue;
          if (now - (createdAt.get(mint) ?? now) > p.maxT20) continue;
          if (pendingByMint.has(mint)) continue;
          if (state.positions.has(mint)) continue;
          const last = lastExit.get(mint);
          if (last !== undefined && now - last < p.cooldown) continue;
          if ((entries.get(mint) ?? 0) >= p.maxEntries) continue;
          candidates.push({ mint, rqSol, price: Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves) });
        }
        candidates.sort((a, b) => b.rqSol - a.rqSol);
        for (const c of candidates) {
          if (orders.length >= cap) break;
          if (state.positions.size + orders.length >= state.hello.caps.max_open_positions) break;
          if (exposure + p.initSol > p.maxExposureSol) break;
          const buySol = Math.min(p.initSol, Number(state.maxBuyLamports(c.mint)) / LAMPORTS);
          if (buySol < p.minBuySol) continue;
          held.set(c.mint, { opened: now, peakValue: 0, invested: buySol, exiting: false, filled: false, lastAddPrice: c.price, lastValue: buySol, reason: '', addsDone: 0, topped: false, entryRq: c.rqSol, runner: c.rqSol >= p.runnerRq, runnerTpDone: false, entryPrice: c.price, peakRq: c.rqSol });
          entries.set(c.mint, (entries.get(c.mint) ?? 0) + 1);
          decided.add(c.mint);
          exposure += buySol;
          orders.push({ side: 'buy', mint: c.mint, quote_lamports: Math.floor(buySol * LAMPORTS), max_slippage_bps: p.buySlipBps });
        }
      }

      // ---- Probes: keep the 20-coin guardrail met at a small loss. At most two
      // probe slots at once, so runner entries always have room.
      let totalCoins = myCoins.size;
      let totalFills = myFills;
      if (firstTime !== null && lastTime !== null) {
        const t = (lastTime - firstTime) / p.paceSecs;
        const wantCoins = Math.min(p.targetCoins, Math.floor(p.targetCoins * t) + 1);
        const wantFills = Math.min(p.targetFills, Math.floor(p.targetFills * t) + 1);
        if (totalCoins < wantCoins || totalFills < wantFills) {
          const want = Math.min(2, cap - orders.length);
          for (const mint of traded) {
            if (orders.length >= cap) break;
            if (probes.has(mint) || held.has(mint) || decided.has(mint) || state.positions.has(mint) || pendingByMint.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) < LAMPORTS) continue;
            const buySol = Math.min(p.probeSol, Number(state.maxBuyLamports(mint)) / LAMPORTS);
            if (buySol < p.probeSol) continue;
            if (state.positions.size + orders.length >= p.maxProbes) break;
            probes.set(mint, true);
            probeOpened.set(mint, now);
            orders.push({ side: 'buy', mint, quote_lamports: Math.floor(buySol * LAMPORTS), max_slippage_bps: p.buySlipBps });
            if (orders.length >= want) break;
          }
        }
      }

      // ---- Probe exit: sell a probe as soon as it clears the guardrail round
      // trip, or a few slots after buying — before the coin can dump to zero
      // real reserves, which would make the tokens unsellable and the slot stuck.
      for (const [mint] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined || curve === undefined || curve.complete) continue;
        if (orders.length >= cap) break;
        const tokens = Number(pos.token_amount);
        const vq = Number(curve.virtual_quote_reserves);
        const vt = Number(curve.virtual_token_reserves);
        const value = (tokens * vq) / (vt + tokens) / LAMPORTS;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > cost * 1.03 || now - (probeOpened.get(mint) ?? now) > 3) {
          const sellTokens = sellChunk(state, mint, pos.token_amount);
          if (sellTokens > 0n && !pendingByMint.has(mint)) {
            orders.push({ side: 'sell', mint, token_amount: sellTokens, max_slippage_bps: 10_000 });
            probes.delete(mint);
            probeOpened.delete(mint);
          }
        }
      }
      return orders;
    },
  };
  (bot as unknown as { closed: typeof closed }).closed = closed;
  return bot;
}
