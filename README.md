# Documentation exercises

An exercise hands a coding agent a piece of work that can only be done by reading a
library's published material, asks it afterwards how difficult that library was to use
correctly, and leaves both answers behind as a draft pull request. The point is not the
code the agent writes — it is what the exercise reveals about the documentation.

This README is the program. Each agent is a section of it, so running the README runs the
exercise with every agent in turn, and naming a section runs one:

```
xmd run README.md          claude, then codex
xmd run README.md#claude   claude alone
xmd run README.md#codex    codex alone
```

Every run is named, and runs meant to be compared share a name — `sweep-3`,
`after-agents-md-fix`. The name is asked once, here, whichever way the program is run, and
it leads every branch name and pull request title.

<Ask schema={{type:"string",minLength:1,description:"What to call this iteration, for the branch names and pull request titles."}} question="What is this iteration called?" as="iteration" />

## Methodology

[`docs/methodology.md`](docs/methodology.md) is the method these exercises serve: shape
agent behaviour by giving a model the smallest set of facts it cannot safely infer, then
verify the behaviour rather than asking the model's opinion of the library. It is written
as a prompt, for the agent doing the documentation work.

The harness is the instrument for the parts of that method which need one. The task is
answered before the assessment question is ever shown, because asking first primes the
evaluator. Every run is a fresh session in its own worktree, and the transcript is kept.
Scenario prompts are files rather than prose inside a program, so the identical task can
be rerun against improved documentation — the iteration name is what tells one run from
the next, and the draft pull request is where the two are compared.

## What a run does

A run is one agent doing one scenario. Running every agent is worth the wait: a mistake
both agents make is evidence about the documentation, while a mistake only one makes
usually is not.

Each run:

1. Creates a worktree of this repository on a branch of its own, so nothing touches the
   current checkout.
2. Sends the scenario's task prompt to the agent in a session of its own, which reads the
   documentation, writes the implementation, and tests it.
3. Asks the scenario's assessment question in the same session, so it is answered from
   the work just done rather than from general impressions.
4. Writes `transcript.md` — both prompts verbatim, and both replies.
5. Commits, pushes, and opens a **draft** pull request titled
   `{iteration}-{agent}: {scenario}`, whose description is the assessment.

## Scenarios

A scenario is a directory under `scenarios/` holding two prompts:

| File | What it is |
| --- | --- |
| `task.md` | The work, including which documentation is authoritative and what may not be used. |
| `assessment.md` | The question asked once the work is done. |

Both are sent verbatim and quoted verbatim in the transcript, which is why they are files
rather than prose inside a program. Adding a directory adds a scenario; nothing else needs
editing.

`download-all` is the one that exists: implement `downloadAll(urls, destination)` on
Effection — bounded concurrency, cancellation, cleanup of partial files, orderly Ctrl-C —
learning Effection only from the local documentation preview, with no guessing at APIs and
no reading of Effection's source.

## Before running

- The documentation the scenario names must be reachable. `download-all` reads a local
  Effection preview at `http://localhost:8000`.
- `origin` must be a repository you can push to, and `gh` must be authenticated, for the
  draft pull request.
- Every permission request is approved automatically for the duration of the run, because
  the agent writes files and runs commands the whole way through.

## Run it

The sections below are the entrypoints. Each runs `download-all` unless `<Exercise>` is
given another scenario, and both share the iteration name asked for at the top, so the
whole-README run produces two runs that can be compared.

A run with nothing left to ask is `<Exercise scenario="download-all" agent="codex" iteration="sweep-3" />`.

## claude

<Exercise agent="claude" iteration={iteration} />

## codex

<Exercise agent="codex" iteration={iteration} />
