---
description: Run a documentation exercise in its own worktree — hand a scenario to an agent, ask it afterwards how hard the library was to use, and open a draft pull request with that answer as the description.
props:
  type: object
  properties:
    scenario:
      type: string
      default: download-all
      description: The scenario to run, named after its directory under `scenarios/`.
    agent:
      enum: [claude, codex]
      description: The agent that runs it. Asked for when absent.
    iteration:
      type: string
      description: What to call this run. It leads the branch name and the pull request title. Asked for when absent.
---

## The scenario, the agent and the iteration

<Glob include={["scenarios/*/task.md"]} as="tasks" />
<Let as="available" value={tasks.map(path => path.split("/")[1])} />

<Assert expr={available.includes(props.scenario)} msg={"There is no scenarios/" + props.scenario + " directory. Available: " + available.join(", ")} />

<Ask value={props.agent} schema={{type:"string",enum:["claude","codex"],description:"The agent that runs the exercise."}} question="Which agent should run the exercise?" as="agent" />
<Ask value={props.iteration} schema={{type:"string",minLength:1,description:"What to call this run, for the branch name and the pull request title."}} question="What is this iteration called?" as="iteration" />

<File path={"scenarios/" + props.scenario + "/task.md"} as="task" />
<File path={"scenarios/" + props.scenario + "/assessment.md"} as="assessment" />

Running **{props.scenario}** with **{agent}**, as iteration `{iteration}`.

## A worktree for the task

The iteration name is free text, so the branch takes a slug of it, and a timestamp so a
name used twice does not land back in the first run's worktree.

```sh exec as="naming"
printf '%s-%s-%s-%s' "{iteration}" "{agent}" "{props.scenario}" "$(date +%Y%m%d-%H%M%S)" \
  | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9-' '-' | sed 's/^-*//; s/-*$//'
```

<Let as="branch" value={"exercise/" + naming.stdout} />

<Worktree name={naming.stdout} branch={branch}>

<Agent name={agent}>
<ApproveAll>
<Session name="exercise">

```sh exec as="checkout"
printf '%s' "$PWD"
```

Working in `{checkout.stdout}` on `{branch}`.

## The task

<Prompt text={task} timeout="3h" throwOnError as="implementation" />

## The assessment

<Prompt text={assessment} timeout="30min" throwOnError as="verdict" />

## The transcript

<File path="transcript.md">
# Session transcript

The **{props.scenario}** exercise, iteration `{iteration}`, run by `{agent}` on `{branch}`.

## 1. Task

{task}

## 2. Implementation

{implementation}

## 3. Assessment

{assessment}

## 4. Verdict

{verdict}
</File>

## The draft pull request

<Let as="subject" value={iteration + "-" + agent + ": " + props.scenario} />

<Git.Add paths={["."]} />
<Git.Commit as="commit">
{subject}

Ran the {props.scenario} scenario against the documentation it names. The session
transcript, including both prompts verbatim, is in transcript.md.
</Git.Commit>
<Git.Push />
<PullRequest title={subject} draft as="pr">
{verdict}
</PullRequest>

</Session>
</ApproveAll>
</Agent>
</Worktree>

Commit `{commit}` is pushed, and the draft pull request is at {pr.url}.
