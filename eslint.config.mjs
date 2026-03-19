import solanaConfig from '@solana/eslint-config-solana';

export default [
    {
        ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo', '**/__tests__/**', 'demo/**'],
    },
    ...solanaConfig,
];
