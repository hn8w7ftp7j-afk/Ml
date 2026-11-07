"""Reproduce the pinned, CC-BY-4 Wyscout EPL native-shot projection.

No outcome-based match sampling. Originals stay in the explicit private cache;
only the exact English member is streamed. No moving mirrors, account keys,
website scraping, StatsBomb/ESPN data, or provider xG fields are used.
"""
import argparse, collections, datetime, hashlib, io, json, pathlib, urllib.request, zipfile

PINS = [
 (7770599,14464685,'events.zip',77323413,'7c20e8647e7eda58d7838a0c7b1ec6ab','877e015b716ffdeea18f04418e3f24fed307ed03c37ff305cabe1f47c4822a45'),
 (7770422,14464622,'matches.zip',645097,'51d80beb17480919f69a53a0152c2d71','c8f92bb7533e5c127e043cee764c991b5c25b4f5e70a65be931baae0b1765ce9'),
 (11743836,21385245,'eventid2name.csv',1001,'46daf16100ece0c743eedc9adcfea162','ce7bafb341b36ab4c6093bf1c09c967e9cea10d4223724a1fc679086e5d16842'),
 (11743818,21385239,'tags2name.csv',1754,'e7acb14918d00e40c80a898b1da8fc39','e0bc1bd8ff6ea5339586fdfc3e8e9b285a4a18f1ae2f5868ccc9ec9cecc8a922'),
]

def hashes(path):
 md5,sha=hashlib.md5(),hashlib.sha256()
 with path.open('rb') as file:
  while chunk:=file.read(1024*1024):md5.update(chunk);sha.update(chunk)
 return md5.hexdigest(),sha.hexdigest()

