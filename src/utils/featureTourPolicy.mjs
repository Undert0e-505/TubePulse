export const FEATURE_TOUR_VERSION = 1;

export const FEATURE_TOUR_HOME_ROUTE = 'Home';

export const FEATURE_TOUR_STEPS = Object.freeze([
  Object.freeze({
    id: 'home-channels', route: 'Home', target: 'homeChannels', title: 'Make TubePulse yours',
    body: 'Channels is where you manage the YouTube channels TubePulse follows for you.',
  }),
  Object.freeze({
    id: 'channels-add', route: 'Channels', target: 'channelsAdd', title: 'Add a channel',
    body: 'Enter the channel’s YouTube @handle, then tap Add. For example: @ReedTimmerWx.',
  }),
  Object.freeze({
    id: 'channels-order', route: 'Channels', target: 'channelsOrder', title: 'Choose your channel order',
    body: 'Auto-order puts the channel with the newest video first. Turn it off to drag channels into your own order. Long-press a channel for its individual settings.',
  }),
  Object.freeze({
    id: 'home-settings', route: 'Home', target: 'homeSettings', title: 'Tune TubePulse',
    body: 'Settings controls what opens, how often TubePulse reminds you, quiet periods, live alerts and what appears at home.',
  }),
  Object.freeze({
    id: 'settings-tap', route: 'Settings', target: 'settingsTap', title: 'Choose where a notification takes you',
    body: 'Open the individual video, or go to its channel page. Your choice also controls what TubePulse marks as seen.',
  }),
  Object.freeze({
    id: 'settings-notifications', route: 'Settings', target: 'settingsNotifications', title: 'Choose how reminders behave',
    body: 'Chill notifies once and reminds every four hours. Relentless repeats at the interval you choose until the videos are seen.',
  }),
  Object.freeze({
    id: 'settings-dnd', route: 'Settings', target: 'settingsDnd', title: 'Protect quiet time',
    body: 'Do not disturb holds notifications on the host, then delivers them when the quiet period ends.',
  }),
  Object.freeze({
    id: 'settings-live', route: 'Settings', target: 'settingsLive', title: 'Get ready for live streams',
    body: 'Choose how early TubePulse warns you about a scheduled live stream. The live-now alert is sent separately when the stream starts.',
  }),
  Object.freeze({
    id: 'settings-display', route: 'Settings', target: 'settingsDisplay', title: 'Shape each channel',
    body: 'Choose how many videos appear per channel. Enable per-channel settings, then long-press a channel to override notifications, quiet time, live warning and video count.',
  }),
]);

export const FEATURE_TOUR_STAGE_ORDER = Object.freeze([
  'homeChannels',
  'channels',
  'homeSettings',
  'settings',
]);

export const FEATURE_TOUR_STAGES = Object.freeze({
  homeChannels: Object.freeze({ route: 'Home', stepIndexes: Object.freeze([0]) }),
  channels: Object.freeze({ route: 'Channels', stepIndexes: Object.freeze([1, 2]) }),
  homeSettings: Object.freeze({ route: 'Home', stepIndexes: Object.freeze([3]) }),
  settings: Object.freeze({ route: 'Settings', stepIndexes: Object.freeze([4, 5, 6, 7, 8]), scroll: true }),
});

export function featureTourStageSteps(stageId) {
  const stage = FEATURE_TOUR_STAGES[stageId];
  return stage ? stage.stepIndexes.map((index) => FEATURE_TOUR_STEPS[index]) : [];
}

export function nextFeatureTourStage(stageId) {
  const index = FEATURE_TOUR_STAGE_ORDER.indexOf(stageId);
  return index >= 0 && index + 1 < FEATURE_TOUR_STAGE_ORDER.length
    ? FEATURE_TOUR_STAGE_ORDER[index + 1]
    : null;
}

export function featureTourGlobalStepNumber(stepId) {
  const index = FEATURE_TOUR_STEPS.findIndex((step) => step.id === stepId);
  return index >= 0 ? index + 1 : 1;
}

export function initialFeatureTourState({ storedState, freshInstall }) {
  if (storedState === 'completed' || storedState === 'skipped') return storedState;
  return freshInstall ? 'pending' : 'completed';
}

export async function initializeFeatureTour({ readState, writeState, freshInstall }) {
  const storedState = await readState();
  const state = initialFeatureTourState({ storedState, freshInstall });
  if (storedState !== state) await writeState(state);
  return state;
}

export function featureTourExitNavigationState() {
  return { index: 0, routes: [{ name: FEATURE_TOUR_HOME_ROUTE }] };
}

// The Settings replay control starts on press-in so Android cannot consume the
// gesture solely to stop ScrollView momentum. TouchableOpacity will normally
// follow that with onPress; treat both callbacks as one user request.
export function shouldAcceptFeatureTourReplayPress(lastAcceptedAt, pressedAt, dedupeMs = 750) {
  if (!Number.isFinite(pressedAt)) return false;
  if (!Number.isFinite(lastAcceptedAt)) return true;
  return pressedAt - lastAcceptedAt >= dedupeMs;
}
