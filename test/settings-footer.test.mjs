import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/screens/SettingsScreen.js', import.meta.url), 'utf8');
const appConfig = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'));

test('Settings footer uses configured version and the exact source link contract', () => {
  assert.equal(appConfig.expo.version, '4.0.0');
  assert.match(source, /Version \{appConfig\.expo\.version\}/);
  assert.doesNotMatch(source, /Version 3\.5\.2/);
  assert.match(source, />Link to Source<\/Text>/);
  assert.match(source, /accessibilityRole="link"/);
  assert.match(source, /https:\/\/github\.com\/Undert0e-505\/TubePulse/);
});

test('Settings footer is rendered after the ScrollView with balanced visual padding plus safe area', () => {
  assert.ok(source.indexOf('</ScrollView>') < source.indexOf('styles.footer'));
  assert.match(source, /const FOOTER_VISUAL_PADDING = 8;/);
  assert.match(source, /paddingTop: FOOTER_VISUAL_PADDING/);
  assert.match(source, /paddingBottom: FOOTER_VISUAL_PADDING \+ insets\.bottom/);
  assert.doesNotMatch(source, /Math\.max\(insets\.bottom/);
});
