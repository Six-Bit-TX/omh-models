/**
 * Internal platform-profile builders for the local sandbox provider.
 *
 * @module @deepseek-ai/dsh-sandbox-local/profiles
 */
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox';
/**
 * The arguments that keep host device nodes reachable inside a bwrap mount
 * profile. Bubblewrap mounts its binds no-dev, so an ordinary bind leaves a
 * device node unusable; `--dev-bind` is the flag that permits device access.
 * @param devices - absolute device paths that exist on the host, in bind order.
 * @returns one `--dev-bind` pair per device, or an empty list.
 */
export declare function deviceBindArgs(devices: readonly string[]): string[];
/**
 * Build the bwrap profile arguments for one file-effect policy.
 * @param policy - file-effect policy to express as bwrap mounts.
 * @param devices - host device paths to rebind with device access; the caller detects them per wrap.
 * @returns profile arguments before the trailing separator and command argv.
 */
export declare function bwrapProfileArgs(policy: SandboxPolicy, devices?: readonly string[]): string[];
/**
 * Build the Landlock launcher grants for one file-effect policy.
 * @param policy - file-effect policy to express as Landlock allow-list grants.
 * @param devices - host device paths to grant write access; the caller detects them per wrap.
 * @returns launcher grant arguments before the trailing separator and command argv.
 */
export declare function landlockProfileArgs(policy: SandboxPolicy, devices?: readonly string[]): string[];
/**
 * Build the sandbox-exec arguments and SBPL profile for one policy. The
 * writable roots come from the shared {@link writableRoots} helper (canonical,
 * deduplicated) so the Seatbelt grant and the in-process fs fence
 * (`@deepseek-ai/dsh-fs-sandbox`) can never drift apart.
 * @param policy - file-effect policy to express as an SBPL profile.
 * @returns sandbox-exec arguments before the trailing separator and command argv.
 */
export declare function seatbeltProfileArgs(policy: SandboxPolicy): string[];
//# sourceMappingURL=profiles.d.ts.map