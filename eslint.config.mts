import { defineConfig, globalIgnores } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';

export default defineConfig(
  globalIgnores([
    'node_modules',
    'dist',
    'versions.json',
    'main.js',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'tsconfig.node.json',
  ]),
  {
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        projectService: {
          // TypeScript 6 no longer loads @types/node by default, which these files need.
          defaultProject: 'tsconfig.node.json',
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 20,
          allowDefaultProject: [
            'eslint.config.mts',
            'manifest.json',
            'tests/*.test.ts',
            'tests/stubs/*.ts',
            '*.mjs',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.json'],
      },
    },
  },
  ...obsidianmd.configs.recommended,
  {
    files: ['*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'obsidianmd/no-nodejs-modules': 'off',
      // The preset enables type-aware rules only for TypeScript; these matter for the
      // async build hook in esbuild.config.mjs.
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      'obsidianmd/no-nodejs-modules': 'off',
    },
  }
);
