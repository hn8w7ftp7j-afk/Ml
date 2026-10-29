import './seen-local.js';
const local=globalThis.Tai888SeenStorage;
export const SEEN_CAPTURE_ALARM='tai888-reader-seen-retry';
export function createSeenCaptureOutbox({storage,upload,now=Date.now}) {
  let flushing, memoryFailure=null;
  const receiptTime=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
  async function failure(code,stage='capture') {
    memoryFailure={code:/^[A-Z][A-Z0-9_]{0,79}$/.test(code||'')?code:'SEEN_SAVE_FAILED',stage,updatedAt:new Date(now()).toISOString()};
    try {await storage.set({[stage==='capture'?'seenCaptureFailure':'seenDeliveryFailure']:memoryFailure});} catch {}
  }
  async function status() {
    try {
      const [rows,acks,state]=await Promise.all([local.entries(storage),local.entries(storage,local.ACK_PREFIX),
        storage.get(['deviceId','readerToken','seenCaptureFailure','seenDeliveryFailure'])]);
      const fail=state.seenCaptureFailure||memoryFailure||state.seenDeliveryFailure;
      const mismatch=rows.some(row=>row.ownerDeviceId!==state.deviceId);
      return {state:fail||mismatch?'error':rows.length?'pending':'sent',pendingCount:rows.length,
        pendingBytes:rows.reduce((n,row)=>n+local.bytes(row.wireText||''),0),savedCaptureCount:acks.length,
        failedCaptureCount:state.seenCaptureFailure||memoryFailure?.stage==='capture'?1:0,
        code:fail?.code||(mismatch?'SEEN_DEVICE_MISMATCH':rows.length&&!state.readerToken?'SEEN_PAIR_REQUIRED':''),
        lastPersistedAt:acks.map(row=>row.persistedAt).filter(Boolean).sort().at(-1)||null,updatedAt:new Date(now()).toISOString()};
    } catch {return {state:'error',pendingCount:null,pendingBytes:null,savedCaptureCount:null,failedCaptureCount:null,code:'SEEN_STORAGE_UNAVAILABLE',lastPersistedAt:null,updatedAt:new Date(now()).toISOString()};}
  }
  async function enqueue(evidence) {
    try{return await local.persist(evidence,{storage});}
    catch(error){await failure(error.message);return {queued:false,durable:false,code:error.message||'SEEN_LOCAL_SAVE_FAILED'};}
  }
  async function accepted(ack,row,wire) {
    return ack?.ok===true && ack.durable===true && ack.schema===local.SCHEMA && ack.captureId===row.captureId
      && ack.evidenceHash===await local.sha(local.canonical(wire.evidence)) && ack.league===wire.evidence.league
      && ack.readerVersion===wire.evidence.readerVersion && ack.observedAt===wire.evidence.observedAt
      && ack.pageActivityAt===(wire.evidence.pageActivityAt||null) && ack.archiveOnly===true
      && ack.currentBoardUpdated===false && ack.executable===false && ack.historicalAvailabilityVerified===false
      && ack.coverageComplete===false && ack.evidenceStatus==='EVIDENCE_UNVERIFIED'
      && ack.status==='EVIDENCE_UNVERIFIED' && receiptTime(ack.receivedAt) && receiptTime(ack.persistedAt);
  }
  function flush({force=false}={}) {
    if(flushing)return flushing;
    flushing=(async()=>{
      const config=await storage.get(['readerToken','deviceId']);
      if(!config.readerToken||!config.deviceId)return;
      const rows=(await local.entries(storage)).filter(row=>row.ownerDeviceId===config.deviceId&&(force||Number(row.nextAttemptAt||0)<=now())).sort((a,b)=>a.queuedAt-b.queuedAt).slice(0,20);
      const start=now();
      for(const row of rows) {
        if(now()-start>20000)break;
        try {
          const current=await storage.get(['deviceId','readerToken']);
          if(current.deviceId!==config.deviceId||current.readerToken!==config.readerToken)break;
          if(await local.sha(row.wireText)!==row.captureId)throw Error('SEEN_LOCAL_HASH_MISMATCH');
          const wire=JSON.parse(row.wireText), ackKey=local.ACK_PREFIX+row.ownerDeviceId+':'+row.captureId;
          let saved=(await storage.get([ackKey]))[ackKey];
          if(saved&&(saved.captureId!==row.captureId||saved.ownerDeviceId!==row.ownerDeviceId||saved.durable!==true
            ||saved.schema!==local.SCHEMA||!receiptTime(saved.receivedAt)||!receiptTime(saved.persistedAt)))saved=null;
          if(!saved) {
            const ack=await upload(wire,config);
            if(!await accepted(ack,row,wire))throw Error('SEEN_INVALID_RECEIPT');
            saved={captureId:row.captureId,ownerDeviceId:row.ownerDeviceId,durable:true,schema:local.SCHEMA,persistedAt:ack.persistedAt,receivedAt:ack.receivedAt};
            await storage.set({[ackKey]:saved});
            const verified=(await storage.get([ackKey]))[ackKey];
            if(verified?.captureId!==row.captureId||verified?.persistedAt!==ack.persistedAt||verified?.ownerDeviceId!==row.ownerDeviceId)throw Error('SEEN_ACK_READBACK_FAILED');
          }
          if(saved.captureId!==row.captureId||saved.ownerDeviceId!==row.ownerDeviceId
            ||saved.durable!==true||saved.schema!==local.SCHEMA
            ||!receiptTime(saved.receivedAt)||!receiptTime(saved.persistedAt))throw Error('SEEN_ACK_CONFLICT');
          // Read back the ACK before removing this immutable item. A concurrent
          // frame verifies either the local item or its persisted receipt.
          await storage.remove(row.key);
          await storage.remove('seenDeliveryFailure');
          if(memoryFailure?.stage==='delivery')memoryFailure=null;
        } catch(error) {
          const attempts=Math.min(Number(row.attempts||0)+1,20), {key,...item}=row;
          try {await storage.set({[key]:{...item,attempts,nextAttemptAt:now()+Math.min(15000*2**(attempts-1),300000)}});} catch {await failure('SEEN_RETRY_SAVE_FAILED');}
          await failure(error.message||'SEEN_UPLOAD_FAILED','delivery');
          if(error.status===401)break;
        }
      }
    })().finally(()=>{flushing=null;});
    return flushing;
  }
  return {enqueue,flush,status,failure};
}
