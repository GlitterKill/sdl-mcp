# PR Risk Copilot Tool - Implementation Summary

## Overview

The PR Risk Copilot Tool (`sdl.pr.risk.analyze`) has been successfully implemented as an MCP tool that analyzes Pull Request risk by computing deltas between versions, assessing blast radius impact, and recommending appropriate tests.

## Acceptance Criteria Met

### ✅ AC1: Tool returns findings[], riskScore, impactedSymbols[], evidence[], recommendedTests[]

All required outputs are returned in the response:

- `findings[]`: Array of risk findings with severity levels (low/medium/high)
- `riskScore`: Overall risk score (0-100)
- `impactedSymbols[]`: Array of symbol IDs within blast radius
- `evidence[]`: Detailed evidence supporting the risk assessment
- `recommendedTests[]`: Array of test recommendations with priorities

**Location**: `src/mcp/tools/prRisk.ts:handlePRRiskAnalysis()`

### ✅ AC2: Policy gates are respected for any escalation calls

The tool integrates with the PolicyEngine to evaluate escalation decisions:

- When `riskScore >= riskThreshold` and high-severity findings exist, escalation is required
- Policy engine is invoked to evaluate the request
- `policyDecision` is included in response when escalation is triggered

**Location**: `src/mcp/tools/prRisk.ts:106-127`

### ✅ AC3: Harness tests pass for normal and edge scenarios

Unit tests created covering:

- Risk score computation
- Findings generation with severity validation
- Impacted symbols from blast radius
- Evidence collection
- Recommended tests with priorities
- Escalation required based on threshold
- Policy decision inclusion
- Error handling for missing versions

**Location**: `tests/unit/pr-risk-analysis.test.ts`

**Golden test**: `tests/golden/08-pr-risk-analysis.json`

### ✅ AC4: Documentation includes examples and expected output schema

Comprehensive documentation added to:

- `docs/USER_GUIDE.md`: Full tool reference with parameters, response schema, risk scoring factors, usage examples
- `README.md`: Tool added to MCP tools list

**Documentation sections**:

- Request/response parameters
- Example requests and responses
- Risk scoring factor breakdown (40/30/20/10 weights)
- Finding types table
- Recommended test types
- CI/CD integration example
- Best practices

## Implementation Details

### Files Created/Modified

**New Files:**

1. `src/mcp/tools/prRisk.ts` - Main tool handler implementation (277 lines)
2. `tests/unit/pr-risk-analysis.test.ts` - Unit tests (130 lines)
3. `tests/golden/08-pr-risk-analysis.json` - Golden test scenario

**Modified Files:**

1. `src/mcp/tools.ts` - Added PR Risk request/response schemas
2. `src/mcp/tools/index.ts` - Registered `sdl.pr.risk.analyze` tool
3. `docs/USER_GUIDE.md` - Added comprehensive tool documentation
4. `README.md` - Added tool to MCP tools list

### Risk Scoring Algorithm

The overall risk score is computed as a weighted average:

```
Risk Score = (ChangedSymbolsRisk × 0.4) +
             (BlastRadiusRisk × 0.3) +
             (InterfaceStabilityRisk × 0.2) +
             (SideEffectsRisk × 0.1)
```

**Components:**

1. **Changed Symbols (40%)**: Average risk score of all changed symbols
   - Based on interface stability, behavior stability, and side effect changes
   - Each symbol has individual risk score (0-100)

2. **Blast Radius (30%)**: Impact analysis
   - Considers number of direct dependents
   - Distance to transitive dependents
   - Dependency rank scores

3. **Interface Stability (20%)**: Breaking changes
   - Proportion of changes with interface modifications
   - Signature changes detected

4. **Side Effects (10%)**: Side effect modifications
   - Proportion of changes affecting side effects

### Finding Types

