from pathlib import Path

path = Path('scripts/apply-scoring-validation-v8-2.py')
text = path.read_text()
old = """t = replace_once(t, '        integrityWarning: integrity.warning,', '        integrityWarning: integrity.warning || scoreAuditFailed,', 'result integrity warning')
t = replace_once(t, '        integrityMessage: integrity.message,', \"        integrityMessage: scoreAuditFailed ? scoreAudit.errors.join('；') : integrity.message,\", 'result integrity message')
t = replace_once(t, '        score,\\n        scoreBand:', '        score,\\n        scoreContractVersion: SCORE_CONTRACT_VERSION,\\n        scoreAudit,\\n        scoreBand:', 'result score audit metadata')"""
new = """t = replace_once(
    t,
    '        scenarioSensitivity: sensitivity,\\n        integrityWarning: integrity.warning,\\n        integrityMessage: integrity.message,\\n        confidence: profile.quality,\\n        score,\\n        scoreBand:',
    \"        scenarioSensitivity: sensitivity,\\n        integrityWarning: integrity.warning || scoreAuditFailed,\\n        integrityMessage: scoreAuditFailed ? scoreAudit.errors.join('；') : integrity.message,\\n        confidence: profile.quality,\\n        score,\\n        scoreContractVersion: SCORE_CONTRACT_VERSION,\\n        scoreAudit,\\n        scoreBand:\",
    'result score audit metadata block',
)"""
if old not in text:
    raise SystemExit('patcher result metadata repair target missing')
path.write_text(text.replace(old, new, 1))
print('scoring patcher repaired')
