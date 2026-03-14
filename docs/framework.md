# OpenClaw Framework

## 1. 总体框架组成

```mermaid
flowchart LR
    U[User / External Surface]

    subgraph Entry["Entry Layer"]
        E1["src/entry.ts\nCLI entry wrapper"]
        E2["src/cli/run-main.ts\nCLI bootstrap + lazy command registration"]
        E3["src/cli/program/*\nCommand tree"]
    end

    subgraph Runtime["Core Runtime"]
        G["src/gateway/server.impl.ts\nGateway Core"]
        C["src/config/*\nConfig + Session + State"]
        S["src/secrets/*\nSecrets runtime snapshot"]
        I["src/infra/*\nInfra / network / fs / process / bonjour"]
        P["src/plugins/*\nPlugin discovery + registry + sidecars"]
        R["src/routing/*\nRoute + session key resolution"]
        CH["src/channels/*\nCross-channel policies"]
        L["src/logging/*\nLogs + diagnostics"]
    end

    subgraph Agent["Agent Execution"]
        AR["src/auto-reply/*\nInbound orchestration"]
        AG["src/commands/agent.ts\nUnified agent command"]
        A1["src/agents/pi-embedded*.ts\nEmbedded agent runtime"]
        A2["src/agents/cli-runner.ts\nExternal CLI backend runner"]
        MEM["src/memory/*\nMemory / embeddings"]
        MU["src/media-understanding/*\nMedia understanding"]
        LU["src/link-understanding/*\nLink understanding"]
    end

    subgraph Surfaces["Connected Surfaces"]
        GW["Gateway WS / HTTP methods"]
        TUI["src/tui/*\nTerminal UI"]
        WEBUI["ui/\nControl UI (browser)"]
        NODE["apps/* + src/node-host/*\nmacOS/iOS/Android nodes"]
    end

    subgraph Channels["Inbound/Outbound Channels"]
        TG["src/telegram/*"]
        SL["src/slack/*"]
        DC["src/discord/*"]
        SG["src/signal/*"]
        IM["src/imessage/*"]
        LN["src/line/*"]
        WB["src/web/*"]
        PX["extensions/*\nChannel plugins / capability plugins"]
    end

    U --> E1 --> E2 --> E3
    E3 -->|gateway run| G
    E3 -->|agent / send / config / etc.| AG

    G --> C
    G --> S
    G --> I
    G --> P
    G --> R
    G --> CH
    G --> L
    G --> GW
    G --> NODE
    G --> PX

    TG --> AR
    SL --> AR
    DC --> AR
    SG --> AR
    IM --> AR
    LN --> AR
    WB --> AR
    PX --> AR

    AR --> MU
    AR --> LU
    AR --> R
    AR --> C
    AR --> AG

    AG --> A1
    AG --> A2
    A1 --> MEM
    A2 --> MEM

    G --> TUI
    G --> WEBUI
    GW --> WEBUI
    GW --> TUI
```

## 2. Gateway 的装配与调度关系

```mermaid
flowchart TB
    CLI["openclaw gateway run"]
    G["Gateway Core\nstartGatewayServer()"]

    CFG["Config snapshot\nvalidate + migrate legacy config"]
    SEC["Secrets runtime\nprepare / activate / reload"]
    PLG["Plugin registry\nauto-enable + discover + sidecars"]
    WS["WS handlers + server methods\nrequest context"]
    DISC["Discovery\nmDNS / wide-area / Tailscale exposure"]
    CHAN["Channel manager\nstart / stop channels"]
    CRON["Cron runtime"]
    HEART["Heartbeat runner"]
    HEALTH["Channel health monitor"]
    MAINT["Maintenance timers\nhealth tick / dedupe cleanup / media cleanup"]
    BOOT["BOOT.md boot run\noptional one-shot agent turn"]
    RELOAD["Config reloader\nhot reload or restart plan"]
    BCTRL["Browser control sidecar"]
    HOOK["gateway_start hooks"]

    CLI --> G
    G --> CFG
    CFG --> SEC
    SEC --> PLG
    PLG --> WS
    WS --> CHAN
    G --> DISC
    G --> CRON
    G --> HEART
    G --> HEALTH
    G --> MAINT
    G --> BCTRL
    G --> HOOK
    G --> RELOAD
    G --> BOOT

    RELOAD -->|hot reload| SEC
    RELOAD -->|hot reload| CHAN
    RELOAD -->|hot reload| HEART
    RELOAD -->|hot reload| HEALTH
    RELOAD -->|restart required| CLI

    CRON --> AGENT["agentCommand / agent runtime"]
    HEART --> AGENT
    CHAN --> INBOUND["Inbound messages"]
    INBOUND --> AGENT
    AGENT --> WS
    AGENT --> OUT["Outbound delivery"]
```

