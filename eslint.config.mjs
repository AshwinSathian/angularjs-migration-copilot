import nx from '@nx/eslint-plugin';

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: ['**/dist', '**/out-tsc', '**/vitest.config.*.timestamp*'],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          // CLAUDE.md "Module boundaries": migration-core never imports
          // a framework or an app; nothing under libs/ imports from apps/.
          depConstraints: [
            {
              sourceTag: 'scope:migration-core',
              onlyDependOnLibsWithTags: ['scope:migration-core', 'scope:secrets-scan'],
              bannedExternalImports: ['@angular/*', '@nestjs/*', 'mongodb', 'mongoose'],
            },
            {
              sourceTag: 'scope:secrets-scan',
              onlyDependOnLibsWithTags: ['scope:secrets-scan'],
              bannedExternalImports: ['@angular/*', '@nestjs/*', 'mongodb', 'mongoose'],
            },
            {
              sourceTag: 'type:lib',
              onlyDependOnLibsWithTags: ['type:lib'],
            },
          ],
        },
      ],
    },
  },
];

/**
 * Spread into every project under libs/ (not apps/, which are the
 * framework layer). The Nx rule's bannedExternalImports only sees packages
 * already in the project graph, so an import of a not-yet-installed
 * framework package passes it; this core rule does not depend on the graph.
 */
export const frameworkFreeLib = {
  files: ['**/*.ts', '**/*.mts', '**/*.js', '**/*.mjs'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['@angular/*', '@nestjs/*', 'mongodb', 'mongoose', '**/apps/*'],
            message: 'libs/ stay framework-free and never import from apps/ (CLAUDE.md "Module boundaries").',
          },
        ],
      },
    ],
  },
};
