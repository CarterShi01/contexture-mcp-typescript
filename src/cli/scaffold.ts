import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { UsageError } from './usage.js';

/** Every stable name derived from one `contexture new` argument. */
export interface ProjectNames {
  readonly projectName: string;
  readonly packageName: string;
  readonly roleName: string;
  readonly roleDescription: string;
  readonly resourceScheme: string;
}

/** Derive native project, package, and root-role names without prompting. */
export function deriveNames(raw: string): ProjectNames {
  const projectName = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (projectName.length === 0)
    throw new UsageError(
      `${JSON.stringify(raw)} contains no letters or digits to build a name from.`,
    );
  if (/^[0-9]/.test(projectName))
    throw new UsageError(
      `${JSON.stringify(raw)} starts with a digit; choose a leading letter for its root role.`,
    );
  return Object.freeze({
    projectName,
    packageName: projectName,
    roleName: `${projectName}-assistant`,
    roleDescription: `Answer requests about ${projectName.replaceAll('-', ' ')}.`,
    resourceScheme: projectName,
  });
}

/** The native starter application files shipped by the TypeScript package. */
export function projectTemplate(names: ProjectNames): Readonly<Record<string, string>> {
  const variables = { ...names };
  return Object.freeze({
    '.gitignore': 'node_modules/\ndist/\n.env\n',
    'package.json': `${JSON.stringify(
      {
        private: true,
        type: 'module',
        scripts: {
          check: 'contexture check',
          list: 'contexture list',
          inspect: 'contexture inspect',
          serve: 'contexture serve',
        },
        dependencies: { '@contexture/mcp': '^0.12.0', zod: '^3.24.0' },
        contexture: { app: './assistant/app.js' },
      },
      null,
      2,
    )}\n`,
    'README.md': `# ${variables.projectName}\n\nA Contexture MCP application.\n\n\`npm install\`\n\n\`npm run check\`\n\`npm run list\`\n\`npm run inspect\`\n\`npm run serve\`\n`,
    'assistant/app.js': `import { defineApplication, defineTool } from '@contexture/mcp';
import { z } from 'zod';

const ping = defineTool({
  kind: 'tool',
  name: 'ping',
  description: 'Check a target without changing it.',
  readOnly: true,
  input: z.strictObject({ target: z.string() }),
  invoke: ({ target }) => ({ target, healthy: true }),
});

export const app = defineApplication({
  name: '${variables.projectName}',
  roots: [() => ({
    kind: 'role',
    name: '${variables.roleName}',
    description: '${variables.roleDescription}',
    instructions: 'Inspect evidence before stating a result.',
    skills: [() => ({
      kind: 'skill',
      name: 'check-target',
      description: 'Check one target and report the evidence.',
      instructions: 'Call ping, then report its returned facts.',
      uses: ['${variables.roleName}/ping'],
    })],
    tools: [() => ping],
  })],
});
`,
  });
}

/** Write a runnable project and refuse to overwrite an existing directory. */
export async function newProject(
  rawName: string,
  options: { readonly destination?: string } = {},
): Promise<string> {
  const names = deriveNames(rawName);
  const destination = path.resolve(options.destination ?? process.cwd());
  const root = path.join(destination, names.projectName);
  try {
    await stat(root);
    throw new UsageError(`${root} already exists; refusing to write into it.`);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    if (!(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ))
      throw error;
  }
  for (const [relative, content] of Object.entries(projectTemplate(names))) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  return root;
}
