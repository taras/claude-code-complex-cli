---
description: Take a value from the caller, or ask a person for it when the caller did not supply one.
props:
  type: object
  properties:
    value: {}
    schema: {}
    question:
      type: string
      description: The question a person is shown when the value has to be asked for.
  required: [schema, question]
returns:
  type: string
---

<If condition={props.value !== undefined && props.value !== null}>

<Return value={props.value} />

<Else>

<Elicit as="picked" schema={props.schema}>
{props.question}
</Elicit>

<Return value={picked} />

</Else>
</If>