def objects(stream):
 decoder=json.JSONDecoder();buffer='';position=0;started=False;closed=False;needs_value=True;count=0
 while True:
  chunk=stream.read(1024*1024)
  if chunk:buffer=buffer[position:]+chunk;position=0
  while True:
   while position<len(buffer) and buffer[position].isspace():position+=1
   if not started:
    if position==len(buffer):break
    if buffer[position]!='[':raise ValueError('WYSCOUT_ORIGINAL_NOT_ARRAY')
    started=True;position+=1;continue
   if position==len(buffer):break
   if buffer[position]==']':
    if needs_value and count:raise ValueError('WYSCOUT_TRAILING_COMMA')
    position+=1;closed=True;break
   if not needs_value:
    if buffer[position]!=',':raise ValueError('WYSCOUT_COMMA_MISSING')
    position+=1;needs_value=True;continue
   try:value,next_position=decoder.raw_decode(buffer,position)
   except json.JSONDecodeError:
    if chunk:break
    raise
   position=next_position;needs_value=False;count+=1;yield value
  if closed:
   if (buffer[position:]+stream.read()).strip():raise ValueError('WYSCOUT_TRAILING_DATA')
   return
  if not chunk:raise ValueError('WYSCOUT_TRUNCATED_ARRAY')

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--cache',required=True,type=pathlib.Path);parser.add_argument('--fetch',action='store_true');args=parser.parse_args();root=args.cache.resolve();root.mkdir(parents=True,exist_ok=True)
 for article,file_id,name,size,md5,sha in PINS:
  path=root/name
  if not path.exists():
   if not args.fetch:raise ValueError('WYSCOUT_ORIGINAL_MISSING_USE_FETCH_'+name)
   # Verify the primary repository's explicit licence before acquiring bytes.
   meta_url=f'https://api.figshare.com/v2/articles/{article}/versions/1'
   with urllib.request.urlopen(meta_url,timeout=30) as response:metadata=response.read()
   meta=json.loads(metadata)
   if meta.get('license',{}).get('name')!='CC BY 4.0' or meta.get('version')!=1 or not any(f['id']==file_id and f['computed_md5']==md5 and f['size']==size for f in meta['files']):raise ValueError('WYSCOUT_PRIMARY_CONTRACT_CHANGED')
   (root/f'{article}-metadata.json').write_bytes(metadata)
   request=urllib.request.Request(f'https://ndownloader.figshare.com/files/{file_id}',headers={'Cache-Control':'no-cache','User-Agent':'SoccerShotResearch/1.0 (CC-BY-4 dataset)'})
   temporary=path.with_suffix(path.suffix+'.part');total=0
   with urllib.request.urlopen(request,timeout=45) as response,temporary.open('wb') as out:
    while chunk:=response.read(1024*1024):
     total+=len(chunk)
     if total>size:raise ValueError('WYSCOUT_ORIGINAL_BYTE_BUDGET')
     out.write(chunk)
   if temporary.stat().st_size!=size or hashes(temporary)!=(md5,sha):raise ValueError('WYSCOUT_ORIGINAL_HASH_MISMATCH')
   temporary.replace(path)
  if path.stat().st_size!=size or hashes(path)!=(md5,sha):raise ValueError('WYSCOUT_CACHED_ORIGINAL_HASH_MISMATCH_'+name)
 with zipfile.ZipFile(root/'matches.zip') as archive:
  match_bytes=archive.read('matches_England.json')
 if hashlib.sha256(match_bytes).hexdigest()!='620725c2e6a58b4db3e574ed6c559136477451d81af543f8a06bd85c3da3fe29':raise ValueError('WYSCOUT_MATCH_MEMBER_CHANGED')
 (root/'matches_England.json').write_bytes(match_bytes)
 with zipfile.ZipFile(root/'events.zip') as archive:
  digest=hashlib.sha256()
  with archive.open('events_England.json') as stream:
   while chunk:=stream.read(1024*1024):digest.update(chunk)
  member_hash=digest.hexdigest()
  if member_hash!='301599543aa1a7fa457bb8ef33c9fe860bf81dca65d418d618d68abcda3defad':raise ValueError('WYSCOUT_EVENT_MEMBER_CHANGED')
  retained=[];seen=set();types=collections.Counter();periods=collections.Counter();total=0
  with archive.open('events_England.json') as raw:
   for event in objects(io.TextIOWrapper(raw,encoding='utf-8')):
    event_id=event['id']
    if event_id in seen:raise ValueError('WYSCOUT_DUPLICATE_ORIGINAL_EVENT')
    seen.add(event_id);total+=1;types[str((event['eventId'],str(event['subEventId'])))]+=1;periods[event['matchPeriod']]+=1
    tags={tag['id'] for tag in event['tags']}
    if event['eventId']==10 or event['eventId']==3 and event['subEventId'] in [33,35] or 101 in tags or 102 in tags:retained.append(event)
 projection={'projectionVersion':'WYSCOUT_FULL_PASS_NATIVE_SHOT_PROJECTION-v1','originalZipSha256':PINS[0][5], 'originalMemberSha256':member_hash,'totalEvents':total,'uniqueEventIds':len(seen),'eventTypeCounts':dict(sorted(types.items())),'periodCounts':dict(sorted(periods.items())),'events':retained}
 data=json.dumps(projection,separators=(',',':'),ensure_ascii=False).encode()
 if total!=643150 or hashlib.sha256(data).hexdigest()!='627c31f38e33e90dd0cfeff07ba5527e69c191f31801dce2b6b504c83f38480c':raise ValueError('WYSCOUT_FULL_PASS_PROJECTION_CHANGED')
 target=root/'events_England.native-shots.json';temporary=target.with_suffix('.json.part');temporary.write_bytes(data);temporary.replace(target)
 receipt={'version':'WYSCOUT_FULL_PASS_NATIVE_SHOT_PROJECTION-v1','completedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceEvents':total,'retainedNativeEvents':len(retained),'projectionSha256':hashlib.sha256(data).hexdigest(),'originalEventMemberSha256':member_hash,'license':'CC BY 4.0','collectionDoi':'10.6084/m9.figshare.c.4415000.v5','sourceScope':'EPL_2017_18_ONLY_NOT_CURRENT_SEASON_OR_UCL','reconstruction':'Every original event read; only shot/goalaudit native events retained, no outcome-selected match sampling.'}
 (root/'collection-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))

if __name__=='__main__':main()