## 3. 渠道消息进入直到回复送回去的核心时序

```mermaid
sequenceDiagram
    participant User as External User
    participant Channel as Channel Adapter\n(Telegram/Slack/.../plugin)
    participant AR as auto-reply dispatcher
    participant Prep as media/link/session prep
    participant AgentCmd as commands/agent.ts
    participant Runner as embedded runner or CLI runner
    participant Events as agent events / buffers
    participant Deliver as outbound delivery
    participant OutCh as outbound adapter
    participant UI as Gateway WS / TUI / Control UI

    User->>Channel: send inbound message
    Channel->>Channel: parse update / debounce / policy checks
    Channel->>AR: dispatchInboundMessage(...)
    AR->>Prep: finalize inbound context
    Prep->>Prep: media understanding
    Prep->>Prep: link understanding
    Prep->>Prep: command auth + session init + route resolve

    alt Native command handled before model run
        Prep-->>Channel: immediate command reply / state change
    else Needs agent turn
        Prep->>AgentCmd: agentCommand(...)
        AgentCmd->>AgentCmd: resolve session, model, delivery plan
        AgentCmd->>Runner: runEmbeddedPiAgent() or runCliAgent()
        Runner-->>Events: streaming deltas / tool events / lifecycle
        Events-->>UI: WS broadcast / TUI updates / Control UI updates
        Runner-->>AgentCmd: final payloads + meta
        AgentCmd->>Deliver: deliverAgentCommandResult(...)
        Deliver->>Deliver: normalize payloads + resolve target channel
        Deliver->>OutCh: deliverOutboundPayloads(...)
        OutCh-->>Channel: send text/media/reply
        Channel-->>User: final response
    end
```

## 4. 关键时序与后台调度

```mermaid
sequenceDiagram
    participant Boot as Gateway startup
    participant G as Gateway Core
    participant Timers as Timers / Watchers
    participant Ch as Channels
    participant A as Agent runtime
    participant UI as WS clients / TUI / Web UI

    Boot->>G: startGatewayServer()
    G->>G: config validate + secrets preflight
    G->>Ch: start channels / sidecars
    G->>Timers: start cron / heartbeat / maintenance / config reload watcher
    G->>UI: attach WS handlers

    loop Inbound events
        Ch->>A: dispatch inbound message
        A-->>UI: stream lifecycle / assistant / tool events
        A-->>Ch: resolved outbound payloads
    end

    loop Heartbeat interval
        Timers->>A: heartbeat-triggered turn
        A-->>UI: heartbeat events
    end

    loop Cron schedule
        Timers->>A: scheduled isolated agent run
        A-->>Ch: optional direct delivery
    end

    loop Maintenance interval
        Timers->>G: health refresh / dedupe cleanup / media cleanup
        G-->>UI: health snapshot changes
    end

    loop Config file changes
        Timers->>G: build reload plan
        alt hot-reloadable
            G->>Ch: update runtime parts in place
        else restart-needed
            G->>Boot: request process restart
        end
    end
```

## 5. Agent 子系统细化

