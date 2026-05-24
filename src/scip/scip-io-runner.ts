/**
 * scip-io CLI integration.
 *
 * Detects, installs, and runs the `scip-io` CLI to generate a fresh
 * `index.scip` at the repo root before sdl-mcp's own indexing pass.
 *
 * Design:
 * - Detection reuses `resolveExecutable` from runtime/runtimes.ts (cross-
 *   platform `which`/`where` via execFileSync, no shell).
 * - Auto-install downloads the platform-matched archive directly from the
 *   GitHub Releases API using Node 24's built-in `fetch`. SHA-256 checksums
 *   from the release's `SHA256SUMS.txt` are verified before extraction.
 * - Extraction shells out to the system `tar` binary (Windows 10+, macOS,
 *   and Linux all ship a `tar` capable of reading both `.tar.gz` and `.zip`
 *   via libarchive/bsdtar). No new npm dependency.
 * - Execution uses the same safe spawn pattern as runtime/executor.ts:
 *   `shell: false`, args as array, scrubbed env, byte-bounded stdio capture,
 *   timeout via setTimeout, AbortSignal wiring.
 * - All failures are non-fatal at the call-site level. The orchestration
 *   wrapper `runScipIoBeforeIndex` catches and logs everything; the indexer
 *   continues regardless.
 *
 * Security notes:
 * - No shell invocation anywhere; all child_process calls use `shell: false`
 *   and pass args as arrays.
 * - Downloaded archives are size-capped (200 MB) and SHA-256 verified.
 * - Tarball extraction uses system `tar`, which validates archive structure
 *   and refuses path-escape entries by default.
 * - Atomic install: download → verify → extract to staging → rename. Partial
 *   downloads never replace a working binary.
 */

import { spawn } from "child_process";
import { createHash } from "crypto";
import { createReadStream } from "fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "fs/promises";
import type { Dirent } from "fs";
import { homedir, tmpdir } from "os";
import { isAbsolute, join } from "path";

import type { ScipGeneratorConfig } from "../config/types.js";
import { loadConfig } from "../config/loadConfig.js";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { logger } from "../util/logger.js";
import {
  getRelativePath,
  normalizePath,
  validatePathWithinRootAsync,
} from "../util/paths.js";
import { killProcessTree } from "../runtime/executor.js";
import { resolveExecutable } from "../runtime/runtimes.js";
import { SCIP_MAX_INDEX_BYTES } from "./limits.js";
import type {
  ScipFailureDiagnostic,
  ScipGeneratedIndexDiagnostic,
  ScipGeneratedIndexMode,
} from "./diagnostics.js";

const IS_WINDOWS = process.platform === "win32";

/** Default name of the scip-io binary on disk. */
const DEFAULT_BINARY_NAME = IS_WINDOWS ? "scip-io.exe" : "scip-io";

/**
 * On Windows, Node's `child_process.spawn` with `shell: false` cannot
 * directly execute `.cmd` or `.bat` files — those require `cmd.exe` to
 * be spawned as the parent. This matters in the real world because many
 * tools (including npm-installed shims) publish `.cmd` wrappers that end
 * up first on PATH.
 *
 * This helper wraps a `.cmd`/`.bat` target in `cmd.exe /d /s /c <path>
 * <args...>`. The `/d` flag suppresses AutoRun, `/s` preserves interior
 * quoting, and `/c` tells cmd.exe to run the command and exit. Passing
 * the path and each arg as separate array elements lets Node's Windows
 * command-line builder handle quoting safely — we never build a shell
 * command string ourselves.
 *
 * Non-.cmd/.bat paths (.exe, no extension) are returned unchanged.
 */
function wrapForWindowsCmdShim(
  binaryPath: string,
  args: readonly string[],
): { executable: string; args: string[] } {
  if (!IS_WINDOWS || !/\.(cmd|bat)$/i.test(binaryPath)) {
    return { executable: binaryPath, args: [...args] };
  }
  const cmdExe = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
  return {
    executable: cmdExe,
    args: ["/d", "/s", "/c", binaryPath, ...args],
  };
}

/** Directory where sdl-mcp keeps managed binaries. Mirrors logger.ts. */
const MANAGED_BIN_DIR = join(homedir(), ".sdl-mcp", "bin");

/** GitHub Releases API endpoint for the latest scip-io release. */
const RELEASES_API_URL =
  "https://api.github.com/repos/GlitterKill/scip-io/releases/latest";

/** Hard cap on downloaded archive size to bound memory + disk usage. */
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024; // 200 MB

/** Smoke-test timeout for `scip-io --version`. */
const SMOKE_TEST_TIMEOUT_MS = 10_000;

/** Bounded stdio capture caps for the scip-io child process. */
const MAX_STDOUT_BYTES = 1 * 1024 * 1024; // 1 MB
const MAX_STDERR_BYTES = 1 * 1024 * 1024;

/**
 * Allowed hostnames for release asset downloads. The GitHub API returns
 * `browser_download_url` values pointing at these domains for real release
 * assets; any response claiming a different host is either a bug in the
 * API response, a MitM on a misconfigured proxy, or a compromised release.
 * In any of those cases, we refuse to download.
 *
 * Includes the `objects.githubusercontent.com` bucket that GitHub uses to
 * serve large release artifacts.
 */
const ALLOWED_DOWNLOAD_HOSTS = ["github.com", "objects.githubusercontent.com"];

