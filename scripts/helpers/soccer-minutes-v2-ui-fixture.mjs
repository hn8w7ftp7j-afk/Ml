import fs from 'node:fs';
import vm from 'node:vm';
import {transform} from 'next/dist/build/swc/index.js';

// Execute the real shipped leaf so parent JSX tests cannot replace its coverage
// guards or research-only language with a presentation stub.
export async function loadSoccerMinutesV2CoverageForTest(React){
  const minutesV2Coverage=JSON.parse(fs.readFileSync(new URL('../../research/soccer/personnel-minutes-v2-coverage.json',import.meta.url),'utf8'));
  const source=fs.readFileSync(new URL('../../app/soccer/minutes-v2-coverage.js',import.meta.url),'utf8')
    .replace(/^import .*?;\n/gm,'').replace(/export function/g,'function');
  const {code}=await transform(source,{filename:'soccer-minutes-v2-coverage.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
  const context=vm.createContext({React,minutesV2Coverage});vm.runInContext(code,context);
  return context.SoccerMinutesV2Coverage;
}
