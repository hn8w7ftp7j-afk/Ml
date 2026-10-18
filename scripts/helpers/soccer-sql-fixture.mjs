// Execute the shipped stores against real PostgreSQL (WASM), replacing only the
// Neon HTTP transport. Fixtures never connect to a Production database.
import { register } from 'node:module';
import { PGlite } from '@electric-sql/pglite';

export async function soccerSqlFixture(){
  const db=new PGlite();await db.waitReady;
  const before=globalThis.__SOCCER_TEST_SQL;
  globalThis.__SOCCER_TEST_SQL=async(queries,transaction)=>{
    const execute=async connection=>{
      const output=[];
      for(const {query,params} of queries)output.push((await connection.query(query,params)).rows);
      return output;
    };
    return transaction?db.transaction(execute):execute(db);
  };
  const adapter='data:text/javascript,'+encodeURIComponent(`
    function task(query,params){return {query,params,then(a,b){return globalThis.__SOCCER_TEST_SQL([{query,params}],false).then(x=>x[0]).then(a,b);}};}
    export function neon(){
      const sql=(parts,...params)=>task(parts.reduce((q,p,i)=>q+(i?'$'+i:'')+p,''),params);
      sql.query=(query,params=[])=>task(query,params);
      sql.transaction=queries=>globalThis.__SOCCER_TEST_SQL(queries,true);
      return sql;
    }
  `);
  register('data:text/javascript,'+encodeURIComponent(`export async function resolve(s,c,n){
    if(s==='@neondatabase/serverless'&&/\\/lib\\/soccer\\/(?:analysis-store|reader-store|journal)\\.js$/.test(c.parentURL||''))return {url:${JSON.stringify(adapter)},shortCircuit:true};
    return n(s,c);
  }`),import.meta.url);
  return {db,async close(){globalThis.__SOCCER_TEST_SQL=before;await db.close();}};
}
