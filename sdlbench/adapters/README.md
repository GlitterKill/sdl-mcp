# Adapters

V1 keeps live product automation behind command templates in `../config/agents` and `../config/products.lock.json`.

Implemented acceptance paths:

- `baseline`: fixture run with no product context tokens.
- `sdl`: fixture run with SDL context-token accounting.
- `import`: transcript-to-SessionRecord parsing through `sdlbench import`.

`crg` and `repomix` are locked as dry-run competitors until the fixture benchmark path is stable enough to make external-product failures meaningful.
