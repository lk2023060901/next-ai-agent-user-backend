package workflow

// --- Condition Node (Branch) ---
// Analogous to UE's Branch node: one exec in, bool condition in, two exec outs (true/false).
func conditionNode() NodeType {
	return NodeType{
		TypeID:      "condition",
		Version:     1,
		DisplayName: "条件分支",
		Category:    CategoryLogic,
		Description: "根据布尔条件选择执行路径",
		Icon:        "git-branch",
		Inputs: []Pin{
			{PinID: "exec_in", Label: "执行", Direction: DirInput, Kind: KindExec},
			{PinID: "condition", Label: "条件", Direction: DirInput, Kind: KindData, ValueType: TypeBoolean, Required: true},
		},
		Outputs: []Pin{
			{PinID: "exec_true", Label: "True", Direction: DirOutput, Kind: KindExec},
			{PinID: "exec_false", Label: "False", Direction: DirOutput, Kind: KindExec},
		},
		Properties: []Property{},
	}
}

// --- Loop Node ---
// Iterates over an array, executing the body for each element.
func loopNode() NodeType {
	return NodeType{
		TypeID:      "loop",
		Version:     1,
		DisplayName: "循环",
		Category:    CategoryFlow,
		Description: "遍历数组，对每个元素执行循环体",
		Icon:        "repeat",
		Inputs: []Pin{
			{PinID: "exec_in", Label: "执行", Direction: DirInput, Kind: KindExec},
			{PinID: "items", Label: "数组", Direction: DirInput, Kind: KindData, ValueType: TypeJSON, ContainerType: ContainerArray, Required: true},
		},
		Outputs: []Pin{
			{PinID: "exec_body", Label: "循环体", Direction: DirOutput, Kind: KindExec},
			{PinID: "exec_done", Label: "完成", Direction: DirOutput, Kind: KindExec},
			{PinID: "item", Label: "当前元素", Direction: DirOutput, Kind: KindData, ValueType: TypeJSON},
			{PinID: "index", Label: "索引", Direction: DirOutput, Kind: KindData, ValueType: TypeNumber},
		},
		Properties: []Property{},
	}
}
