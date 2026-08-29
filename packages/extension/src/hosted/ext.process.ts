import { extProcessInit } from './ext.process-base';
import { startMemoryDiagnostics } from './memory-diagnostics';

(async () => {
  startMemoryDiagnostics();
  await extProcessInit();
})();
