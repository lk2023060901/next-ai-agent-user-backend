package workflow

import "testing"

// --- Registry completeness ---

func TestAllNodeTypesRegistered(t *testing.T) {
	expected := []string{
		"text", "comment",
		"condition", "loop",
		"llm-call",
		"variable-set", "variable-get", "json-transform",
		"http-request", "code-execute",
		"kb-search", "send-message",
	}
	for _, id := range expected {
		if Get(id) == nil {
			t.Errorf("node type %q not registered", id)
		}
	}
	all := All()
	if len(all) != len(expected) {
		t.Errorf("expected %d node types, got %d", len(expected), len(all))
	}
}

// --- Pin structure validation for each node ---

func TestTextNode_NoPinInputs(t *testing.T) {
	nt := Get("text")
	if len(nt.Inputs) != 0 {
		t.Errorf("text node should have 0 inputs, got %d", len(nt.Inputs))
	}
	if len(nt.Outputs) != 2 {
		t.Errorf("text node should have 2 outputs, got %d", len(nt.Outputs))
	}
	assertPin(t, nt, "exec_out", DirOutput, KindExec, "")
	assertPin(t, nt, "text", DirOutput, KindData, TypeString)
}

func TestCommentNode_NoPins(t *testing.T) {
	nt := Get("comment")
	if len(nt.Inputs) != 0 || len(nt.Outputs) != 0 {
		t.Errorf("comment should have no pins, got %d inputs, %d outputs", len(nt.Inputs), len(nt.Outputs))
	}
	if !nt.IsComment() {
		t.Error("comment node should be identified as comment")
	}
}

func TestConditionNode_Pins(t *testing.T) {
	nt := Get("condition")
	assertPin(t, nt, "exec_in", DirInput, KindExec, "")
	assertPin(t, nt, "condition", DirInput, KindData, TypeBoolean)
	assertPin(t, nt, "exec_true", DirOutput, KindExec, "")
	assertPin(t, nt, "exec_false", DirOutput, KindExec, "")
}

func TestLoopNode_Pins(t *testing.T) {
	nt := Get("loop")
	assertPin(t, nt, "exec_in", DirInput, KindExec, "")
	assertPin(t, nt, "items", DirInput, KindData, TypeJSON)
	assertPin(t, nt, "exec_body", DirOutput, KindExec, "")
	assertPin(t, nt, "exec_done", DirOutput, KindExec, "")
	assertPin(t, nt, "item", DirOutput, KindData, TypeJSON)
	assertPin(t, nt, "index", DirOutput, KindData, TypeNumber)

	// items pin should be array container
	itemsPin := nt.FindPin("items")
	if itemsPin.EffectiveContainer() != ContainerArray {
		t.Errorf("items pin should be array container, got %s", itemsPin.EffectiveContainer())
	}
}

func TestLLMCallNode_Pins(t *testing.T) {
	nt := Get("llm-call")
	assertPin(t, nt, "exec_in", DirInput, KindExec, "")
	assertPin(t, nt, "prompt", DirInput, KindData, TypeString)
	assertPin(t, nt, "context", DirInput, KindData, TypeString)
	assertPin(t, nt, "exec_out", DirOutput, KindExec, "")
	assertPin(t, nt, "exec_error", DirOutput, KindExec, "")
	assertPin(t, nt, "result", DirOutput, KindData, TypeString)
	assertPin(t, nt, "usage", DirOutput, KindData, TypeNumber)

	// prompt should be required
	promptPin := nt.FindPin("prompt")
	if !promptPin.Required {
		t.Error("prompt pin should be required")
	}
}

func TestVariableSetNode_Pins(t *testing.T) {
	nt := Get("variable-set")
	assertPin(t, nt, "exec_in", DirInput, KindExec, "")
	assertPin(t, nt, "value", DirInput, KindData, TypeJSON)
	assertPin(t, nt, "exec_out", DirOutput, KindExec, "")
}

func TestVariableGetNode_NoPinInputs(t *testing.T) {
	nt := Get("variable-get")
	if len(nt.Inputs) != 0 {
		t.Errorf("variable-get should have 0 inputs, got %d", len(nt.Inputs))
	}
	assertPin(t, nt, "value", DirOutput, KindData, TypeJSON)
}

