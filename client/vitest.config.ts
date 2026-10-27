// Plain config so this file does not import vitest/config (that package pulls in
// the hoisted vitest, which cannot see the client's Vite install).
export default {
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
};
