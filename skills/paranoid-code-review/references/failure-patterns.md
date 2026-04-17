# Failure Patterns & Code Smells

Specific patterns to hunt for during code logic reviews.

---

## The "Happy Path Only" Smell

```pseudocode
// RED FLAG: No error handling
permission = getPermission(toolId)
doSomething(permission.data)  // What if permission is null?
```

No guard against missing data. The code assumes the dependency always returns a valid result.

---

## The "Trust the Data" Smell

```pseudocode
// RED FLAG: No validation
function handleResponse(response)
  processResponse(response)  // What if response is malformed?
```

External input used directly without schema validation or type narrowing.

---

## The "Fire and Forget" Smell

```pseudocode
// RED FLAG: Async without error handling
function sendResponse(response)
  api.send(response)        // What if this fails?
  showSuccess()             // Shows success even on failure?
```

Async operations that don't await or handle rejection, paired with optimistic UI updates.

---

## The "State Assumption" Smell

```pseudocode
// RED FLAG: Assuming state is current
permission = permissions.get(toolId)
afterDelay(1000):
  if permission:
    // Permission might have changed since we read it
    use(permission)
```

Reading state and using it later without re-validating. The world can change between read and use.

---

## The "Missing Cleanup" Smell

```pseudocode
// RED FLAG: Resources not cleaned up
function onInitialize()
  this.interval = startTimer(this.update, 1000)
// Where's the cleanup/dispose handler?
```

Timers, subscriptions, event listeners, or connections opened but never closed. Look for missing `dispose()`, `removeEventListener()`, `clearInterval()`.

---

## Silent Failure Pattern

```pseudocode
// ISSUE: Silent failure — user thinks it worked but data wasn't saved
function saveData(data)
  try:
    api.sendData(data)
  catch error:
    log.error(error)  // Silently fails - UI shows success
```

Error is caught and logged but not propagated. The caller has no way to know the operation failed.

---

## Race Condition Pattern

```pseudocode
// ISSUE: Race condition — resource could change between check and use
resource = getResource(id)
// ...time passes, other async work happens...
if resource:
  useResource(resource)  // Resource might be stale/removed
```

Time-of-check vs time-of-use. Any gap between reading state and acting on it is a potential race.

---

## State Inconsistency Pattern

```pseudocode
// ISSUE: State can become inconsistent
items.delete(itemId)
// If UI reads between delete and re-render, it sees stale data
triggerUpdate()
```

Mutation followed by async notification. Observers can read intermediate/inconsistent state.

---

## Anti-Patterns to Avoid in Reviews

### The Requirements Checklist Reviewer

```markdown
❌ "Requirement 1: ✓ Implemented"
❌ "Requirement 2: ✓ Implemented"
❌ "All requirements met, approved!"
```

Checking boxes without questioning the requirements themselves.

### The Surface Scanner

```markdown
❌ "No TODO comments found"
❌ "No obvious stubs"
❌ "Functions have implementations"
```

Only checking Level 1 (stub detection) and calling it done.

### The Optimist

```markdown
❌ "Assuming the API returns valid data..."
❌ "This should work in normal conditions..."
❌ "Edge cases are unlikely..."
```

Defaulting to trust instead of suspicion.

### The Dismisser

```markdown
❌ "Minor UX issue, not blocking"
❌ "Edge case, low priority"
❌ "Can be fixed later"
```

Downgrading severity to avoid uncomfortable conversations.
