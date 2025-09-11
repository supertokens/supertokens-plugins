import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    preserveSymlinks: true,
  },
  test: {
    globals: true,
    environment: "node",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
