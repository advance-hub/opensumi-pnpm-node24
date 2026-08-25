import React from 'react';
import { act } from 'react-dom/test-utils';

import { createOverlay, destroyAllOverlays, destroyFns } from '../../src/utils/create-overlay';

describe('createOverlay', () => {
  afterEach(() => {
    act(() => destroyAllOverlays());
    jest.restoreAllMocks();
  });

  it('reuses one React root for updates and unmounts it exactly once', async () => {
    expect.hasAssertions();
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const overlay = createOverlay(<span>first</span>);
    await act(async () => Promise.resolve());
    expect(document.body.textContent).toContain('first');

    act(() => overlay.update(<span>second</span>));
    expect(document.body.textContent).toContain('second');

    act(() => overlay.destroy());
    overlay.destroy();
    expect(document.body.textContent).not.toContain('second');
    expect(destroyFns).toHaveLength(0);
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining('createRoot'));
  });
});
