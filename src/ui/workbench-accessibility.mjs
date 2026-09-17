// Shared by the web template and the desktop bridge. No application state.
const focusable = 'button, input, select, textarea, a[href], summary, [tabindex]';
const available = node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length > 0;

export function createOverlayController(doc) {
  let active = null;
  let trigger = null;
  const background = new Map();
  const controls = () => [...active.querySelectorAll(focusable)].filter(available);
  const enter = () => (controls()[0] || active).focus({preventScroll: true});
  const keydown = event => {
    if (!active || event.key !== 'Tab') return;
    const items = controls();
    const index = items.indexOf(doc.activeElement);
    if (!items.length || index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === items.length - 1) {
      event.preventDefault();
      (event.shiftKey ? items.at(-1) || active : items[0] || active).focus({preventScroll: true});
    }
  };
  const focusin = event => {
    if (active && !active.contains(event.target)) enter();
  };
  return {
    open(node) {
      if (active) this.close();
      trigger = doc.activeElement;
      active = node;
      node.tabIndex = -1;
      // Inert siblings along the ancestor path: works even when the desktop
      // bridge nests overlays inside the results column.
      for (let branch = node; branch && branch !== doc.body; branch = branch.parentElement) {
        for (const sibling of branch.parentElement.children) {
          if (sibling === branch || sibling.id === 'overlayScrim') continue;
          background.set(sibling, sibling.inert);
          sibling.inert = true;
        }
      }
      doc.addEventListener('keydown', keydown, true);
      doc.addEventListener('focusin', focusin, true);
      enter();
    },
    close() {
      if (!active) return;
      active = null;
      doc.removeEventListener('keydown', keydown, true);
      doc.removeEventListener('focusin', focusin, true);
      for (const [node, inert] of background) node.inert = inert;
      background.clear();
      if (trigger?.isConnected && available(trigger)) trigger.focus({preventScroll: true});
      trigger = null;
    },
  };
}

// Capture logical field identity before a legacy renderer replaces its subtree.
// If an edit removes that field, return to its armor-row summary instead.
export function captureEditorFocus(root) {
  const active = root.ownerDocument.activeElement;
  if (!root.contains(active)) return () => {};
  const id = active.id;
  const action = active.getAttribute('onchange');
  const index = active.closest('[data-index]')?.dataset.index;
  return () => {
    const candidates = [...root.querySelectorAll(focusable)];
    const replacement = candidates.find(node => id ? node.id === id
      : action && node.getAttribute('onchange') === action);
    const row = [...root.querySelectorAll('[data-index]')].find(node => node.dataset.index === index);
    const target = replacement && available(replacement) ? replacement : row?.querySelector('summary');
    target?.focus({preventScroll: true});
  };
}
