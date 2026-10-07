import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const app = fs.readFileSync(new URL('../App.js', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const settings = fs.readFileSync(new URL('../src/screens/SettingsScreen.js', import.meta.url), 'utf8');
const home = fs.readFileSync(new URL('../src/screens/HomeScreen.js', import.meta.url), 'utf8');
const channels = fs.readFileSync(new URL('../src/screens/ChannelsScreen.js', import.meta.url), 'utf8');
const presentation = fs.readFileSync(new URL('../src/utils/notificationPresentation.js', import.meta.url), 'utf8');
const backgroundTask = fs.readFileSync(new URL('../src/utils/notificationBackgroundTask.js', import.meta.url), 'utf8');
const actionRuntime = fs.readFileSync(new URL('../src/utils/notificationActionRuntime.js', import.meta.url), 'utf8');
const demo = fs.readFileSync(new URL('../src/utils/updateDemoConfig.js', import.meta.url), 'utf8');
const homeRuntime = fs.readFileSync(new URL('../self-host/src/runtime.mjs', import.meta.url), 'utf8');

test('data-only receipt displays before best-effort feed refresh', () => {
  assert.ok(app.indexOf('await presentRemoteMessageLocally(remoteMessage)') < app.indexOf("const { getDeviceId, fetchFeed }"));
  assert.match(presentation, /setNotificationCategoryAsync\(LOCAL_NOTIFICATION_CATEGORY/);
  assert.match(presentation, /LOCAL_NOTIFICATION_CHANNEL_MUTED_CATEGORY/);
  assert.match(presentation, /LOCAL_NOTIFICATION_GLOBAL_MUTED_CATEGORY/);
  assert.match(presentation, /buttonTitle: 'Unmute channel'/);
  assert.match(presentation, /buttonTitle: 'Unmute all'/);
  assert.match(
    presentation,
    /setNotificationCategoryAsync\(LOCAL_NOTIFICATION_CHANNEL_MUTED_CATEGORY,[\s\S]*?UNMUTE_CHANNEL[\s\S]*?\]\),/,
  );
  assert.match(
    presentation,
    /setNotificationCategoryAsync\(LOCAL_NOTIFICATION_GLOBAL_MUTED_CATEGORY,[\s\S]*?UNMUTE_CHANNEL[\s\S]*?UNMUTE_ALL[\s\S]*?\]\),/,
  );
  assert.ok(
    presentation.indexOf('await setupLocalNotificationPresentation()')
      < presentation.indexOf('await Notifications.scheduleNotificationAsync'),
    'the interactive category must be ready before every local notification is posted',
  );
  assert.match(presentation, /silent \? 'new-videos-silent' : 'new-videos'/);
  assert.match(presentation, /categoryIdentifier: localPresentation\.categoryIdentifier/);
});

test('background action task loads before App and action taps exit before default handling', () => {
  assert.ok(index.indexOf("./src/utils/notificationBackgroundTask") < index.indexOf("./App"));
  assert.ok(app.indexOf("if (route === 'silence')") < app.indexOf('const data = messageOrResponse?.data'));
  assert.match(backgroundTask, /ensureNotificationResponseTaskRegistered/);
  assert.match(backgroundTask, /processLocalNotificationActionResponse\(data\)/);
  assert.ok(app.indexOf('ensureNotificationResponseTaskRegistered()') < app.indexOf('await registerDevice('));
});

test('Home owns local sound recovery while Settings retains update accessibility', () => {
  assert.doesNotMatch(settings, /All notifications are silent|Resume sound|localSilenceNotice/);
  assert.match(settings, /UpdateAvailablePill/);
  assert.match(home, />Unmute</);
  assert.match(home, />Unmute all</);
  assert.match(home, /formatNotificationSilenceStatus/);
  assert.match(home, /notificationSilencePresentation\(silenceState, item\.channelId\)/);
  assert.match(home, /silenceState\.globalMuted \? null : silenceUntil/);
  assert.match(home, /styles\.silenceStatus/);
  assert.match(home, /ellipsizeMode="tail"/);
  assert.match(home, /channelNameBtn:\s*\{[\s\S]*?flexShrink: 1,[\s\S]*?minWidth: 0,/);
  assert.match(home, /unmuteLozenge:\s*\{[\s\S]*?flexShrink: 0,/);
  assert.match(home, /nextNotificationSilenceExpiry/);
  assert.match(home, /AppState\.addEventListener/);
  assert.match(home, /subscribeLocalNotificationSilence/);
  assert.doesNotMatch(channels, /Silent until|Resume sound|resumeChannelNotificationSound/);
});

test('update demo is opt-in and off by default', () => {
  assert.match(demo, /=== '1'/);
  assert.doesNotMatch(demo, /\|\| true/);
});

test('runtime silence storage adapter cannot collide with the pure module during Metro resolution', () => {
  const runtimeSources = [home, presentation, actionRuntime];
  for (const source of runtimeSources) {
    if (/LocalNotification|NotificationSilence|notificationShouldBeSilent/.test(source)) {
      assert.match(source, /localNotificationSilenceStorage/);
    }
  }
  assert.equal(fs.existsSync(new URL('../src/utils/localNotificationSilence.js', import.meta.url)), false);
  assert.equal(fs.existsSync(new URL('../src/utils/localNotificationSilence.mjs', import.meta.url)), true);
  assert.equal(fs.existsSync(new URL('../src/utils/localNotificationSilenceStorage.js', import.meta.url)), true);
});

test('Home workerd exposes the shared FCM module to the API worker', () => {
  assert.match(homeRuntime, /worker\.scheduled \|\| worker\.name === 'api'/);
  assert.match(homeRuntime, /tubepulse-cron', 'shared\.mjs'/);
});
