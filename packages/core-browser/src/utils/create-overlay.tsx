import React from 'react';
import ReactDOMClient from 'react-dom/client';

export const destroyFns: Array<() => void> = [];

export function destroyAllOverlays() {
  while (destroyFns.length) {
    const close = destroyFns.pop();
    if (close) {
      close();
    }
  }
}

export function createOverlay(children: React.ReactElement) {
  const div = document.createElement('div');
  const root = ReactDOMClient.createRoot(div);
  document.body.appendChild(div);

  let destroyed = false;

  function destroy() {
    if (destroyed) {
      return;
    }
    destroyed = true;
    root.unmount();
    if (div.parentNode) {
      div.parentNode.removeChild(div);
    }
    for (let i = 0; i < destroyFns.length; i++) {
      const fn = destroyFns[i];
      if (fn === close) {
        destroyFns.splice(i, 1);
        break;
      }
    }
  }

  function render(comp: React.ReactElement) {
    if (!destroyed) {
      root.render(React.cloneElement(comp));
    }
  }

  function update(newChildren: React.ReactElement) {
    render(newChildren);
  }

  function close() {
    destroy();
  }

  render(children);

  destroyFns.push(close);

  return {
    destroy: close,
    update,
  };
}
