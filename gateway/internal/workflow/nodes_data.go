package workflow

// --- Variable Set ---
// Stores a value into a named variable for later retrieval.
func variableSetNode() NodeType {
	return NodeType{
		TypeID:      "variable-set",
		Version:     1,
		DisplayName: "设置变量",
		Category:    CategoryData,
		Description: "将值存入命名变量",
		Icon:        "box",
		Inputs: []Pin{
			{PinID: "exec_in", Label: "执行", Direction: DirInput, Kind: KindExec},
			{PinID: "value", Label: "值", Direction: DirInput, Kind: KindData, ValueType: TypeJSON, Required: true},
		},
		Outputs: []Pin{
			{PinID: "exec_out", Label: "执行", Direction: DirOutput, Kind: KindExec},
		},
		Properties: []Property{
			{Key: "variableName", Label: "变量名", Kind: "string", Required: true},
		},
	}
}

// --- Variable Get ---
// Retrieves a previously stored named variable. No exec pins — pure data node.
func variableGetNode() NodeType {
	return NodeType{
		TypeID:      "variable-get",
		Version:     1,
		DisplayName: "获取变量",
		Category:    CategoryData,
		Description: "读取已存储的命名变量",
		Icon:        "box",
		Inputs:      []Pin{},
		Outputs: []Pin{
			{PinID: "value", Label: "值", Direction: DirOutput, Kind: KindData, ValueType: TypeJSON},
		},
		Properties: []Property{
			{Key: "variableName", Label: "变量名", Kind: "string", Required: true},
		},
	}
}

// --- JSON Transform ---
// Applies a JSONPath or template expression to transform input JSON.
func jsonTransformNode() NodeType {
	return NodeType{
		TypeID:      "json-transform",
		Version:     1,
		DisplayName: "JSON 转换",
		Category:    CategoryData,
		Description: "对 JSON 数据进行提取或转换",
		Icon:        "braces",
		Inputs: []Pin{
			{PinID: "exec_in", Label: "执行", Direction: DirInput, Kind: KindExec},
			{PinID: "input", Label: "输入", Direction: DirInput, Kind: KindData, ValueType: TypeJSON, Required: true},
		},
		Outputs: []Pin{
			{PinID: "exec_out", Label: "执行", Direction: DirOutput, Kind: KindExec},
			{PinID: "output", Label: "输出", Direction: DirOutput, Kind: KindData, ValueType: TypeJSON},
		},
		Properties: []Property{
			{Key: "expression", Label: "表达式", Kind: "code", Required: true},
		},
	}
}
