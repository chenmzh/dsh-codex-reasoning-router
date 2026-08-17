import type { UserConfig } from 'tsdown'

export default {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/schemastery',
      'dsh-codex',
    ],
  },
} satisfies UserConfig
