package workflow

// --- KB Search ---
func kbSearchNode() NodeType {
	return NodeType{
		TypeID:      "kb-search",
		Version:     1,
		DisplayName: "知识库检索",
		Category:    CategoryKnowledge,
		Description: "在知识库中进行语义检索",
		Icon:        "search",
		Inputs: []Pin{
			{PinID: "exec_in", Label: "执行", Direction: DirInput, Kind: KindExec},
			{PinID: "query", Label: "查询", Direction: DirInput, Kind: KindData, ValueType: TypeString, Required: true},
		},
		Outputs: []Pin{
			{PinID: "exec_out", Label: "完成", Direction: DirOutput, Kind: KindExec},
			{PinID: "results", Label: "结果", Direction: DirOutput, Kind: KindData, ValueType: TypeJSON, ContainerType: ContainerArray},
			{PinID: "topResult", Label: "最佳结果", Direction: DirOutput, Kind: KindData, ValueType: TypeString},
		},
		Properties: []Property{
			{Key: "knowledgeBaseId", Label: "知识库", Kind: "select", Required: true, Options: []Option{}},
			{Key: "topK", Label: "返回数量", Kind: "number", Default: 5, Min: pf(1), Max: pf(20)},
			{Key: "threshold", Label: "匹配阈值", Kind: "number", Default: 0.7, Min: pf(0), Max: pf(1), Step: pf(0.05)},
		},
	}
}

// --- Send Message ---
func sendMessageNode() NodeType {
	return NodeType{
		TypeID:      "send-message",
		Version:     1,
		DisplayName: "发送消息",
		Category:    CategoryChannel,
		Description: "通过渠道发送消息",
		Icon:        "send",
		Inputs: []Pin{
			{PinID: "exec_in", Label: "执行", Direction: DirInput, Kind: KindExec},
			{PinID: "content", Label: "内容", Direction: DirInput, Kind: KindData, ValueType: TypeString, Required: true},
		},
		Outputs: []Pin{
			{PinID: "exec_out", Label: "完成", Direction: DirOutput, Kind: KindExec},
			{PinID: "exec_error", Label: "失败", Direction: DirOutput, Kind: KindExec},
			{PinID: "messageId", Label: "消息 ID", Direction: DirOutput, Kind: KindData, ValueType: TypeString},
		},
		Properties: []Property{
			{Key: "channelId", Label: "渠道", Kind: "select", Required: true, Options: []Option{}},
			{Key: "recipient", Label: "接收者", Kind: "string"},
		},
	}
}
