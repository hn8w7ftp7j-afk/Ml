import fs from 'node:fs';

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, value) { fs.writeFileSync(path, value); }
function replaceExact(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one match, found ${count}`);
  return source.replace(before, after);
}
function replaceCount(source, before, after, expected, label) {
  const count = source.split(before).length - 1;
  if (count !== expected) throw new Error(`${label}: expected ${expected} matches, found ${count}`);
  return source.split(before).join(after);
}

// 1) MLB standalone context: honest lineup status and expected starter workload.
{
  const path = 'lib/mlb-context-v11.js';
  let source = read(path);
  source = replaceExact(
    source,
    "export const MLB_CONTEXT_V11_VERSION = 'MLB-STANDALONE-POINT-IN-TIME-CONTEXT-2026-08-v10.2.0';",
    "export const MLB_CONTEXT_V11_VERSION = 'MLB-STANDALONE-POINT-IN-TIME-CONTEXT-2026-08-v10.3.0';",
    'MLB context version',
  );
  source = replaceExact(
    source,
    "  if (!awayStarter.available) Object.assign(awayStarter, { ...awayPitching, status: FEATURE_STATUS.PROJECTED, projectedFromTeamPitching: true });\n  if (!homeStarter.available) Object.assign(homeStarter, { ...homePitching, status: FEATURE_STATUS.PROJECTED, projectedFromTeamPitching: true });",
    "  if (!awayStarter.available) Object.assign(awayStarter, { ...awayPitching, status: FEATURE_STATUS.PROJECTED, projectedFromTeamPitching: true });\n  if (!homeStarter.available) Object.assign(homeStarter, { ...homePitching, status: FEATURE_STATUS.PROJECTED, projectedFromTeamPitching: true });\n  const expectedStarterInnings = starter => {\n    if (starter?.projectedFromTeamPitching === true) return 5.0;\n    const starts = Math.max(0, finite(starter?.gamesStarted, 0));\n    const innings = Math.max(0, finite(starter?.inningsPitched, 0));\n    return clamp(starts >= 2 ? innings / starts : 5.2, 1.0, 7.2);\n  };\n  awayStarter.expectedInnings = expectedStarterInnings(awayStarter);\n  homeStarter.expectedInnings = expectedStarterInnings(homeStarter);",
    'starter expected innings',
  );
  source = replaceExact(
    source,
    "{ name: 'lineups', status: FEATURE_STATUS.PROJECTED, core: false }",
    "{ name: 'lineups', status: FEATURE_STATUS.MISSING, core: false }",
    'lineup status honesty',
  );
  source = replaceExact(source, "'V10.1比分核心已完全切離Legacy context與Legacy distribution。'", "'V10.3比分核心維持完全切離Legacy context與Legacy distribution。'", 'context warning version');
  source = replaceExact(
    source,
    "'正式打線未公布時使用球隊point-in-time進攻投影，不虛構個別打序。'",
    "'目前尚未建立可驗證的逐人projected lineup；中央值只使用球隊point-in-time進攻，打線未知以情境不確定性表示並標記MISSING。'",
    'lineup warning',
  );
  write(path, source);
}

// 2) Exact score distribution uses the conservative de-correlated v10.3 run profile.
{
  const path = 'lib/joint-score-v11.js';
  let source = read(path);
  source = replaceExact(
    source,
    "import { sha256 } from './snapshot-v9.js';",
    "import { sha256 } from './snapshot-v9.js';\nimport { estimateRunProfileV103, MLB_RUN_MODEL_V103_VERSION } from './mlb-run-model-v103.js';",
    'run model import',
  );
  source = replaceExact(source, "export const JOINT_SCORE_V11_VERSION = 'BASEBALL-EXACT-JOINT-SCORE-2026-08-v10.2.0';", "export const JOINT_SCORE_V11_VERSION = 'BASEBALL-EXACT-JOINT-SCORE-2026-08-v10.3.0';", 'joint v11 version');
  source = replaceExact(source, '  const profile = estimateRunProfileV11(context);', '  const profile = estimateRunProfileV103(context);', 'run profile activation');
  source = replaceExact(
    source,
    '    version: JOINT_SCORE_V11_VERSION,\n    quadratureVersion: SCENARIO_QUADRATURE_VERSION,',
    '    version: JOINT_SCORE_V11_VERSION,\n    runProfileVersion: MLB_RUN_MODEL_V103_VERSION,\n    quadratureVersion: SCENARIO_QUADRATURE_VERSION,',
    'run profile identity',
  );
  write(path, source);
}

{
  const path = 'lib/joint-score-v12.js';
  let source = read(path);
  source = replaceExact(source, "export const JOINT_SCORE_V12_VERSION = 'BASEBALL-EXACT-JOINT-SCORE-WITH-EXTRAS-2026-08-v10.2.0';", "export const JOINT_SCORE_V12_VERSION = 'BASEBALL-EXACT-JOINT-SCORE-WITH-EXTRAS-2026-08-v10.3.0';", 'joint v12 version');
  write(path, source);
}
