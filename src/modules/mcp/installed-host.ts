import { execFileSync } from 'node:child_process';
import { constants, closeSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { z } from 'zod';

const Binding = z.object({ version: z.literal(1), registration: z.uuid(), label: z.string().min(1).max(80),
  executables: z.array(z.string().startsWith('/')).min(1), legacyMember: z.union([z.uuid(), z.literal('default')]).nullable() }).strict();

function registrations(profile: string) {
  const info = lstatSync(profile);
  if (!info.isDirectory() || realpathSync(profile) !== profile || info.uid !== process.getuid?.() || (info.mode & 0o077)) {
    throw new Error('LOCAL_HOST_REGISTRATION_INVALID');
  }
  const bindings = [];
  for (const name of readdirSync(profile).filter(name => name.endsWith('.peer.json'))) {
    const fd = openSync(join(profile, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 16384) throw new Error('LOCAL_HOST_REGISTRATION_INVALID');
      const binding = Binding.parse(JSON.parse(readFileSync(fd, 'utf8')));
      bindings.push(binding);
    } finally { closeSync(fd); }
  }
  return bindings;
}

const ownerProfile = () => join(userInfo().homedir, 'Library/Application Support/Yosh Agent Registration');

export function findHostBinding(profile: string, executable: string) {
  if (/^(?:node|bun|deno|python[.0-9]*|sh|bash|zsh|electron|ruby|perl)$/i.test(basename(executable))) throw new Error('LOCAL_HOST_EXECUTABLE_NOT_REGISTERED');
  // Resolve installed CLI links at session start to survive versioned updates.
  const matches = registrations(profile).filter(binding => binding.executables.some(path => {
    try { return realpathSync(path) === executable; } catch { return false; }
  }));
  if (matches.length !== 1) throw new Error('LOCAL_HOST_EXECUTABLE_NOT_REGISTERED');
  return matches[0];
}

export function legacyMemberForRegistration(registration: string, label: string) {
  const matches = registrations(ownerProfile()).filter(binding => binding.registration === registration);
  if (matches.length !== 1 || matches[0].label !== label) throw new Error('LOCAL_HOST_REGISTRATION_INVALID');
  return matches[0].legacyMember;
}

export function resolveInstalledHost(runtime: string, profile = ownerProfile()) {
  try {
    // Standalone and first-use are invoked directly by the stdio client. The
    // kernel's parent path outlives config imports, aliases and MCP clientInfo.
    const path = execFileSync(join(runtime, 'yosh-confirm'), ['--calling-host'], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 8192, stdio: ['ignore', 'pipe', 'ignore'],
    }).trimEnd();
    return findHostBinding(profile, realpathSync(path));
  } catch { throw new Error('LOCAL_HOST_EXECUTABLE_NOT_REGISTERED'); }
}