func TestJSONTransformNode_Pins(t *testing.T) {
	nt := Get("json-transform")
	assertPin(t, nt, "exec_in", DirInput, KindExec, "")
	assertPin(t, nt, "input", DirInput, KindData, TypeJSON)
	assertPin(t, nt, "exec_out", DirOutput, KindExec, "")
	assertPin(t, nt, "output", DirOutput, KindData, TypeJSON)
}

func TestHTTPRequestNode_Pins(t *testing.T) {
	nt := Get("http-request")
	assertPin(t, nt, "exec_in", DirInput, KindExec, "")
	assertPin(t, nt, "url", DirInput, KindData, TypeString)
	assertPin(t, nt, "body", DirInput, KindData, TypeJSON)
	assertPin(t, nt, "exec_out", DirOutput, KindExec, "")
	assertPin(t, nt, "exec_error", DirOutput, KindExec, "")
	assertPin(t, nt, "response", DirOutput, KindData, TypeJSON)
	assertPin(t, nt, "statusCode", DirOutput, KindData, TypeNumber)
}

func TestCodeExecuteNode_Pins(t *testing.T) {
	nt := Get("code-execute")
	assertPin(t, nt, "exec_in", DirInput, KindExec, "")
	assertPin(t, nt, "input", DirInput, KindData, TypeJSON)
	assertPin(t, nt, "exec_out", DirOutput, KindExec, "")
	assertPin(t, nt, "exec_error", DirOutput, KindExec, "")
	assertPin(t, nt, "output", DirOutput, KindData, TypeJSON)
}

func TestKBSearchNode_Pins(t *testing.T) {
	nt := Get("kb-search")
	assertPin(t, nt, "exec_in", DirInput, KindExec, "")
	assertPin(t, nt, "query", DirInput, KindData, TypeString)
	assertPin(t, nt, "exec_out", DirOutput, KindExec, "")
	assertPin(t, nt, "results", DirOutput, KindData, TypeJSON)
	assertPin(t, nt, "topResult", DirOutput, KindData, TypeString)

	// results should be array
	resultsPin := nt.FindPin("results")
	if resultsPin.EffectiveContainer() != ContainerArray {
		t.Errorf("results pin should be array, got %s", resultsPin.EffectiveContainer())
	}
}

func TestSendMessageNode_Pins(t *testing.T) {
	nt := Get("send-message")
	assertPin(t, nt, "exec_in", DirInput, KindExec, "")
	assertPin(t, nt, "content", DirInput, KindData, TypeString)
	assertPin(t, nt, "exec_out", DirOutput, KindExec, "")
	assertPin(t, nt, "exec_error", DirOutput, KindExec, "")
	assertPin(t, nt, "messageId", DirOutput, KindData, TypeString)
}

// --- Cross-node connection validation ---

func TestTextToLLMCall_ValidConnection(t *testing.T) {
	text := Get("text")
	llm := Get("llm-call")
	// text.exec_out -> llm.exec_in
	resp := CanConnect(text.FindPin("exec_out"), llm.FindPin("exec_in"))
	if resp.Code == ResponseDisallow {
		t.Fatalf("text.exec_out -> llm.exec_in should be allowed, got: %s", resp.Message)
	}
	// text.text -> llm.prompt (string -> string)
	resp = CanConnect(text.FindPin("text"), llm.FindPin("prompt"))
	if resp.Code == ResponseDisallow {
		t.Fatalf("text.text -> llm.prompt should be allowed, got: %s", resp.Message)
	}
}

func TestLLMCallToCondition_UsageToCondition_Disallow(t *testing.T) {
	llm := Get("llm-call")
	cond := Get("condition")
	// llm.usage (number) -> condition.condition (boolean) = disallow
	resp := CanConnect(llm.FindPin("usage"), cond.FindPin("condition"))
	if resp.Code != ResponseDisallow {
		t.Fatalf("llm.usage (number) -> condition.condition (boolean) should be disallowed, got %s", resp.Code)
	}
}

