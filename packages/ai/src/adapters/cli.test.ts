import { describe, expect, it } from 'vitest';
import { childEnv, CliAdapter } from './cli';
import { getProvider, PROVIDERS } from '../registry';

/**
 * These tests exist for one reason: this adapter spawns a local process on
 * behalf of a web request, and calendar text is attacker-controllable. The
 * properties below are the difference between "a model provider" and "remote
 * code execution with a settings page".
 */
describe('CLI provider registry entries', () => {
  it('pins the command in the registry, not in user settings', () => {
    for (const id of ['claude-code', 'codex']) {
      const provider = getProvider(id);
      expect(provider.protocol).toBe('cli');
      expect(provider.cli?.command).toBeTruthy();
      // A user-editable command would let a settings form choose which binary
      // the server executes.
      expect(provider.editableBaseUrl ?? false).toBe(false);
    }
  });

  it('asks for no API key, because the CLI is already signed in', () => {
    for (const id of ['claude-code', 'codex']) {
      expect(getProvider(id).requiresKey).toBe(false);
    }
  });

  it('carries no unverified caveat now that both are exercised end to end', () => {
    for (const id of ['claude-code', 'codex']) {
      expect(getProvider(id).unverified ?? false, id).toBe(false);
    }
  });

  it('gives every CLI provider a command', () => {
    const cliProviders = PROVIDERS.filter((provider) => provider.protocol === 'cli');
    expect(cliProviders.length).toBeGreaterThan(0);
    for (const provider of cliProviders) {
      expect(provider.cli, provider.id).toBeDefined();
    }
  });
});

describe('argument construction', () => {
  /** Reach the private builder without loosening its visibility in the source. */
  const argsFor = (adapter: CliAdapter, reasoning: 'minimal' | 'normal' | 'deep' = 'normal') =>
    (
      adapter as unknown as {
        buildArgs(spec: { system: string; messages: []; reasoning: string }): string[];
      }
    ).buildArgs({ system: 'sys', messages: [], reasoning });

  it('disables all tools for Claude Code', () => {
    const args = argsFor(new CliAdapter({ command: 'claude', variant: 'claude-code' }));

    // The single most important assertion in this file. Claude Code can read
    // files and run shell commands; an injected calendar invite must not be
    // able to reach either.
    const toolsIndex = args.indexOf('--tools');
    expect(toolsIndex).toBeGreaterThan(-1);
    expect(args[toolsIndex + 1]).toBe('');
  });

  it('isolates the run from the user’s own Claude Code setup', () => {
    const args = argsFor(new CliAdapter({ command: 'claude', variant: 'claude-code' }));

    for (const flag of ['--disable-slash-commands', '--strict-mcp-config', '--no-session-persistence']) {
      expect(args, flag).toContain(flag);
    }
    expect(args).toContain('--print');
  });

  it('maps reasoning intent onto the CLI effort levels', () => {
    const adapter = new CliAdapter({ command: 'claude', variant: 'claude-code' });

    for (const [reasoning, effort] of [
      ['minimal', 'low'],
      ['normal', 'medium'],
      ['deep', 'high'],
    ] as const) {
      const args = argsFor(adapter, reasoning);
      expect(args[args.indexOf('--effort') + 1], reasoning).toBe(effort);
    }
  });

  it('omits --model when none is configured, deferring to the CLI', () => {
    const args = argsFor(new CliAdapter({ command: 'claude', variant: 'claude-code' }));
    expect(args).not.toContain('--model');
  });

  it('passes an allowlisted model through', () => {
    const args = argsFor(
      new CliAdapter({ command: 'claude', variant: 'claude-code', model: 'claude-sonnet-4-6' }),
    );
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-4-6');
  });

  it('never puts prompt text in argv', () => {
    const adapter = new CliAdapter({ command: 'claude', variant: 'claude-code' });
    const args = argsFor(adapter);

    // The system prompt was 'sys'; nothing resembling free text should appear.
    // Prompts travel over stdin, which also keeps task titles out of `ps`.
    expect(args).not.toContain('sys');
    for (const arg of args) {
      expect(arg === '' || arg.startsWith('--') || /^[A-Za-z0-9._:/-]+$/.test(arg), arg).toBe(true);
    }
  });

  it('sandboxes the Codex variant read-only', () => {
    const args = argsFor(new CliAdapter({ command: 'codex', variant: 'codex' }));

    expect(args[0]).toBe('exec');
    // Codex offers no way to disable tools outright, so read-only is the
    // strongest available restriction. Losing it would let an injected
    // calendar invite write to the filesystem.
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
  });

  it('keeps the Codex run isolated and parseable', () => {
    const args = argsFor(new CliAdapter({ command: 'codex', variant: 'codex' }));

    // Runs in a temp dir, so without this Codex refuses to start at all.
    expect(args).toContain('--skip-git-repo-check');
    // No session files, none of the user's own config.
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--ignore-user-config');
    // ANSI escapes would corrupt parsing.
    expect(args[args.indexOf('--color') + 1]).toBe('never');
  });
});

