package workflow

import "fmt"

// --- Connection Response (analogous to UE's FPinConnectionResponse) ---

type ResponseCode string

const (
	ResponseAllow        ResponseCode = "ALLOW"          // connection permitted
	ResponseDisallow     ResponseCode = "DISALLOW"       // connection forbidden
	ResponseBreakOthersA ResponseCode = "BREAK_OTHERS_A" // allowed, but break existing links on pin A first
	ResponseBreakOthersB ResponseCode = "BREAK_OTHERS_B" // allowed, but break existing links on pin B first
)

type ConnectionResponse struct {
	Code    ResponseCode `json:"code"`
	Message string       `json:"message"`
}

func allow() ConnectionResponse {
	return ConnectionResponse{Code: ResponseAllow}
}

func disallow(msg string) ConnectionResponse {
	return ConnectionResponse{Code: ResponseDisallow, Message: msg}
}

func breakOthersA(msg string) ConnectionResponse {
	return ConnectionResponse{Code: ResponseBreakOthersA, Message: msg}
}

func breakOthersB(msg string) ConnectionResponse {
	return ConnectionResponse{Code: ResponseBreakOthersB, Message: msg}
}

// --- Connection request (what the frontend sends when saving) ---

type Connection struct {
	SourceNodeID string `json:"sourceNodeId"`
	SourcePinID  string `json:"sourcePinId"`
	TargetNodeID string `json:"targetNodeId"`
	TargetPinID  string `json:"targetPinId"`
}

type GraphNode struct {
	NodeID string `json:"nodeId"`
	TypeID string `json:"typeId"`
}

// --- Schema (analogous to UE's UEdGraphSchema / UEdGraphSchema_K2) ---

// CanConnect validates whether two pins can be connected.
// pinA is always the source (output), pinB is always the target (input).
func CanConnect(pinA, pinB *Pin) ConnectionResponse {
	// 1. Direction check: must be output -> input
	if pinA.Direction != DirOutput || pinB.Direction != DirInput {
		return disallow("连线方向错误：必须从输出连到输入")
	}

	// 2. Kind check: exec <-> exec, data <-> data
	if pinA.Kind != pinB.Kind {
		return disallow(fmt.Sprintf("类型不匹配：不能将 %s 连接到 %s", pinA.Kind, pinB.Kind))
	}

	// 3. Exec pins: single-link on output side (analogous to UE exec pin exclusivity)
	if pinA.IsExec() {
		if !pinA.MultiLinks {
			return breakOthersA("执行 pin 只能有一条输出连线，将替换已有连线")
		}
		return allow()
	}

	// 4. Data pins: type compatibility check
	return checkDataCompatibility(pinA, pinB)
}

func checkDataCompatibility(output, input *Pin) ConnectionResponse {
	// Container must match
	if output.EffectiveContainer() != input.EffectiveContainer() {
		return disallow(fmt.Sprintf("容器类型不匹配：%s 无法连接到 %s",
			output.EffectiveContainer(), input.EffectiveContainer()))
	}

	// Value type compatibility
	if !isTypeCompatible(output.ValueType, input.ValueType) {
		return disallow(fmt.Sprintf("数据类型不匹配：%s 无法连接到 %s",
			output.ValueType, input.ValueType))
	}

	// Input pin single-link by default (unless multiLinks)
	if !input.MultiLinks {
		return breakOthersB("输入 pin 只能有一条连线，将替换已有连线")
	}

	return allow()
}

// isTypeCompatible checks if output type can flow into input type.
func isTypeCompatible(output, input DataType) bool {
	if output == input {
		return true
	}
	// json accepts string/number/boolean (implicit conversion)
	if input == TypeJSON {
		return true
	}
	return false
}

// --- Graph-level validation (called on save) ---

