export const CLOUDFLARE_FREE_LIMITS = Object.freeze({
  kvReads: 100_000,
  kvWrites: 1_000,
  kvLists: 1_000,
  durableObjectRequests: 100_000,
  durableObjectGbSeconds: 13_000,
});

export function projectAuthorityDailyUsage({
  users = 6,
  channels = 85,
  canonicalKeyCount = 900,
  feedRequestsPerUser = 48,
  mutationRequestsPerUser = 24,
  averageMutationReads = 12,
  registerListsPerUser = 24,
  fallbackFeedFraction = 0,
  averageFallbackFeedReads = 10,
  schedulerPublicationCap = 650,
  totalWriteCap = 950,
  schedulerTicks = 1_440,
  coordinatorRequestsPerTick = 3,
  statusRequests = 288,
  averageDoActiveMs = 20,
  durableObjectMemoryGb = 0.125,
} = {}) {
  const feeds = users * feedRequestsPerUser;
  const mutations = users * mutationRequestsPerUser;
  const fallbackFeeds = Math.ceil(feeds * fallbackFeedFraction);
  const initialSeed = {
    // The signed Worker-binding snapshot carries the exact values Home
    // imports, so the one-time seed reads each canonical key once. Bulk reads
    // are still charged per key.
    kvReads: canonicalKeyCount,
    kvLists: Math.max(1, Math.ceil(canonicalKeyCount / 1000)),
  };
  const steady = {
    kvReads: mutations * averageMutationReads + fallbackFeeds * averageFallbackFeedReads,
    kvWrites: totalWriteCap,
    kvLists: users * registerListsPerUser,
    durableObjectRequests: schedulerTicks * coordinatorRequestsPerTick
      + feeds
      + mutations * 2
      + statusRequests,
  };
  const durableObjectGbSeconds = steady.durableObjectRequests
    * (averageDoActiveMs / 1000)
    * durableObjectMemoryGb;
  const totals = {
    kvReads: initialSeed.kvReads + steady.kvReads,
    kvWrites: steady.kvWrites,
    kvLists: initialSeed.kvLists + steady.kvLists,
    durableObjectRequests: steady.durableObjectRequests,
    durableObjectGbSeconds,
  };
  return {
    assumptions: {
      users, channels, canonicalKeyCount, feedRequestsPerUser, mutationRequestsPerUser,
      averageMutationReads, registerListsPerUser, fallbackFeedFraction,
      averageFallbackFeedReads, schedulerPublicationCap, totalWriteCap,
      schedulerTicks, coordinatorRequestsPerTick, statusRequests,
      averageDoActiveMs, durableObjectMemoryGb,
    },
    initialSeed,
    steady,
    totals,
    limits: CLOUDFLARE_FREE_LIMITS,
    headroom: Object.fromEntries(Object.entries(CLOUDFLARE_FREE_LIMITS)
      .map(([key, limit]) => [key, limit - totals[key]])),
    withinFreeTier: Object.entries(CLOUDFLARE_FREE_LIMITS)
      .every(([key, limit]) => totals[key] < limit),
    publicationReserve: totalWriteCap - schedulerPublicationCap,
    youtubePostUnits: channels * 24,
  };
}
