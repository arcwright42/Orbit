# OpenRig reference attribution

OpenRig — Copyright 2026 Mike Schwarz.
Source: https://github.com/mvschwarz/openrig
Reviewed commit: `4b48ca21a9bd072aa05a08b3da6d9c0708e093c5` (package version 0.6.9).
License: Apache License 2.0, reproduced in `LICENSE` in this directory.

Orbit's execution queue and context taxonomy reference the behavior and concepts in
`packages/daemon/src/domain/queue-repository.ts`, `queue-owner.ts`,
`queue-pickup.ts`, `queue-recovery.ts`, `runtime-adapter.ts`, and
`context-packs/context-pack-types.ts`.

The Orbit modules are newly written and substantially narrower implementations;
they are not verbatim copies or compatible replacements for the OpenRig daemon.
The original repository contains no root NOTICE file at the reviewed commit.
See `docs/EXECUTION-CORE.md` for the behavioral mapping and deliberate differences.
