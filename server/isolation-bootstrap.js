import { createRequire } from 'node:module';
import { createIsolationConfig } from './isolation-config.js';

const require = createRequire(import.meta.url);

export const isolationConfig = createIsolationConfig({
  env: process.env,
  cwd: process.cwd(),
  execArgv: process.execArgv,
  loadProductionDotenv: () => require('dotenv/config'),
});

if (isolationConfig.isIsolated) {
  throw new Error('Isolated server startup is disabled until the remaining storage and destructive-operation guards are implemented');
}
