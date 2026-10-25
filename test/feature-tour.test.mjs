import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FEATURE_TOUR_STAGES,
  FEATURE_TOUR_STAGE_ORDER,
  FEATURE_TOUR_STEPS,
  featureTourExitNavigationState,
  featureTourGlobalStepNumber,
  featureTourStageSteps,
  initializeFeatureTour,
  initialFeatureTourState,
  nextFeatureTourStage,
  shouldAcceptFeatureTourReplayPress,
} from '../src/utils/featureTourPolicy.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(repo, relative), 'utf8');

test('only a genuinely fresh installation is automatically eligible', () => {
  assert.equal(initialFeatureTourState({ storedState: null, freshInstall: true }), 'pending');
  assert.equal(initialFeatureTourState({ storedState: null, freshInstall: false }), 'completed');
  assert.equal(initialFeatureTourState({ storedState: 'skipped', freshInstall: true }), 'skipped');
  assert.equal(initialFeatureTourState({ storedState: 'completed', freshInstall: true }), 'completed');
});

test('initialization persists a versioned decision and respects skip/completion', async () => {
  const writes = [];
  assert.equal(await initializeFeatureTour({
    freshInstall: true,
    readState: async () => null,
    writeState: async (value) => writes.push(value),
  }), 'pending');
  assert.deepEqual(writes, ['pending']);

  writes.length = 0;
  assert.equal(await initializeFeatureTour({
    freshInstall: true,
    readState: async () => 'completed',
    writeState: async (value) => writes.push(value),
  }), 'completed');
  assert.deepEqual(writes, []);
});

test('nine semantic steps map to the intended actual controls', () => {
  assert.deepEqual(FEATURE_TOUR_STEPS.map(({ route, target, title }) => ({ route, target, title })), [
    { route: 'Home', target: 'homeChannels', title: 'Make TubePulse yours' },
    { route: 'Channels', target: 'channelsAdd', title: 'Add a channel' },
    { route: 'Channels', target: 'channelsOrder', title: 'Choose your channel order' },
    { route: 'Home', target: 'homeSettings', title: 'Tune TubePulse' },
    { route: 'Settings', target: 'settingsTap', title: 'Choose where a notification takes you' },
    { route: 'Settings', target: 'settingsNotifications', title: 'Choose how reminders behave' },
    { route: 'Settings', target: 'settingsDnd', title: 'Protect quiet time' },
    { route: 'Settings', target: 'settingsLive', title: 'Get ready for live streams' },
    { route: 'Settings', target: 'settingsDisplay', title: 'Shape each channel' },
  ]);
  FEATURE_TOUR_STEPS.forEach((step, index) => assert.equal(featureTourGlobalStepNumber(step.id), index + 1));
});

test('tour is split into route-local stages with Settings owning scroll', () => {
  assert.deepEqual(FEATURE_TOUR_STAGE_ORDER, ['homeChannels', 'channels', 'homeSettings', 'settings']);
  assert.deepEqual(featureTourStageSteps('homeChannels').map((step) => step.target), ['homeChannels']);
  assert.deepEqual(featureTourStageSteps('channels').map((step) => step.target), ['channelsAdd', 'channelsOrder']);
  assert.deepEqual(featureTourStageSteps('homeSettings').map((step) => step.target), ['homeSettings']);
  assert.deepEqual(featureTourStageSteps('settings').map((step) => step.target), [
    'settingsTap', 'settingsNotifications', 'settingsDnd', 'settingsLive', 'settingsDisplay',
  ]);
  assert.equal(FEATURE_TOUR_STAGES.settings.scroll, true);
  assert.equal(nextFeatureTourStage('homeChannels'), 'channels');
  assert.equal(nextFeatureTourStage('channels'), 'homeSettings');
  assert.equal(nextFeatureTourStage('homeSettings'), 'settings');
  assert.equal(nextFeatureTourStage('settings'), null);
});

test('all exit paths reset navigation to the Home feed', () => {
  assert.deepEqual(featureTourExitNavigationState(), {
    index: 0,
    routes: [{ name: 'Home' }],
  });
});

test('replay starts on press-in and deduplicates the trailing onPress callback', () => {
  assert.equal(shouldAcceptFeatureTourReplayPress(Number.NEGATIVE_INFINITY, 1_000), true);
  assert.equal(shouldAcceptFeatureTourReplayPress(1_000, 1_080), false);
  assert.equal(shouldAcceptFeatureTourReplayPress(1_000, 1_750), true);
  assert.equal(shouldAcceptFeatureTourReplayPress(1_000, Number.NaN), false);
});

test('pinned library integration replaces the custom modal/measurement engine', () => {
  const pkg = JSON.parse(read('package.json'));
  const component = read('src/components/FeatureTour.js');
  assert.equal(pkg.dependencies['@wrack/react-native-tour-guide'], '2.0.0');
  assert.match(component, /TourGuideOverlay/);
  assert.match(component, /LibraryTourGuideProvider/);
  assert.match(component, /<TourTarget id=\{targetKey\}/);
  assert.match(component, /tour\.canStartTour/);
  assert.match(component, /delayBefore: 1/);
  assert.doesNotMatch(component, /<Modal|<Svg|measureInWindow|\.measure\(/);
  assert.doesNotMatch(component, /setTimeout\(/);
});

test('route controls, exact Settings regions, scroll settling and replay are wired', () => {
  const app = read('App.js');
  const channels = read('src/screens/ChannelsScreen.js');
  const settings = read('src/screens/SettingsScreen.js');
  const component = read('src/components/FeatureTour.js');

  assert.match(app, /tourTarget="homeChannels"/);
  assert.match(app, /tourTarget="homeSettings"/);
  assert.match(channels, /targetKey="channelsAdd"/);
  assert.match(channels, /targetKey="channelsOrder"/);
  for (const key of ['settingsTap', 'settingsNotifications', 'settingsDnd', 'settingsLive', 'settingsDisplay']) {
    assert.match(settings, new RegExp(`targetKey="${key}"`));
  }
  assert.match(settings, /useTourScroll\(\)/);
  assert.match(settings, /onMomentumScrollEnd=\{tourScroll\.onMomentumScrollEnd\}/);
  assert.match(settings, /registerStageScroll\('settings'/);
  assert.match(settings, /onPressIn=\{replayFeatureTour\}/);
  assert.match(settings, /featureTour\.replay\(\)/);
  assert.match(component, /onTourEnd: \(completed\) => completeStage\(completed, stageId\)/);
  assert.match(component, /navigationRef\.current\?\.reset\?\.\(featureTourExitNavigationState\(\)\)/);
});
