"""Render a self-contained Chinese report from verified evaluation results."""
import html
import json
from pathlib import Path
import sys

data, destination = map(Path, sys.argv[1:3])
result = json.loads((data / 'evaluation-results.json').read_text())
verification = json.loads((data / 'verification.json').read_text())
assert verification['status'] == 'PASS'
teams = {'701': '中信兄弟', '702': '統一獅', '703': '樂天桃猿', '704': '富邦悍將', '705': '味全龍', '706': '台鋼雄鷹'}
escape = html.escape
percent = lambda x: '—' if x is None else f'{100*x:.1f}%'
def method_rows(summary):
    methods = [('現行公式／6 場歷史', summary['old']), ('候選公式／24 場歷史', summary['next']),
               ('現行公式／24 場歷史', summary['diagnostics']['baseline24']), ('候選公式／6 場歷史', summary['diagnostics']['candidate6'])]
    return ''.join(f'<tr><th>{label}</th><td>{m["covered"]}/{m["eligible"]} · {percent(m["coverage"])}</td><td>{m["correct"]}/{m["eligible"]} · {percent(m["top1All"])}</td><td>{percent(m["top1Covered"])}</td><td>{percent(m["candidateRecallAll"])}</td></tr>' for label, m in methods)
def table(summary):
    return '<div class="scroll"><table><thead><tr><th>方法</th><th>可預估／全部</th><th>首選命中／全部</th><th>可預估時命中率</th><th>實際投手在候選名單內</th></tr></thead><tbody>' + method_rows(summary) + '</tbody></table></div>'
def breakdown(groups, labels=None):
    rows = []
    for key, s in groups.items():
        old, new = s['old'], s['next']
        rows.append(f'<tr><th>{escape((labels or {}).get(key, key))}</th><td>{old["eligible"]}</td><td>{old["correct"]} · {percent(old["top1All"])}</td><td>{new["correct"]} · {percent(new["top1All"])}</td><td>{old["covered"]} / {new["covered"]}</td></tr>')
    return '<div class="scroll"><table><thead><tr><th>分組</th><th>球隊場次</th><th>現行 6 場：首選命中</th><th>候選 24 場：首選命中</th><th>兩者可預估場次</th></tr></thead><tbody>' + ''.join(rows) + '</tbody></table></div>'

