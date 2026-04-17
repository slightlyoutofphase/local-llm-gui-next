# Review Output Template

Use this exact structure for every code logic review.

---

```markdown
# Code Logic Review — [Feature/Component Name]

## Review Summary

| Metric              | Value                                |
| ------------------- | ------------------------------------ |
| Overall Score       | X/10                                 |
| Assessment          | APPROVED / NEEDS_REVISION / REJECTED |
| Critical Issues     | X                                    |
| Serious Issues      | X                                    |
| Moderate Issues     | X                                    |
| Failure Modes Found | X                                    |

## The 5 Paranoid Questions

### 1. How does this fail silently?

[Specific scenarios where failures go unnoticed]

### 2. What user action causes unexpected behavior?

[Specific user flows that break]

### 3. What data makes this produce wrong results?

[Specific input data that causes problems]

### 4. What happens when dependencies fail?

[Analysis of each integration point failure]

### 5. What's missing that the requirements didn't mention?

[Gap analysis of implicit requirements]

## Failure Mode Analysis

### Failure Mode 1: [Name]

- **Trigger**: [What causes this]
- **Symptoms**: [What user sees]
- **Impact**: [Severity of impact]
- **Current Handling**: [How code handles it now]
- **Recommendation**: [What should happen]

[Repeat for each failure mode — MUST have at least 3]

## Critical Issues

### Issue 1: [Title]

- **File**: [path:line]
- **Scenario**: [When this happens]
- **Impact**: [User/system impact]
- **Evidence**: [Code snippet showing problem]
- **Fix**: [Specific solution]

[Repeat for each critical issue]

## Serious Issues

[Same format as Critical]

## Data Flow Analysis

[ASCII diagram showing data flow with annotations at each step]

### Gap Points Identified:

1. [Where data can be lost/corrupted]
2. [Where state can become inconsistent]
3. [Where errors can go unhandled]

## Requirements Fulfillment

| Requirement | Status                   | Concern    |
| ----------- | ------------------------ | ---------- |
| [Req 1]     | COMPLETE/PARTIAL/MISSING | [Any gaps] |
| [Req 2]     | COMPLETE/PARTIAL/MISSING | [Any gaps] |

### Implicit Requirements NOT Addressed:

1. [Requirement that should exist but wasn't specified]
2. [Edge case that users will expect to work]

## Edge Case Analysis

| Edge Case                | Handled | How           | Concern      |
| ------------------------ | ------- | ------------- | ------------ |
| Null/undefined input     | YES/NO  | [Description] | [Any issues] |
| Rapid repeated actions   | YES/NO  | [Description] | [Any issues] |
| Navigation mid-operation | YES/NO  | [Description] | [Any issues] |
| Network failure          | YES/NO  | [Description] | [Any issues] |
| Timeout race             | YES/NO  | [Description] | [Any issues] |

## Integration Risk Assessment

| Integration        | Failure Probability | Impact   | Mitigation       |
| ------------------ | ------------------- | -------- | ---------------- |
| [Component A → B]  | LOW/MED/HIGH        | [Impact] | [Current/Needed] |

## Verdict

**Recommendation**: [APPROVE / REVISE / REJECT]
**Confidence**: [HIGH / MEDIUM / LOW]
**Top Risk**: [Single biggest concern]

## What Robust Implementation Would Include

[Describe what bulletproof implementation would have that this doesn't:
- Error boundaries
- Retry logic
- Optimistic updates with rollback
- Loading states
- Offline handling
- etc.]
```