```mermaid
flowchart TB
    IN[Inbound message / CLI agent request]

    subgraph ReplyPrep["Reply Preparation"]
        D1["src/auto-reply/dispatch.ts\ndispatchInboundMessage"]
        D2["src/auto-reply/reply/get-reply.ts\ncontext finalize + directive resolution"]
        D3["src/media-understanding/*\nmedia understanding"]
        D4["src/link-understanding/*\nlink understanding"]
        D5["src/config/sessions/*\nsession init / lookup / update"]
        D6["src/routing/*\nagent + session route resolve"]
    end

    subgraph AgentExec["Agent Execution Core"]
        A0["src/commands/agent.ts\nagentCommand"]
        A1["runWithModelFallback\nprovider/model fallback loop"]
        A2["src/agents/pi-embedded*.ts\nembedded runtime"]
        A3["src/agents/cli-runner.ts\nCLI backend runtime"]
        A4["src/memory/*\nembedding / retrieval"]
        A5["src/process/*\nexternal process supervision"]
    end

    subgraph StreamAndState["Streaming + State"]
        S1["src/infra/agent-events.ts\nrun context + stream events"]
        S2["src/commands/agent/session-store.ts\npersist session state"]
        S3["src/sessions/*\ntranscript / send policy / overrides"]
        S4["Gateway WS / TUI / Control UI\nstream consumers"]
    end

    subgraph Delivery["Delivery"]
        O1["src/commands/agent/delivery.ts\ndeliverAgentCommandResult"]
        O2["src/infra/outbound/*\nnormalize payload + resolve target"]
        O3["src/channels/plugins/outbound/*\noutbound adapter loading"]
        O4["Channel adapter / plugin\nsend text / media / reply"]
    end

    IN --> D1 --> D2
    D2 --> D3
    D2 --> D4
    D2 --> D5
    D2 --> D6
    D5 --> A0
    D6 --> A0
    D2 --> A0

    A0 --> A1
    A1 -->|embedded provider| A2
    A1 -->|CLI provider| A3
    A2 --> A4
    A3 --> A5

    A2 --> S1
    A3 --> S1
    S1 --> S4
    A0 --> S2
    S2 --> S3

    A2 --> O1
    A3 --> O1
    O1 --> O2 --> O3 --> O4
```

## 6. Gateway 控制平面细化

```mermaid
flowchart TB
    CLI["openclaw gateway run"]

    subgraph Bootstrap["Bootstrap"]
        G0["src/cli/gateway-cli/run.ts\nresolve options + start loop"]
        G1["src/gateway/server.impl.ts\nstartGatewayServer"]
        G2["Config snapshot\nvalidate + legacy migration"]
        G3["Secrets runtime\npreflight / activate snapshot"]
        G4["Plugin auto-enable + discovery"]
    end

    subgraph CorePlane["Gateway Control Plane"]
        C1["Gateway request context\nshared runtime registry"]
        C2["WS handlers + HTTP methods"]
        C3["Channel manager\nstart/stop channels"]
        C4["Node registry / mobile nodes"]
        C5["Plugin services + sidecars"]
        C6["Browser control sidecar"]
    end

    subgraph TimersAndWatchers["Timers / Watchers"]
        T1["Cron runtime"]
        T2["Heartbeat runner"]
        T3["Maintenance timers\nhealth / dedupe / media cleanup"]
        T4["Channel health monitor"]
        T5["Config reloader\nhot reload or restart"]
        T6["Gateway discovery + Tailscale exposure"]
    end

    subgraph Consumers["Connected Consumers"]
        U1["Control UI / TUI / operators"]
        U2["Channels / channel plugins"]
        U3["Mobile nodes"]
        U4["Hooks / plugin event handlers"]
    end

    subgraph Workloads["Dispatched Workloads"]
        W1["Inbound message handling"]
        W2["agentCommand / agent runtime"]
        W3["Outbound delivery"]
    end

    CLI --> G0 --> G1 --> G2 --> G3 --> G4
    G4 --> C1
    C1 --> C2
    C1 --> C3
    C1 --> C4
    C1 --> C5
    C1 --> C6

    G1 --> T1
    G1 --> T2
    G1 --> T3
    G1 --> T4
    G1 --> T5
    G1 --> T6

    C2 --> U1
    C3 --> U2
    C4 --> U3
    C5 --> U4

    U2 --> W1 --> W2 --> W3 --> U2
    T1 --> W2
    T2 --> W2
    T5 -->|hot reload| C3
    T5 -->|hot reload| T2
    T5 -->|hot reload| T4
    T5 -->|restart| G0
```

## 7. 插件系统 / 渠道插件装配时序

