// Pre-seeded channels
export const DEFAULT_CHANNELS = [
  {
    handle: 'mattdoesartandstuff',
    name: 'MattO',
    channelId: 'UCDZThIzxlU2VzqO4ChHz_xg',
  },
  {
    handle: 'DNDrebeccaAFTG',
    name: 'DND Rebecca AFTG',
    channelId: 'UCZzoiefHjq3WTDorjSUqLfg',
  },
];

export const STORAGE_KEYS = {
  CHANNELS: 'tubepulse_channels',
  SETTINGS: 'tubepulse_settings',
  LAST_SEEN: 'tubepulse_last_seen',
  CHANNEL_CACHE: 'tubepulse_channel_cache',
  GENTLE_NOTIF_STATE: 'tubepulse_gentle_notif_state',
  CHANNEL_NOTIF_SETTINGS: 'tubepulse_channel_notif_settings',
  CHANNEL_DISPLAY_SETTINGS: 'tubepulse_channel_display_settings',
  LAST_RECONCILE_AT: 'tubepulse_last_reconcile_at',
  SEEN_MUTATION_QUEUE: 'tubepulse_seen_mutation_queue_v1',
};

export const NAG_INTERVALS = [
  { label: '5m', value: 5 },
  { label: '15m', value: 15 },
  { label: '30m', value: 30 },
  { label: '1h', value: 60 },
  { label: '2h', value: 120 },
];

export const DEFAULT_SETTINGS = {
  tapAction: 'video',              // 'video' or 'channel'
  autoOrderChannels: false,        // display channels newest-video-first without changing manual order
  notificationMode: 'chill',        // 'relentless' | 'chill'
  nagInterval: 15,                 // minutes between nag attempts (5, 15, 30, 60, 120)
  includeCommunityPosts: false,    // placeholder — not detectable via RSS/WebSub
  dndEnabled: false,
  dndStart: '22:00',
  dndEnd: '07:00',
  perChannelNotifications: false,  // enable per-channel notification overrides
  dndTimezone: 'UTC',              // IANA tz string; overridden at runtime via Intl.DateTimeFormat
  prewarnMinutes: 60,              // minutes before a scheduled livestream to fire a prewarn push (15, 30, 60, 120, 240, 1440)
  latestVideosPerChannel: 1,      // how many recent videos to show per channel on HomeScreen (1, 2, or 3)
};

export const VIDEOS_PER_CHANNEL_OPTIONS = [
  { value: 1, label: '1' },
  { value: 2, label: '2' },
  { value: 3, label: '3' },
];

export const PREWARN_OPTIONS = [
  { value: 15,   label: '15m' },
  { value: 30,   label: '30m' },
  { value: 60,   label: '1h' },
  { value: 120,  label: '2h' },
  { value: 240,  label: '4h' },
  { value: 1440, label: '1d' },
];

export const COLORS = {
  bg: '#0D0D0D',
  surface: '#1A1A1A',
  surfaceTranslucent: 'rgba(26, 26, 26, 0.85)',
  text: '#E0E0E0',
  textDim: '#666666',
  accent: '#4FC3F7',
  accentGlow: 'rgba(79, 195, 247, 0.3)',
  newDot: '#4FC3F7',
  border: '#2A2A2A',
  danger: '#EF5350',
  success: '#66BB6A',
  warning: '#D7A84A',
};
