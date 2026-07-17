# Repeat Provider Materialization Safety Design

## Problem

CI run `29580560720` fails in the second locked Zod benchmark sample while replacing provider-first rows in an existing LadybugDB graph. Four hosted attempts failed with the same duplicate `Symbol` primary key, including attempts after deleting the Linux benchmark-repository and `node_modules` caches.

The provider planner used a separate 50,000-symbol replacement ceiling, while the database layer already documents 2,048 as the safe limit for deleting or mutating a COPY-loaded `Symbol` table under LadybugDB 0.18.1. Zod materializes 4,414 provider symbols, so the repeat sample entered the unsafe replacement path.

Local boundary probes confirmed the broader failure mode. After provider rows were reused but unchanged legacy fallback files were indexed again, a persisted `Symbol` scan returned 4,628 rows for only 4,160 unique IDs despite the primary key. Version snapshot COPY then failed on those duplicated physical rows.

## Design

Use the database layer's shared `LADYBUG_SAFE_SYMBOL_DELETE_ROW_LIMIT` everywhere the provider-first planner decides whether an active `Symbol` table can be replaced. Repositories above that limit reuse existing provider rows rather than deleting and copying them again.

An unchanged repeat can reuse the entire verified graph, including rows previously supplied by legacy fallback, only when all three conditions hold:

1. the active-materialization plan already selected provider-row reuse;
2. the generated provider input fingerprint matches the recorded active input; and
3. every scanned source file is unchanged and no file was removed.

That path performs the existing persisted-graph no-op verification, reuses the active version, and skips both provider graph materialization and legacy fallback writes. If any condition is false, normal indexing continues; a raw symbol-count match alone never qualifies for the full-graph no-op.

## Alternatives Rejected

- Deduplicate version snapshot rows: this masks a corrupted `Symbol` scan after unsafe mutations and does not repair the active graph.
- Create a fresh version for the repeat: version IDs are not the failing boundary; the source `Symbol` table is already physically inconsistent by snapshot time.
- Reset the benchmark database between samples: this hides repeat-index correctness and changes the guardrail's workload.
- Treat every same-sized provider result as unchanged: equal counts do not prove provider content identity.

## Verification

- Unit tests cover the shared 2,048-symbol ceiling and require all three full-graph reuse gates.
- The exact locked Zod two-sample benchmark passes locally against a fresh database with all 10 threshold evaluations green.
- Typecheck, lint, focused provider-first tests, and hosted Ubuntu CI remain required before completion.
