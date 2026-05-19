# Structured Output

Localagent supports structured final answers for workflows that need machine-readable output from a local model.

Example: inspect a document, issue, or pull request with Pi tools, then classify whether it matches a criterion.

## How It Works

Use `--final-schema <path>` or the shorter `--schema <path>` in Pi print mode (`-p` or `--print`).

Localagent does not modify Pi and does not proxy the model API. Instead, it creates a temporary Pi extension for the run:

1. Localagent reads the JSON Schema file.
2. It generates a Pi extension that registers a `final_json` tool with that schema as its parameters.
3. It starts Pi with that extension plus an extra instruction telling the model to call `final_json` when the work is done.
4. Pi can still use normal tools during the investigation.
5. When the model calls `final_json`, Pi validates the tool arguments against the schema, the extension writes the JSON to disk, and the run terminates.
6. Localagent prints only the captured JSON.

This keeps the agent loop freeform while making the final answer structured.

## CLI

```bash
localagent --final-schema ./examples/schemas/binary-classifier.schema.json -p "classify whether this issue is release-blocking: <text>"
```

Alias:

```bash
localagent --schema ./examples/schemas/binary-classifier.schema.json -p "classify whether this issue is release-blocking: <text>"
```

You can also set a default schema with:

```bash
export LOCALAGENT_FINAL_SCHEMA=./examples/schemas/binary-classifier.schema.json
```

## Tool Allow Lists

If you pass Pi a tool allow list with `--tools` or `-t`, localagent automatically adds `final_json` to it.

For example, this:

```bash
localagent --final-schema ./examples/schemas/binary-classifier.schema.json --tools bash -p "inspect the repository and classify the issue"
```

is passed to Pi as if the tool list were:

```text
bash,final_json
```

`--final-schema` cannot be used with `--no-tools`, because the final JSON is submitted through a Pi tool.

`--final-schema` also requires Pi print mode (`-p` or `--print`). Localagent suppresses Pi's normal stdout during schema runs so it can print only the captured JSON, which is not compatible with Pi's interactive terminal UI.

## Example Schema

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["is_match", "label", "confidence", "summary", "reasons", "caveats"],
  "properties": {
    "is_match": { "type": "boolean" },
    "label": {
      "type": "string",
      "enum": ["match", "partial_match", "no_match", "unclear"]
    },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
    "summary": { "type": "string" },
    "reasons": { "type": "array", "items": { "type": "string" } },
    "caveats": { "type": "array", "items": { "type": "string" } }
  }
}
```

## Example Output

```json
{
  "is_match": true,
  "label": "match",
  "confidence": 0.86,
  "summary": "The issue describes a startup crash that blocks the release candidate path.",
  "reasons": [
    "The issue affects the release branch.",
    "The failure happens before the main UI can load."
  ],
  "caveats": ["The impact on patch releases was not checked."]
}
```

## Reliability Notes

The schema must be a JSON object schema with root `type: "object"`.

If the model never calls `final_json`, localagent exits with a clear error instead of printing unstructured text.

This design works even when the local OpenAI-compatible backend does not support OpenAI `response_format: { type: "json_schema" }`, because Pi validates the final tool arguments before executing the tool.
