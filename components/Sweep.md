---
description: Run one scenario across several agents under a single iteration name, so the same work can be compared across model families.
props:
  type: object
  properties:
    scenario:
      type: string
      default: download-all
      description: The scenario every agent is given, named after its directory under `scenarios/`.
    agents:
      type: array
      items:
        enum: [claude, codex]
      minItems: 1
      uniqueItems: true
      default: [claude, codex]
      description: The agents that run it, one after another.
    iteration:
      type: string
      description: What to call this sweep. Every run in it shares the name. Asked for when absent.
---

<Ask value={props.iteration} schema={{type:"string",minLength:1,description:"What to call this sweep, for the branch names and pull request titles."}} question="What is this iteration called?" as="iteration" />

Running **{props.scenario}** as iteration `{iteration}`, once per agent.

<Each in={props.agents} let="name">

<Exercise scenario={props.scenario} agent={name} iteration={iteration} />

</Each>

Every run in `{iteration}` is finished. Compare their pull requests — a mistake both
agents made is evidence about the documentation, and one only a single agent made is
usually not.
