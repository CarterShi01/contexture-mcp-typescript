/** A host-facing command that starts one Contexture stdio server. */
export class Launch {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];

  constructor(options: {
    readonly name: string;
    readonly command: string;
    readonly args?: Iterable<string>;
  }) {
    this.name = options.name;
    this.command = options.command;
    this.args = Object.freeze([...(options.args ?? [])]);
    Object.freeze(this);
  }

  /** Return a fresh command vector suitable for process spawning. */
  asList(): string[] {
    return [this.command, ...this.args];
  }

  /** Return the POSIX-shell spelling used by host installation commands. */
  asShell(): string {
    return this.asList().map(shellQuote).join(' ');
  }
}

/** Render Claude Code's project-scoped `.mcp.json` configuration. */
export function claudeCodeConfig(launch: Launch): string {
  return json({
    mcpServers: {
      [launch.name]: { type: 'stdio', command: launch.command, args: launch.asList().slice(1) },
    },
  });
}

/** Render Cursor's `.cursor/mcp.json`, whose server shape matches Claude Code. */
export function cursorConfig(launch: Launch): string {
  return claudeCodeConfig(launch);
}

/** Render the Contexture stanza for Codex's `config.toml`. */
export function codexConfig(launch: Launch): string {
  return [
    `[mcp_servers.${launch.name}]`,
    `command = ${pythonJson(launch.command)}`,
    `args = [${launch.args.map(pythonJson).join(', ')}]`,
    '',
  ].join('\n');
}

/** Return the documented one-line install command for each supported host. */
export function cliCommands(launch: Launch): Readonly<Record<'claude-code' | 'codex', string>> {
  return Object.freeze({
    'claude-code': `claude mcp add --scope project ${launch.name} -- ${launch.asShell()}`,
    codex: `codex mcp add ${launch.name} -- ${launch.asShell()}`,
  });
}

function json(value: unknown): string {
  return `${JSON.stringify(value, undefined, 2)}\n`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

// Python's json.dumps defaults to ensure_ascii=True; preserve that stable TOML output.
function pythonJson(value: string): string {
  return JSON.stringify(value).replace(/[\u0080-\u{10FFFF}]/gu, (character) => {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) return character;
    if (codePoint <= 0xffff) return `\\u${codePoint.toString(16).padStart(4, '0')}`;
    const offset = codePoint - 0x10000;
    const high = 0xd800 + (offset >> 10);
    const low = 0xdc00 + (offset & 0x3ff);
    return `\\u${high.toString(16)}\\u${low.toString(16)}`;
  });
}
