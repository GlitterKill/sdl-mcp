---
memoryId: ebbc7ef8c0f7f020
type: bugfix
title: "Go isExported: toUpperCase() identity for non-alpha chars caused false exports"
tags: [bugfix, go-adapter, exports, unicode]
confidence: 0.95
symbols: []
files: [src/indexer/adapter/go.ts]
createdAt: 2026-03-22T14:46:46.991Z
deleted: false
---
Go adapter's `isExported` function used `firstChar === firstChar.toUpperCase()` to determine export status. Since `toUpperCase()` returns the same character for non-alphabetic characters, `_init`, blank identifiers, and digit-prefixed names were incorrectly marked as exported. Fixed with Unicode-correct regex: `return /^\\p{Lu}/u.test(name)`. This is important for any future language adapter that uses case-based export detection.