/**
 * Validate that a download URL returned by the GitHub API is (a) HTTPS
 * and (b) on a known-good github.com host. Throws ScipIoInstallError on
 * any violation. See ALLOWED_DOWNLOAD_HOSTS for the hostname allowlist.
 *
 * This prevents a hostile or tampered API response from redirecting
 * sdl-mcp to download a binary from an attacker-controlled server.
 */
function assertTrustedDownloadUrl(url: string, context: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ScipIoInstallError(`${context}: not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new ScipIoInstallError(
      `${context}: must be https://, got ${parsed.protocol}//${parsed.hostname}`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = ALLOWED_DOWNLOAD_HOSTS.some(
    (h) => host === h || host.endsWith(`.${h}`),
  );
  if (!allowed) {
    throw new ScipIoInstallError(
      `${context}: host ${host} is not in the allowed download list ` +
        `(${ALLOWED_DOWNLOAD_HOSTS.join(", ")})`,
    );
  }
}

/** How scip-io was located. */
export type ScipIoSource = "path" | "managed" | "installed";

export interface ScipIoResolution {
  binaryPath: string;
  source: ScipIoSource;
}

export interface ScipIoRunResult {
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export interface ScipGeneratedIndexSelection {
  generatedIndexes: ScipGeneratedIndexDiagnostic[];
  failures: ScipFailureDiagnostic[];
}

export interface ScipIoPreRefreshResult extends ScipGeneratedIndexSelection {
  attempted: boolean;
  ok: boolean;
  run?: ScipIoRunResult;
  splitRun?: ScipIoRunResult;
}

export class ScipIoUnsupportedPlatformError extends Error {
  constructor(platform: string, arch: string) {
    super(
      `scip-io has no published binary for ${platform}/${arch}. ` +
        `Install manually from https://github.com/GlitterKill/scip-io/releases ` +
        `or set scip.generator.binary to a path you maintain yourself.`,
    );
    this.name = "ScipIoUnsupportedPlatformError";
  }
}

export class ScipIoInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScipIoInstallError";
  }
}

/**
 * Map (process.platform, process.arch) → the suffix the published asset uses.
 * Asset names are of the form `scip-io-vX.Y.Z-<suffix>` for the binary archive
 * and `<suffix>` is what we match against the asset list returned by GitHub.
 *
 * This indirection (suffix match instead of exact name) means we don't have
 * to know the version up front — the GitHub API returns a tag and asset list
 * for the latest release, and we pick the asset whose name *contains* the
 * suffix.
 */
function getAssetSuffix(): { suffix: string; archiveExt: ".zip" | ".tar.gz" } {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "win32" && arch === "x64") {
    return { suffix: "x86_64-pc-windows-msvc.zip", archiveExt: ".zip" };
  }
  if (platform === "darwin" && arch === "x64") {
    return { suffix: "x86_64-apple-darwin.tar.gz", archiveExt: ".tar.gz" };
  }
  if (platform === "darwin" && arch === "arm64") {
    return { suffix: "aarch64-apple-darwin.tar.gz", archiveExt: ".tar.gz" };
  }
  if (platform === "linux" && arch === "x64") {
    return { suffix: "x86_64-unknown-linux-gnu.tar.gz", archiveExt: ".tar.gz" };
  }

  throw new ScipIoUnsupportedPlatformError(platform, arch);
}

/**
 * Search for an existing scip-io binary.
 *
 * 1. PATH (via cross-platform `which`/`where`)
 * 2. The sdl-mcp managed location (~/.sdl-mcp/bin/scip-io[.exe])
 *
 * Returns null if not found in either location.
 */
export async function detectScipIo(
  binaryName: string = DEFAULT_BINARY_NAME,
): Promise<ScipIoResolution | null> {
  // Explicit absolute paths are common in CI/tests and are also the documented
  // escape hatch for users who maintain their own scip-io binary. Do not pass
  // them through `where`/`which`: Windows `where C:\path\tool.cmd` treats the
  // colon as pattern syntax and fails even when the file exists.
  if (isAbsolute(binaryName)) {
    try {
      await access(binaryName);
      return { binaryPath: binaryName, source: "path" };
    } catch {
      return null;
    }
  }

  // Strip .exe for the PATH lookup on Windows: `where scip-io` matches
  // scip-io.exe automatically. Keep .exe when we check the managed dir
  // because that's the actual filename on disk.
  const pathLookupName = IS_WINDOWS
    ? binaryName.replace(/\.exe$/i, "")
    : binaryName;

  const fromPath = resolveExecutable(pathLookupName);
  if (fromPath) {
    return { binaryPath: fromPath, source: "path" };
  }

  const managedPath = join(MANAGED_BIN_DIR, binaryName);
  try {
    await access(managedPath);
    return { binaryPath: managedPath, source: "managed" };
  } catch {
    return null;
  }
}

/**
 * Module-level single-flight lock for installs. Two parallel `indexRepo`
 * calls must not both download scip-io.
 */
let installInFlight: Promise<string> | null = null;

/**
 * Per-repo serialization lock for `scip-io index` runs. Two parallel
 * `indexRepo` calls against the same repo must not both run scip-io
 * concurrently — they would race on writing `index.scip` at the repo root.
 *
 * This lock is keyed by repoId, so parallel refreshes of DIFFERENT repos
 * still run scip-io concurrently (the expected and useful behavior).
 *
 * A second caller that arrives while the first is still running will await
 * the first's promise (without re-running scip-io). If the first call
 * completes successfully, the fresh `index.scip` is already on disk — the
 * second caller's indexer will pick it up via the existing post-refresh
 * auto-ingest. If the first call fails (non-fatal), the second call is
 * free to try again by re-entering the wrapper.
 */
