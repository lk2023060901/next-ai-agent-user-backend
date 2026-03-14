package workflow

import "sync"

var registry struct {
	mu    sync.RWMutex
	types map[string]NodeType
}

func init() {
	registry.types = make(map[string]NodeType)

	// Data
	Register(textNode())
	Register(variableSetNode())
	Register(variableGetNode())
	Register(jsonTransformNode())

	// Flow / Logic
	Register(conditionNode())
	Register(loopNode())

	// AI
	Register(llmCallNode())

	// Tool
	Register(httpRequestNode())
	Register(codeExecuteNode())

	// Knowledge / Channel
	Register(kbSearchNode())
	Register(sendMessageNode())

	// Comment
	Register(commentNode())
}

func Register(nt NodeType) {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	registry.types[nt.TypeID] = nt
}

func Get(typeID string) *NodeType {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	nt, ok := registry.types[typeID]
	if !ok {
		return nil
	}
	return &nt
}

func All() []NodeType {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	types := make([]NodeType, 0, len(registry.types))
	for _, nt := range registry.types {
		types = append(types, nt)
	}
	return types
}
