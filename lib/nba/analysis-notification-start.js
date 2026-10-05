// Begin inside the click gesture, but never hold analysis behind push setup.
export function prepareNbaNotification(control) {
  try { Promise.resolve(control?.prepare()).catch(() => {}); } catch {}
}
