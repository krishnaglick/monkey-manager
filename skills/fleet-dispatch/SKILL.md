---
name: fleet-dispatch
description: Example monkey-manager workflow for an ORCHESTRATOR dispatching several parallel Claude agents across git worktrees. Claim each agent's feature BEFORE launch so two agents (or two fleets) never duplicate the same work. Use when fanning out independent feature work concurrently and you want fire-and-forget dedup.
---

# fleet-dispatch (example)

A worked example of orchestrating N parallel agents with `monkey-manager` so you can
**fire and forget** without paying for duplicate work. The orchestrator does the
coordination once per agent at dispatch; the implementer agents never think about it.

Coordination is **advisory** (warns, never blocks). The primary dedup guard is still
*you picking non-overlapping work up front* — the plugin is the backstop that catches
an overlap your selection missed, especially across two independent fleets.

## The load-bearing idea: id = branch = claim

Give every parallel unit ONE canonical id and use it for all three of:
its **branch name**, its **worktree**, and its **`feature` claim**. Then a duplicate
collides three ways:

- same `feature://<id>` claim → caught at dispatch (step 3), even with disjoint files;
- same branch → caught for free at the sibling's SessionStart (engine reads `branch`);
- overlapping file → caught at edit time by the pre-edit hook.

**The engine already canonicalizes** the feature id (lowercase, strip punctuation/
separators) on both claim and check, so `§0.5.B`, `0.5B` and `05b` collide for free,
while `payment-v2` and `checkout-v2` stay distinct. You do **not** need a helper for
case or punctuation drift.

You only need one if your tracker ids carry **extra text the engine can't know to
drop** — e.g. a roadmap convention where `0.5B-questionnaire` and `0.5B` are the same
work (the engine keeps them distinct, correctly, because dropping a name suffix is a
domain choice). Put that reduction in ONE shared helper every skill calls, so copies
can't drift:

```js
// canon.mjs — domain-shape reduction ONLY (the engine does case/punctuation).
// This example extracts a section number; it is roadmap-specific.
export function canon(s) {
  const c = String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const m = c.match(/(\d+)([a-z]?)/);          // first digit-led token + one letter
  return m ? m[1] + m[2] : c;
}
if (process.argv[2] !== undefined) process.stdout.write(canon(process.argv[2]) + '\n');
```

> ⚠️ Number-extraction like the above is domain-specific and **unsafe as a general
> rule** — it would collapse `payment-v2` and `checkout-v2` both to `2`. Only use it
> when your ids really are section numbers. For most trackers (issue/ticket numbers),
> the engine's built-in canonicalization is all you need — pass the raw id.

## Steps

1. **Select non-overlapping units.** Your up-front selection is the first dedup pass;
   the claim then locks each unit in before anything is created on disk.

2. **Claim each unit's feature FIRST — before creating its worktree (the gate).** For
   each unit, derive the canonical id and dispatch the cheap `monkey-manager-scout`
   (haiku) agent to claim it:

   ```bash
   id=$(node canon.mjs 'Issue #412')        # -> 412
   # scout runs: claim feature=$id path=<unit's file scope> note="$id: <summary>"
   ```

   - `CLAIMED` → proceed to create its worktree (step 3).
   - `CONFLICT` (same feature, or a shared file a sibling/other fleet holds) →
     **do NOT create or launch that unit; surface it to the user.** Claiming before
     the worktree exists means a conflict costs you nothing to back out of — this is
     the moment that saves you the duplicate hours.

3. **Pre-create one worktree + branch per CLAIMED unit, named by the canonical id:**

   ```bash
   git worktree add ../wt-$id -b feature-$id
   # repeat per claimed unit
   ```

4. **Dispatch** each agent with its `WORKTREE_PATH`, scope, and a scope-lock prompt
   ("touch only these files; don't commit/merge; report gate output verbatim").
   Tell each agent to re-claim (same feature id) if its scope grows.

5. **Integrate on the main thread only** after each unit's gates pass: merge its
   branch, resolve overlaps, remove the worktree + branch. Claims release at the
   agent's SessionEnd (and stale ones are TTL-reaped if an agent dies).

## Honest limit

A teammate (or fleet) **not** running this convention won't file feature claims —
they still get the automatic file + branch warnings, but not feature-level dedup.
Advisory coordination can't force participation; only a blocking mutex could, and
that would break solo use and the never-block design. Keep step 1 as the real guard.
