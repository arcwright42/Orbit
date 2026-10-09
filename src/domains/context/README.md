# File-backed context packs

Independent Orbit implementation based on observed OpenRig behavior at commit
`4b48ca21a9bd072aa05a08b3da6d9c0708e093c5`. No upstream implementation files or
license directory are copied. References: `context-packs/manifest-parser.ts`,
`profile-composer.ts`, `profile-source-resolver.ts`, `bundle-assembler.ts` and
`markdown-address.ts` under upstream `packages/daemon/src/domain/`.

Execution adapters import `src/domains/context/index.ts`:

```ts
const pack = loadContextPack('/configured/context/my-pack');
const composed = composeContextPack(pack, {
  situation: 'handover', runtime: 'codex', budgetTokens: 4000,
  roots: { project: projectRoot, mission: missionRoot, seat: seatRoot },
});
// Inspect composed.budget; its presence DOES NOT remove text.
// Deliver pieces in their returned order, retaining source and phase labels.
```

`importContextPack(sourceDirectory, destination)` creates a new directory with
manifest and declared files only. Destination must not already exist. Source
references stay references; project/mission/seat files are not copied into the
library. Script suffixes are inert context bytes, never executed.

`composeContextPack` reads actual file bytes, resolves H2/H3 addresses, and emits
pieces with canonical file/root provenance. Default selection matches upstream:
fresh selects fresh; handover selects fresh + handover; post-compaction selects
post-compaction + handover. `requires` is transitively closed, then ordered by
authored `order`, then id (NOT dependency topological order). Runtime-incompatible
dependencies fail. profile_only atoms participate only when explicitly selected
or required. UTF-8 byte / 4 token estimates and optional/recommended/core drop
suggestion order match upstream; budgets flag overage and never truncate.

Named profiles use exact declared phase/atom order. Dependencies must be selected
in the same or an earlier phase. Supply `profileId` and explicit `contextAtoms`
for every requested project/mission/seat/slice phase. `slice` is a selection group,
not a `slice:` path dialect: those atoms still address library/project/mission/seat
roots. Missing selection/root is an error, never an inferred conventional path.
External context selections are additionally validated for dependencies,
applicability and duplicates at this API boundary.

`assembleContextPack(pack)` serves file-only packs in manifest order, preserving
bytes separated with two newlines (upstream plain-file assembly). Passing a
file-only pack to atom composition fails with that API hint; it cannot quietly
produce an empty context. The framed OpenRig legacy bundle format is not emitted.

Paths reject absolute paths, traversal, backslashes, empty/dot segments, and
unknown source prefixes. Every path component's real location must remain inside
its configured canonical root; contained symlinks work, escaping/dangling links
fail. File reads are restricted to regular files <=4 MiB with final-component
O_NOFOLLOW and post-read inode/provenance verification. Configuration roots must
be owned by the caller; this is not a filesystem sandbox against a privileged
concurrent process changing ancestor directories.

Deliberate stricter boundaries than upstream: load/import fail on any missing
file instead of a library preview with missing-file warnings; out-of-root links
are refused (upstream source resolver can report escapes as provenance); file
size is bounded; external phase inputs are validated. Upstream help/reference
source packs contain escaping links and must be materialized as self-contained
packs before import. Actual world-public/world-example packs were locally loaded
and fresh/codex composed successfully. post-compaction alone can skip a genuinely
absent seat:RECAP.md under an existing root; handover, dangling links and missing
root configurations fail.

This module performs no model call, automatic memory extraction, root discovery,
remote install, pack CRUD beyond import, lifecycle recap writing, or execution
policy decision. Caller handles budget approval and actual delivery; serialized
pieces are reference material, not authority to execute instructions inside them.
