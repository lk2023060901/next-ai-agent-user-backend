package workflow

// Each function below is analogous to a UEdGraphNode subclass's AllocateDefaultPins().

// --- Text Node ---
// No input pins. Serves as a start node that outputs a static text value.
func textNode() NodeType {
	return NodeType{
		TypeID:      "text",
		Version:     1,
		DisplayName: "文本",
		Category:    CategoryData,
		Description: "输出一段静态文本，可作为工作流的起始节点",
		Icon:        "type",
		Inputs:      []Pin{}, // no inputs — this is a source node
		Outputs: []Pin{
			{
				PinID:     "exec_out",
				Label:     "执行",
				Direction: DirOutput,
				Kind:      KindExec,
			},
			{
				PinID:     "text",
				Label:     "文本",
				Direction: DirOutput,
				Kind:      KindData,
				ValueType: TypeString,
			},
		},
		Properties: []Property{
			{
				Key:     "content",
				Label:   "文本内容",
				Kind:    "code",
				Default: "",
			},
		},
	}
}

// --- Comment Node ---
// Analogous to UE's UEdGraphNode_Comment.
// Independent node type: no pins, no execution, own properties.
func commentNode() NodeType {
	return NodeType{
		TypeID:      "comment",
		Version:     1,
		DisplayName: "注释",
		Category:    CategoryComment,
		Description: "注释框，用于标注和分组节点，不参与执行",
		Icon:        "message-square",
		Inputs:      []Pin{},
		Outputs:     []Pin{},
		Properties: []Property{
			{
				Key:     "text",
				Label:   "注释内容",
				Kind:    "string",
				Default: "",
			},
			{
				Key:     "color",
				Label:   "颜色",
				Kind:    "string",
				Default: "#3b82f6",
			},
			{
				Key:     "fontSize",
				Label:   "字号",
				Kind:    "number",
				Default: 14,
				Min:     pf(8),
				Max:     pf(48),
				Step:    pf(1),
			},
			{
				Key:     "moveMode",
				Label:   "移动模式",
				Kind:    "select",
				Default: "group",
				Options: []Option{
					{Label: "带动包含的节点", Value: "group"},
					{Label: "仅移动注释框", Value: "independent"},
				},
			},
		},
	}
}

func pf(v float64) *float64 { return &v }
