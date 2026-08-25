import { Buffer } from 'node:buffer';
import * as timer from 'node:timers';

import fetchMock from 'jest-fetch-mock';
import 'jest-canvas-mock';

import './setup-base';

const testGlobal = globalThis as Record<string, any>;

fetchMock.enableMocks();

// vscode-jsonrpc 的 node 层需要 setImmediate 函数
testGlobal.setImmediate = timer.setImmediate;
testGlobal.Buffer = Buffer;
testGlobal.clearImmediate = timer.clearImmediate;

// jsdom does not implement IntersectionObserver. A deterministic test double
// is enough for unit tests and avoids carrying the retired browser polyfill.
class MockIntersectionObserver {
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly thresholds: number[];

  constructor(_callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? '0px';
    this.thresholds = Array.isArray(options.threshold) ? options.threshold : [options.threshold ?? 0];
  }

  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

testGlobal.IntersectionObserver = MockIntersectionObserver;

// packages/extension/__tests__/browser/main.thread.env.test.ts
// MainThreadEnvAPI Test Suites  › can read/write text via clipboard
let text = '';
testGlobal.IS_REACT_ACT_ENVIRONMENT = true;

window.navigator = Object.assign(window.navigator, {
  clipboard: {
    writeText(value) {
      text = value;
    },
    readText() {
      return text;
    },
  },
});

// https://github.com/jsdom/jsdom/issues/1742
testGlobal.document.queryCommandSupported = () => {};
testGlobal.document.execCommand = (command: string, _ui: boolean, value = '') => {
  const node = window.getSelection()?.anchorNode;
  const element = node instanceof HTMLElement ? node : node?.parentElement;
  if (!element) {
    return;
  }
  switch (command) {
    case 'insertHTML':
      if (element.innerHTML) {
        element.innerHTML += value;
      } else {
        element.innerHTML = value;
      }
      break;
    case 'insertLineBreak':
      element.innerHTML += '<br>';
      break;
  }
};

testGlobal.ElectronIpcRenderer = {
  send: () => {},
  removeListener: () => {},
  on: () => {},
};

class MockLocalStorage {
  private store: Record<string, string> = {};

  get length(): number {
    return Object.keys(this.store).length;
  }

  clear(): void {
    this.store = {};
  }

  getItem(key: string): string | null {
    return this.store[key] || null;
  }

  key(index: number): string | null {
    return Object.keys(this.store)[index] ?? null;
  }

  setItem(key: string, value: string): void {
    this.store[key] = value.toString();
  }

  removeItem(key: string): void {
    delete this.store[key];
  }
}

testGlobal.localStorage = new MockLocalStorage();

// https://jestjs.io/docs/manual-mocks#mocking-methods-which-are-not-implemented-in-jsdom
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(), // deprecated
    removeListener: jest.fn(), // deprecated
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

// Mock window.crypto
Object.defineProperty(window, 'crypto', {
  writable: true,
  value: {
    randomUUID: () =>
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      }),
    getRandomValues: (array) => {
      if (!(
        array instanceof Int8Array ||
        array instanceof Uint8Array ||
        array instanceof Int16Array ||
        array instanceof Uint16Array ||
        array instanceof Int32Array ||
        array instanceof Uint32Array ||
        array instanceof Uint8ClampedArray
      )) {
        throw new TypeError('Expected a TypedArray');
      }
      for (let i = 0; i < array.length; i++) {
        array[i] = Math.floor(Math.random() * 256);
      }
      return array;
    },
  },
});

// Mock window.CSS
Object.defineProperty(window, 'CSS', {
  writable: true,
  value: {
    escape: jest.fn((str) => str),
  },
});
