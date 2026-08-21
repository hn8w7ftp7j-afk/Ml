import fs from 'node:fs';
const path = 'app/page.js';
let s = fs.readFileSync(path, 'utf8');
const importAnchor = "import { summarizeBetLedger } from '../lib/bet-stats.js';";
if (!s.includes("auditModelDirection")) s = s.replace(importAnchor, importAnchor + "\nimport { auditModelDirection } from '../lib/model-qa-v2.js';");
const metaAnchor = '      <div className="scoreMeta">{scoreMetaText}</div>';
const qaUi = `      <div className="scoreMeta">{scoreMetaText}</div>
      {(() => {
        const qa2 = auditModelDirection(row);
        if (qa2.status === 'PASS') return <div className="qaLine">QA 2.0：PASS｜未發現額外合理性異常</div>;
        return <details className="auditWarnings" open={qa2.status === 'ERROR'}>
          <summary>QA 2.0：{qa2.status === 'ERROR' ? 'ERROR' : 'WARN'}｜{qa2.issues.length} 項診斷</summary>
          <div>{qa2.issues.map(item => (item.level === 'ERROR' ? '⛔ ' : '⚠️ ') + item.message).join('；')}</div>
          <small>僅診斷：不修改W、R、S或影子排名。</small>
        </details>;
      })()}`;
if (!s.includes('QA 2.0：PASS')) {
  if (!s.includes(metaAnchor)) throw new Error('score meta anchor missing');
  s = s.replace(metaAnchor, qaUi);
}
fs.writeFileSync(path, s);
