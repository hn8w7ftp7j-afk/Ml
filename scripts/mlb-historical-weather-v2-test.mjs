import assert from 'node:assert/strict';
import { buildHistoricalWindFeatureV2 } from '../lib/mlb-historical-weather-v2.js';

const out = buildHistoricalWindFeatureV2({ condition: 'Clear', temp: '80', wind: '10 mph, Out To CF' });
assert.equal(out.available, true);
assert.equal(out.relativeFieldAlignment, 1);
assert.equal(out.regressed, 1.5);

const inward = buildHistoricalWindFeatureV2({ condition: 'Cloudy', temp: '70', wind: '16 mph, In From RF' });
assert.equal(inward.relativeFieldAlignment, -0.72);
assert.equal(inward.regressed, -1.152);

const cross = buildHistoricalWindFeatureV2({ condition: 'Clear', temp: '70', wind: '12 mph, L To R' });
assert.equal(cross.relativeFieldAlignment, 0);

const dome = buildHistoricalWindFeatureV2({ condition: 'Dome', temp: '72', wind: '8 mph, Out To CF' });
assert.equal(dome.relativeFieldAlignment, 0);
assert.equal(dome.regressed, 0);

assert.equal(buildHistoricalWindFeatureV2({ condition: 'Clear', temp: '75', wind: '' }).available, false);
console.log('mlb-historical-weather-v2-test: PASS');
