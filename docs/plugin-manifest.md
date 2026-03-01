# OpenClaw Plugin Manifest (`openclaw.plugin.json`)

This document defines the backend/runtime contract for plugin manifests used by install and runtime loading.

## Required fields

```json
{
  "id": "my-plugin-id",
  "kind": "tool",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "Plugin description",
  "configSchema": {
    "type": "object",
    "properties": {},
    "required": []
  },
  "runtime": {
    "tool": {
      "entry": "dist/tool.js",
      "exportName": "createTool"
    }
  }
}
```

- `id`: plugin identifier, must match install request/plugin record id.
- `configSchema`: JSON schema object for plugin configuration.
- `kind=tool`: `runtime.tool.entry` and `runtime.tool.exportName` are required.

## Runtime tool entry rules

- `runtime.tool.entry`:
  - must be a safe relative path inside plugin root
  - cannot start with `/`, `./`, `../`
  - cannot contain `.` / `..` path segments
  - must end with `.js`, `.mjs`, or `.cjs`
  - must exist as a file at install/load time
- `runtime.tool.exportName`:
  - required
  - either `default` or a valid JS export identifier

## Runtime tool export contract

The export pointed by `runtime.tool.exportName` must be one of:

1. A factory function that returns a tool object (recommended)
2. A tool object directly

Tool object shape:

```json
{
  "name": "my_tool",
  "description": "Tool description",
  "parameters": {
    "type": "object",
    "properties": {}
  },
  "executeMode": "openclaw",
  "execute": "function"
}
```

- `name`: optional, defaults to plugin-derived name
- `description`: optional
- `parameters`: optional JSON Schema object; defaults to permissive object schema
- `executeMode`: optional
  - `openclaw` (default): `execute(toolCallId, args, context)`
  - `ai-sdk`: `execute(args, aiOptions, context)`
  - `args-only`: `execute(args, context)`
- `execute`: required function

## Optional permissions block

```json
{
  "permissions": {
    "network": true,
    "fsRead": ["./data"],
    "fsWrite": ["./cache"],
    "exec": ["git", "node"]
  }
}
```

- `permissions` is optional.
- `network` is boolean.
- `fsRead`, `fsWrite`, `exec` are string arrays (normalized by backend).

## Validation behavior

- Install-time validation (service):
  - verifies manifest structure and required fields
  - verifies `runtime.tool.entry` resolves inside plugin root
  - verifies runtime entry file exists
- Runtime load-time validation (runtime):
  - revalidates manifest and runtime entry fields
  - rechecks runtime entry file exists under installed path
