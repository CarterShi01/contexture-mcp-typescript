import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ApplicationDeclaration } from '../application.js';

import { UsageError } from './usage.js';

/** The discovered project root and its native Contexture application target. */
export interface ProjectConfig {
  readonly root: string;
  readonly app: string;
}

/** Walk upward for the nearest package.json containing a contexture.app target. */
export async function findProject(start = process.cwd()): Promise<ProjectConfig | undefined> {
  let current = path.resolve(start);
  for (;;) {
    const candidate = path.join(current, 'package.json');
    try {
      const parsed: unknown = JSON.parse(await readFile(candidate, 'utf8'));
      const config = projectConfig(parsed, candidate);
      if (config !== undefined) return Object.freeze({ root: current, app: config });
    } catch (error) {
      if (!(
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Load and validate the one lazy application declaration exported by a project. */
export async function loadApplication(
  options: { readonly start?: string; readonly target?: string } = {},
): Promise<{
  readonly project: ProjectConfig | undefined;
  readonly application: ApplicationDeclaration;
}> {
  const project = await findProject(options.start);
  const target = options.target ?? project?.app;
  const root = project?.root ?? options.start ?? process.cwd();
  if (target === undefined)
    throw new UsageError(
      'No Contexture project was found. Run inside a project created with `contexture new`, or name an application target.',
    );
  const resolved = path.resolve(root, target);
  if (project !== undefined && !inside(project.root, resolved)) {
    throw new UsageError(
      `Contexture application ${JSON.stringify(target)} is outside project ${project.root}.`,
    );
  }
  try {
    await stat(resolved);
    if (project !== undefined && !inside(await realpath(project.root), await realpath(resolved))) {
      throw new UsageError(
        `Contexture application ${JSON.stringify(target)} resolves outside project ${project.root}.`,
      );
    }
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(
      `Cannot load Contexture application ${JSON.stringify(target)}: ${message(error)}.`,
    );
  }
  let imported: unknown;
  try {
    imported = await import(pathToFileURL(resolved).href);
  } catch (error) {
    throw new UsageError(
      `Cannot import Contexture application ${JSON.stringify(target)}: ${message(error)}.`,
    );
  }
  if (!isRecord(imported) || !isApplication(imported.app))
    throw new UsageError(
      `${JSON.stringify(target)} must export \`app\` from defineApplication(...).`,
    );
  return Object.freeze({ project, application: imported.app });
}

function projectConfig(value: unknown, candidate: string): string | undefined {
  if (!isRecord(value) || value.contexture === undefined) return undefined;
  if (!isRecord(value.contexture))
    throw new UsageError(`${candidate} must declare contexture as an object.`);
  const { app, ...legacy } = value.contexture;
  if (app !== undefined && Object.keys(legacy).length > 0) {
    throw new UsageError(
      `${candidate} names both contexture.app and legacy keys (${Object.keys(legacy).sort().join(', ')}). Keep only app.`,
    );
  }
  if (typeof app !== 'string' || app.trim() === '') {
    throw new UsageError(
      `${candidate} must name contexture.app as a non-empty relative module path.`,
    );
  }
  return app;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function isApplication(value: unknown): value is ApplicationDeclaration {
  return isRecord(value) && typeof value.name === 'string' && Array.isArray(value.roots);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