type ValidationError struct {
	NodeID  string `json:"nodeId,omitempty"`
	PinID   string `json:"pinId,omitempty"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ValidateGraph validates an entire workflow graph.
func ValidateGraph(nodes []GraphNode, connections []Connection) []ValidationError {
	var errs []ValidationError

	// Build node type lookup
	nodeTypes := make(map[string]*NodeType)
	for _, n := range nodes {
		nt := Get(n.TypeID)
		if nt == nil {
			errs = append(errs, ValidationError{
				NodeID:  n.NodeID,
				Code:    "UNKNOWN_NODE_TYPE",
				Message: fmt.Sprintf("未知的节点类型: %s", n.TypeID),
			})
			continue
		}
		nodeTypes[n.NodeID] = nt
	}

	// Validate each connection
	for _, conn := range connections {
		// Self-connection check
		if conn.SourceNodeID == conn.TargetNodeID {
			errs = append(errs, ValidationError{
				NodeID:  conn.SourceNodeID,
				Code:    "SELF_CONNECTION",
				Message: "节点不能连接自己",
			})
			continue
		}

		sourceNT := nodeTypes[conn.SourceNodeID]
		targetNT := nodeTypes[conn.TargetNodeID]
		if sourceNT == nil || targetNT == nil {
			continue // already reported as UNKNOWN_NODE_TYPE
		}

		// Comment nodes cannot have connections
		if sourceNT.IsComment() || targetNT.IsComment() {
			errs = append(errs, ValidationError{
				NodeID:  conn.SourceNodeID,
				Code:    "COMMENT_CONNECTION",
				Message: "注释节点不能参与连线",
			})
			continue
		}

		sourcePin := sourceNT.FindPin(conn.SourcePinID)
		targetPin := targetNT.FindPin(conn.TargetPinID)

		if sourcePin == nil {
			errs = append(errs, ValidationError{
				NodeID: conn.SourceNodeID, PinID: conn.SourcePinID,
				Code: "UNKNOWN_PIN", Message: fmt.Sprintf("未知的 pin: %s", conn.SourcePinID),
			})
			continue
		}
		if targetPin == nil {
			errs = append(errs, ValidationError{
				NodeID: conn.TargetNodeID, PinID: conn.TargetPinID,
				Code: "UNKNOWN_PIN", Message: fmt.Sprintf("未知的 pin: %s", conn.TargetPinID),
			})
			continue
		}

		resp := CanConnect(sourcePin, targetPin)
		if resp.Code == ResponseDisallow {
			errs = append(errs, ValidationError{
				NodeID:  conn.SourceNodeID,
				PinID:   conn.SourcePinID,
				Code:    "INVALID_CONNECTION",
				Message: resp.Message,
			})
		}
	}

	// Detect cycles in exec flow
	cycleErrs := detectExecCycles(nodes, connections, nodeTypes)
	errs = append(errs, cycleErrs...)

	return errs
}

// detectExecCycles checks for cycles in exec pin connections using DFS.
func detectExecCycles(nodes []GraphNode, connections []Connection, nodeTypes map[string]*NodeType) []ValidationError {
	// Build adjacency list for exec connections only
	adj := make(map[string][]string)
	for _, conn := range connections {
		sourceNT := nodeTypes[conn.SourceNodeID]
		if sourceNT == nil {
			continue
		}
		sourcePin := sourceNT.FindPin(conn.SourcePinID)
		if sourcePin == nil || !sourcePin.IsExec() {
			continue
		}
		adj[conn.SourceNodeID] = append(adj[conn.SourceNodeID], conn.TargetNodeID)
	}

	// DFS cycle detection
	const (
		white = 0 // unvisited
		gray  = 1 // in current path
		black = 2 // fully processed
	)
	color := make(map[string]int)

	var errs []ValidationError
	var dfs func(nodeID string) bool
	dfs = func(nodeID string) bool {
		color[nodeID] = gray
		for _, next := range adj[nodeID] {
			if color[next] == gray {
				errs = append(errs, ValidationError{
					NodeID:  next,
					Code:    "EXEC_CYCLE",
					Message: "执行链路中存在循环",
				})
				return true
			}
			if color[next] == white {
				if dfs(next) {
					return true
				}
			}
		}
		color[nodeID] = black
		return false
	}

	for _, n := range nodes {
		if color[n.NodeID] == white {
			dfs(n.NodeID)
		}
	}

	return errs
}