| Type                         | Severity | Description                                       |
| ---------------------------- | -------- | ------------------------------------------------- |
| `high-risk-changes`          | high     | Symbols with risk score ≥70                       |
| `interface-breaking-changes` | high     | Modified symbols with signature changes           |
| `side-effect-changes`        | medium   | Modified symbols with side effect changes         |
| `removed-symbols`            | medium   | Deleted symbols that may break dependents         |
| `large-impact-radius`        | medium   | Many direct dependents (>10) potentially affected |
| `new-symbols`                | low      | Newly added symbols                               |

### Recommended Test Types

| Type                 | Priority | When Recommended                    |
| -------------------- | -------- | ----------------------------------- |
| `unit-tests`         | high     | Modified symbols present            |
| `integration-tests`  | high     | Interface-breaking changes detected |
| `regression-tests`   | medium   | Direct dependents in blast radius   |
| `api-breakage-tests` | high     | Symbols were removed                |
| `new-coverage-tests` | low      | New symbols added                   |

### Evidence Collection

The tool collects comprehensive evidence:

1. **Summary**: Total changes breakdown (added/removed/modified)
2. **High-risk changes**: List of symbols with risk scores ≥70
3. **Interface breaks**: Symbols with signature changes
4. **Blast radius**: Impact analysis with top impacted symbols

## Usage Examples

### Basic PR Risk Analysis

```bash
# Via MCP client
{
  "tool": "sdl.pr.risk.analyze",
  "arguments": {
    "repoId": "my-api",
    "fromVersion": "v1.2.0",
    "toVersion": "v1.3.0",
    "riskThreshold": 70
  }
}
```

### CI/CD Integration

```bash
# Index base branch
sdl-mcp index --repo-id my-api

# Analyze PR changes
sdl-mcp serve --stdio &
echo '{
  "tool": "sdl.pr.risk.analyze",
  "arguments": {
    "repoId": "my-api",
    "fromVersion": "main",
    "toVersion": "feature-branch",
    "riskThreshold": 70
  }
}' | mcp-client

# Check escalationRequired field
# If true, block merge and require additional review
```

## Testing

### Unit Tests

Run unit tests:

```bash
npm test -- tests/unit/pr-risk-analysis.test.ts
```

Test coverage includes:

- ✅ Risk score computation
- ✅ Findings with severity levels
- ✅ Impacted symbols from blast radius
- ✅ Evidence collection
- ✅ Recommended tests with priorities
- ✅ Escalation threshold logic
- ✅ Policy decision integration
- ✅ Error handling for invalid versions

### Golden Tests

Run golden tests:

```bash
npm run test:golden
```

## Next Steps

### Recommended Enhancements

1. **Historical Risk Tracking**: Store and analyze risk scores over time to identify risk trends
2. **Custom Risk Thresholds**: Allow per-repository or per-branch risk thresholds
3. **Risk Mitigation Suggestions**: Provide specific remediation steps based on findings
4. **Integration with CI Providers**: Create GitHub Actions, GitLab CI, etc. integrations
5. **Risk Dashboard**: Visual dashboard for PR risk across the organization
6. **Automated Test Execution**: Integrate with test frameworks to automatically run recommended tests

### Potential Improvements

1. **Machine Learning Model**: Train a model on historical PR data to improve risk prediction
2. **Custom Risk Weights**: Allow configuration of risk scoring weights per project
3. **Multi-Repo Analysis**: Analyze PRs that span multiple repositories
4. **Real-time Risk Updates**: Update risk assessment as changes are made to the PR
5. **Risk Heatmaps**: Generate visual heatmaps of risk across the codebase

## Conclusion

The PR Risk Copilot Tool has been successfully implemented with all acceptance criteria met. The tool provides comprehensive PR risk analysis with:

- ✅ Delta-based change detection
- ✅ Blast radius impact analysis
- ✅ Risk scoring with configurable thresholds
- ✅ Policy-governed escalation
- ✅ Comprehensive findings and evidence
- ✅ Actionable test recommendations
- ✅ Full documentation and examples

The implementation follows SDL-MCP's existing patterns for MCP tools, integrates seamlessly with the policy engine, and provides valuable insights for PR review processes.
