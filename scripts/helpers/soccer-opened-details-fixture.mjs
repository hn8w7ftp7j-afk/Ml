import { createElement } from 'react';

// Static markup fixtures inspect the content a reader sees after opening the disclosure.
export function OpenedSoccerDetails({ className, label, children }) {
  return createElement('details', { className, open: true },
    createElement('summary', null, label), children());
}
