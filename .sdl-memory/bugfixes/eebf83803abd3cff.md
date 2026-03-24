---
memoryId: eebf83803abd3cff
type: bugfix
title: Compact wire format silently drops memories — add memories field to all 3 compact schemas
tags: [wire-format, memories, compact-schema, silent-regression]
confidence: 0.97
symbols: []
files: [src/mcp/tools.ts, src/mcp/tools/slice-wire-format.ts]
createdAt: 2026-03-24T11:51:12.099Z
deleted: false
---
The `GraphSliceSchema` included `memories: z.array(SurfacedMemorySchema).optional()` but none of the three compact wire format schemas (V1, V2, V3) included it. The serializer in `slice-wire-format.ts` never copied memories to compact output. Since compact V2 is the default wire format, most clients never received surfaced memories from slice builds — a silent feature regression.

Fix: Added `memories` field to `CompactGraphSliceSchema`, `CompactGraphSliceV2Schema`, and `CompactGraphSliceV3Schema` in tools.ts. Added memory copying in `toCompactGraphSliceV1`, `toCompactGraphSliceV2`, `toCompactGraphSliceV3` in slice-wire-format.ts using the same pattern as `staleSymbols`.

Also added `staleSymbols` to the standard `GraphSliceSchema` (was only in compact schemas — asymmetric omission).