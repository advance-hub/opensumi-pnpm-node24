export default class LogService {
  debug(...args: unknown[]) {
    // eslint-disable-next-line no-console
    console.debug(...args);
  }

  error(...args: unknown[]) {
    // eslint-disable-next-line no-console
    console.error(...args);
  }

  log(...args: unknown[]) {
    // eslint-disable-next-line no-console
    console.log(...args);
  }

  warn(...args: unknown[]) {
    // eslint-disable-next-line no-console
    console.warn(...args);
  }
}
