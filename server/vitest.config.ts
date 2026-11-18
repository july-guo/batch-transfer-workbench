import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.ts'],
    // 每个测试文件使用独立进程，避免模块级单例（内存 DB / 模拟链）互相污染
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } }
  }
})
