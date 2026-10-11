# Alpine/musl native package qualification — 2026-10-11

## Scope and source identity

- Repository: https://github.com/GlitterKill/sdl-mcp
- Failing maintenance commit: `34ab8955329ced0fbd657d4e9d8dbecf3da3eab8`.
- Isolated fix branch: `codex/fix-alpine-musl-package`.
- Tested implementation commit: `063bafb2d40a963b890492f625a9ad2ad08c82c5`.
- Baseline run: https://github.com/GlitterKill/sdl-mcp/actions/runs/38163622459
- Fixed dry run: https://github.com/GlitterKill/sdl-mcp/actions/runs/38165460944

The maintenance worktree and remote branch were both verified at the failing
commit before creating the isolated worktree. The primary checkout contained
unrelated dirty work and was not edited. Another session subsequently advanced
the maintenance branch; this patch does not include those later changes.
No package versions, credentials, workflow permissions, OpenSSL files, parser
implementation, or wrapper exports were changed. Nothing was published or merged.

## Confirmed cause

The baseline musl build ran on Ubuntu with the Rust musl target but no musl
Cargo linker configuration. Its log reports `/bin/sh: 1: zig: not found`.
The installed napi CLI disables `crt-static` for shared musl addons; when its
implicit Zig lookup fails it falls back to the normal linker. The downloaded
musl ELF already directly requires `libc.so.6`, `ld-linux-x86-64.so.2`, and
GLIBC symbol versions through 2.34. Thus host glibc entered during linking,
before package staging. It is not a missing-parser-export failure or a
transitive runtime library accidentally installed by npm.

| Baseline artifact | SHA-256 |
| --- | --- |
| Downloaded musl `.node` | `a095f6405660ae864a1db03e0882e7a0e39bad98574554f6b8b8ef72050ca46d` |
| Downloaded GNU `.node` | `e248d5b93af7c102cd7f7fbaab9c2a241732f1ef80b72aa7705d9ed989c3ea07` |
| Locally repacked failed musl tarball | `f92f2c5d600a40e3be9af40abfa10fbeda0e849dfec24fb251231a9c4c074450` |

The baseline job did not upload its failed qualification tarballs. To inspect
packing rather than infer from a filename, the downloaded musl artifact was
repacked with its platform manifest and the run's staging version `0.13.8`.
Extracting that actual npm tarball produced the identical failed binary hash.
The qualifier copies the selected binary verbatim; the separate GNU artifact
has a different hash. The original failed consumer log identifies the musl
platform package path. No original linker command trace was retained, so the
precise host-linker invocation cannot be recovered from that run.

## Fix and regression coverage

The musl build uses `rust:alpine`, `build-base`, an explicit `cc` linker, and a
separate Cargo target directory. This keeps the final Rust link and native
C/C++ dependencies inside Alpine. Other target build commands are unchanged.
The build image resolved to
`sha256:0cce0a5e0e8ba67b455257a3a02a1d99005f382748789d6464460028810f1627`.

`verify-musl-elf.mjs` invokes readelf on the binary and requires an ELF64 x86-64
shared object linked to musl. It rejects glibc dependencies/version requirements,
unexpected direct libraries, executable interpreters and RPATH/RUNPATH. The
check runs before artifact upload and again before package staging. The clean
consumer must select the requested platform package and load the same binary
hash as the input. Qualification evidence includes tarball SHA-256 values.

Focused tests cover compatible musl metadata, mixed libc dependencies, GLIBC
symbol requirements, wrong architecture/class/type, interpreters, unexpected
libraries and search paths. Workflow tests retain all six platform gates and
the existing parser/package contracts, and check the new pre-publication gates.
The actual failed ELF metadata was separately rejected by the new validator.
The downloaded fixed ELF independently passed and requires only
`libgcc_s.so.1` and `libc.musl-x86_64.so.1`.

## Reproduction and verification commands

