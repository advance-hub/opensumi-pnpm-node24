import { TextDecoder, TextEncoder } from 'node:util';

// Do not log message on GitHub Actions.
// Because these logs will affect the detection of real problems.
const originalConsole = globalThis.console;
globalThis.console = process.env.CI
  ? ({
      info: () => {},
      console: () => {},
      warn: () => {},
      error: () => {},
      log: () => {},
      time: () => {},
      timeEnd: () => {},
    } as unknown as Console)
  : originalConsole;

Object.assign(globalThis, { TextDecoder, TextEncoder });

process.on('unhandledRejection', (error) => {
  originalConsole.error('unhandledRejection', error);
  if (process.env.EXIT_ON_UNHANDLED_REJECTION) {
    process.exit(1); // To exit with a 'failure' code
  }
});

process.env.IS_JEST_TEST = 'true';
