import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', '../client/src/lib/ttsErrors.test.ts', '../client/src/lib/ttsPlayer.test.ts'],
  },
});