```sh
gh run view 38163622459 --repo GlitterKill/sdl-mcp --job 114542675061 --log
gh run download 38163622459 --repo GlitterKill/sdl-mcp -n bindings-x86_64-unknown-linux-musl -D failed-musl
readelf --wide --file-header --program-headers --dynamic --version-info failed-musl/sdl-mcp-native.node
node --experimental-strip-types --test tests/unit/native-musl-elf.test.ts tests/unit/native-platform-qualification.test.ts tests/unit/native-package-exports.test.ts tests/unit/release-publish-lockfile.test.ts
gh workflow run publish-native.yml --repo GlitterKill/sdl-mcp --ref codex/fix-alpine-musl-package -f native_version=0.13.8 -f dry_run=true
```

The workflow builds musl with:

```sh
docker run --rm --volume "$GITHUB_WORKSPACE:/workspace" --workdir /workspace \
  --env CARGO_TARGET_DIR=/workspace/native/target/alpine-musl \
  --env CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=cc \
  rust:alpine sh -ec '
    apk add --no-cache nodejs npm build-base binutils
    npx --no-install napi build --release --cargo-cwd native --config native/package.json --target x86_64-unknown-linux-musl native
    node scripts/verify-musl-elf.mjs native/sdl-mcp-native.node
  '
```

Consumer qualification uses a separate `node:24-alpine` container with only
`libstdc++` and `binutils` added. The qualifier runs `npm pack --ignore-scripts`
for both staging packages, then `npm install --offline --ignore-scripts
--no-audit --no-fund <umbrella.tgz> <platform.tgz>` in a fresh consumer. It
loads `sdl-mcp-native` through normal package resolution, checks all required
exports, parser identity `native:1`, symbol identity, and exact content/disk/
async parsing parity. Overrides and NODE_PATH/NODE_OPTIONS are removed;
platform/binary-origin checks prevent a borrowed checkout addon from passing.

## Results

Hosted platform qualification and independently verified artifact results follow.

The hosted run completed all six builds and all six package qualifications
successfully. The shared regression job passed **22 tests, zero failures**.

| Tested package target | Consumer environment | Result |
| --- | --- | --- |
| Linux x64 musl | clean `node:24-alpine` container | PASS |
| Linux x64 GNU | Ubuntu 24.04 x64 | PASS |
| Linux arm64 GNU | Ubuntu 24.04 arm64 | PASS |
| Windows x64 MSVC | windows-latest | PASS |
| macOS x64 | macos-15-intel | PASS |
| macOS arm64 | macos-15 | PASS |

All consumers passed the required exports, `native:1` identity and exact
content/disk/async parity, with no local-addon override. The Alpine consumer
image resolved to
`sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1`.
No glibc compatibility package was installed. The actual ELF extracted from
the qualified npm tarball was independently inspected with readelf: only
`libgcc_s.so.1` and `libc.musl-x86_64.so.1` are needed; version requirements
are GCC-only, with no GLIBC version requirements.

The six qualification artifacts were downloaded. Independent checks recomputed
all seven distinct tarball hashes, checked shared umbrella tarballs were
identical, extracted all six native binaries, and matched every binary hash to
its successful consumer contract. These are tested artifacts, not substituted
checkout binaries. Download commands:

```sh
gh run download 38165460944 --repo GlitterKill/sdl-mcp --pattern 'native-qualified-063bafb2d40a963b890492f625a9ad2ad08c82c5-*' --dir qualified
```
All six contracts, seven distinct tarballs, and six embedded binaries verified.