describe('model name validation', () => {
  it('refuses shell metacharacters in the model name', () => {
    // Two separate hazards. Shell metacharacters are defence in depth (the
    // process is spawned without a shell), but a leading `-` is live: the CLI
    // would read it as a flag, and `--dangerously-skip-permissions` would undo
    // the tools restriction. Neither must be constructible.
    for (const model of [
      'sonnet; rm -rf /',
      'sonnet && curl evil.test',
      'sonnet`whoami`',
      'sonnet $(id)',
      'sonnet | tee /tmp/x',
      'sonnet\nrm -rf /',
      '--dangerously-skip-permissions',
    ]) {
      expect(
        () => new CliAdapter({ command: 'claude', variant: 'claude-code', model }),
        model,
      ).toThrow(/not allowed/i);
    }
  });

  it('accepts ordinary model names and aliases', () => {
    for (const model of ['sonnet', 'opus', 'claude-sonnet-4-6', 'gpt-5', 'openai/gpt-4.1']) {
      expect(
        () => new CliAdapter({ command: 'claude', variant: 'claude-code', model }),
        model,
      ).not.toThrow();
    }
  });
});

describe('missing binary', () => {
  it('reports a missing CLI as unavailable rather than crashing', async () => {
    const adapter = new CliAdapter({
      command: 'fluid-definitely-not-a-real-binary',
      variant: 'claude-code',
      timeoutMs: 15_000,
    });

    // healthCheck swallows the error and reports false, so a provider that is
    // not installed degrades to the deterministic scheduler.
    await expect(adapter.healthCheck()).resolves.toBe(false);
  });
});

describe('subscription sign-in metadata', () => {
  it('tells the user which official command signs them in', () => {
    // The app deliberately runs no OAuth flow of its own — neither vendor
    // publishes a client that lets a third party spend a consumer
    // subscription. Naming the official command is the honest substitute.
    //
    // These must be the *headless-capable* forms. The server may well be in a
    // container with no browser and no localhost listener, and the plain
    // commands assume both: a bare `claude` opens an interactive session, and
    // a bare `codex login` binds a callback on localhost:1455. The subcommands
    // pinned here print a URL and accept a pasted or device code instead,
    // which is what makes signing in from inside a container possible.
    const expected: Record<string, string> = {
      'claude-code': 'claude auth login',
      codex: 'codex login --device-auth',
      'anthropic-oauth': 'ant auth login',
    };

    for (const [id, command] of Object.entries(expected)) {
      const provider = getProvider(id);
      expect(provider.signIn?.command, id).toBe(command);
      expect(provider.signIn?.detail.length, id).toBeGreaterThan(20);
    }
  });

  it('never asks a sign-in provider for an API key', () => {
    for (const id of ['claude-code', 'codex', 'anthropic-oauth']) {
      expect(getProvider(id).requiresKey, id).toBe(false);
    }
  });

  it('keeps the key-based Anthropic entry distinct from the sign-in one', () => {
    // Both talk to Anthropic, but only one wants a key — collapsing them would
    // force a key on someone who signed in through a browser.
    expect(getProvider('anthropic').requiresKey).toBe(true);
    expect(getProvider('anthropic').signIn).toBeUndefined();
    expect(getProvider('anthropic-oauth').protocol).toBe('anthropic');
  });
});

// ---------------------------------------------------------------------------
// Rule 4: no ambient secrets
//
// `spawn` inherits the parent environment unless told otherwise, and this
// process holds the database URL, the encryption key, and every provider API
// key. The child's input is attacker-controllable calendar text. A regression
// here is completely invisible in normal use — the CLI keeps working — which
// is exactly why it needs a test.
// ---------------------------------------------------------------------------
describe('child environment', () => {
  const secrets = {
    DATABASE_URL: 'postgresql://fluid:hunter2@postgres:5432/fluid',
    ENCRYPTION_KEK: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    OPENAI_API_KEY: 'sk-openai-secret',
    REDIS_URL: 'redis://redis:6379',
    SESSION_SECRET: 'do-not-leak',
    AWS_SECRET_ACCESS_KEY: 'also-do-not-leak',
  };

  it('passes none of the app’s secrets to the child', () => {
    const env = childEnv({ ...secrets, PATH: '/usr/bin' });

    for (const key of Object.keys(secrets)) {
      expect(env).not.toHaveProperty(key);
    }
    // And not merely absent by name — the values must not appear at all, in
    // case something is ever copied under a different key.
    const serialized = JSON.stringify(env);
    for (const value of Object.values(secrets)) {
      expect(serialized).not.toContain(value);
    }
  });

  it('passes through what the CLI genuinely needs', () => {
    const env = childEnv({
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/home/nextjs',
      CLAUDE_CONFIG_DIR: '/home/nextjs/.claude',
      CODEX_HOME: '/home/nextjs/.codex',
      DATABASE_URL: 'postgresql://leak',
    });

    expect(env.PATH).toBe('/usr/local/bin:/usr/bin');
    expect(env.HOME).toBe('/home/nextjs');
    // Without these the CLI reads the default home and never finds the login
    // that was written into the container's credential volume.
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/nextjs/.claude');
    expect(env.CODEX_HOME).toBe('/home/nextjs/.codex');
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('is an allowlist, so a newly added secret is excluded by default', () => {
    // The failure mode this guards: someone adds a variable to the app and it
    // silently reaches the child because the code copied `process.env`.
    const env = childEnv({ PATH: '/usr/bin', SOME_FUTURE_TOKEN: 'nope' });

    expect(Object.keys(env)).toEqual(['PATH']);
  });

  it('omits keys that are unset rather than passing undefined through', () => {
    const env = childEnv({ PATH: '/usr/bin' });

    expect('HOME' in env).toBe(false);
  });
});
