export default {
  test: {
    include: ['tests/container/*.test.ts'],
    // The containers share the images the first hook builds.
    fileParallelism: false,
    testTimeout: 120000,
    hookTimeout: 30 * 60 * 1000,
  },
};
