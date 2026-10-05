import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { prepareChannelNotificationSettings } from '../src/utils/channelNotificationSettings.mjs';
import { stepTime } from '../src/utils/timeSpinner.mjs';

const channelsSource = readFileSync(new URL('../src/screens/ChannelsScreen.js', import.meta.url), 'utf8');
const spinnerSource = readFileSync(new URL('../src/components/TimeSpinner.js', import.meta.url), 'utf8');
const settingsSource = readFileSync(new URL('../src/screens/SettingsScreen.js', import.meta.url), 'utf8');

test('hour and minute rollers update independently and wrap across midnight', () => {
  assert.equal(stepTime('22:15', 'hour', 1), '23:15');
  assert.equal(stepTime('22:15', 'minute', 1), '22:30');
  assert.equal(stepTime('23:45', 'minute', 1), '00:00');
  assert.equal(stepTime('00:00', 'hour', -1), '23:00');
});

test('saved channel notification payload retains both DND times', () => {
  const prepared = prepareChannelNotificationSettings({
    notificationMode: 'chill',
    dndEnabled: true,
    dndStart: '21:15',
    dndEnd: '06:45',
    includeCommunityPosts: null,
    prewarnMinutes: 30,
    latestVideosPerChannel: 2,
  });

  assert.equal(prepared.notificationSettings.dndStart, '21:15');
  assert.equal(prepared.notificationSettings.dndEnd, '06:45');
  assert.equal(prepared.overridePayload.dndStart, '21:15');
  assert.equal(prepared.overridePayload.dndEnd, '06:45');
  assert.equal(prepared.latestVideosPerChannel, 2);
  assert.equal('latestVideosPerChannel' in prepared.overridePayload, false);
  assert.equal('includeCommunityPosts' in prepared.overridePayload, false);
});

test('per-channel sheet uses compact responsive rollers and fixed action footer', () => {
  assert.match(channelsSource, /value=\{editingNotif\.dndStart\}[\s\S]*dndStart: v[\s\S]*compact/);
  assert.match(channelsSource, /value=\{editingNotif\.dndEnd\}[\s\S]*dndEnd: v[\s\S]*compact/);
  assert.match(channelsSource, /scrollEnabled=\{modalScrollEnabled\}/);
  assert.match(channelsSource, /onInteractionChange=\{\(active\) => setModalScrollEnabled\(!active\)\}/);
  assert.match(channelsSource, /maxHeight: '96%'/);
  assert.match(channelsSource, /minHeight: 44/);

  const scrollClose = channelsSource.indexOf('</ScrollView>');
  const buttons = channelsSource.indexOf('<View style={[styles.modalButtons');
  assert.ok(scrollClose >= 0 && buttons > scrollClose, 'Save/Cancel footer is outside the scrollable content');

  assert.match(spinnerSource, /columnCompact:[\s\S]*width: 44[\s\S]*height: 52/);
  assert.match(spinnerSource, /\.onBegin\([\s\S]*setInteracting\)\(true\)/);
  assert.match(spinnerSource, /\.onFinalize\([\s\S]*setInteracting\)\(false\)/);

  assert.match(settingsSource, /scrollEnabled=\{scrollEnabled\}/);
  assert.equal(
    (settingsSource.match(/onInteractionChange=\{\(active\) => setScrollEnabled\(!active\)\}/g) || []).length,
    2,
    'global Settings keeps both rollers isolated from its parent ScrollView',
  );
});

test('native Modal owns a gesture-handler root containing both DND spinners', () => {
  assert.match(channelsSource, /import \{ GestureHandlerRootView \} from 'react-native-gesture-handler'/);

  const modalOpen = channelsSource.indexOf('<Modal');
  const modalClose = channelsSource.indexOf('</Modal>', modalOpen);
  const modalSource = channelsSource.slice(modalOpen, modalClose);
  const rootOpen = modalSource.indexOf('<GestureHandlerRootView');
  const rootClose = modalSource.indexOf('</GestureHandlerRootView>');
  const startSpinner = modalSource.indexOf('value={editingNotif.dndStart}');
  const endSpinner = modalSource.indexOf('value={editingNotif.dndEnd}');

  assert.ok(modalOpen >= 0 && modalClose > modalOpen, 'native Modal is present');
  assert.ok(rootOpen >= 0 && rootClose > rootOpen, 'Modal content has its own gesture root');
  assert.ok(startSpinner > rootOpen && startSpinner < rootClose, 'From spinner is inside the modal gesture root');
  assert.ok(endSpinner > rootOpen && endSpinner < rootClose, 'Until spinner is inside the modal gesture root');
  assert.match(channelsSource, /modalGestureRoot:\s*\{\s*flex: 1/);
});
