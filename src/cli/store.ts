import path from 'node:path';
import { decodeJSON } from '../core/graph/canonical.js';
import { JournalError } from '../server/managed-journal.js';
import {
  StoreOperations,
  DEFAULT_STORE_BUDGET,
  readStoreFile,
  storeFailure,
  trustedStoreOperator,
} from '../server/managed-store-ops.js';
import type { CliEnvironment, CliOutput } from './main.js';
import { UsageError } from './usage.js';

const HELP = [
  'Offline administrator operations; stop the source owner first.',
  'contexture store doctor --root DIR --schema FILE --operator-config FILE [--durability strict|process_crash]',
  'contexture store backup --root DIR --schema FILE --operator-config FILE --verify-root FRESH_DIR --output NEW_FILE [--durability strict|process_crash]',
  'contexture store restore --root FRESH_DIR --schema FILE --operator-config FILE --input FILE --allow-write [--durability strict|process_crash]',
  'Configuration must explicitly grant the operation and exact native software support.',
  'Doctor never repairs or creates a source. Backup retains a closed, isolated verification clone.',
  'No live overwrite, application loading, serving adoption, or platform downgrade.',
].join('\n');

export function commandStore(
  argv: readonly string[],
  output: CliOutput,
  environment: CliEnvironment,
): number {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === 'help')) {
    output.out(HELP);
    return 0;
  }
  const [operation, ...rest] = argv;
  if (operation !== 'doctor' && operation !== 'backup' && operation !== 'restore')
    throw new UsageError(HELP);
  const values = new Map<string, string>();
  let allowWrite = false;
  const allowed = [
    '--root',
    '--schema',
    '--operator-config',
    '--durability',
    ...(operation === 'backup' ? ['--verify-root', '--output'] : []),
    ...(operation === 'restore' ? ['--input'] : []),
  ];
  for (let index = 0; index < rest.length; index++) {
    const option = rest[index];
    if (option === '--allow-write' && operation === 'restore') {
      if (allowWrite) throw new UsageError('Use --allow-write at most once.');
      allowWrite = true;
      continue;
    }
    const value = rest[index + 1];
    if (
      !option ||
      !allowed.includes(option) ||
      values.has(option) ||
      value === undefined ||
      value.startsWith('--')
    )
      throw new UsageError(HELP);
    values.set(option, value);
    index++;
  }
  const required = [
    '--root',
    '--schema',
    '--operator-config',
    ...(operation === 'backup' ? ['--verify-root', '--output'] : []),
    ...(operation === 'restore' ? ['--input'] : []),
  ];
  if (required.some((option) => !values.has(option))) throw new UsageError(HELP);
  const profile = values.get('--durability') ?? 'strict';
  if (profile !== 'strict' && profile !== 'process_crash') throw new UsageError(HELP);
  const resolve = (option: string): string => {
    const value = values.get(option);
    if (value === undefined) throw new UsageError(HELP);
    if (value.split(/[\\/]/u).includes('..'))
      throw new UsageError('Store paths cannot contain dot traversal.');
    return path.resolve(environment.cwd ?? process.cwd(), value);
  };
  try {
    const operator = trustedStoreOperator(
      decodeJSON(readStoreFile(resolve('--operator-config'), 1024 * 1024)),
    );
    const operations = new StoreOperations({
      operator,
      schema: decodeJSON(readStoreFile(resolve('--schema'), 1024 * 1024, false)),
      durability: profile,
    });
    if (operation === 'doctor') {
      const report = operations.doctor(resolve('--root'));
      output.out(JSON.stringify(report));
      return report.code === 'ok' ? 0 : 1;
    }
    if (operation === 'restore') {
      if (!allowWrite) {
        output.out(
          JSON.stringify(
            storeFailure(
              operation,
              new JournalError('confirmation_required', 'Restore confirmation required'),
            ),
          ),
        );
        return 1;
      }
      const report = operations.restore(
        resolve('--root'),
        readStoreFile(resolve('--input'), DEFAULT_STORE_BUDGET.maxSnapshotBytes),
        { allowWrite: true },
      );
      output.out(JSON.stringify(report));
      return 0;
    }
    const artifact = operations.backup(resolve('--root'), resolve('--verify-root'));
    operations.publishBackup(resolve('--output'), artifact);
    output.out(JSON.stringify({ ...artifact.result, manifest: artifact.manifest }));
    return 0;
  } catch (error) {
    const report = storeFailure(operation, error);
    output.out(JSON.stringify(report));
    return 1;
  }
}
