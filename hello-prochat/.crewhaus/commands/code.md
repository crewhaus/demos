---
description: Run a task in the Python sandbox. Show the code and the result.
argument-hint: "<what to compute / plot / parse>"
---
Use the `Python` tool in the sandbox to: **$ARGUMENTS**

Steps:
1. Think about what packages you need. `numpy`, `pandas`, `matplotlib`,
   `scipy`, `requests` are all available.
2. Write a short, readable script — under 40 lines if at all possible.
3. Call `Python` once with that script.
4. Present the result.

Output format:

````
**Code**
```python
<the script>
```

**Output**
<stdout / stderr / value>
````

If a plot was produced, describe what it shows in 1-2 sentences (the
terminal won't render the image, but the description is the value).

If the task is better suited to `JavaScript` (e.g. JSON tooling) or
`Shell` (e.g. a quick text munge), pick that tool instead — `$ARGUMENTS`
is a target, not a constraint on the toolchoice.
