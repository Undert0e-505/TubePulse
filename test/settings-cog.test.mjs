import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SETTINGS_COG_PATH, SETTINGS_COG_VIEW_BOX } from '../src/utils/settingsCog.mjs';

const appSource = readFileSync(new URL('../App.js', import.meta.url), 'utf8');

test('settings cog is a deterministic filled gear with a separate centre hole', () => {
  assert.equal(SETTINGS_COG_VIEW_BOX, '0 0 32 32');
  assert.match(SETTINGS_COG_PATH, /^M12 0H20/);
  assert.match(SETTINGS_COG_PATH, /M16 10A6 6/);
  assert.equal((SETTINGS_COG_PATH.match(/Z/g) || []).length, 2);
});

test('Home title and Channels action share the approved 18sp header scale', () => {
  assert.match(appSource, /headerTitleStyle: \{ fontWeight: '600', fontSize: 18 \}/);
  assert.match(appSource, /color: COLORS\.accent, fontSize: 18, fontWeight: '500'/);
  assert.match(appSource, /<HeaderButton title="Channels"/);
  assert.match(appSource, /<SettingsCogIcon \/>/);
});