const perRepoRunLocks = new Map<string, Promise<ScipIoPreRefreshResult>>();

function emptyPreRefreshResult(
  attempted: boolean,
  failure?: ScipFailureDiagnostic,
): ScipIoPreRefreshResult {
  return {
    attempted,
    ok: !attempted && !failure,
    generatedIndexes: [],
    failures: failure ? [failure] : [],
  };
}

/**
 * Download and install the scip-io binary into the managed bin directory.
 *
 * Returns the absolute path to the installed binary.
 *
 * Throws `ScipIoInstallError` on any verification failure (download HTTP
 * status, content-length sanity, SHA-256 mismatch, extraction failure,
 * smoke test failure). The managed bin directory is left in a clean state
 * on failure (staging directory removed).
 *
 * Concurrent calls share a single in-flight install via `installInFlight`.
 */
export async function installScipIo(opts?: {
  signal?: AbortSignal;
}): Promise<string> {
  if (installInFlight) {
    return installInFlight;
  }
  installInFlight = doInstall(opts).finally(() => {
    installInFlight = null;
  });
  return installInFlight;
}

async function doInstall(opts?: { signal?: AbortSignal }): Promise<string> {
  const { suffix, archiveExt } = getAssetSuffix();
  const binaryName = DEFAULT_BINARY_NAME;
  const targetPath = join(MANAGED_BIN_DIR, binaryName);

  await mkdir(MANAGED_BIN_DIR, { recursive: true });

  // 1. Discover release metadata
  logger.info("scip-io: querying latest release", { url: RELEASES_API_URL });
  const release = await fetchLatestRelease(opts?.signal);

  const archiveAsset = release.assets.find((a) => a.name.endsWith(suffix));
  if (!archiveAsset) {
    throw new ScipIoInstallError(
      `No release asset matching '${suffix}' in scip-io ${release.tag_name}. ` +
        `Available assets: ${release.assets.map((a) => a.name).join(", ")}`,
    );
  }

  const checksumAsset = release.assets.find((a) => a.name === "SHA256SUMS.txt");

  // SHA-256 verification is mandatory. If the release does not publish
  // SHA256SUMS.txt, we refuse to install — running an unverified binary
  // downloaded over the network is a downgrade attack waiting to happen.
  // Users who need to bypass this can set scip.generator.autoInstall=false
  // and manage the binary themselves.
  if (!checksumAsset) {
    throw new ScipIoInstallError(
      `scip-io release ${release.tag_name} does not publish SHA256SUMS.txt. ` +
        `Refusing to install an unverified binary. Set ` +
        `scip.generator.autoInstall=false and install scip-io manually, or ` +
        `open an issue against GlitterKill/scip-io requesting the checksum file.`,
    );
  }

  // Validate every URL we're about to hit before issuing any network call.
  // This catches tampered API responses that point at attacker hosts.
  assertTrustedDownloadUrl(
    archiveAsset.browser_download_url,
    `Archive asset ${archiveAsset.name}`,
  );
  assertTrustedDownloadUrl(
    checksumAsset.browser_download_url,
    "SHA256SUMS.txt",
  );

  // 2. Download archive
  logger.info("scip-io: downloading release asset", {
    asset: archiveAsset.name,
    size: archiveAsset.size,
  });
  if (archiveAsset.size > MAX_ARCHIVE_BYTES) {
    throw new ScipIoInstallError(
      `Release asset ${archiveAsset.name} is ${archiveAsset.size} bytes, ` +
        `exceeds the ${MAX_ARCHIVE_BYTES}-byte cap.`,
    );
  }

  const archiveBytes = await downloadAsset(
    archiveAsset.browser_download_url,
    archiveAsset.size,
    opts?.signal,
  );

  // 3. Verify checksum (mandatory — we bailed above if missing).
  logger.info("scip-io: verifying SHA-256 checksum", {
    asset: archiveAsset.name,
  });
  const checksumText = await downloadText(
    checksumAsset.browser_download_url,
    opts?.signal,
  );
  const expected = parseChecksumLine(checksumText, archiveAsset.name);
  if (!expected) {
    throw new ScipIoInstallError(
      `SHA256SUMS.txt does not contain an entry for ${archiveAsset.name}.`,
    );
  }
  const actual = createHash("sha256").update(archiveBytes).digest("hex");
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new ScipIoInstallError(
      `SHA-256 mismatch for ${archiveAsset.name}: expected ${expected}, got ${actual}.`,
    );
  }

  // 4. Extract to staging dir, then atomic rename
  const stagingDir = await mkdtemp(join(tmpdir(), "scip-io-install-"));
  try {
    const archivePath = join(stagingDir, `archive${archiveExt}`);
    await writeFile(archivePath, archiveBytes);

    await extractArchive(archivePath, stagingDir, opts?.signal);

    // Find the binary inside the extracted tree. scip-io archives place
    // the binary at the root, but tolerate one level of nesting.
    const extractedBinary = await findBinaryInDir(stagingDir, binaryName);
    if (!extractedBinary) {
      throw new ScipIoInstallError(
        `Could not find ${binaryName} inside extracted archive ${archiveAsset.name}.`,
      );
    }

    // Validate the discovered path is inside the staging dir (defense in
    // depth — system tar already refuses path-escape entries, but we
    // double-check). Use the async variant so realpath() resolves any
    // symlinks in the extracted tree: a malicious archive could include
    // a symlink entry pointing outside stagingDir that would otherwise
    // pass the lexical `path.resolve` check.
    await validatePathWithinRootAsync(stagingDir, extractedBinary);

    // Stage the final file with a unique tmp name in the managed dir to
    // ensure rename is atomic and on the same filesystem as the target.
    const tmpTarget = `${targetPath}.tmp-${process.pid}`;
    await rename(extractedBinary, tmpTarget);
    if (!IS_WINDOWS) {
      await chmod(tmpTarget, 0o755);
    }

    // Smoke test before committing the rename. If the binary doesn't run,
    // surface that immediately rather than failing on the next refresh.
    const smokeOk = await smokeTest(tmpTarget, opts?.signal);
    if (!smokeOk) {
      try {
        await rm(tmpTarget, { force: true });
      } catch {
        // Best-effort cleanup.
      }
      throw new ScipIoInstallError(
        `Installed ${binaryName} failed smoke test (\`${binaryName} --version\` exited non-zero).`,
      );
    }

    await rename(tmpTarget, targetPath);
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }

  logger.info("scip-io: installation complete", {
    path: targetPath,
    tag: release.tag_name,
  });
  return targetPath;
}

