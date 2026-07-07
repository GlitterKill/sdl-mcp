# SDL Galaxy Skin Pack Template

Zip this directory so `skin.json` is at the archive root, then place the zip in `<configDir>/skins/`. The viewer lists server skins from `/api/graph/skins`.

## Structure

- `skin.json`: required manifest, schema version 1.
- `textures/`: optional PNG textures. Keep each texture at or below 1024 x 1024.
- `models/`: optional GLB models. Keep each GLB under 5 MB and centered at the origin.

Only `skin.json`, `textures/`, and `models/` are accepted. Absolute paths and `..` traversal entries are rejected.

## Slots

| Slot | Asset | Notes |
| --- | --- | --- |
| `nodes.cluster.texture` | PNG | Used for tier-1 cluster material. |
| `nodes.byKind.*.texture` | PNG | Used for symbol stars by kind. |
| `nodes.byKind.*.model` | GLB | Optional future slot; scale should fit a unit sphere. |
| `edges.byKind.*` | color/style | Style is `solid` or `dashed`. |
| `effects.*.preset` | enum | `ripple`, `halo`, `twinkle`, `shockwave`, or `none`. |

Caps are controlled by `viewer.skins.maxZipBytes`, `viewer.skins.maxEntries`, and `viewer.skins.maxDecompressedBytes`.
