"""Read-only CPBL personnel audit. Official post-start records, never model inputs."""
import argparse
import base64
import concurrent.futures
import datetime as dt
import gzip
import hashlib
import json
from pathlib import Path
import re
import urllib.request

TEAM_CODES = {'CTB': 'ACN011', 'UNI': 'ADD011', 'RKM': 'AJL011',
              'FUB': 'AEO011', 'WCD': 'AAA011', 'TSG': 'AKP011'}
POSITION = re.compile(r'^(P|C|1B|2B|3B|SS|LF|CF|RF|DH)(?:\(|$)')


def utcnow():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def clean(value):
    return str(value or '').strip()


def number(value):
    try:
        return float(value)
    except (ValueError, TypeError):
        return None


def parse_cpbl_actual(payload, expected):
    root = payload.get('Data', payload.get('data', {}))
    root = root.get('Game', root.get('game', root))
    if not isinstance(root, dict):
        raise ValueError('INVALID_CPBL_GAME_PAYLOAD')
    issues = []
    identity = {'providerGameId': root.get('GameId'), 'officialDate': clean(root.get('PreExeDate'))[:10],
                'expectedOfficialDate': expected.get('officialDate'),
                'scheduledLocalStart': root.get('PreExeDate'), 'kindCode': root.get('KindCode')}
    identity_ok = clean(root.get('GameId')) == clean(expected.get('providerGameId'))
    if not identity_ok:
        issues.append('GAME_ID_MISMATCH')
    identity['dateAlignment'] = 'MATCH' if identity['officialDate'] == expected.get('officialDate') else 'DATE_CHANGED'
    if identity['dateAlignment'] != 'MATCH':
        issues.append('OFFICIAL_GAME_DATE_CHANGED')
    for side, source_side in [('away', 'Visiting'), ('home', 'Home')]:
        team = root.get(source_side, {}).get('Team', {})
        identity[side] = {'code': team.get('Code'), 'name': team.get('Name')}
        expected_code = TEAM_CODES.get(expected.get(side + 'Code'))
        if not expected_code or clean(team.get('Code')) != expected_code:
            identity_ok = False
            issues.append(side.upper() + '_TEAM_IDENTITY_NOT_VERIFIED')
    identity['status'] = 'PASS' if identity_ok else 'NOT_VERIFIED'
    logs = root.get('LiveLog') or []
    has_pitch = any(number(row.get('PitchCnt')) and row.get('PitcherAcnt') for row in logs)
    post_start = root.get('GameStatus') == 'FINISHED' or has_pitch
    output = {'league': 'CPBL', 'providerGameId': expected.get('providerGameId'),
              'officialDate': expected.get('officialDate'), 'actualOfficialDate': identity['officialDate'], 'status': root.get('GameStatus'),
              'identity': identity, 'sources': [], 'issues': issues}
    for side, source_side, pitching_half in [('away', 'Visiting', '2'), ('home', 'Home', '1')]:
        block = root.get(source_side, {})
        half_logs = sorted((r for r in logs if clean(r.get('VisitingHomeType')) == pitching_half
                            and number(r.get('InningSeq')) == 1), key=lambda r: clean(r.get('MainEventNo')))
        first = next((r for r in half_logs if number(r.get('PitchCnt'))
                      and r.get('PitcherAcnt') and clean(r.get('IsChangePlayer')) != '1'), None)
        first_pitcher = {'status': 'PASS' if first and identity_ok and post_start else 'NOT_VERIFIED',
                         'id': clean(first.get('PitcherAcnt')) if first else None,
                         'name': clean(first.get('PitcherName')) if first else None,
                         'method': 'FIRST_THROWN_PITCH_IN_FIRST_INNING',
                         'eventNo': first.get('MainEventNo') if first else None}
        starters = [p for p in block.get('Pitchers', []) if clean(p.get('RoleType')) == '先發']
        starter = {'status': 'NOT_VERIFIED', 'id': None, 'name': None}
        scorebook_starter = {'status': 'NOT_VERIFIED', 'id': None, 'name': None}
        if len(starters) == 1 and identity_ok and post_start:
            p = starters[0]
            starter = {'status': 'PASS', 'id': clean(p.get('PitcherAcnt')), 'name': clean(p.get('PitcherName')),
                       'method': 'OFFICIAL_EXPLICIT_STARTER_ROLE', 'sourcePath': f'$.Data.{source_side}.Pitchers[RoleType=先發]'}
            if not starter['id'] or not starter['name']:
                starter['status'] = 'NOT_VERIFIED'
            scorebook_starter = dict(starter)
            starter['firstInningPitcherId'] = first.get('PitcherAcnt') if first else None
            starter['firstInningPitcherName'] = first.get('PitcherName') if first else None
            if first and clean(first.get('PitcherAcnt')) != starter['id']:
                change = next((r for r in half_logs if clean(r.get('IsChangePlayer')) == '1'
                               and number(r.get('PitchCnt')) == 0
                               and clean(r.get('PitcherAcnt')) == scorebook_starter['id']
                               and clean(r.get('MainEventNo')) < clean(first.get('MainEventNo'))
                               and '更換投手' in clean(r.get('Content'))
                               and clean(first.get('PitcherName')) in clean(r.get('Content'))), None)
                if change and any(clean(p.get('PitcherAcnt')) == clean(first.get('PitcherAcnt')) for p in block.get('Pitchers', [])):
                    starter = {'status': 'PASS', 'id': clean(first.get('PitcherAcnt')), 'name': clean(first.get('PitcherName')),
                               'method': 'ACTUAL_FIRST_THROWN_PITCH_WITH_PRESTART_CHANGE',
                               'sourcePath': '$.Data.LiveLog', 'firstPitchEvidence': first_pitcher,
                               'changeEventNo': change.get('MainEventNo'), 'changeText': change.get('Content')}
                    issues.append(side.upper() + '_STARTER_CHANGED_BEFORE_FIRST_PITCH')
                else:
                    starter['status'] = 'NOT_VERIFIED'
                    issues.append(side.upper() + '_STARTER_ROLE_LIVELOG_CONFLICT')
            elif first:
                starter['firstPitchEvidence'] = first_pitcher
        else:
            issues.append(side.upper() + '_STARTER_NOT_VERIFIED')
        players = []
        unresolved = []
        # A bare opening position identifies a starter; parenthesized-only roles
        # are substitutions. Preserve a starter even if they had zero PA.
        for order in range(1, 10):
            candidates = [h for h in block.get('Hitters', []) if number(h.get('Lineup')) == order
                          and POSITION.match(clean(h.get('DefendStation')))]
            if len(candidates) != 1:
                unresolved.append(order)
                continue
            h = candidates[0]
            players.append({'order': order, 'id': clean(h.get('HitterAcnt')), 'name': clean(h.get('HitterName')),
                            'position': clean(h.get('DefendStation')), 'plateAppearances': number(h.get('PlateAppearances'))})
        unique_ids = {p['id'] for p in players if p['id']}
        verified = identity_ok and post_start and not unresolved and len(players) == 9 and len(unique_ids) == 9
        lineup = {'status': 'PASS' if verified else 'NOT_VERIFIED', 'players': players,
                  'method': 'NINE_UNIQUE_SLOTS_WITH_EXPLICIT_INITIAL_DEFENSIVE_POSITION',
                  'unresolvedOrders': unresolved, 'sourcePath': f'$.Data.{source_side}.Hitters'}
        if not verified:
            issues.append(side.upper() + '_STARTING_NINE_NOT_VERIFIED')
        output[side] = {'starter': starter, 'scorebookStarter': scorebook_starter, 'firstThrownPitcher': first_pitcher, 'lineup': lineup,
                        'beforeFirstPitchChanges': [r.get('Content') for r in half_logs
                                                   if clean(r.get('IsChangePlayer')) == '1'
                                                   and first and clean(r.get('MainEventNo')) < clean(first.get('MainEventNo'))],
                        'participants': [{'id': clean(h.get('HitterAcnt')), 'name': clean(h.get('HitterName')),
                                          'order': number(h.get('Lineup')), 'position': clean(h.get('DefendStation'))}
                                         for h in block.get('Hitters', [])],
                        'pitchers': [{'id': clean(p.get('PitcherAcnt')), 'name': clean(p.get('PitcherName')),
                                      'role': clean(p.get('RoleType'))} for p in block.get('Pitchers', [])]}
    output['umpires'] = {'status': 'PASS' if identity_ok and post_start and any(
        r.get('Job') == '主審' and clean(r.get('Name')) for r in root.get('Referee', [])) else 'NOT_VERIFIED',
        'officials': [{'role': clean(r.get('Job')), 'name': clean(r.get('Name'))}
                     for r in root.get('Referee', []) if clean(r.get('Name'))], 'sourcePath': '$.Data.Referee'}
    return output


