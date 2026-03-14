package workflow

import "time"

const (
	DocumentSpecVersion   = "workflow.v1"
	DefinitionSpecVersion = "workflow.definition.v1"
	LayoutSpecVersion     = "workflow.layout.v1"
)

type Definition struct {
	SpecVersion string                 `json:"specVersion"`
	Nodes       []DefinitionNode       `json:"nodes"`
	Connections []DefinitionConnection `json:"connections"`
}

type DefinitionNode struct {
	ID         string                 `json:"id"`
	TypeID     string                 `json:"typeId"`
	Version    int                    `json:"version,omitempty"`
	Properties map[string]interface{} `json:"properties,omitempty"`
}

type DefinitionConnection struct {
	ID           string `json:"id,omitempty"`
	SourceNodeID string `json:"sourceNodeId"`
	SourcePinID  string `json:"sourcePinId"`
	TargetNodeID string `json:"targetNodeId"`
	TargetPinID  string `json:"targetPinId"`
}

type Layout struct {
	SpecVersion string       `json:"specVersion"`
	Viewport    Viewport     `json:"viewport"`
	Nodes       []LayoutNode `json:"nodes"`
}

type Viewport struct {
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	Zoom float64 `json:"zoom"`
}

type LayoutNode struct {
	NodeID   string   `json:"nodeId"`
	Position Position `json:"position"`
	Width    *float64 `json:"width,omitempty"`
	Height   *float64 `json:"height,omitempty"`
	ZIndex   *int     `json:"zIndex,omitempty"`
}

type Position struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type Document struct {
	WorkflowID  string     `json:"workflowId"`
	Revision    int        `json:"revision"`
	SpecVersion string     `json:"specVersion"`
	Definition  Definition `json:"definition"`
	Layout      Layout     `json:"layout"`
	UpdatedAt   time.Time  `json:"updatedAt"`
}

func DefaultDefinition() Definition {
	return Definition{
		SpecVersion: DefinitionSpecVersion,
		Nodes:       []DefinitionNode{},
		Connections: []DefinitionConnection{},
	}
}

func DefaultLayout() Layout {
	return Layout{
		SpecVersion: LayoutSpecVersion,
		Viewport: Viewport{
			X:    0,
			Y:    0,
			Zoom: 1,
		},
		Nodes: []LayoutNode{},
	}
}

func NormalizeDefinition(def Definition) Definition {
	if def.SpecVersion == "" {
		def.SpecVersion = DefinitionSpecVersion
	}
	if def.Nodes == nil {
		def.Nodes = []DefinitionNode{}
	}
	if def.Connections == nil {
		def.Connections = []DefinitionConnection{}
	}
	for i := range def.Nodes {
		if def.Nodes[i].Properties == nil {
			def.Nodes[i].Properties = map[string]interface{}{}
		}
	}
	return def
}

func NormalizeLayout(layout Layout) Layout {
	if layout.SpecVersion == "" {
		layout.SpecVersion = LayoutSpecVersion
	}
	if layout.Viewport.Zoom == 0 {
		layout.Viewport.Zoom = 1
	}
	if layout.Nodes == nil {
		layout.Nodes = []LayoutNode{}
	}
	return layout
}
