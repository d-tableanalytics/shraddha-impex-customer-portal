/**
 * Test environment for the frontend suite.
 *
 * Unmounts between tests: Testing Library renders into a shared document, so a
 * tree left mounted is still queryable from the next test and turns a real
 * failure into a false pass.
 */

import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

// jsdom implements neither, and both are read by components under test.
if (!window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
