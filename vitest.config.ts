import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) }

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], environment: 'node' },
      },
      {
        test: { name: 'api', include: ['tests/api/**/*.test.ts'], environment: 'node', testTimeout: 60_000, hookTimeout: 120_000 },
      },
      {
        test: {
          name: 'db',
          include: ['tests/db/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: { name: 'postman', include: ['tests/postman/**/*.test.ts'], environment: 'node', testTimeout: 300_000, hookTimeout: 180_000 },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
        },
      },
    ],
  },
})
