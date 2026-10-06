import json,pathlib,hashlib,sys
# Arguments: retained archive root, verified full-history JSON, output JSON.
root=pathlib.Path(sys.argv[1]);src=pathlib.Path(sys.argv[2]);manifest=json.loads((root/'manifest.json').read_text());history=json.loads(src.read_text());rows=[]
for row in history['rows']:
 b=(root/'checkpoints'/row['checkpoint']).read_bytes();digest=hashlib.sha256(b).hexdigest();assert digest==row['checkpointSha256']==manifest['sha256']['checkpoints/'+row['checkpoint']]
 r=json.loads(b)['result'];g=r['data']['game'];assert r['status']=='ready' and r['qa']['status']!='BLOCK' and g['completed'] and g['status']=='final'
 assert (g['id'],g['taipeiDate'],g['startTime'],g['season']['year'],g['seasonType'],g['home']['id'],g['away']['id'],g['home']['score'],g['away']['score'])==(row['gameId'],row['date'],row['startTime'],row['year'],row['seasonType'],row['homeId'],row['awayId'],row['homeScore'],row['awayScore'])
 periods=[g[s]['periodScores'] for s in ['home','away']];assert len(periods[0])==len(periods[1])>=4
 for side,p in zip(['home','away'],periods):
  assert [x['period'] for x in p]==list(range(1,len(p)+1)) and all(type(x['score'])==int and x['score']>=0 for x in p) and sum(x['score'] for x in p)==g[side]['score']
 rows.append({**{k:row[k] for k in ['gameId','date','year','seasonType','homeId','awayId','homeScore','awayScore','neutralSite']},'homeHalf':sum(x['score'] for x in periods[0][:2]),'awayHalf':sum(x['score'] for x in periods[1][:2]),'checkpointSha256':digest})
out={'kind':'NBA_VERIFIED_ARCHIVED_QUARTER_HISTORY','sourceArchiveSha256':history['sourceArchiveSha256'],'strictPointInTime':False,'rows':rows};pathlib.Path(sys.argv[3]).write_text(json.dumps(out));print(json.dumps({'verifiedGames':len(rows),'OTGames':sum(len(json.loads((root/'checkpoints'/x['checkpoint']).read_text())['result']['data']['game']['home']['periodScores'])>4 for x in history['rows']),'firstGame':rows[0]}))
