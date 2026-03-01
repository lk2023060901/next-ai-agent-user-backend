# Plugin Usage Event Spec (`plugin-usage.v1`)

This document defines the standardized JSON event contract for plugin usage telemetry.

## Core principles

- We define required core fields only.
- Plugin developers can add custom fields in `metrics` and `payload`.
- Runtime and backend keep unknown fields without schema lock-in.

## Required top-level fields

```json
{
  "specVersion": "plugin-usage.v1",
  "pluginName": "weather-plugin",
  "pluginVersion": "1.2.3",
  "eventId": "unique-event-id",
  "eventType": "plugin.tool.weather_lookup",
  "timestamp": "2026-03-01T12:34:56.789Z",
  "workspaceId": "ws_xxx",
  "runId": "run_xxx",
  "status": "success",
  "metrics": {},
  "payload": {}
}
```

Required keys:

- `specVersion`
- `pluginName`
- `pluginVersion`
- `eventId`
- `eventType`
- `timestamp` (RFC3339)
- `workspaceId`
- `runId`
- `status` (`success` | `failure` | `partial`)
- `metrics` (JSON object)
- `payload` (JSON object)

## Metrics recommendations

Standard keys (recommended):

- `inputTokens`
- `outputTokens`
- `totalTokens`
- `successCount`
- `failureCount`
- `latencyMs`

Custom keys are allowed and preserved.

## Payload recommendations

Standard keys (recommended):

- `recordType` (`plugin`)
- `scope` (`coordinator` | `sub_agent`)
- `agentId`
- `taskId`
- `toolName`
- `pluginId`

Custom keys are allowed and preserved.

## Runtime integration

Runtime automatically emits plugin tool call events for both coordinator and sub-agent flows:

- event start/end timestamps
- success/failure status
- default metrics (`latencyMs`, success/failure count)
- optional custom metrics/payload from plugin return value

