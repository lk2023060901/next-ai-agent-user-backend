package workflow

// --- Pin Direction ---

type PinDirection string

const (
	DirInput  PinDirection = "input"
	DirOutput PinDirection = "output"
)

func (d PinDirection) Complementary() PinDirection {
	if d == DirInput {
		return DirOutput
	}
	return DirInput
}

// --- Pin Kind ---

type PinKind string

const (
	KindExec PinKind = "exec"
	KindData PinKind = "data"
)

// --- Data Type ---

type DataType string

const (
	TypeString  DataType = "string"
	TypeNumber  DataType = "number"
	TypeBoolean DataType = "boolean"
	TypeJSON    DataType = "json"
)

// --- Container Type ---

type ContainerType string

const (
	ContainerNone  ContainerType = "none"
	ContainerArray ContainerType = "array"
)

// --- Pin (analogous to UE's UEdGraphPin) ---

type Pin struct {
	PinID         string        `json:"pinId"`
	Label         string        `json:"label"`
	Direction     PinDirection  `json:"direction"`
	Kind          PinKind       `json:"kind"`
	ValueType     DataType      `json:"valueType,omitempty"`
	ContainerType ContainerType `json:"containerType,omitempty"`
	Required      bool          `json:"required,omitempty"`
	MultiLinks    bool          `json:"multiLinks,omitempty"`
	DefaultValue  interface{}   `json:"defaultValue,omitempty"`
}

func (p *Pin) IsExec() bool { return p.Kind == KindExec }
func (p *Pin) IsData() bool { return p.Kind == KindData }

func (p *Pin) EffectiveContainer() ContainerType {
	if p.ContainerType == "" {
		return ContainerNone
	}
	return p.ContainerType
}

// --- Property (node configuration, not connected via pins) ---

type Property struct {
	Key      string      `json:"key"`
	Label    string      `json:"label"`
	Kind     string      `json:"kind"` // "string" | "number" | "boolean" | "select" | "json" | "code"
	Required bool        `json:"required,omitempty"`
	Default  interface{} `json:"defaultValue,omitempty"`
	Min      *float64    `json:"min,omitempty"`
	Max      *float64    `json:"max,omitempty"`
	Step     *float64    `json:"step,omitempty"`
	Options  []Option    `json:"options,omitempty"`
}

type Option struct {
	Label string      `json:"label"`
	Value interface{} `json:"value"`
}

// --- Node Type (analogous to UE's UEdGraphNode subclass) ---

// NodeCategory classifies how a node participates in the graph.
type NodeCategory string

const (
	CategoryFlow      NodeCategory = "flow"
	CategoryAI        NodeCategory = "ai"
	CategoryData      NodeCategory = "data"
	CategoryTool      NodeCategory = "tool"
	CategoryKnowledge NodeCategory = "knowledge"
	CategoryChannel   NodeCategory = "channel"
	CategoryLogic     NodeCategory = "logic"
	CategoryComment   NodeCategory = "comment" // no pins, no execution
)

type NodeType struct {
	TypeID      string                 `json:"typeId"`
	Version     int                    `json:"version"`
	DisplayName string                 `json:"displayName"`
	Category    NodeCategory           `json:"category"`
	Description string                 `json:"description,omitempty"`
	Icon        string                 `json:"icon,omitempty"`
	Tags        []string               `json:"tags,omitempty"`
	Inputs      []Pin                  `json:"inputs"`
	Outputs     []Pin                  `json:"outputs"`
	Properties  []Property             `json:"properties"`
	Execution   map[string]interface{} `json:"execution,omitempty"`
	SchemaFlags map[string]interface{} `json:"schemaFlags,omitempty"`
}

// IsComment returns true if this node type is a comment (no pins, no execution).
func (nt *NodeType) IsComment() bool {
	return nt.Category == CategoryComment
}

// FindPin looks up a pin by ID across inputs and outputs.
func (nt *NodeType) FindPin(pinID string) *Pin {
	for i := range nt.Inputs {
		if nt.Inputs[i].PinID == pinID {
			return &nt.Inputs[i]
		}
	}
	for i := range nt.Outputs {
		if nt.Outputs[i].PinID == pinID {
			return &nt.Outputs[i]
		}
	}
	return nil
}
