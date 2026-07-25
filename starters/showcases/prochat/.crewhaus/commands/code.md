---
description: Run a task in the Python sandbox. Show the code and the result.
argument-hint: "<what to compute / plot / parse>"
---
Use the `Python` tool in the sandbox to: **$ARGUMENTS**

Steps:
1. The container is `python:3.13-slim` with **no network** — the
   standard library is all you get. `numpy`, `pandas`, `matplotlib`,
   `scipy` and `requests` are NOT installed and cannot be installed at
   call time. Reach for `math`, `statistics`, `itertools`, `csv`,
   `json`, `re`, `decimal`, `fractions`, `collections` instead.
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

For anything chart-shaped, print an ASCII chart from the standard
library and describe what it shows in 1-2 sentences. Never import
`matplotlib`, and never tell the user a PNG was written — the
container is read-only apart from `/tmp`, which is thrown away when
the call returns.

If the task is better suited to `JavaScript` (e.g. JSON tooling) or
`Shell` (e.g. a quick text munge), pick that tool instead — `$ARGUMENTS`
is a target, not a constraint on the toolchoice.
