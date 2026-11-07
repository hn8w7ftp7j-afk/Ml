import fs from 'node:fs';
import vm from 'node:vm';
import { transform } from 'next/dist/build/swc/index.js';
import { soccerIdentityHash } from '../../lib/soccer/identity-hash.js';

// Execute the shipped child and its real client-safe hash implementation.
// These functions remain display checks, never mocked source authority.
export async function loadSoccerShotXgResearchUiForTest(React) {
  const path='app/soccer/shot-xg-research-panel.js';
  const source=fs.readFileSync(path,'utf8').replace(/^import .*?;\n/gm,'').replace(/export function/g,'function');
  const compiled=await transform(source,{filename:path.replace('.js','.jsx'),jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
  const context=vm.createContext({React,soccerIdentityHash});vm.runInContext(compiled.code,context);
  return {SoccerShotXgResearchPanel:context.SoccerShotXgResearchPanel,soccerShotXgViewRenderable:context.soccerShotXgViewRenderable};
}