| Tarball | SHA-256 |
| --- | --- |
| `sdl-mcp-native-0.13.8.tgz` | `9f40db9fabc57e9c1ab06180c08a5f0490e7fc8d29b041c1388f0ad34de01e27` |
| `sdl-mcp-native-darwin-arm64-0.13.8.tgz` | `2a43501765c4dfe662d9f9aeaf4e5c6d46461b4039a3998be325da99b9867d1b` |
| `sdl-mcp-native-darwin-x64-0.13.8.tgz` | `e7443dfd9e7783f1070456c389d4bc72b1702cdd68d072d919cf2dd1e43f8d77` |
| `sdl-mcp-native-linux-arm64-gnu-0.13.8.tgz` | `835b2d36afede2971619600f945ac31814e42f1764e2dc8994a6c25600fab290` |
| `sdl-mcp-native-linux-x64-gnu-0.13.8.tgz` | `cb8e53b9e1ab59268953dd2d844ec08fea1e489a444c6472b8072e240d28b661` |
| `sdl-mcp-native-linux-x64-musl-0.13.8.tgz` | `3198521e6deb89bafa4d32b83013a38845441048193a03d7beeb7c32c79712fe` |
| `sdl-mcp-native-win32-x64-msvc-0.13.8.tgz` | `8af9fb9f4dc14c39020030153c64e2d2e0c1b2491cadcc0907f7efdbb0c96ddc` |

| Platform binary | SHA-256 |
| --- | --- |
| `sdl-mcp-native-darwin-arm64` | `ef14641489a188fbde2786ec6d1d8495f9c8ca7c7e8348062927837963f84622` |
| `sdl-mcp-native-darwin-x64` | `46c6c3e1738133b62350152387ab87dfee1cb08fc8986d199b8c456474ee3a1c` |
| `sdl-mcp-native-linux-arm64-gnu` | `0718f34147cf1874f728f3b4b69504c31acf0c86fa7de13cab85351d963992ff` |
| `sdl-mcp-native-linux-x64-gnu` | `e248d5b93af7c102cd7f7fbaab9c2a241732f1ef80b72aa7705d9ed989c3ea07` |
| `sdl-mcp-native-linux-x64-musl` | `44987099d1e5fe48f246c7c27edff74e345061ae6062cb57f42f7a6ba6e869da` |
| `sdl-mcp-native-win32-x64-msvc` | `12997caa4d1a8cc052c6c1d83047f1f3ce8d62ded03d2f47f94084789824d8dd` |

## Remaining release gate and verification limits

**Overall workflow conclusion: failure**, after all six platform qualifications
passed. The existing `Publish / Validate exact qualified tarballs` step failed
at `assert.equal(info.name, name)`: actual `undefined`, expected
`sdl-mcp-native`. This code is unchanged by the musl fix. Job:
https://github.com/GlitterKill/sdl-mcp/actions/runs/38165460944/job/114548420020

The step parses redirected `npm publish --dry-run --json` output. The redirected
JSON was not uploaded, so its actual shape is not established by the log.
A local offline dry-run against the identical umbrella tarball with Node
24.14.0/npm 11.9.0 returns the expected object and does not reproduce the issue.
Do not assume an array response or change the assertion without inspecting the
hosted output. This downstream release-assembly investigation belongs to the
parallel release session; it was not patched here. The workflow's extra GNU
packed-contract check passed before that failure.

Actual platform/umbrella publishing and registry verification were skipped.
No npm packages were published, no versions overwritten, no workflow permissions
added, and no merge performed. Existing authorization sufficed for pushing the
isolated branch and dispatching this dry run; no additional permission remains
necessary for the requested musl qualification. Publication still requires a
separate authorized release operation.

Locally: script syntax checks passed; the new test files passed ESLint. Attempting
ESLint on the `.mjs` scripts reports they are outside its TypeScript project;
the repository lint command only covers `src` and tests. Script execution was
verified by the hosted jobs instead. The full application/DB suite, registry
installs, and platforms outside the six-target matrix were not tested.
Local Docker was not running; Alpine execution evidence is hosted.

Raw downloaded artifacts, logs, ELF output, and independent hash-check output
are retained locally in `.musl-evidence/` in the isolated worktree, not committed.
The small evidence-report follow-up commit changes documentation only; the
implementation SHA tested above remains the exact code used for every result.

Recommended handoff: apply the musl fix and this report to the maintenance
branch, preserving the release session's later commits, then separately repair
and rerun the downstream release-assembly gate before any publication.