dataset = result['dataset']
summary = result['summary']
common = summary['all']['common']
acquisition = result['acquisition']
body = f'''<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>中職先發推估擴大驗證｜2026-09-23</title>
<style>body{{margin:0;background:#f3f5f7;color:#182737;font:16px/1.75 system-ui,"Noto Sans TC",sans-serif}}main{{max-width:1080px;margin:auto;padding:42px 24px}}h1{{font-size:32px;line-height:1.35}}h2{{font-size:23px;margin-top:36px}}p{{max-width:920px}}.eyebrow{{font-size:13px;color:#456278;letter-spacing:.1em}}.card{{background:white;padding:24px;border-radius:12px;margin:18px 0;border:1px solid #dce3e9}}.decision{{border-left:5px solid #bc7900}}.metrics{{display:flex;gap:18px;flex-wrap:wrap}}.metric{{flex:1;min-width:160px}}.metric strong{{display:block;font-size:32px;color:#114e68}}small,.muted{{color:#5b6876}}.scroll{{overflow:auto}}table{{width:100%;border-collapse:collapse;background:white;font-size:14px}}th,td{{padding:12px;text-align:left;border-bottom:1px solid #dce3e9;white-space:nowrap}}thead{{background:#e8eef3}}tbody th{{font-weight:500}}li{{margin:7px 0}}code{{overflow-wrap:anywhere;font-size:12px}}a{{color:#075985}}@media print{{body{{background:white}}main{{padding:0}}.card{{break-inside:avoid}}}}</style>
<main><div class="eyebrow">CPBL · OFFLINE VALIDATION · 2026-09-23</div><h1>中職先發投手推估<br>擴大歷史驗證</h1>
<p>將原本少量查核樣本擴大至官方賽程可取得的已完賽紀錄。每場分主、客隊比較，驗證的是「實際第一位投球者」，不是比分、勝率或投注收益。</p>
<p><strong>本次測的是未公布先發時使用的輪值推估公式。</strong>為公平比较，每個歷史場次都套用公式；沒有模擬當天是否已取得官方先發公告，因此這些比率不代表網站全部先發名單的正確率。</p>
<div class="metrics"><div class="card metric"><strong>{dataset['games']}</strong>已完賽比賽</div><div class="card metric"><strong>{dataset['sides']}</strong>已確認先發的球隊場次</div><div class="card metric"><strong>{summary['newlyAcquired']['old']['eligible']}</strong>原查核樣本以外的球隊場次</div></div>
<p class="muted">比賽日期：{dataset['firstDate']} 至 {dataset['lastDate']}。統一截止時間：2026-09-23 11:17:27（台灣）。</p>
<div class="card decision"><strong>部署決定：候選公式維持研究狀態。</strong><p>本次沒有更換正式網站的中職輪值公式。2025 年接口全數回傳空賽程，無法提供獨立球季驗證；本次資料也屬賽後取得的歷史重播。部署前仍需前瞻驗證、名單有效性核對及擴大歷史查詢的效能驗證。</p></div>
<h2>全部可核對場次</h2>{table(summary['all'])}
<p>「全部命中率」將無法產生預估的場次保留在分母；「可預估時命中率」僅計算有預估的場次。候選名單越大，名單涵蓋率可能越高，不能直接當作首選準確度。</p>
<h2>原查核樣本以外</h2>{table(summary['newlyAcquired'])}
<p>這組排除先前查核過的比賽。它是新增歷史資料，不是尚未發生比賽的前瞻測試。</p>
<h2>相同比較分母</h2><div class="card">兩種主要方法都有預估：<strong>{common['old']['eligible']}</strong> 個球隊場次。現行命中 {common['old']['correct']} 次，候選命中 {common['next']['correct']} 次；只有現行命中 {common['oldOnlyCorrect']} 次，只有候選命中 {common['nextOnlyCorrect']} 次。完整具備 24 場歷史者共 {summary['all']['complete24HistorySides']} 個球隊場次。</div>
<h2>各月份</h2>{breakdown(summary['byMonth'])}<h2>各球隊</h2>{breakdown(summary['byTeam'], teams)}
<h2>資料與驗證範圍</h2><ul>
<li>2026 年官方賽程去重後 {acquisition['seasonScheduleGames'].get('2026', 0)} 場；賽程讀取失敗 {len(acquisition['scheduleFailures'])} 筆、逐場讀取失敗 {len(acquisition['detailFailures'])} 筆、實際先發無法確認而排除 {len(result['exclusions'])} 個球隊場次。</li>
<li>2025 年十二個月均回傳空清單，不能據此宣稱該球季沒有比賽或驗證通過。</li>
<li>歷史只採同球季、同球隊且台灣日期早於目標賽事的比賽；同日雙重賽採保守排除。方法與參數在計算結果前固定，沒有依本次命中結果調整。</li>
<li>原始資料雜湊、逐場身分、歷史日期、候選權重與彙總分母皆通過獨立檢查。</li>
<li>歷史紀錄可能含賽後修正；缺少獨立完賽時間及當時取得時間，無法完整還原延賽／保留比賽當時可知資訊。候選名單也尚未獨立驗證當日登錄資格。</li>
<li>候選權重是相對排序分數，尚未校準成真實先發機率。</li></ul>
<p class="muted">正式網站：<a href="https://mlb-positive-ev.vercel.app">mlb-positive-ev.vercel.app</a>。本次僅擴大離線驗證。</p>
<details><summary>驗證版本</summary><p>規格：{escape(result['protocol']['protocolVersion'])}</p><p>規格 SHA-256：<code>{result['protocolSha256']}</code></p><p>候選函式 SHA-256：<code>{result['candidateFunctionSha256']}</code></p></details>
</main></html>'''
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(body)
print(json.dumps({'report': str(destination), 'bytes': destination.stat().st_size}, ensure_ascii=False))