interface GitHubRelease {
  tag_name: string;
  assets: Array<{
    name: string;
    size: number;
    browser_download_url: string;
  }>;
}

async function fetchLatestRelease(
  signal?: AbortSignal,
): Promise<GitHubRelease> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "sdl-mcp-scip-io-installer",
  };
  // GitHub allows higher rate limits with a token. Honor it if the user
  // exposes one in env, but never invent one.
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(RELEASES_API_URL, { headers, signal });
  if (!res.ok) {
    throw new ScipIoInstallError(
      `GitHub API returned ${res.status} ${res.statusText} for ${RELEASES_API_URL}.`,
    );
  }
  const json = (await res.json()) as GitHubRelease;
  if (!json || typeof json !== "object" || !Array.isArray(json.assets)) {
    throw new ScipIoInstallError(
      `Unexpected GitHub API response shape from ${RELEASES_API_URL}.`,
    );
  }
  return json;
}

async function downloadAsset(
  url: string,
  expectedSize: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const res = await fetch(url, {
    signal,
    headers: { "User-Agent": "sdl-mcp-scip-io-installer" },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new ScipIoInstallError(
      `Asset download failed: ${res.status} ${res.statusText} for ${url}.`,
    );
  }

  // Stream and bound the size as we go to avoid OOM on a malicious server
  // that lies about content-length.
  const reader = res.body?.getReader();
  if (!reader) {
    throw new ScipIoInstallError(`Asset download stream missing for ${url}.`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > MAX_ARCHIVE_BYTES) {
      // Cancel and bail.
      try {
        await reader.cancel();
      } catch {
        // Best-effort.
      }
      throw new ScipIoInstallError(
        `Asset download exceeded ${MAX_ARCHIVE_BYTES}-byte cap (received ${total} bytes).`,
      );
    }
    chunks.push(Buffer.from(value));
  }

  if (total === 0) {
    throw new ScipIoInstallError(`Asset download was empty for ${url}.`);
  }
  // Sanity check expected vs actual; small differences are tolerated because
  // the API's reported size is occasionally off by a byte for compressed
  // assets, but order-of-magnitude differences indicate a bug.
  if (expectedSize > 0 && Math.abs(total - expectedSize) > expectedSize * 0.1) {
    throw new ScipIoInstallError(
      `Downloaded size ${total} differs from expected ${expectedSize} for ${url}.`,
    );
  }
  return Buffer.concat(chunks);
}

async function downloadText(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(url, {
    signal,
    headers: { "User-Agent": "sdl-mcp-scip-io-installer" },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new ScipIoInstallError(
      `Text download failed: ${res.status} ${res.statusText} for ${url}.`,
    );
  }
  const text = await res.text();
  if (text.length > 1024 * 1024) {
    throw new ScipIoInstallError(
      `Text response from ${url} is unexpectedly large (${text.length} bytes).`,
    );
  }
  return text;
}

/**
 * Parse a SHA256SUMS.txt file (one `<hex>  <filename>` line per asset)
 * and return the hex digest for the requested filename, if present.
 */
function parseChecksumLine(text: string, filename: string): string | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // Format: "<hex>  <filename>" or "<hex> *<filename>" (binary marker).
    const match = /^([a-fA-F0-9]{64})\s+\*?(\S.*)$/.exec(line);
    if (!match) continue;
    if (match[2].trim() === filename) {
      return match[1];
    }
  }
  return null;
}

/**
 * Extract a `.tar.gz` or `.zip` archive into `destDir` using the system
 * `tar` binary. Modern bsdtar/libarchive (Windows 10+, macOS, Linux) reads
 * both formats; on Linux GNU tar reads `.tar.gz` natively.
 *
 * Uses `shell: false` and passes args as an array, so the file paths can
 * never be reinterpreted as shell expressions.
 */
