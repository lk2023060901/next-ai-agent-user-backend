package workflow

// --- LLM Call Node ---
// Calls a language model with a prompt and returns the response.
func llmCallNode() NodeType {
	return NodeType{
		TypeID:      "llm-call",
		Version:     1,
		DisplayName: "LLM 调用",
		Category:    CategoryAI,
		Description: "调用大语言模型，输入 Prompt 获得回复",
		Icon:        "brain",
		Inputs: []Pin{
			{PinID: "exec_in", Label: "执行", Direction: DirInput, Kind: KindExec},
			{PinID: "prompt", Label: "Prompt", Direction: DirInput, Kind: KindData, ValueType: TypeString, Required: true},
			{PinID: "context", Label: "上下文", Direction: DirInput, Kind: KindData, ValueType: TypeString},
		},
		Outputs: []Pin{
			{PinID: "exec_out", Label: "完成", Direction: DirOutput, Kind: KindExec},
			{PinID: "exec_error", Label: "失败", Direction: DirOutput, Kind: KindExec},
			{PinID: "result", Label: "结果", Direction: DirOutput, Kind: KindData, ValueType: TypeString},
			{PinID: "usage", Label: "Token 用量", Direction: DirOutput, Kind: KindData, ValueType: TypeNumber},
		},
		Properties: []Property{
			{Key: "modelId", Label: "模型", Kind: "select", Required: true, Options: []Option{}},
			{Key: "temperature", Label: "温度", Kind: "number", Default: 0.7, Min: pf(0), Max: pf(2), Step: pf(0.1)},
			{Key: "maxTokens", Label: "最大 Token", Kind: "number", Default: 4096},
			{Key: "systemPrompt", Label: "系统提示词", Kind: "code"},
		},
	}
}
