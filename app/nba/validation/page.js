import NbaForwardValidationPanel from '../forward-validation-panel.js';
import { APP_VERSION } from '../../../lib/app-version.js';
export default function NbaValidationPage() {
  return <main><header className="topbar"><h1>NBA 前瞻驗證</h1><span className="version">v{APP_VERSION}</span></header><p><a href="/?sport=NBA">回到 NBA 分析</a>｜<a href="/model-validation">四聯盟驗證說明</a></p><NbaForwardValidationPanel/></main>;
}
