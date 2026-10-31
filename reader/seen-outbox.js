import './seen-local.js';
const local=globalThis.Tai888SeenStorage;
export const SEEN_CAPTURE_ALARM='tai888-reader-seen-retry';
export function createSeenCaptureOutbox({storage,upload,now=Date.now}) {
  let flushing, memoryFailure=null;
  const captureFailures=new Map(), retryCaptures=new Map();
  const failureCodes=new Set(['SEEN_EVIDENCE_INVALID','SEEN_EVIDENCE_UNKNOWN_FIELD','SEEN_SOURCE_INVALID',
    'SEEN_PRIVATE_TEXT_BLOCKED','SEEN_ROWS_INVALID','SEEN_ROW_TOO_LARGE','SEEN_CAPTURE_TOO_LARGE',
    'SEEN_FRAGMENT_TOO_LARGE','SEEN_STORAGE_UNAVAILABLE','SEEN_PAIR_REQUIRED','SEEN_LOCAL_CONFLICT',
    'SEEN_LOCAL_READBACK_FAILED','SEEN_LOCAL_SAVE_FAILED','SEEN_LOCAL_HASH_MISMATCH','SEEN_INVALID_RECEIPT',
    'SEEN_ACK_READBACK_FAILED','SEEN_ACK_CONFLICT','SEEN_RETRY_SAVE_FAILED','SEEN_UPLOAD_FAILED',
    'SEEN_DEVICE_MISMATCH','SEEN_FLUSH_FAILED','SEEN_SAVE_FAILED','SEEN_CAPTURE_FAILED',
    'SEEN_TEXT_TOO_LARGE','SEEN_VERSION_INVALID','SEEN_TIME_INVALID','SEEN_REASONS_INVALID',
    'SEEN_HEADER_TOO_LARGE','SEEN_CELL_TOO_LARGE','SEEN_PAIR_TOO_LARGE','SEEN_DIAGNOSTICS_INVALID']);
  const safeFailureCode=code=>failureCodes.has(code)?code:'SEEN_SAVE_FAILED';
  const receiptTime=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
  async function failure(code,stage='capture',evidence=null) {
    if(stage==='capture'&&evidence)try {
      const scope=await local.failureScope(evidence,storage), key=local.FAILURE_PREFIX+scope.ownerDeviceId+':'+scope.failureId;
      const [rows,acks]=await Promise.all([local.entries(storage),local.entries(storage,local.ACK_PREFIX)]);
      // A delayed failure notification may arrive after the other writer has
      // already saved this exact source. Never turn that race into a loss alert.
      if(await local.scopeConfirmed(scope,rows,acks))return scope;
      const item={...scope,code:safeFailureCode(code),stage,updatedAt:new Date(now()).toISOString()};
      captureFailures.set(key,item);
      try {await storage.set({[key]:item});} catch {}
      return scope;
    } catch {}
    memoryFailure={code:safeFailureCode(code),stage,updatedAt:new Date(now()).toISOString()};
    try {await storage.set({[stage==='capture'?'seenCaptureFailure':'seenDeliveryFailure']:memoryFailure});} catch {}
    return null;
  }
  async function status() {
    try {
      const [rows,acks,storedFailures,state]=await Promise.all([local.entries(storage),local.entries(storage,local.ACK_PREFIX),local.entries(storage,local.FAILURE_PREFIX),
        storage.get(['deviceId','readerToken','seenCaptureFailure','seenDeliveryFailure'])]);
      const scoped=new Map([...storedFailures.map(row=>[row.key,row]),...captureFailures]);
      for(const [key,item] of scoped)if(await local.scopeConfirmed(item,rows,acks)) {
        try {await storage.remove(key);scoped.delete(key);captureFailures.delete(key);retryCaptures.delete(item.failureId);} catch {}
      }
      // Legacy reports lack the exact failed fragment identities. A newer
      // unrelated ACK cannot establish whether that historical source survived.
      const fail=state.seenCaptureFailure||memoryFailure||scoped.values().next().value||state.seenDeliveryFailure;
      const unidentified=state.seenCaptureFailure||(memoryFailure?.stage==='capture'?memoryFailure:null);
      const captureFailure=unidentified||scoped.values().next().value;
      const mismatch=rows.some(row=>row.ownerDeviceId!==state.deviceId);
      return {state:fail||mismatch?'error':rows.length?'pending':'sent',pendingCount:rows.length,
        pendingBytes:rows.reduce((n,row)=>n+local.bytes(row.wireText||''),0),savedCaptureCount:acks.length,
        failedCaptureCount:scoped.size+(state.seenCaptureFailure||memoryFailure?.stage==='capture'?1:0),
        captureFailureScope:unidentified?'UNIDENTIFIED_CAPTURE':scoped.size?'EXACT_FRAGMENTS':'NONE',
        captureFailureAt:captureFailure?.updatedAt||null,
        code:fail?.code||(mismatch?'SEEN_DEVICE_MISMATCH':rows.length&&!state.readerToken?'SEEN_PAIR_REQUIRED':''),
        lastPersistedAt:acks.map(row=>row.persistedAt).filter(Boolean).sort().at(-1)||null,updatedAt:new Date(now()).toISOString()};
    } catch {return {state:'error',pendingCount:null,pendingBytes:null,savedCaptureCount:null,failedCaptureCount:null,code:'SEEN_STORAGE_UNAVAILABLE',lastPersistedAt:null,updatedAt:new Date(now()).toISOString()};}
  }
  async function enqueue(evidence) {
    try{return await local.persist(evidence,{storage});}
    catch(error){
      const scope=await failure(error.message,'capture',evidence);
      // The worker keeps a safe copy for the retry alarm if a source frame
      // closes after both local writers failed. It remains explicitly failed
      // until durable storage or the exact server ACK is read back.
      if(scope)retryCaptures.set(scope.failureId,{scope,evidence:JSON.parse(local.canonical(evidence))});
      return {queued:false,durable:false,code:safeFailureCode(error.message)};
    }
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
      if(!config.deviceId)return;
      for(const [id,item] of retryCaptures)if(item.scope.ownerDeviceId===config.deviceId) {
        try {await local.persist(item.evidence,{storage});retryCaptures.delete(id);} catch {}
      }
      if(!config.readerToken)return;
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
