import { expect, test } from 'vitest';
import { nowSec } from '../src/clock.js';

test('nowSec returns integer unix seconds near current time', () => {
  const t = nowSec();
  expect(Number.isInteger(t)).toBe(true);
  expect(Math.abs(t - Date.now() / 1000)).toBeLessThan(5);
});