async function extractArchive(
  archivePath: string,
  destDir: string,
  signal?: AbortSignal,
): Promise<void> {
  // `tar -xf <archive> -C <dest>` autodetects compression on bsdtar and
  // GNU tar 1.30+. The `-C` flag changes directory before extracting,
  // ensuring relative entries land under destDir.
  const args = ["-xf", archivePath, "-C", destDir];

  const tarPath = resolveExecutable("tar");
  if (!tarPath) {
    throw new ScipIoInstallError(
      "Cannot extract scip-io archive: `tar` not found in PATH. " +
        "Install GNU tar / bsdtar (Windows 10+ ships it built-in) or set " +
        "scip.generator.autoInstall = false and install scip-io manually.",
    );
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(tarPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const s = chunk.toString();
      if (stderr.length < 64 * 1024) {
        stderr += s;
      }
    });

    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      if (child.pid) killProcessTree(child.pid);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      reject(
        new ScipIoInstallError(
          `tar spawn failed for ${archivePath}: ${err.message}`,
        ),
      );
    });

    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (cancelled) {
        reject(new ScipIoInstallError("tar extraction was aborted"));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new ScipIoInstallError(
          `tar exited ${code} extracting ${archivePath}: ${stderr.trim() || "(no stderr)"}`,
        ),
      );
    });
  });
}

/**
 * Recursively find a file named `binaryName` inside `dir` (one level deep
 * is the common case for scip-io archives, but tolerate two levels of
 * nesting just in case).
 */
async function findBinaryInDir(
  dir: string,
  binaryName: string,
  depth: number = 0,
): Promise<string | null> {
  if (depth > 3) return null;

  // Annotate as Dirent[] explicitly because TS's strict overloads on
  // readdir + withFileTypes can resolve to Dirent<NonSharedBuffer>[] on
  // some Node versions, which trips assignability checks.
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const name = String(entry.name);
    if (entry.isFile() && name === binaryName) {
      return join(dir, name);
    }
  }
  for (const entry of entries) {
    const name = String(entry.name);
    if (entry.isDirectory()) {
      const found = await findBinaryInDir(
        join(dir, name),
        binaryName,
        depth + 1,
      );
      if (found) return found;
    }
  }
  return null;
}

/**
 * Run `<binary> --version` and return whether it exited cleanly. Bounded
 * by SMOKE_TEST_TIMEOUT_MS so a hung binary cannot block the install.
 */
async function smokeTest(
  binaryPath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const { executable, args } = wrapForWindowsCmdShim(binaryPath, ["--version"]);
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      stdio: ["ignore", "ignore", "ignore"],
      shell: false,
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      if (child.pid) killProcessTree(child.pid);
      resolve(false);
    }, SMOKE_TEST_TIMEOUT_MS);
    timer.unref();

    const onAbort = () => {
      clearTimeout(timer);
      if (child.pid) killProcessTree(child.pid);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(code === 0);
    });
  });
}

function hasNoMergeArg(args: readonly string[]): boolean {
  return args.includes("--no-merge");
}

function hasCustomOutputArg(args: readonly string[]): boolean {
  return args.some(
    (arg) => arg === "--output" || arg === "-o" || arg.startsWith("--output="),
  );
}

