import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
const source = fs.readFileSync('app/soccer/prematch-inputs-panel.js', 'utf8').replace(/export function/g, 'function');
const { code } = await transform(source, { filename: 'soccer-prematch-inputs-panel.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'classic' } } } });
const context = vm.createContext({ React }); vm.runInContext(code, context);
const render = evidence => renderToStaticMarkup(React.createElement(context.SoccerPrematchInputsPanel, { evidence }));
assert.equal(render({}), '');
const html = render({ prematchInputConnection: {}, weather: { status: 'PROVIDER_REPORTED', source: { fetchedAt: '2026-11-09T01:00:00Z' },
  value: { venue: { name: 'Test Stadium' }, temperatureC: 0, precipitationMm: 0, windSpeedKmh: 5, validAt: '2026-11-21T12:00:00Z' },
  observationArchive: { persisted: true } }, teams: { home: { minutes: { players: [{ id: '1', name: '<script>', expectedMinutes: null, startProbability: null }] } } } });
assert.match(html, /0\.0°C/); assert.match(html, /0\.0 mm/); assert.match(html, /來源未提供預報發布時間/);
assert.match(html, /原始文件已保存並讀回核對/); assert.match(html, /模型效果與正式評分仍須獨立驗證/);
assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
assert.match(html, /尚未提供/); assert.match(html, /Open-Meteo/);
console.log('PASS prematch input display: measured zero, missing values, escaped names, attribution and no formal-scoring claim');