```mermaid
sequenceDiagram
    participant CLI as Gateway bootstrap
    participant Loader as src/plugins/loader.ts
    participant Discovery as src/plugins/discovery.ts
    participant Registry as src/plugins/registry.ts
    participant Runtime as src/plugins/runtime.ts
    participant Gateway as src/gateway/server.impl.ts
    participant Sidecars as src/gateway/server-startup.ts
    participant Services as src/plugins/services.ts
    participant ChLookup as src/channels/plugins/index.ts
    participant Outbound as src/channels/plugins/outbound/load.ts
    participant HTTP as plugin HTTP registry

    CLI->>Loader: loadOpenClawPlugins(config, workspaceDir)
    Loader->>Discovery: discoverOpenClawPlugins(...)
    Discovery-->>Loader: plugin candidates + diagnostics
    Loader->>Registry: createPluginRegistry(runtime, core handlers)
    Loader->>Loader: import plugin modules + validate config
    Loader->>Registry: register tools / hooks / channels / providers / services / commands / http routes
    Loader->>Runtime: setActivePluginRegistry(registry)
    Runtime-->>Loader: global registry version updated
    Loader-->>Gateway: pluginRegistry

    Gateway->>Sidecars: startGatewaySidecars(pluginRegistry, config)
    Sidecars->>Services: startPluginServices(registry.services)
    Services-->>Sidecars: running service handles
    Sidecars-->>Gateway: pluginServices + started channels/sidecars

    Note over Runtime,ChLookup: Runtime phase: registry becomes the shared source of truth

    Gateway->>HTTP: attach plugin http routes / gateway handlers
    Gateway->>ChLookup: getChannelPlugin(channelId)
    ChLookup->>Runtime: requireActivePluginRegistry()
    Runtime-->>ChLookup: channels[] from active registry
    ChLookup-->>Gateway: resolved channel plugin

    Gateway->>Outbound: loadChannelOutboundAdapter(channelId)
    Outbound->>Runtime: read active registry via registry loader
    Runtime-->>Outbound: outbound adapter from channel plugin
    Outbound-->>Gateway: sendText / sendMedia / chunker adapter

    alt inbound or lifecycle integration
        Gateway->>ChLookup: resolve channel plugin for startup/status/routing
    else outbound delivery integration
        Gateway->>Outbound: resolve outbound adapter for delivery
    else webhook integration
        Gateway->>HTTP: dispatch request to registered plugin route
    end
```

## 8. 渠道入站后的 Session 路由与 Agent 绑定时序

```mermaid
sequenceDiagram
    participant Channel as Channel adapter
    participant Inbound as Inbound handler
    participant Route as src/routing/resolve-route.ts
    participant Bindings as bindings matcher
    participant SessKey as src/routing/session-key.ts
    participant Sessions as src/config/sessions/*
    participant Reply as auto-reply/get-reply
    participant Agent as commands/agent.ts

    Channel->>Inbound: inbound message event
    Inbound->>Inbound: extract channel / accountId / peer / parentPeer / guild/team context
    Inbound->>Route: resolveAgentRoute(cfg, inbound context)
    Route->>Bindings: evaluate bindings by channel/account/peer/guild/team/roles

    alt explicit binding matched
        Bindings-->>Route: matched binding + target agentId
    else no binding matched
        Route->>Route: resolve default agent id
    end

    Route->>SessKey: buildAgentSessionKey(...)
    SessKey-->>Route: sessionKey
    Route->>SessKey: buildAgentMainSessionKey(...)
    SessKey-->>Route: mainSessionKey
    Route-->>Inbound: {agentId, sessionKey, mainSessionKey, matchedBy, lastRoutePolicy}

    Inbound->>Sessions: load/init session entry by sessionKey
    Sessions-->>Inbound: session state + transcript context
    Inbound->>Reply: getReplyFromConfig(ctx with SessionKey / CommandTargetSessionKey)
    Reply->>Agent: agentCommand(sessionKey, agentId, message)
    Agent-->>Channel: outbound reply path continues

    Note over Route,SessKey: DM scope may collapse to main session or expand to per-peer / per-channel-peer / per-account-channel-peer
    Note over Route,Bindings: Matching precedence observed in code: peer > parent peer > guild+roles > guild > team > account > channel > default
```

## 9. Config / Secrets 热重载与重启判定时序

