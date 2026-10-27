import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Client unit tests are pure-logic and run here too, because the client workspace
    // has no Vitest of its own (the hoisted copy cannot see its Vite install).
    include: ['src/**/*.test.ts', '../client/src/**/*.test.ts'],
  },
});
