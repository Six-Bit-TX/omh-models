/**
 * Internal platform-profile builders for the local sandbox provider.
 *
 * @module @deepseek-ai/dsh-sandbox-local/profiles
 */

import { grantArgs as landlockGrantArgs } from '@deepseek-ai/node-addon-system/landlock-run'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/**
 * The arguments that keep host device nodes reachable inside a bwrap mount
 * profile. Bubblewrap mounts its binds no-dev, so an ordinary bind leaves a
 * device node unusable; `--dev-bind` is the flag that permits device access.
 * @param devices - absolute device paths that exist on the host, in bind order.
 * @returns one `--dev-bind` pair per device, or an empty list.
 */
export function deviceBindArgs(devices: readonly string[]): string[] {
  return devices.flatMap(device => ['--dev-bind', device, device])
}

/**
 * Build the bwrap profile arguments for one file-effect policy.
 * @param policy - file-effect policy to express as bwrap mounts.
 * @param devices - host device paths to rebind with device access; the caller detects them per wrap.
 * @returns profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(policy: SandboxPolicy, devices: readonly string[] = []): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', ...deviceBindArgs(devices), '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
  }
  return args
}

/**
 * Build the Landlock launcher grants for one file-effect policy.
 * @param policy - file-effect policy to express as Landlock allow-list grants.
 * @param devices - host device paths to grant write access; the caller detects them per wrap.
 * @returns launcher grant arguments before the trailing separator and command argv.
 */
export function landlockProfileArgs(policy: SandboxPolicy, devices: readonly string[] = []): string[] {
  const readWrite = ['/dev/null', ...devices]
  if (policy.mode === 'workspace-write') {
    readWrite.push('/tmp', policy.workspaceRoot)
  }
  return landlockGrantArgs({ readOnly: ['/'], readWrite })
}

/** Quote one path as an SBPL string literal. */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/**
 * Build the sandbox-exec arguments and SBPL profile for one policy. The
 * writable roots come from the shared {@link writableRoots} helper (canonical,
 * deduplicated) so the Seatbelt grant and the in-process fs fence
 * (`@deepseek-ai/dsh-fs-sandbox`) can never drift apart.
 * @param policy - file-effect policy to express as an SBPL profile.
 * @returns sandbox-exec arguments before the trailing separator and command argv.
 */
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* (literal ${sbplString('/dev/null')}))`]
  const roots = writableRoots(policy)
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  return ['-p', forms.join(' ')]
}
