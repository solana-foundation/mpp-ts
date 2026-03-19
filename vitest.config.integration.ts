import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['sdk/src/__tests__/integration.test.ts'],
        testTimeout: 30_000,
        fileParallelism: false,
        maxWorkers: 1,
        globals: true,
    },
});
