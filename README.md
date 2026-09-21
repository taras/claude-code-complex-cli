# Documentation exercises

An exercise hands a coding agent a piece of work that can only be done by reading a
library's published material, asks it afterwards how difficult that library was to use
correctly, and leaves both answers behind as a draft pull request. The point is not the
code the agent writes — it is what the exercise reveals about the documentation.

This README is the program. Running it runs an exercise:

```
xmd run README.md
```

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

1. Creates a worktree of this repository on a branch of its own, so nothing touches the
   current checkout.
2. Sends the scenario's task prompt to the agent, which reads the documentation, writes
   the implementation, and tests it.
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

The run asks which agent should do the work and what to call this iteration, and uses the
`download-all` scenario unless told otherwise. The iteration name is what tells one run of
a scenario from the next — `sweep-3`, `after-agents-md-fix` — and it leads both the branch
name and the pull request title. Naming all three asks nothing:
`<Exercise scenario="download-all" agent="codex" iteration="sweep-3" />`.

<Exercise />
