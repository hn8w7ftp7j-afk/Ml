"""Read-only official CPBL history acquisition. Never writes application data.

Usage: python research/cpbl-acquire-history.py DATA_DIR [PRIOR_AUDIT_DIR]
Monthly schedule files and hash receipts must already exist in DATA_DIR.
"""
import concurrent.futures
import datetime as dt
import hashlib
import json
from pathlib import Path
import shutil
import sys
from cpbl_actual_personnel import TEAM_CODES, fetch_cpbl_actual

directory = Path(sys.argv[1]).resolve()
prior = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else None
protocol_path = Path(__file__).with_name('cpbl-complete-history-protocol.json')
protocol = json.loads(protocol_path.read_text())
cutoff = dt.datetime.fromisoformat(protocol['cutoff'].replace('Z', '+00:00'))
ids = dict(zip(TEAM_CODES, [701, 702, 703, 704, 705, 706]))
codes = {value: key for key, value in TEAM_CODES.items()}
by_id, schedule_receipts, failures, empty_months = {}, [], [], []
for year in protocol['seasons']:
    for month in protocol['months']:
        stem = f'schedule-{year}-{month:02d}'
        try:
            raw = (directory / f'{stem}.json').read_bytes()
            receipt = json.loads((directory / f'{stem}.receipt.json').read_text())
            assert hashlib.sha256(raw).hexdigest() == receipt['sha256']
            rows = json.loads(raw)['Data']['Games']
            assert isinstance(rows, list)
            schedule_receipts.append(receipt)
            if not rows:
                empty_months.append(stem)
            for row in rows:
                if row.get('KindCode') == 'A':
                    by_id.setdefault(row['GameId'], []).append(row)
        except Exception as exc:
            failures.append({'source': stem, 'error': str(exc)})

def acquire(item):
    provider_id, schedules = item
    latest = max(schedules, key=lambda row: row.get('PreExeDate', ''))
    # The detail response is authoritative for actual date/status. Request any
    # ID with a scheduled occurrence before cutoff, including rescheduled IDs.
    if not any(dt.datetime.fromisoformat(row['PreExeDate']).replace(tzinfo=dt.timezone(dt.timedelta(hours=8))) < cutoff for row in schedules):
        return {'providerGameId': provider_id, 'status': 'FUTURE_SCHEDULE'}
    try:
        away = codes[latest['Visiting']['Team']['Code']]
        home = codes[latest['Home']['Team']['Code']]
        teams = {(row['Visiting']['Team']['Code'], row['Home']['Team']['Code']) for row in schedules}
        assert len(teams) == 1, 'CONFLICTING_SCHEDULE_TEAMS'
        game = {'providerGameId': provider_id, 'league': 'CPBL',
                'officialDate': latest['PreExeDate'][:10],
                'awayCode': away, 'homeCode': home,
                'awayTeamId': ids[away], 'homeTeamId': ids[home]}
        reused = False
        if prior and not (directory / f'{provider_id}.json').exists():
            cached = prior / f'{provider_id}.json'
            cached_receipt = prior / f'{provider_id}.receipt.json'
            if cached.exists() and cached_receipt.exists():
                receipt = json.loads(cached_receipt.read_text())
                assert hashlib.sha256(cached.read_bytes()).hexdigest() == receipt['sha256']
                shutil.copy2(cached, directory / cached.name)
                shutil.copy2(cached_receipt, directory / cached_receipt.name)
                reused = True
        personnel = fetch_cpbl_actual(game, directory)
        assert personnel['identity']['status'] == 'PASS', 'DETAIL_IDENTITY_NOT_VERIFIED'
        start = personnel['identity']['scheduledLocalStart']
        actual = dt.datetime.fromisoformat(start).replace(tzinfo=dt.timezone(dt.timedelta(hours=8)))
        game.update(gameDate=actual.isoformat(), officialDate=actual.date().isoformat())
        status = 'ELIGIBLE' if personnel['status'] == 'FINISHED' and actual < cutoff else 'NOT_FINISHED_BY_CUTOFF'
        return {'providerGameId': provider_id, 'status': status, 'game': game,
                'scheduleOccurrences': len(schedules), 'reusedAuditRaw': reused}
    except Exception as exc:
        return {'providerGameId': provider_id, 'status': 'ERROR', 'error': str(exc)}

results = []
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
    futures = {executor.submit(acquire, item): item[0] for item in sorted(by_id.items())}
    for future in concurrent.futures.as_completed(futures):
        result = future.result()
        results.append(result)
        if len(results) % 20 == 0 or result['status'] == 'ERROR':
            print(json.dumps({'done': len(results), 'total': len(by_id), 'last': result['providerGameId'], 'status': result['status']}, ensure_ascii=False), flush=True)
        (directory / 'acquisition-checkpoint.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
manifest = {'protocolSha256': hashlib.sha256(protocol_path.read_bytes()).hexdigest(),
            'cutoff': protocol['cutoff'], 'scheduleReceipts': schedule_receipts,
            'scheduleFailures': failures, 'emptyScheduleMonths': empty_months,
            'seasonScheduleGames': {str(year): sum(key.startswith(str(year) + '-') for key in by_id) for year in protocol['seasons']},
            'rows': sorted(results, key=lambda row: row['providerGameId'])}
(directory / 'history-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
print(json.dumps({'complete': True, 'seasonScheduleGames': manifest['seasonScheduleGames'], 'scheduleFailures': failures,
                  'statuses': {status: sum(r['status'] == status for r in results) for status in sorted({r['status'] for r in results})}}, ensure_ascii=False))
