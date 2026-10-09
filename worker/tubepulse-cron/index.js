// tubepulse-cron — DEPRECATED no-op stub
// All work has been moved to sharded workers:
//   tubepulse-rss      — RSS/video polling (per-channel, every minute)
//   tubepulse-posts    — Community post polling (per-channel, every minute)
//   tubepulse-nag      — Legacy nag/reminder rollback path (bounded batch)
//   tubepulse-prewarn  — Prewarn + upcoming drain (every minute)
//
// This worker remains deployed only to keep the old cron schedule
// from firing the heavy combined job. It does nothing.

export default {
  async scheduled(event, env, ctx) {
    console.log('[Cron] DEPRECATED — work moved to shard workers. No-op.');
  },
};