function appendNoMergeArg(args: readonly string[]): string[] {
  return hasNoMergeArg(args) ? [...args] : [...args, "--no-merge"];
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function discoverSplitIndexPaths(repoRootPath: string): Promise<string[]> {
  const entries = await readdir(repoRootPath, { withFileTypes: true });
  return entries
    .filter((entry: Dirent) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.toLowerCase().endsWith(".scip"))
    .filter((name) => name.toLowerCase() !== "index.scip")
    .sort()
    .map((name) => join(repoRootPath, name));
}

function repoRelativeScipPath(repoRootPath: string, absolutePath: string): string {
  const normalizedRoot = normalizePath(repoRootPath);
  const normalizedPath = normalizePath(absolutePath);
  return normalizedPath.startsWith(normalizedRoot)
    ? normalizePath(getRelativePath(normalizedRoot, normalizedPath))
    : normalizedPath;
}

/**
 * Select generated SCIP indexes that are safe to feed into the decoder.
 *
 * The merged path is preferred while it remains under the decoder cap. When
 * the merged file is too large, the caller runs scip-io again with
 * `--no-merge` and calls this helper in split mode. Split outputs are
 * SHA-256 deduped because scip-typescript can produce identical
 * TypeScript/JavaScript indexes from the same project graph.
 */
export async function selectGeneratedScipIndexes(opts: {
  repoRootPath: string;
  mode: ScipGeneratedIndexMode;
  maxIndexBytes?: number;
  candidatePaths?: readonly string[];
}): Promise<ScipGeneratedIndexSelection> {
  const maxIndexBytes = opts.maxIndexBytes ?? SCIP_MAX_INDEX_BYTES;
  const repoRootPath = normalizePath(opts.repoRootPath);
  const candidatePaths =
    opts.candidatePaths ??
    (opts.mode === "merged"
      ? [join(repoRootPath, "index.scip")]
      : await discoverSplitIndexPaths(repoRootPath));

  const generatedIndexes: ScipGeneratedIndexDiagnostic[] = [];
  const failures: ScipFailureDiagnostic[] = [];
  const acceptedByHash = new Map<string, string>();

  for (const candidatePath of candidatePaths) {
    const absolutePath = normalizePath(candidatePath);
    const relPath = repoRelativeScipPath(repoRootPath, absolutePath);
    let sizeBytes = 0;
    try {
      const fileStat = await stat(absolutePath);
      sizeBytes = fileStat.size;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      const message =
        err instanceof Error ? err.message : `failed to stat ${relPath}`;
      failures.push({
        stage:
          opts.mode === "merged"
            ? "generator-select"
            : "generator-split-select",
        message,
        path: relPath,
      });
      generatedIndexes.push({
        path: relPath,
        label: opts.mode === "merged" ? "scip-io" : relPath,
        sizeBytes,
        mode: opts.mode,
        skipped: true,
        skipReason: message,
      });
      continue;
    }

    const label = opts.mode === "merged" ? "scip-io" : relPath;
    if (sizeBytes > maxIndexBytes) {
      const message = `SCIP index ${relPath} is ${sizeBytes} bytes, exceeding the ${maxIndexBytes} byte decoder limit`;
      failures.push({
        stage:
          opts.mode === "merged"
            ? "generator-select"
            : "generator-split-select",
        message,
        path: relPath,
        sizeBytes,
      });
      generatedIndexes.push({
        path: relPath,
        label,
        sizeBytes,
        mode: opts.mode,
        skipped: true,
        skipReason: "over-size",
      });
      continue;
    }

    let contentHash: string;
    try {
      contentHash = await sha256File(absolutePath);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : `failed to hash ${relPath}`;
      failures.push({
        stage:
          opts.mode === "merged"
            ? "generator-select"
            : "generator-split-select",
        message,
        path: relPath,
        sizeBytes,
      });
      generatedIndexes.push({
        path: relPath,
        label,
        sizeBytes,
        mode: opts.mode,
        skipped: true,
        skipReason: message,
      });
      continue;
    }

    if (opts.mode === "split") {
      const firstPath = acceptedByHash.get(contentHash);
      if (firstPath) {
        generatedIndexes.push({
          path: relPath,
          label,
          sizeBytes,
          mode: opts.mode,
          contentHash,
          skipped: true,
          skipReason: `duplicate-content:${firstPath}`,
        });
        continue;
      }
      acceptedByHash.set(contentHash, relPath);
    }

    generatedIndexes.push({
      path: relPath,
      label,
      sizeBytes,
      mode: opts.mode,
      contentHash,
    });
  }

  return { generatedIndexes, failures };
}

/**
 * Run `scip-io index` (plus any user-supplied args) in `repoRootPath`
 * with the safe spawn pattern. Captures stderr (bounded) for diagnostic
 * logging on failure.
 *
 * Never throws on process error; returns `{ ok: false, ... }` instead.
 */
export async function runScipIoIndex(args: {
  binaryPath: string;
  repoRootPath: string;
  timeoutMs: number;
  extraArgs?: readonly string[];
  signal?: AbortSignal;
}): Promise<ScipIoRunResult> {
  const startTime = Date.now();
  const cwd = isAbsolute(args.repoRootPath)
    ? args.repoRootPath
    : normalizePath(args.repoRootPath);

  // Build a minimal env: PATH plus the platform's home/temp keys. Mirrors
  // the buildScrubbedEnv logic in runtime/executor.ts but inlined here so
  // the runner has no dependency on the runtime executor module.
  const env: Record<string, string> = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (IS_WINDOWS) {
    if (process.env.USERPROFILE) env.USERPROFILE = process.env.USERPROFILE;
    if (process.env.TEMP) env.TEMP = process.env.TEMP;
    if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  } else {
    if (process.env.HOME) env.HOME = process.env.HOME;
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  }

  const cliArgs = ["index", ...(args.extraArgs ?? [])];
  const { executable, args: spawnArgs } = wrapForWindowsCmdShim(
    args.binaryPath,
    cliArgs,
  );

  return new Promise<ScipIoRunResult>((resolve) => {
    let timedOut = false;
    let cancelled = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let stderrTruncated = false;
    let stdoutBytes = 0;
    let stdoutTruncated = false;

    const child = spawn(executable, spawnArgs, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buf.length;
      if (stdoutTruncated) return;
      if (stdoutBytes > MAX_STDOUT_BYTES && !stdoutTruncated) {
        const before = stdoutBytes - buf.length;
        const remaining = Math.max(0, MAX_STDOUT_BYTES - before);
        if (remaining > 0) stdoutChunks.push(buf.subarray(0, remaining));
        stdoutTruncated = true;
        return;
      }
      stdoutChunks.push(buf);
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += buf.length;
      if (stderrTruncated) return;
      if (stderrBytes > MAX_STDERR_BYTES) {
        const before = stderrBytes - buf.length;
        const remaining = Math.max(0, MAX_STDERR_BYTES - before);
        if (remaining > 0) stderrChunks.push(buf.subarray(0, remaining));
        stderrTruncated = true;
        return;
      }
      stderrChunks.push(buf);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killProcessTree(child.pid);
    }, args.timeoutMs);
    timer.unref();

    const onAbort = () => {
      cancelled = true;
      if (child.pid) killProcessTree(child.pid);
    };
    args.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      clearTimeout(timer);
      args.signal?.removeEventListener("abort", onAbort);
      logger.warn("scip-io: spawn error", {
        binaryPath: args.binaryPath,
        error: err.message,
      });
      resolve({
        ok: false,
        exitCode: null,
        durationMs: Date.now() - startTime,
        timedOut: false,
        stderr: err.message,
        stdoutTruncated,
        stderrTruncated,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      args.signal?.removeEventListener("abort", onAbort);
      const durationMs = Date.now() - startTime;
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      const ok = !timedOut && !cancelled && code === 0;
      resolve({
        ok,
        exitCode: code,
        durationMs,
        timedOut,
        stdout: stdout.length > 0 ? stdout : undefined,
        stderr: stderr.length > 0 ? stderr : undefined,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

/**
 * Orchestration entry point used by `indexRepoImpl`. Resolves the binary
 * (auto-installing if configured), runs `scip-io index`, and logs each
 * step. Never throws — caller wraps in a try/catch as belt-and-suspenders
 * but this function already swallows all errors and converts them to log
 * lines.
 */
export async function runScipIoBeforeIndex(opts: {
  repoRootPath: string;
  generatorCfg: ScipGeneratorConfig;
  signal?: AbortSignal;
  maxIndexBytes?: number;
}): Promise<ScipIoPreRefreshResult> {
  const { repoRootPath, generatorCfg, signal, maxIndexBytes } = opts;

  let resolution: ScipIoResolution | null;
  try {
    resolution = await detectScipIo(generatorCfg.binary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("scip-io: detection failed", { error: message });
    return emptyPreRefreshResult(true, {
      stage: "generator-detect",
      message,
    });
  }

  if (!resolution) {
    if (!generatorCfg.autoInstall) {
      const message =
        "scip-io binary not found in PATH or managed location, and autoInstall is disabled";
      logger.warn(
        "scip-io: binary not found in PATH or managed location, and autoInstall is disabled",
        { binary: generatorCfg.binary, managedDir: MANAGED_BIN_DIR },
      );
      return emptyPreRefreshResult(true, {
        stage: "generator-detect",
        message,
      });
    }
    logger.info("scip-io: binary not found, installing from GitHub releases", {
      binary: generatorCfg.binary,
    });
    try {
      const installed = await installScipIo({ signal });
      resolution = { binaryPath: installed, source: "installed" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("scip-io: installation failed (non-fatal)", {
        error: message,
      });
      return emptyPreRefreshResult(true, {
        stage: "generator-install",
        message,
      });
    }
  }

  logger.info("scip-io: running index", {
    binary: resolution.binaryPath,
    source: resolution.source,
    cwd: repoRootPath,
    timeoutMs: generatorCfg.timeoutMs,
  });

  const result = await runScipIoIndex({
    binaryPath: resolution.binaryPath,
    repoRootPath,
    timeoutMs: generatorCfg.timeoutMs,
    extraArgs: generatorCfg.args,
    signal,
  });

  if (result.ok) {
    logger.info("scip-io: index completed", {
      durationMs: result.durationMs,
      exitCode: result.exitCode,
    });
  } else {
    logger.warn("scip-io: index command failed (non-fatal, continuing)", {
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stderr: result.stderr?.slice(0, 2000),
    });
    return {
      attempted: true,
      ok: false,
      run: result,
      generatedIndexes: [],
      failures: [
        {
          stage: "generator-run",
          message:
            result.stderr?.slice(0, 2000) ??
            `scip-io exited with ${result.exitCode ?? "unknown"}`,
        },
      ],
    };
  }

  if (hasCustomOutputArg(generatorCfg.args)) {
    return {
      attempted: true,
      ok: true,
      run: result,
      generatedIndexes: [],
      failures: [],
    };
  }

  if (hasNoMergeArg(generatorCfg.args)) {
    const splitSelection = await selectGeneratedScipIndexes({
      repoRootPath,
      mode: "split",
      maxIndexBytes,
    });
    const accepted = splitSelection.generatedIndexes.some(
      (index) => !index.skipped,
    );
    return {
      attempted: true,
      ok: accepted,
      run: result,
      generatedIndexes: splitSelection.generatedIndexes,
      failures:
        accepted || splitSelection.failures.length > 0
          ? splitSelection.failures
          : [
              {
                stage: "generator-split-select",
                message: "scip-io --no-merge completed but produced no split .scip files",
              },
            ],
    };
  }

  const mergedSelection = await selectGeneratedScipIndexes({
    repoRootPath,
    mode: "merged",
    maxIndexBytes,
  });
  const mergedAccepted = mergedSelection.generatedIndexes.some(
    (index) => !index.skipped,
  );
  const mergedOversized = mergedSelection.generatedIndexes.some(
    (index) => index.skipped && index.skipReason === "over-size",
  );
  if (mergedAccepted || !mergedOversized) {
    return {
      attempted: true,
      ok: mergedAccepted,
      run: result,
      generatedIndexes: mergedSelection.generatedIndexes,
      failures:
        mergedAccepted || mergedSelection.failures.length > 0
          ? mergedSelection.failures
          : [
              {
                stage: "generator-select",
                message: "scip-io completed but did not produce index.scip",
              },
            ],
    };
  }

  logger.info("scip-io: merged index exceeded decoder cap; generating split indexes", {
    repoRootPath,
    maxIndexBytes: SCIP_MAX_INDEX_BYTES,
  });
  const splitRun = await runScipIoIndex({
    binaryPath: resolution.binaryPath,
    repoRootPath,
    timeoutMs: generatorCfg.timeoutMs,
    extraArgs: appendNoMergeArg(generatorCfg.args),
    signal,
  });
  if (!splitRun.ok) {
    return {
      attempted: true,
      ok: false,
      run: result,
      splitRun,
      generatedIndexes: mergedSelection.generatedIndexes,
      failures: [
        ...mergedSelection.failures,
        {
          stage: "generator-split-run",
          message:
            splitRun.stderr?.slice(0, 2000) ??
            `scip-io --no-merge exited with ${
              splitRun.exitCode ?? "unknown"
            }`,
        },
      ],
    };
  }

  const splitSelection = await selectGeneratedScipIndexes({
    repoRootPath,
    mode: "split",
    maxIndexBytes,
  });
  const splitAccepted = splitSelection.generatedIndexes.some(
    (index) => !index.skipped,
  );
  return {
    attempted: true,
    ok: splitAccepted,
    run: result,
    splitRun,
    generatedIndexes: [
      ...mergedSelection.generatedIndexes,
      ...splitSelection.generatedIndexes,
    ],
    failures:
      splitAccepted || splitSelection.failures.length > 0
        ? [...mergedSelection.failures, ...splitSelection.failures]
        : [
            ...mergedSelection.failures,
            {
              stage: "generator-split-select",
              message: "scip-io --no-merge completed but produced no split .scip files",
            },
          ],
  };
}

/**
 * Indexer entry point. Called at the start of every `indexRepo()` run to
 * (conditionally) regenerate `index.scip` via scip-io before sdl-mcp's own
 * indexing pass.
 *
 * This function is intentionally thin and defensive: it loads config,
 * checks the generator gate, calls `runScipIoBeforeIndex`, and swallows any
 * error with a warning log. The indexer never has to know scip-io exists
 * beyond a single import — keeping `src/indexer/indexer.ts` clear of
 * integration-specific logic.
 *
 * **Per-repo serialization**: When called concurrently for the same repo
 * (e.g., a watcher-triggered refresh arrives while a previous refresh is
 * still running scip-io), the second call awaits the first's promise
 * instead of starting a parallel scip-io run. This prevents two scip-io
 * processes from racing on writing `index.scip` at the repo root. Parallel
 * calls for DIFFERENT repos run scip-io concurrently, which is fine.
 *
 * Because this function is called BEFORE `indexLocks` serialization in
 * `indexRepo()`, a long-running scip-io does not starve queued incremental
 * refreshes of the indexLocks slot.
 */
export async function maybeRunScipIoPreRefresh(
  repoId: string,
  repoRootPath: string,
  signal?: AbortSignal,
): Promise<ScipIoPreRefreshResult> {
  // Cheap gate first — if the generator is disabled, skip the lock dance
  // entirely and return without touching any shared state.
  let generatorCfg: ScipGeneratorConfig | undefined;
  try {
    const appConfig = loadConfig();
    if (!appConfig.scip?.enabled) return emptyPreRefreshResult(false);
    generatorCfg = appConfig.scip.generator;
    if (!generatorCfg?.enabled) return emptyPreRefreshResult(false);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("scip-io pre-refresh hook failed to load config (non-fatal)", {
      repoId,
      error: message,
    });
    return emptyPreRefreshResult(false, {
      stage: "generator-detect",
      message,
    });
  }

  // Coalesce parallel calls for the same repo onto a single promise so we
  // never run two scip-io processes concurrently in the same working tree.
  const existing = perRepoRunLocks.get(repoId);
  if (existing) {
    logger.debug("scip-io: joining in-flight run for repo", { repoId });
    try {
      return await existing;
    } catch {
      // The previous run's error was already logged; nothing to do here.
      return emptyPreRefreshResult(true, {
        stage: "generator-run",
        message: "joined in-flight scip-io run failed",
      });
    }
  }

  const runPromise = (async () => {
    try {
      return await runScipIoBeforeIndex({
        repoRootPath,
        generatorCfg,
        signal,
      });
    } catch (err) {
      // `runScipIoBeforeIndex` swallows its own errors into warn logs,
      // but a config-load or unexpected throw still lands here.
      logger.warn("scip-io pre-refresh hook failed (non-fatal)", {
        repoId,
        error: err instanceof Error ? err.message : String(err),
      });
      return emptyPreRefreshResult(true, {
        stage: "generator-run",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  perRepoRunLocks.set(repoId, runPromise);
  try {
    return await runPromise;
  } finally {
    if (perRepoRunLocks.get(repoId) === runPromise) {
      perRepoRunLocks.delete(repoId);
    }
  }
}

/**
 * Convenience wrapper for `indexRepo()`. Does the full pre-refresh dance:
 * checks config, looks up the repo root, and invokes the scip-io runner
 * with per-repo serialization. Swallows all errors — the indexer calls
 * this from OUTSIDE its own indexLocks, so a failure here must never
 * block indexing from proceeding.
 *
 * Keeping this function in the runner (rather than inline in indexer.ts)
 * isolates the scip-io integration from the indexer's line-count budget
 * and gives the runner a single well-defined entry point the indexer can
 * call in one line.
 */
export async function runScipIoPreRefreshForIndex(
  repoId: string,
  signal?: AbortSignal,
): Promise<ScipIoPreRefreshResult> {
  try {
    const appConfig = loadConfig();
    if (!appConfig.scip?.enabled || !appConfig.scip?.generator?.enabled) {
      return emptyPreRefreshResult(false);
    }
    const conn = await getLadybugConn();
    const repoRow = await ladybugDb.getRepo(conn, repoId);
    if (!repoRow) return emptyPreRefreshResult(false);
    return await maybeRunScipIoPreRefresh(repoId, repoRow.rootPath, signal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("scip-io pre-refresh outer hook failed (non-fatal)", {
      repoId,
      error: message,
    });
    return emptyPreRefreshResult(false, {
      stage: "generator-detect",
      message,
    });
  }
}

/**
 * Test-only export. Resets the in-flight install lock so unit tests can
 * verify the single-flight behavior across runs without polluting state.
 *
 * @internal
 */
export function __resetInstallLockForTests(): void {
  installInFlight = null;
}

/**
 * Test-only export. The managed bin directory path. Useful for tests that
 * need to assert install side-effects.
 *
 * @internal
 */
export const __MANAGED_BIN_DIR_FOR_TESTS = MANAGED_BIN_DIR;
