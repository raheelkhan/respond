/** @type {import('jest').Config} */
module.exports = {
    testEnvironment: 'node',
    roots: ['<rootDir>/tests'],
    setupFiles: ['<rootDir>/tests/setup.ts'],
    testPathIgnorePatterns: ['<rootDir>/tests/setup.ts'],
    transform: {
        '^.+\\.ts$': [
            'ts-jest',
            {
                tsconfig: {
                    module: 'commonjs',
                    target: 'es2020',
                    esModuleInterop: true,
                    strict: true,
                },
            },
        ],
    },
};
