# Structured Output

Structured final output is out of scope for localpi.

Localpi focuses on launching Pi against local models with good runtime defaults: managed `llama-server`, optional LM Studio support, default tools, tool approval, and token status.

Schema-constrained classifier workflows belong in caller-specific tools such as `localpager-agent`, where the prompt, schema, retries, and output validation belong to the application workflow.

The previous localagent `--final-schema` / `--schema` behavior was removed during the localpi rename implementation.
