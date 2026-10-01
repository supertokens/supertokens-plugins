import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: {
      resolve: true,
    },
    noExternal: ['@shared/js', '@shared/nodejs'],
  },
  {
    entry: {
      cli: 'scripts/cli.ts',
      initConfig: 'scripts/initConfig.ts',
      bulkMigrate: 'scripts/bulkMigrate.ts',
      setupCoreInstance: 'scripts/setupCoreInstance.ts',
      generateAppConfig: 'scripts/generateAppConfig.ts',
    },
    format: ['cjs'],
    dts: false,
    splitting: false,
    clean: false,
    banner: {
      js: '#!/usr/bin/env node',
    },
    noExternal: ['@shared/js', '@shared/nodejs'],
  },
]);
