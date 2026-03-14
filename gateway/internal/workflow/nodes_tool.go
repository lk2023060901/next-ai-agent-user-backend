package workflow

// --- HTTP Request ---
func httpRequestNode() NodeType {
	return NodeType{
		TypeID:      "http-request",
		Version:     1,
		DisplayName: "HTTP 请求",
		Category:    CategoryTool,
		Description: "发送 HTTP 请求并获取响应",
		Icon:        "globe",
		Inputs: []Pin{
			{PinID: "exec_in", Label: "执行", Direction: DirInput, Kind: KindExec},
			{PinID: "url", Label: "URL", Direction: DirInput, Kind: KindData, ValueType: TypeString, Required: true},
			{PinID: "body", Label: "请求体", Direction: DirInput, Kind: KindData, ValueType: TypeJSON},
		},
		Outputs: []Pin{
			{PinID: "exec_out", Label: "完成", Direction: DirOutput, Kind: KindExec},
			{PinID: "exec_error", Label: "失败", Direction: DirOutput, Kind: KindExec},
			{PinID: "response", Label: "响应体", Direction: DirOutput, Kind: KindData, ValueType: TypeJSON},
			{PinID: "statusCode", Label: "状态码", Direction: DirOutput, Kind: KindData, ValueType: TypeNumber},
		},
		Properties: []Property{
			{Key: "method", Label: "方法", Kind: "select", Default: "GET", Options: []Option{
				{Label: "GET", Value: "GET"}, {Label: "POST", Value: "POST"},
				{Label: "PUT", Value: "PUT"}, {Label: "PATCH", Value: "PATCH"},
				{Label: "DELETE", Value: "DELETE"},
			}},
			{Key: "headers", Label: "请求头", Kind: "json", Default: map[string]interface{}{}},
			{Key: "timeoutMs", Label: "超时(ms)", Kind: "number", Default: 30000},
		},
	}
}

// --- Code Execute ---
func codeExecuteNode() NodeType {
	return NodeType{
		TypeID:      "code-execute",
		Version:     1,
		DisplayName: "代码执行",
		Category:    CategoryTool,
		Description: "执行一段自定义代码（JavaScript）",
		Icon:        "code",
		Inputs: []Pin{
			{PinID: "exec_in", Label: "执行", Direction: DirInput, Kind: KindExec},
			{PinID: "input", Label: "输入", Direction: DirInput, Kind: KindData, ValueType: TypeJSON},
		},
		Outputs: []Pin{
			{PinID: "exec_out", Label: "完成", Direction: DirOutput, Kind: KindExec},
			{PinID: "exec_error", Label: "失败", Direction: DirOutput, Kind: KindExec},
			{PinID: "output", Label: "输出", Direction: DirOutput, Kind: KindData, ValueType: TypeJSON},
		},
		Properties: []Property{
			{Key: "code", Label: "代码", Kind: "code", Required: true},
			{Key: "language", Label: "语言", Kind: "select", Default: "javascript", Options: []Option{
				{Label: "JavaScript", Value: "javascript"},
			}},
		},
	}
}
