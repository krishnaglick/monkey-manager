---
name: feature-claim
description: Example monkey-manager workflow for a SINGLE session about to start a feature when other Claude sessions may be live in the same repo. Derive a stable feature id, claim it before editing, stop on CONFLICT. Use when starting feature work and you want fire-and-forget collision avoidance against sibling sessions/worktrees.
---

# feature-claim (example)

A worked example of using the `monkey-manager` MCP server to avoid colliding with
other live sessions before you start a feature. Coordination is **advisory** — it
warns, it never blocks. Adapt the ids/paths to your project; the shape is the point.

## What you get for free (no action needed)

- **File warnings.** Before you edit a file another live session is touching, the
  pre-edit hook warns (and escalates to an "ask" prompt if they explicitly claimed it).
- **Branch warnings.** At session start, if another live session is on your branch,
  you're told — likely the same feature. This needs no claim because the engine
  already knows everyone's branch.

The steps below add the **forward-looking** layer on top: reserve a feature *before*
the first edit so two sessions don't both start it.

## The one rule: a stable feature id

`claim` **requires** a `feature` id. It is the primary collision key — two sessions
claiming the same feature collide **even if their files are disjoint**. So the id
must be **reproducible**: derive it from a tracker (issue number, ticket, roadmap
section), never invent a free-form slug per session, or two sessions pick different
slugs for the same work and never collide.

The engine **canonicalizes** the id (case/punctuation/separator-insensitive), so
`§0.5.B`, `0.5B` and `05b` all match — pass whatever your tracker gives, just be
consistent about *which* id. Distinct ids (`payment-v2` vs `checkout-v2`) stay
distinct; the engine won't over-merge.

> Only if your ids carry extra text the engine can't know to drop (e.g. a roadmap
> name suffix) do you need a derivation helper — and then put it in ONE shared place
> every skill calls, so copies can't drift (see the `fleet-dispatch` example).

## Steps

1. **Pick the feature id.** e.g. issue `#412` → `issue-412`. Reproducible from the tracker.

2. **Claim before editing.** Reserve the feature (and optionally the file scope you
   expect to touch) with a short note:

   ```
   claim feature=issue-412 path=src/payments/ note="issue-412: refund flow"
   ```

   - `CLAIMED` → you're clear, start working.
   - `CLAIMED (conflicts): …` → a sibling already holds this feature or an
     overlapping file. **STOP and surface it** — don't race. Decide with the user
     whether to defer, pick another feature, or coordinate.

   Keep DB chatter off your main context by dispatching the bundled
   `monkey-manager-scout` (haiku) agent to run the claim and report a one-line verdict.

3. **Re-claim to update the note** as scope shifts — same `feature` id, new note.
   The claim's age is preserved.

4. **Release when done.** `release` drops all your claims (it also happens
   automatically at SessionEnd, and stale claims are TTL-reaped if a session dies).

## Claim first — even solo

Claim the feature **first thing, before the first edit — even when you're the only
live session.** `active` showing no siblings is **not** a reason to skip: a second
session (a teammate, a `/tsunami` fleet, a future you in another terminal) can appear
mid-feature, and a claim already on file is what lets the warning fire for them.
Claiming first is cheap and keeps the discipline uniform, so it never gets forgotten
on the one run where it mattered.

Coordination stays **advisory** — this is a recommended default, not a hard mutex; the
engine still never blocks. The automatic file/branch warnings back you up, but they
only cover files you've *already* touched, so they can't reserve the work *before* the
first edit the way an up-front claim does.
