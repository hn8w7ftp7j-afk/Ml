"""Independent evidence/accounting checks for the offline evaluator output."""
import collections
import hashlib
import json
from pathlib import Path
import sys

directory = Path(sys.argv[1])
read = lambda name: json.loads((directory / name).read_text())
result = read('evaluation-results.json')
manifest = read('history-manifest.json')
eligible = {r['providerGameId']: r['game'] for r in manifest['rows'] if r['status'] == 'ELIGIBLE'}
rows = result['rows']
assert len({(r['providerGameId'], r['side']) for r in rows}) == len(rows)
assert len(rows) + len(result['exclusions']) == len(eligible) * 2
for source in result['dataset']['rawFiles']:
    assert hashlib.sha256((directory / (source['providerGameId'] + '.json')).read_bytes()).hexdigest() == source['sha256']
for row in rows:
    target = eligible[row['providerGameId']]
    actual = read(row['providerGameId'] + '.personnel.json')[row['side']]['starter']
    assert actual['status'] == 'PASS' and actual['id'] == row['actual']['id']
    assert len(row['historyIds']) == row['nextHistoryGames'] <= 24
    assert len(set(row['historyIds'])) == len(row['historyIds'])
    for game_id in row['historyIds']:
        previous = eligible[game_id]
        assert previous['officialDate'] < target['officialDate']
        assert previous['officialDate'][:4] == target['officialDate'][:4]
        assert row['teamId'] in [previous['awayTeamId'], previous['homeTeamId']]
    for method in ['old', 'next', 'baseline24', 'candidate6']:
        p = row[method]
        assert p['covered'] == bool(p['top1']) == bool(p['candidates'])
        assert p['correct'] == (p['top1'] == actual['id'])
        assert p['recall'] == any(c['id'] == actual['id'] for c in p['candidates'])
        if p['covered']:
            assert abs(sum(c['weight'] for c in p['candidates']) - 1) < 1e-10
            assert p['top1'] == p['candidates'][0]['id']
def check(rs, summary):
    for method, metric in [('old', summary['old']), ('next', summary['next']),
                           ('baseline24', summary['diagnostics']['baseline24']), ('candidate6', summary['diagnostics']['candidate6'])]:
        assert metric['eligible'] == len(rs)
        for field in ['covered', 'correct', 'recalled']:
            flag = 'recall' if field == 'recalled' else field
            assert metric[field] == sum(r[method][flag] for r in rs)
        assert metric['top1All'] == (metric['correct'] / len(rs) if rs else None)
        assert metric['top1Covered'] == (metric['correct'] / metric['covered'] if metric['covered'] else None)
check(rows, result['summary']['all'])
check([r for r in rows if not r['priorAuditGame']], result['summary']['newlyAcquired'])
for month, summary in result['summary']['byMonth'].items():
    check([r for r in rows if r['date'][:7] == month], summary)
for team, summary in result['summary']['byTeam'].items():
    check([r for r in rows if str(r['teamId']) == team], summary)
print(json.dumps({'status': 'PASS', 'games': len(eligible), 'sides': len(rows),
                  'verified': ['raw hashes', 'unique game sides', 'actual identity', 'strictly prior team history',
                               'same season', 'candidate weights', 'outcome flags', 'summary accounting']}))
