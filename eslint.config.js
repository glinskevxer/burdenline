import js from '@eslint/js';

export default [
  {
    ignores: ['node_modules/**', 'coverage/**', 'dist/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        globalThis: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'error',
      // Added after a bug where a repository shadowed `db` with a parameter of
      // its own and wrote to the wrong connection in a test.
      'no-shadow': 'error',
      'no-param-reassign': ['error', { props: false }],
      'no-else-return': ['error', { allowElseIf: false }],
      'no-lonely-if': 'error',
      'no-implicit-coercion': 'error',
      'no-unneeded-ternary': 'error',
      'max-depth': ['error', 4],
    },
  },
  {
    files: ['tests/**/*.js', 'scripts/**/*.js', 'bin/**/*.js'],
    rules: {
      'no-console': 'off',
    },
  },
];
