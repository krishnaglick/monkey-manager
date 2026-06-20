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
  const c = String(s).toLowerCase().replace(/[^a-z0-9]/g, '')
    .replace(/q\d+/g, '');                     // drop a label suffix (e.g. "Q3") — same section
  const m = c.match(/(\d+)([a-z]?)/);          // first digit-led token + one letter
  return m ? m[1] + m[2] : c;
}
if (process.argv[2] !== undefined) process.stdout.write(canon(process.argv[2]) + '\n');
```

> ⚠️ Number-extraction like the above is domain-specific and **unsafe as a general
> rule** — it would collapse `payment-v2` and `checkout-v2` both to `2`. Only use it
> when your ids really are section numbers. For most trackers (issue/ticket numbers),
> the engine's built-in canonicalization is all you need — pass the raw id.
>
> **Self-test the divergent spellings that MUST collide.** The trap is a label the
> regex silently *keeps*: the first version above lacked the `q\d+` strip, so
> `canon('§5')` → `5` but `canon('§5 Q3')` → `5q` — two ids for the same section, both
> claims succeed, neither session sees the other. Assert the pairs in the helper
> (`canon('§5') === canon('§5 Q3')`) while keeping real sub-sections distinct
> (`canon('§0.B') !== canon('§0.J')`). A real fleet collision (2026-06-20) traced to
> exactly this. The helper is the ONLY thing making two sessions agree on an id — if it
> splits, every downstream guard (claim, branch, worktree) splits with it.

## Steps

1. **Select non-overlapping units — scan for live siblings FIRST.** Your up-front
   selection is the first dedup pass; the claim (step 2) then locks each unit in before
   anything is created on disk. But the claim only catches an **exact** id match — it
   cannot see a sibling working the same unit under a *divergent* id (a label your canon
   helper didn't collapse, or a hand-typed id). So before locking the set, query
   `active` for other live sessions and `check` each candidate's canonical id; also scan
   the active ids/paths for a **shared numeric prefix** or an **overlapping file**. A
   divergent-id sibling won't match exactly but shows up by prefix or path — surface it
   and drop or sequence that candidate. **If the engine warned "likely the same feature"
   at your SessionStart, this scan is mandatory, not optional** — don't absorb that
   warning silently into selection. (Treat a prefix match as a human-judged warning, not
   an auto-claim: a hard claim on the bare number would false-collide legit sibling
   sub-sections like `0b` vs `0j`.)

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

   **Pin every agent to its worktree — a dispatched agent does NOT inherit the
   orchestrator's worktree cwd.** It starts in the **primary checkout**, so a relative
   path resolves against the wrong tree and the edit silently lands there — corrupting
   the shared checkout a sibling session may be on, and skipping the worktree entirely.
   Require the agent's FIRST action to be entering `WORKTREE_PATH`, then asserting
   `pwd` ends in the expected worktree before any edit. Give absolute worktree paths in
   the scope list. After the agent reports, confirm the diff actually landed in the
   worktree before merging.

5. **Integrate on the main thread only** after each unit's gates pass: merge its
   branch, resolve overlaps, remove the worktree + branch. Claims release at the
   agent's SessionEnd (and stale ones are TTL-reaped if an agent dies).

   **Assert the merge target first — the shared checkout can drift between your tool
   calls.** When other live sessions share the repo, a sibling can switch the root
   checkout onto *its* branch between two of your calls, so a merge run "from root"
   lands on the wrong branch, not your integration target. Before each merge, either
   assert the root is on your integration branch (`HEAD` check, else STOP), or — when a
   sibling is live — integrate from a dedicated checkout pinned to the integration
   branch and *outside* the fleet's worktree dir, then remove it after. Same hazard the
   claim warns about (two sessions, shared state), one layer down at the git level.

## Honest limit

A teammate (or fleet) **not** running this convention won't file feature claims —
they still get the automatic file + branch warnings, but not feature-level dedup.
Advisory coordination can't force participation; only a blocking mutex could, and
that would break solo use and the never-block design. Keep step 1 as the real guard.

Subtler — and the one that bites participants: even a sibling that **does** claim only
collides if it derives the **same** canonical id you do. A divergent spelling the domain
helper failed to collapse (or a hand-typed id) produces a different `feature://`, so
both claims succeed and neither sees the other — duplicate work, no warning. Two
defenses, both above: keep the reduction in one shared, **self-tested** helper (so the
spellings that mean the same unit can't drift apart), and run step 1's active/prefix
scan (which catches the divergent-id sibling that the exact-match claim structurally
cannot).
