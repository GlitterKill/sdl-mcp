# Benchmark Baseline Management

This document defines the governance process for managing benchmark baselines in SDL-MCP's CI/CD pipeline.

## Overview

Benchmark baselines provide the reference point for detecting performance and quality regressions. The baseline represents the expected performance metrics at a known-good state of the codebase.

## Baseline File Location

- **File**: `.benchmark/baseline.json`
- **Status**: Tracked in version control
- **Format**: JSON with benchmark results matching the synthetic benchmark format

## Baseline Refresh Policy

### When to Update Baselines

Baselines should be updated ONLY in the following scenarios:

#### 1. Intentional Performance Improvements

- After merging a PR that improves indexing time, slice building, or other performance metrics
- The improvement must be verified across multiple CI runs (min 3) to ensure stability
- Document the improvement in the commit message

#### 2. Intentional Quality Enhancements

- After merging changes that intentionally increase symbol extraction quality or coverage
- Examples: Adding new language adapters, improving symbol resolution
- Quality increases must be reviewed for correctness

#### 3. Infrastructure Changes

- After upgrading CI runner hardware or configuration
- After changes to indexing or build pipelines that inherently change performance
- Must be coordinated with the team and documented

#### 4. Threshold Re-tuning

- After threshold configuration updates that require new baseline anchors
- Must accompany threshold config changes in the same PR

### When NOT to Update Baselines

**DO NOT update baselines for:**

- Temporary performance regressions (investigate and fix instead)
- Flaky test results (fix the flakiness first)
- PRs under active review (update only after merge)
- Feature additions that degrade performance (reject the PR or fix first)
- Any failure without understanding the root cause

## Baseline Update Process

### Step 1: Verification

Before requesting a baseline update, verify:

1. **Reproducibility**: Run benchmarks locally 3+ times

   ```bash
   npm run build
   node dist/cli/index.js benchmark:ci --skip-indexing --json > test-run-1.json
   node dist/cli/index.js benchmark:ci --skip-indexing --json > test-run-2.json
   node dist/cli/index.js benchmark:ci --skip-indexing --json > test-run-3.json
   ```

2. **Stability**: Results should be consistent (<5% variance across runs)

3. **Root Cause**: Understand WHY metrics changed (not just THAT they changed)

### Step 2: Local Baseline Update

Generate a new baseline locally:

```bash
# Run benchmark with current code
npm run build
node dist/cli/index.js benchmark:ci --update-baseline

# Verify the new baseline
cat .benchmark/baseline.json
```

### Step 3: PR Creation

Create a PR following this checklist:

**PR Title Format:**

```
perf: Update benchmark baseline - [reason]

Example: perf: Update baseline - 15% indexing speed improvement
```

**PR Description Must Include:**

- [ ] **Reason for update**: Clear explanation of why baseline needs refresh
- [ ] **Impact analysis**: Show before/after metrics for all changed values
- [ ] **Verification steps**: List steps taken to verify stability
- [ ] **Link to issue**: Reference the issue or PR that caused the change
- [ ] **Threshold review**: Confirm thresholds still make sense with new baseline

**Required Template:**

```markdown
## Baseline Update Summary

### Reason

[Explain why this update is needed]

### Impact

| Metric           | Before | After | Change | Threshold     |
| ---------------- | ------ | ----- | ------ | ------------- |
| indexTimePerFile | 222ms  | 189ms | -15%   | ✅ within 10% |
| avgCardTokens    | 198    | 205   | +3.5%  | ✅ within 10% |

| ...

### Verification

- [ ] Ran 3+ local benchmark runs
- [ ] Variance <5% across runs
- [ ] Root cause identified and understood
- [ ] Thresholds reviewed and still appropriate

### Linked Changes

- Related PR/Issue: #[number]
- Performance work: #[number]
```

### Step 4: Review Process

**Required Reviewers:**

1. **Tech Lead**: Approves overall performance impact
2. **Code Owner of Changed Module**: Verifies correctness of changes
3. **CI Maintainer**: Verifies CI integration correctness

**Review Checklist:**

- [ ] Update reason is valid per this policy
- [ ] Metrics show meaningful improvement, not just noise
- [ ] Baseline values are realistic and sustainable
- [ ] Thresholds are still appropriate with new baseline
- [ ] No regressions in unrelated metrics
- [ ] Documentation is complete

### Step 5: CI Verification

The PR must pass:

1. **All existing CI checks**: Tests, linting, type checking
2. **Benchmark CI gate**: Must PASS with new baseline
3. **Cross-platform verification**: If multi-platform CI exists, all platforms must pass

### Step 6: Merge and Monitor

After merge:

1. **Monitor subsequent runs**: Watch next 3-5 CI runs for stability
2. **Rollback plan**: If regression detected, revert baseline update immediately
3. **Update docs**: If thresholds changed, update docs/benchmark-guardrails.md

## Emergency Baseline Updates

For critical issues requiring immediate baseline adjustment:

1. **Create issue** explaining the emergency
2. **Ping tech leads** in #dev-ops or #performance channels
3. **Update baseline with PR** marked `[EMERGENCY]`
4. **Follow-up issue** must be created for proper investigation and root cause analysis

Emergency updates require:

- At least 2 tech lead approvals
- Detailed post-mortem within 3 business days
- Plans to prevent recurrence

## Baseline Version History

| Version | Date       | Commit    | Reason                                    | Updated By |
| ------- | ---------- | --------- | ----------------------------------------- | ---------- |
| 1.0     | 2026-02-08 | [initial] | Initial baseline from synthetic benchmark | V06-8      |

## Auditing and Compliance

### Audit Trail

All baseline updates are tracked via:

- Git commit history
- PR titles and descriptions
- CI run logs (.benchmark/latest-result.json)

### Compliance Checks

Periodic audits (quarterly) verify:

- All baseline updates have proper documentation
- No updates bypass the review process
- Thresholds remain appropriate
- No unexplained performance degradations

## Threshold Configuration

Thresholds are defined in `config/benchmark.config.json`:

```json
{
  "thresholds": {
    "indexing": {
      "indexTimePerFile": {
        "maxMs": 200,
        "trend": "lower-is-better",
        "allowableIncreasePercent": 10
      }
    }
  }
}
```

**Threshold Updates Require:**

- Same review process as baseline updates
- Justification in PR description
- Impact analysis on CI reliability

## Contact and Escalation

**Questions about this policy:**

- Tech Lead: [team lead]
- CI Maintainer: [dev-ops contact]

**Requesting baseline update:**

1. Create GitHub issue with label `performance/baseline`
2. Include current baseline metrics and proposed new values
3. Explain reason and attach verification data

**Emergency baseline rollback:**

- Contact tech lead immediately
- Create revert PR with `[URGENT]` prefix
- Document in post-mortem

## References

- [Benchmark Guardrails Documentation](./benchmark-guardrails.md)
- [Benchmark Implementation Details](./benchmark-implementation.md)
- [CI Configuration](../.github/workflows/ci.yml)
