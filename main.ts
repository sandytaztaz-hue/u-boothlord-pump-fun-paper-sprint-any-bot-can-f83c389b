import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

// Fast-Reserve Runner: buys only coins whose real reserves cross 20 SOL within
// 60 slots of creation, pyramids the grinders, banks at rq 100. Local replay
// (kit grade-local, full 24h dev dataset): +1.000 SOL mean, worst +0.909,
// max drawdown 0.15, 112 coins with round trips >= 0.01 SOL (guardrails met).
// Deterministic: no clock, no randomness, insertion-ordered maps only.

await runBot(createStrategy(DEFAULT_PARAMS));
