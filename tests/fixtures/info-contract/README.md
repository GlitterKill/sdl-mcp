# sdl.info retrieval contract corpus

Version `v1` pins the complete `code-mode-tool-validation.test.ts` source from
commit `3aff7a6af7de8cd4b45e406b5394d97b7f75bef7`, which contains both requested
contract cases alongside ten other test cases. The manifest records its source
path, revision, and SHA-256 over UTF-8 content with LF line endings. Separately
authored, hash-checked distractors ensure helper symbols compete for retrieval.
The `.fixture` files are indexed as TypeScript; they are never executed.

`tests/benchmark/info-contract.test.ts` copies this corpus into an isolated
temporary repository and uses the scheduled quality configuration's real local
embedding models and FTS. Both scheduled OS jobs run it after provisioning those
dependencies. It checks exact test titles, assertion excerpts, exclusion of
indexed distractors, no omission of either requested case, repeated-response
equality, and the original 2,400-token ceiling. Current context hot-path responses
carry test metadata in `content.card`; card responses carry it directly.

This corpus is independent of the frozen context-quality corpus
`fcf4f2e11c5a1bb9b301a245af42b28556414b8e`, which predates the workflow-rejection
case. Neither that corpus, its baseline, nor its quality thresholds are changed.
Future changes to these fixture sources require a new version directory.
