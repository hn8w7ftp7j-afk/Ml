(() => {
  if (globalThis.Tai888SeenStorage) return;
  const PREFIX = 'tai888SeenV1:';
  const ACK_PREFIX = 'tai888SeenAckV1:';
  const FAILURE_PREFIX = 'tai888SeenFailureV1:';
  const SCHEMA = 'READER-SEEN-CAPTURE-v1';
  const LEAGUES = ['MLB', 'NPB', 'KBO', 'CPBL', 'NBA', 'NHL', 'EPL', 'UCL'];
  const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
  const sha = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
  const bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : canonical(value)).length;
  const receiptTime=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
  const validAck=(ack,captureId,ownerDeviceId)=>ack?.captureId===captureId&&ack.ownerDeviceId===ownerDeviceId
    &&ack.durable===true&&ack.schema===SCHEMA&&receiptTime(ack.receivedAt)&&receiptTime(ack.persistedAt);
  const privateText = /(?:password|passwd|cookie|session|secret|authorization|bearer|account|balance|username|user[ _-]?id|private[ _-]?key|\bmember\b|\bcredit\b|帳號|账号|帳戶|账户|餘額|余额|額度|额度|登入|登录|密碼|密码|會員|会员|用戶名|用户名|(?:^|[^a-z])token(?:[^a-z]|$)|https?:|[<>=@\\]|[A-Za-z0-9_-]{40,})/i;
  function safeEvidence(input) {
    const object = value => Boolean(value && typeof value==='object' && !Array.isArray(value)
      && (Object.getPrototypeOf(value)===Object.prototype || Object.getPrototypeOf(value)===null));
    const ensure = (condition,code='SEEN_EVIDENCE_INVALID')=>{if(!condition)throw Error(code);};
    const fields = (value,allowed)=>ensure(object(value)&&Object.keys(value).every(key=>allowed.includes(key)),'SEEN_EVIDENCE_UNKNOWN_FIELD');
    const date = value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
      &&new Date(`${value}T00:00:00.000Z`).toISOString().slice(0,10)===value;
    const timestamp=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/.test(value)
      &&date(value.slice(0,10))&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
    function scan(value) {
      let result=value.normalize('NFKC').replace(/\p{Cf}/gu,'');
      for(let attempt=0;attempt<4&&/%[a-f0-9]{2}/i.test(result);attempt+=1) {
        try{result=decodeURIComponent(result).normalize('NFKC').replace(/\p{Cf}/gu,'');}catch{throw Error('SEEN_PRIVATE_TEXT_BLOCKED');}
      }
      ensure(!/%[a-f0-9]{2}/i.test(result),'SEEN_PRIVATE_TEXT_BLOCKED');return result;
    }
    function sportText(value) {
      ensure(typeof value==='string','SEEN_EVIDENCE_INVALID');
      ensure(value.length<=65536,'SEEN_TEXT_TOO_LARGE');
      ensure(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)&&!privateText.test(scan(value)),'SEEN_PRIVATE_TEXT_BLOCKED');
    }
    ensure(object(input)&&LEAGUES.includes(input.league)&&Array.isArray(input.tables));
    const allowed = ['version','league','readerVersion','sourceHost','pageUrl','frameUrl','observedAt','pageActivityAt','pageLeagueLabel','tables','captureReasons','completeCapture','diagnostics'];
    fields(input,allowed);
    ensure(/^TAI888-DOM-CAPTURE-v2\.[12]\.0$/.test(input.version||'')&&typeof input.readerVersion==='string'&&/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(input.readerVersion),'SEEN_VERSION_INVALID');
    ensure(timestamp(input.observedAt)&&(!Object.hasOwn(input,'pageActivityAt')||input.pageActivityAt===null||timestamp(input.pageActivityAt)),'SEEN_TIME_INVALID');
    ensure(typeof input.sourceHost==='string'&&/^(?:[a-z0-9-]+\.)*tai888\.in$/.test(input.sourceHost),'SEEN_SOURCE_INVALID');
    for(const name of ['pageUrl','frameUrl']) {
      if(name==='frameUrl'&&!Object.hasOwn(input,name))continue;
      ensure(typeof input[name]==='string'&&input[name].length<=500,'SEEN_SOURCE_INVALID');
      let url;try{url=new URL(input[name]);}catch{throw Error('SEEN_SOURCE_INVALID');}
      ensure(url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.search
        &&/^(?:[a-z0-9-]+\.)*tai888\.in$/.test(url.hostname)&&(name!=='pageUrl'||url.hostname===input.sourceHost)
        &&(!url.hash||/^#\/(?:BS|BB|FT)$/.test(url.hash))&&!privateText.test(scan(url.pathname)),'SEEN_SOURCE_INVALID');
    }
    if(Object.hasOwn(input,'pageLeagueLabel'))sportText(input.pageLeagueLabel);
    if(Object.hasOwn(input,'completeCapture'))ensure(typeof input.completeCapture==='boolean');
    if(Object.hasOwn(input,'captureReasons')) {
      const reasons=['PRE_NORMALIZATION','MUTATION','SCAN','BEFORE_SELECTION','SOURCE_PARTIAL'];
      ensure(Array.isArray(input.captureReasons)&&input.captureReasons.length<=reasons.length&&input.captureReasons.every(reason=>reasons.includes(reason))
        &&new Set(input.captureReasons).size===input.captureReasons.length,'SEEN_REASONS_INVALID');
    }
    for (const table of input.tables) {
      fields(table,['sectionTitle','headers','periodEvidenceTruncated','rows']);ensure(Array.isArray(table.rows));
      if(Object.hasOwn(table,'sectionTitle'))sportText(table.sectionTitle);
      if(Object.hasOwn(table,'headers')){ensure(Array.isArray(table.headers)&&table.headers.length<=128,'SEEN_HEADER_TOO_LARGE');table.headers.forEach(sportText);}
      if(Object.hasOwn(table,'periodEvidenceTruncated'))ensure(typeof table.periodEvidenceTruncated==='boolean');
      for(const row of table.rows) {
        fields(row,['marketLocked','cells']);ensure(Array.isArray(row.cells)&&row.cells.length<=128,'SEEN_CELL_TOO_LARGE');
        if(Object.hasOwn(row,'marketLocked'))ensure(typeof row.marketLocked==='boolean');
        for(const cell of row.cells){fields(cell,['pair']);ensure(Array.isArray(cell.pair)&&cell.pair.length<=4096,'SEEN_PAIR_TOO_LARGE');cell.pair.forEach(sportText);}
      }
    }
    if(Object.hasOwn(input,'diagnostics')) {
      const counts=['recordCount','headerCount','candidateRows','gameCount','pairedRows','singleRows','expectedGameCount','rootCount',
        'candidateElementCount','acceptedRecordCount','skippedAlternativeCount','sectionCount','mutationAgeSeconds'];
      const bools=['sawLeagueMarker','wrongPeriodHeader'],times=['lastMutationAt','activityAt'];
      fields(input.diagnostics,[...counts,...bools,...times,'tableIssues','conflictingGameKeys']);
      for(const name of counts)if(Object.hasOwn(input.diagnostics,name))ensure(input.diagnostics[name]===null||Number.isSafeInteger(input.diagnostics[name])&&input.diagnostics[name]>=0&&input.diagnostics[name]<=10000000,'SEEN_DIAGNOSTICS_INVALID');
      for(const name of bools)if(Object.hasOwn(input.diagnostics,name))ensure(typeof input.diagnostics[name]==='boolean','SEEN_DIAGNOSTICS_INVALID');
      for(const name of times)if(Object.hasOwn(input.diagnostics,name))ensure(input.diagnostics[name]===null||input.diagnostics[name]===''||timestamp(input.diagnostics[name]),'SEEN_DIAGNOSTICS_INVALID');
      for(const name of ['tableIssues','conflictingGameKeys'])if(Object.hasOwn(input.diagnostics,name)) {
        ensure(Array.isArray(input.diagnostics[name])&&input.diagnostics[name].length<=1000,'SEEN_DIAGNOSTICS_INVALID');
        input.diagnostics[name].forEach(value=>{sportText(value);ensure(value.length<=1024,'SEEN_DIAGNOSTICS_INVALID');});
      }
    }
    return JSON.parse(canonical(input));
  }
  async function fragments(input) {
    const evidence = safeEvidence(input);
    const batchId = await sha(canonical({schema: SCHEMA, evidence}));
    const groups = []; let tables = [], currentBytes = 0;
    const base = {...evidence}; delete base.tables;
    function flush() { if (tables.length) { groups.push(tables); tables=[]; currentBytes=0; } }
    for (const table of evidence.tables) {
      const meta = {...table,rows:[]};
      if (!Array.isArray(table.rows)) throw Error('SEEN_ROWS_INVALID');
      if (!table.rows.length) { if (currentBytes+bytes(meta)>140000 || tables.length>=100) flush(); tables.push(meta); currentBytes+=bytes(meta); continue; }
      let part = {...meta,rows:[]};
      for (const row of table.rows) {
        const size=bytes(row);
        if (size>130000) throw Error('SEEN_ROW_TOO_LARGE');
        if (currentBytes+bytes(part)+size>140000 || part.rows.length>=800) {
          if (part.rows.length) {tables.push(part);currentBytes+=bytes(part);part={...meta,rows:[]};}
          flush();
        }
        part.rows.push(row);
      }
      if (part.rows.length) {tables.push(part);currentBytes+=bytes(part);}
      if (tables.length>=100) flush();
    }
    flush(); if (!groups.length) groups.push([]);
    if (groups.length>10000) throw Error('SEEN_CAPTURE_TOO_LARGE');
    return Promise.all(groups.map(async (tables,index) => {
      const wire={schema:SCHEMA,evidence:{...base,tables,captureBatchId:batchId,partIndex:index,partCount:groups.length}};
      const wireText=canonical(wire), captureId=await sha(wireText);
      if(bytes(wireText)>590000) throw Error('SEEN_FRAGMENT_TOO_LARGE');
      return {captureId,wireText};
    }));
  }
  async function entries(storage, prefix=PREFIX) {
    const all=await storage.get(null);
    return Object.entries(all||{}).filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({...value,key}));
  }
  async function failureScope(input, storage) {
    const chunks = await fragments(input), config = await storage.get(['deviceId']);
    if(typeof config.deviceId!=='string'||!config.deviceId) throw Error('SEEN_PAIR_REQUIRED');
    const captureIds = chunks.map(chunk=>chunk.captureId);
    return { ownerDeviceId:config.deviceId,captureIds,
      failureId:await sha(canonical({ownerDeviceId:config.deviceId,captureIds})) };
  }
  async function scopeConfirmed(scope, rows, acks) {
    if(!scope||typeof scope.ownerDeviceId!=='string'||!Array.isArray(scope.captureIds)||!scope.captureIds.length
      ||scope.captureIds.some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))
      ||scope.failureId!==await sha(canonical({ownerDeviceId:scope.ownerDeviceId,captureIds:scope.captureIds})))return false;
    for(const id of scope.captureIds) {
      const ack=acks.find(row=>row.key===ACK_PREFIX+scope.ownerDeviceId+':'+id);
      if(validAck(ack,id,scope.ownerDeviceId))continue;
      const row=rows.find(row=>row.key===PREFIX+scope.ownerDeviceId+':'+id);
      if(row?.captureId!==id||row.ownerDeviceId!==scope.ownerDeviceId||typeof row.wireText!=='string'
        ||await sha(row.wireText)!==id)return false;
    }
    return true;
  }
  async function persist(input,{storage}={}) {
    if(!storage?.get || !storage?.set) throw Error('SEEN_STORAGE_UNAVAILABLE');
    const chunks=await fragments(input), config=await storage.get(['deviceId']);
    if(typeof config.deviceId!=='string' || !config.deviceId) throw Error('SEEN_PAIR_REQUIRED');
    const captureIds=[];
    for(const chunk of chunks) {
      const key=PREFIX+config.deviceId+':'+chunk.captureId;
      const ackKey=ACK_PREFIX+config.deviceId+':'+chunk.captureId;
      const initial=await storage.get([key,ackKey]);
      if(validAck(initial[ackKey],chunk.captureId,config.deviceId)) {captureIds.push(chunk.captureId);continue;}
      const previous=initial[key];
      if(previous && (previous.wireText!==chunk.wireText || previous.ownerDeviceId!==config.deviceId)) throw Error('SEEN_LOCAL_CONFLICT');
      if(!previous) await storage.set({[key]:{...chunk,ownerDeviceId:config.deviceId,queuedAt:Date.now(),attempts:0,nextAttemptAt:0}});
      const readback=await storage.get([key,ackKey]), saved=readback[key];
      if((saved?.wireText!==chunk.wireText || saved?.captureId!==chunk.captureId)
        && !validAck(readback[ackKey],chunk.captureId,config.deviceId)) throw Error('SEEN_LOCAL_READBACK_FAILED');
      captureIds.push(chunk.captureId);
    }
    return {queued:true,durable:true,captureIds};
  }
  globalThis.Tai888SeenStorage=Object.freeze({PREFIX,ACK_PREFIX,FAILURE_PREFIX,SCHEMA,canonical,sha,bytes,fragments,entries,persist,failureScope,scopeConfirmed});
})();