```mermaid
sequenceDiagram
    participant Watcher as config-reloader chokidar watcher
    participant Snapshot as readConfigFileSnapshot()
    participant Diff as diffConfigPaths()
    participant Plan as buildGatewayReloadPlan()
    participant Secrets as secrets runtime snapshot
    participant Handlers as server-reload-handlers.ts
    participant Channels as channel manager
    participant Sidecars as heartbeat / cron / browser / gmail / health monitor
    participant Restart as restart deferral / SIGUSR1 restart

    Watcher->>Snapshot: file add/change/unlink
    Snapshot-->>Watcher: config snapshot

    alt config missing or invalid
        Watcher-->>Watcher: skip reload / retry / warn
    else valid snapshot
        Watcher->>Diff: compare currentConfig vs nextConfig
        Diff-->>Watcher: changedPaths
        Watcher->>Plan: buildGatewayReloadPlan(changedPaths)
        Plan-->>Watcher: restartGateway? hot actions? noop paths?

        alt mode=off
            Watcher-->>Watcher: ignore change
        else mode=restart
            Watcher->>Restart: requestGatewayRestart(plan, nextConfig)
        else hybrid/hot and plan.restartGateway=true
            alt mode=hot
                Watcher-->>Watcher: warn restart required but ignored
            else hybrid
                Watcher->>Secrets: prepare/validate next secret snapshot only
                alt secrets preflight failed
                    Secrets-->>Watcher: restart not scheduled
                else preflight ok
                    Watcher->>Restart: requestGatewayRestart(plan, nextConfig)
                end
            end
        else hot-reloadable
            Watcher->>Secrets: prepare + activate runtime secret snapshot
            alt secrets activation failed
                Secrets-->>Watcher: keep last-known-good snapshot
            else activation ok
                Watcher->>Handlers: applyHotReload(plan, nextConfig)
                Handlers->>Sidecars: reload hooks / restart heartbeat / cron / gmail / browser / health monitor
                Handlers->>Channels: restart channels listed by plan.restartChannels
                Handlers-->>Watcher: hot reload applied
            end
        end
    end

    alt restart requested while work is active
        Restart->>Restart: deferGatewayRestartUntilIdle(queue + replies + embedded runs)
        Restart-->>Restart: emit restart when idle or timeout
    else no active work
        Restart->>Restart: emitGatewayRestart()
    end

    Note over Plan,Handlers: Plugin channel reload rules contribute hot/noop prefixes dynamically through listChannelPlugins()
    Note over Secrets,Handlers: On hot reload, secret activation happens before applying runtime changes; on failure, runtime stays on last-known-good snapshot
```

## 10. 节点系统（macOS / iOS / Android node）与 Gateway 交互时序

```mermaid
sequenceDiagram
    participant Node as Mobile / desktop node
    participant WS as Gateway WS handshake
    participant Pair as infra/device-pairing.ts
    participant Operator as Control UI / operator client
    participant Reg as NodeRegistry
    participant Methods as gateway server methods
    participant SessionBus as node subscriptions / session events
    participant Agent as agent runtime / chat pipeline

    Node->>WS: hello / connect(role=node, device identity, caps, commands)
    WS->>Pair: getPairedDevice(deviceId)

    alt not paired or permission upgrade required
        WS->>Pair: requestDevicePairing(device metadata)
        alt silent local pairing allowed
            WS->>Pair: approveDevicePairing(requestId)
            Pair-->>WS: approved
            WS-->>Node: hello-ok
        else manual pairing required
            WS-->>Operator: broadcast device.pair.requested
            WS-->>Node: NOT_PAIRED / close("pairing required")
            Operator->>Methods: device.pair.approve(requestId)
            Methods->>Pair: approveDevicePairing(requestId)
            Pair-->>Methods: paired device record
            Methods-->>Operator: device.pair.resolved
            Node->>WS: reconnect after approval
            WS->>Pair: getPairedDevice(deviceId)
            Pair-->>WS: paired device found
            WS-->>Node: hello-ok
        end
    else already paired
        Pair-->>WS: paired device found
        WS-->>Node: hello-ok
    end

    WS->>Reg: register(node connection, caps, commands, metadata)
    Reg-->>WS: nodeSession(nodeId)
    WS-->>Node: initial server snapshot + optional voicewake.changed

    Note over Reg,SessionBus: Runtime phase: node becomes addressable by nodeId and can subscribe to session streams

    Node->>Methods: node.event(chat.subscribe, sessionKey)
    Methods->>SessionBus: nodeSubscribe(nodeId, sessionKey)

    Agent-->>SessionBus: chat / agent stream events for sessionKey
    SessionBus-->>Node: event(chat | agent, payload)

    Operator->>Methods: node.invoke(nodeId, command, params)
    Methods->>Methods: validate allowlist + sanitize forwarded params
    Methods->>Reg: invoke(nodeId, command, params)
    Reg-->>Node: event(node.invoke.request, request payload)
    Node-->>Methods: node.invoke.result(id, ok, payload/error)
    Methods->>Reg: handleInvokeResult(...)
    Reg-->>Methods: pending invoke resolved
    Methods-->>Operator: node.invoke response

    alt node emits lifecycle / notification / exec events
        Node->>Methods: node.event(...)
        Methods->>SessionBus: map to session events / system events / heartbeat wake / chat subscription changes
        SessionBus-->>Agent: optional heartbeat wake or follow-up processing
    end
```
