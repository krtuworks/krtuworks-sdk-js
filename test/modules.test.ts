import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GAME_MODULES, MODULES, moduleOfEventType } from '../src/config.js';

test('a position sample belongs to the positions module, as on the server, and only a game makes it (control: an own type is customEvents)', () => {
  assert.equal(moduleOfEventType('position_sample'), 'positions');
  assert.ok(MODULES.includes('positions'));
  assert.ok(GAME_MODULES.includes('positions'));
  assert.equal(moduleOfEventType('death'), 'combat');
  assert.equal(moduleOfEventType('boss_fight'), 'customEvents');
});
