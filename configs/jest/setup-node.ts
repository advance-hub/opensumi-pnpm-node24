import nodeCrypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import { JSDOM, ResourceLoader } from 'jsdom';

import './setup-base';

const testGlobal = globalThis as Record<string, any>;

if (!testGlobal.crypto || !testGlobal.crypto.getRandomValues || !testGlobal.crypto.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: nodeCrypto.webcrypto,
  });
}

const resourceLoader = new ResourceLoader({
  strictSSL: false,
  userAgent: `Mozilla/5.0 (${
    process.platform === 'darwin' ? 'Macintosh' : process.platform === 'win32' ? 'Windows' : 'Linux'
  }) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/v16.7.0`,
});

const jsdom = new JSDOM('<div id="main"></div>', {
  // https://github.com/jsdom/jsdom#basic-options
  // 禁用掉 resources: usable, 采用 jsdom 默认策略不加载 subresources
  // 避免测试用例加载 external subresource, 如 iconfont 的 css 挂掉
  // resources: 'usable',
  runScripts: 'dangerously',
  url: 'http://localhost/?id=1',
  // 保障 `platform.ts` 中 isLinux 等平台信息判断准确性
  resources: resourceLoader,
});
testGlobal.document = jsdom.window.document;
testGlobal.UIEvent = jsdom.window.UIEvent;

let text = '';
testGlobal.navigator = Object.assign(jsdom.window.navigator, {
  clipboard: {
    writeText(value) {
      text = value;
    },
    readText() {
      return text;
    },
  },
});
testGlobal.Element = jsdom.window.Element;
testGlobal.HTMLDivElement = jsdom.window.HTMLDivElement;
testGlobal.HTMLSpanElement = jsdom.window.HTMLSpanElement;
testGlobal.location = jsdom.window.location;
testGlobal.getComputedStyle = jsdom.window.getComputedStyle;
testGlobal.window = jsdom.window;
testGlobal.DOMParser = jsdom.window.DOMParser;
testGlobal.MutationObserver = jsdom.window.MutationObserver;
testGlobal.IntersectionObserver = jsdom.window.IntersectionObserver;
testGlobal.KeyboardEvent = jsdom.window.KeyboardEvent;
testGlobal.requestAnimationFrame = (fn) => setTimeout(fn, 16);
testGlobal.cancelAnimationFrame = (timer) => {
  clearTimeout(timer);
};
jsdom.window.requestAnimationFrame = (fn) => jsdom.window.setTimeout(fn, 16);
jsdom.window.cancelAnimationFrame = (timer) => {
  clearTimeout(timer);
};
testGlobal.document.queryCommandSupported = () => {};
testGlobal.document.execCommand = () => {};
testGlobal.HTMLElement = jsdom.window.HTMLElement;
testGlobal.self = globalThis;

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

// https://stackoverflow.com/a/44143119/9443819
EventEmitter.defaultMaxListeners = 100;
