---
name: to-workflow
description: Turn a need into a Forgequor Workflow file for this Project, reusing a close one when it exists. Use when the human wants a new Workflow, or to change how Runs go (which Steps, Gates, reviews).
---

# To workflow

A **Workflow** is a YAML file of **Steps** that Forgequor runs. Forgequor holds built-in Workflows; a Project adds its own, or overrides a built-in by using its name, in `forgequor/workflows/<name>.yaml` at the Project root. [REFERENCE.md](REFERENCE.md) lists every Step type, Agent, Gate kind and built-in Workflow: write only from it.

## Process

1. **Need.** Ask until you can state in one sentence what the Run produces and where the human must decide. Skip questions the human already answered.
2. **Reuse.** List the Project's `forgequor/workflows/*.yaml` and read the built-in Workflows in REFERENCE.md. Name the closest one and say what differs. Propose, in this order: use it as is (no file to write, stop here), adjust it (copy it to `forgequor/workflows/<name>.yaml`, change the difference), or write a new one. Wait for the human's choice.
3. **Write** `forgequor/workflows/<name>.yaml`. The file name is the Workflow's `name`: lowercase letters, digits and dashes. Use only Step types, Agents, Gate kinds and inputs from REFERENCE.md, and follow its rules. Give each Step a one-line comment when its `on_reject` or `when` is not obvious.
4. **Validate** until `valid` is `true`:

   ```sh
   jq -Rs '{yaml: .}' forgequor/workflows/<name>.yaml |
     curl -s -X POST -H 'content-type: application/json' -d @- "${FORGEQUOR_URL:-http://127.0.0.1:4170}/api/workflows/validate"
   ```

   The answer is `{valid, errors: [{path, line?, column?, message}]}` and lists every error. Fix each, re-run, repeat.
5. **No answer.** When curl cannot connect (Forgequor is not running, or `FORGEQUOR_URL` is wrong), tell the human to open Forgequor's Workflows page: it shows the file's errors once the file is on the Project's default branch. Do not call the file valid.

Done when the validation answered `valid: true`, or the human has been told to check the Workflows page. Then tell the human the file's path, and that Forgequor offers it at launch only once it is on the Project's default branch (commit and merge it).
