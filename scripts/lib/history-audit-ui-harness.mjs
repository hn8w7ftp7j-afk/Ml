import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { taipeiHistoryTime } from '../../app/market-line-history/history-view.js';
import * as validation from '../../app/market-line-history/history-audit-validation.js';

export const auditNodes = value => Array.isArray(value) ? value.flatMap(auditNodes) : value && typeof value === 'object' ? [value, ...auditNodes(value.props?.children)] : [];
export const auditNodeText = value => Array.isArray(value) ? value.map(auditNodeText).join('') : value && typeof value === 'object' ? auditNodeText(value.props?.children) : String(value ?? '');
export async function createAuditHarness(componentPath, componentName) {
  const strip = source => source.replace(/^import .*?;\n/gm, '').replace(/export default function/g, 'function').replace(/export function/g, 'function');
  const hook = fs.readFileSync('app/market-line-history/history-audit-request.js', 'utf8');
  const source = fs.readFileSync(componentPath, 'utf8');
  const { code } = await transform(strip(hook) + '\n' + strip(source), {
    filename: componentName + '.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'classic' } } },
  });
  return function harness() {
    let index = 0, dirty = false, tree, timerSequence = 0, unmounted = false, afterUnmountMutations = 0;
    const hooks = [], effects = [], calls = [], timers = new Map();
    const scope = vm.createContext({ ...validation, React, taipeiHistoryTime, AbortController, URLSearchParams, styles: {},
      window: { setTimeout: (fn, ms) => { const id = ++timerSequence; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) },
      useState: initial => { const n = index++; if (!(n in hooks)) hooks[n] = typeof initial === 'function' ? initial() : initial;
        return [hooks[n], value => { if (unmounted) afterUnmountMutations++; hooks[n] = typeof value === 'function' ? value(hooks[n]) : value; dirty = true; }]; },
      useRef: initial => { const n = index++; return hooks[n] ??= { current: initial }; },
      useEffect: (fn, deps) => { const n = index++, old = hooks[n]; if (old && deps.every((value, j) => Object.is(value, old.deps[j]))) return;
        hooks[n] = { deps }; effects.push(() => { old?.cleanup?.(); hooks[n].cleanup = fn(); }); },
      fetch: (url, options) => new Promise((resolve, reject) => calls.push({ url, options,
        respond: (body, status = 200) => resolve({ ok: status >= 200 && status < 300, status, json: async () => body }), reject })),
    });
    vm.runInContext(code, scope);
    function render() { let turns = 0; do { dirty = false; index = 0; tree = scope[componentName](); effects.splice(0).forEach(fn => fn()); assert.ok(turns++ < 20); } while (dirty); }
    async function settle() { for (let i = 0; i < 35; i++) { await Promise.resolve(); if (dirty && !unmounted) render(); } }
    function button(label) { const node = auditNodes(tree).find(node => node.type === 'button' && auditNodeText(node).includes(label)); assert.ok(node, `button ${label} exists`); return node; }
    function click(label) { return button(label).props.onClick(); }
    function change(label, value) { const field = auditNodes(tree).find(node => ['input', 'select'].includes(node.type) && (node.props['aria-label'] === label || node.props.id === label)); assert.ok(field, `field ${label} exists`); field.props.onChange({ target: { value } }); render(); }
    return { scope, calls, timers, render, settle, click, button, change, get tree() { return tree; }, get markup() { return renderToStaticMarkup(tree); },
      get afterUnmountMutations() { return afterUnmountMutations; },
      expire: () => { const [id, timer] = [...timers.entries()][0] || []; assert.ok(timer); timers.delete(id); assert.equal(timer.ms, 30000); timer.fn(); },
      unmount: () => { unmounted = true; hooks.forEach(hook => hook?.cleanup?.()); } };
  };
}
