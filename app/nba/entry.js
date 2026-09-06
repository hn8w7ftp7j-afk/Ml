'use client';

import { Component, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import dynamic from 'next/dynamic';
import styles from './nba.module.css';

const NbaWorkspace = dynamic(() => import('./workspace.js'), { loading: () => <p className={styles.loading} role="status">正在開啟 NBA 資料…</p> });

class NbaErrorBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <div className={styles.error} role="alert">NBA 畫面載入失敗。請關閉後重新開啟；原本聯盟畫面仍保留。</div> : this.props.children;
  }
}

export default function NbaEntry() {
  const [mounted, setMounted] = useState(false);
  const [opened, setOpened] = useState(false);
  const dialog = useRef(null);
  useEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    if (opened && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [opened]);
  function close() { dialog.current?.close(); setOpened(false); }
  return <>
    <button type="button" onClick={() => setOpened(true)} aria-haspopup="dialog"><span className="leagueDot"/><b>NBA</b><small>籃球資料</small></button>
    {mounted && createPortal(<dialog className={styles.dialog} ref={dialog} aria-label="NBA 籃球資料" onClose={() => setOpened(false)}>
      <div className={styles.closeBar}><button type="button" onClick={close} aria-label="關閉 NBA">關閉 NBA ×</button></div>
      {opened && <NbaErrorBoundary><NbaWorkspace onClose={close}/></NbaErrorBoundary>}
    </dialog>, document.body)}
  </>;
}
