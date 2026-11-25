'use client';
import { useState } from 'react';

export function SoccerDeferredDetails({ className, label, children }) {
  const [visited, setVisited] = useState(false);
  function handleToggle(event) {
    if (event.target === event.currentTarget && event.currentTarget.open) setVisited(true);
  }
  return <details className={className} onToggle={visited ? undefined : handleToggle}>
    <summary>{label}</summary>
    {visited && children()}
  </details>;
}