func TestLLMCallToHTTPRequest_ResultToURL(t *testing.T) {
	llm := Get("llm-call")
	http := Get("http-request")
	// llm.result (string) -> http.url (string) = allow
	resp := CanConnect(llm.FindPin("result"), http.FindPin("url"))
	if resp.Code == ResponseDisallow {
		t.Fatalf("llm.result -> http.url should be allowed, got: %s", resp.Message)
	}
}

func TestHTTPRequestToJSONTransform_ResponseToInput(t *testing.T) {
	http := Get("http-request")
	jt := Get("json-transform")
	// http.response (json) -> jt.input (json) = allow
	resp := CanConnect(http.FindPin("response"), jt.FindPin("input"))
	if resp.Code == ResponseDisallow {
		t.Fatalf("http.response -> json-transform.input should be allowed, got: %s", resp.Message)
	}
}

func TestKBSearchResultsToLoopItems_ArrayCompatibility(t *testing.T) {
	kb := Get("kb-search")
	loop := Get("loop")
	// kb.results (json array) -> loop.items (json array) = allow
	resp := CanConnect(kb.FindPin("results"), loop.FindPin("items"))
	if resp.Code == ResponseDisallow {
		t.Fatalf("kb.results -> loop.items should be allowed, got: %s", resp.Message)
	}
}

func TestStringToArrayPin_Disallow(t *testing.T) {
	text := Get("text")
	loop := Get("loop")
	// text.text (string, none) -> loop.items (json, array) = disallow (container mismatch)
	resp := CanConnect(text.FindPin("text"), loop.FindPin("items"))
	if resp.Code != ResponseDisallow {
		t.Fatalf("text.text (string/none) -> loop.items (json/array) should be disallowed, got %s", resp.Code)
	}
}

// --- Full graph validation ---

func TestValidateGraph_TextToLLMToSendMessage(t *testing.T) {
	nodes := []GraphNode{
		{NodeID: "t1", TypeID: "text"},
		{NodeID: "llm1", TypeID: "llm-call"},
		{NodeID: "send1", TypeID: "send-message"},
	}
	conns := []Connection{
		{SourceNodeID: "t1", SourcePinID: "exec_out", TargetNodeID: "llm1", TargetPinID: "exec_in"},
		{SourceNodeID: "t1", SourcePinID: "text", TargetNodeID: "llm1", TargetPinID: "prompt"},
		{SourceNodeID: "llm1", SourcePinID: "exec_out", TargetNodeID: "send1", TargetPinID: "exec_in"},
		{SourceNodeID: "llm1", SourcePinID: "result", TargetNodeID: "send1", TargetPinID: "content"},
	}
	errs := ValidateGraph(nodes, conns)
	if len(errs) != 0 {
		t.Fatalf("expected valid graph, got errors: %v", errs)
	}
}

func TestValidateGraph_WithCommentNoErrors(t *testing.T) {
	nodes := []GraphNode{
		{NodeID: "t1", TypeID: "text"},
		{NodeID: "c1", TypeID: "comment"},
		{NodeID: "llm1", TypeID: "llm-call"},
	}
	conns := []Connection{
		{SourceNodeID: "t1", SourcePinID: "exec_out", TargetNodeID: "llm1", TargetPinID: "exec_in"},
	}
	errs := ValidateGraph(nodes, conns)
	if len(errs) != 0 {
		t.Fatalf("comment node should not cause errors when not connected, got: %v", errs)
	}
}

// --- Helper ---

func assertPin(t *testing.T, nt *NodeType, pinID string, dir PinDirection, kind PinKind, valueType DataType) {
	t.Helper()
	pin := nt.FindPin(pinID)
	if pin == nil {
		t.Fatalf("node %s: pin %q not found", nt.TypeID, pinID)
	}
	if pin.Direction != dir {
		t.Errorf("node %s pin %s: direction = %s, want %s", nt.TypeID, pinID, pin.Direction, dir)
	}
	if pin.Kind != kind {
		t.Errorf("node %s pin %s: kind = %s, want %s", nt.TypeID, pinID, pin.Kind, kind)
	}
	if kind == KindData && pin.ValueType != valueType {
		t.Errorf("node %s pin %s: valueType = %s, want %s", nt.TypeID, pinID, pin.ValueType, valueType)
	}
}
