'use client';

export default function GlobalError({ error, reset }) {
  return <html lang="zh-Hant"><body style={{margin:0,background:'#06111d',color:'#eff6ff',fontFamily:'-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif'}}><main style={{maxWidth:560,margin:'0 auto',padding:'80px 20px'}}><section style={{background:'#0c1e31',border:'1px solid #294966',borderRadius:20,padding:22}}><h1>網站暫時無法載入</h1><p style={{color:'#9fb4c9',lineHeight:1.6}}>前端程式已發生例外。可以先重新載入；若舊版瀏覽器資料損壞，請回正式首頁後清除暫存。</p><pre style={{whiteSpace:'pre-wrap',fontSize:12,color:'#ffb6c1'}}>{String(error?.message || '')}</pre><button onClick={() => reset()} style={{width:'100%',border:0,borderRadius:12,padding:13,background:'#1976d2',color:'#fff',fontWeight:800}}>重新載入</button></section></main></body></html>;
}
