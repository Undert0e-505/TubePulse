import assert from 'node:assert/strict';
import test from 'node:test';
import { SETTINGS_COG_PATH, SETTINGS_COG_VIEW_BOX } from '../src/utils/settingsCog.mjs';

test('settings cog is a deterministic filled gear with a separate centre hole', () => {
  assert.equal(SETTINGS_COG_VIEW_BOX, '0 0 32 32');
  assert.match(SETTINGS_COG_PATH, /^M12 0H20/);
  assert.match(SETTINGS_COG_PATH, /M16 10A6 6/);
  assert.equal((SETTINGS_COG_PATH.match(/Z/g) || []).length, 2);
});