def fetch_cpbl_actual(game, directory):
    provider_id = clean(game.get('providerGameId'))
    if not re.fullmatch(r'\d{4}-A-\d{1,4}', provider_id):
        raise ValueError('INVALID_CPBL_PROVIDER_ID')
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    raw_path = directory / f'{provider_id}.json'
    receipt_path = directory / f'{provider_id}.receipt.json'
    url = 'https://stats.cpbl.com.tw/api/proxy/v1/games/' + provider_id
    if raw_path.exists() and receipt_path.exists():
        raw = raw_path.read_bytes()
        receipt = json.loads(receipt_path.read_text())
        if hashlib.sha256(raw).hexdigest() != receipt['sha256']:
            raise ValueError('RAW_RECEIPT_HASH_MISMATCH')
    else:
        started = utcnow()
        request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'})
        with urllib.request.urlopen(request, timeout=40) as response:
            raw = response.read()
            receipt = {'url': url, 'method': 'GET', 'requestedAt': started, 'fetchedAt': utcnow(),
                       'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw), 'statusCode': response.status,
                       'rawFile': str(raw_path)}
        json.loads(raw)
        raw_path.write_bytes(raw)
        receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2))
    result = parse_cpbl_actual(json.loads(raw), game)
    result['sources'] = [receipt]
    (directory / f'{provider_id}.personnel.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return result

