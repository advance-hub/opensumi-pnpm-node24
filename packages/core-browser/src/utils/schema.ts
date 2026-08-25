import type { Ajv } from 'ajv';

let _ajv: Ajv | undefined;
export const acquireAjv = (): Ajv | undefined => {
  if (!_ajv) {
    // Ajv 6 is CommonJS; keep the validator lazy so it is only constructed when schema validation is used.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AjvConstructor = require('ajv') as new () => Ajv;
    _ajv = new AjvConstructor();
    return _ajv;
  }
  return _ajv;
};
