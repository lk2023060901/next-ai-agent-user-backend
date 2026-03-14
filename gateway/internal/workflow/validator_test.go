package workflow

import (
	"testing"
)

// --- CanConnect tests ---

func TestCanConnect_ExecToExec_Allow(t *testing.T) {
	out := &Pin{PinID: "a", Direction: DirOutput, Kind: KindExec}
	in := &Pin{PinID: "b", Direction: DirInput, Kind: KindExec}
	resp := CanConnect(out, in)
	if resp.Code == ResponseDisallow {
		t.Fatalf("expected allow, got disallow: %s", resp.Message)
	}
}

func TestCanConnect_ExecOutput_BreakOthers(t *testing.T) {
	out := &Pin{PinID: "a", Direction: DirOutput, Kind: KindExec, MultiLinks: false}
	in := &Pin{PinID: "b", Direction: DirInput, Kind: KindExec}
	resp := CanConnect(out, in)
	if resp.Code != ResponseBreakOthersA {
		t.Fatalf("expected BREAK_OTHERS_A, got %s", resp.Code)
	}
}

func TestCanConnect_ExecMultiLinks_Allow(t *testing.T) {
	out := &Pin{PinID: "a", Direction: DirOutput, Kind: KindExec, MultiLinks: true}
	in := &Pin{PinID: "b", Direction: DirInput, Kind: KindExec}
	resp := CanConnect(out, in)
	if resp.Code != ResponseAllow {
		t.Fatalf("expected ALLOW, got %s", resp.Code)
	}
}

func TestCanConnect_WrongDirection_InputToInput(t *testing.T) {
	a := &Pin{PinID: "a", Direction: DirInput, Kind: KindExec}
	b := &Pin{PinID: "b", Direction: DirInput, Kind: KindExec}
	resp := CanConnect(a, b)
	if resp.Code != ResponseDisallow {
		t.Fatalf("expected disallow for input->input, got %s", resp.Code)
	}
}

func TestCanConnect_WrongDirection_OutputToOutput(t *testing.T) {
	a := &Pin{PinID: "a", Direction: DirOutput, Kind: KindExec}
	b := &Pin{PinID: "b", Direction: DirOutput, Kind: KindExec}
	resp := CanConnect(a, b)
	if resp.Code != ResponseDisallow {
		t.Fatalf("expected disallow for output->output, got %s", resp.Code)
	}
}

func TestCanConnect_ExecToData_Disallow(t *testing.T) {
	out := &Pin{PinID: "a", Direction: DirOutput, Kind: KindExec}
	in := &Pin{PinID: "b", Direction: DirInput, Kind: KindData, ValueType: TypeString}
	resp := CanConnect(out, in)
	if resp.Code != ResponseDisallow {
		t.Fatalf("expected disallow for exec->data, got %s", resp.Code)
	}
}

func TestCanConnect_DataToExec_Disallow(t *testing.T) {
	out := &Pin{PinID: "a", Direction: DirOutput, Kind: KindData, ValueType: TypeString}
	in := &Pin{PinID: "b", Direction: DirInput, Kind: KindExec}
	resp := CanConnect(out, in)
	if resp.Code != ResponseDisallow {
		t.Fatalf("expected disallow for data->exec, got %s", resp.Code)
	}
}

// --- Data type compatibility ---

func TestCanConnect_StringToString_Allow(t *testing.T) {
	out := &Pin{PinID: "a", Direction: DirOutput, Kind: KindData, ValueType: TypeString}
	in := &Pin{PinID: "b", Direction: DirInput, Kind: KindData, ValueType: TypeString, MultiLinks: true}
	resp := CanConnect(out, in)
	if resp.Code == ResponseDisallow {
		t.Fatalf("expected allow string->string, got disallow: %s", resp.Message)
	}
}

func TestCanConnect_NumberToNumber_Allow(t *testing.T) {
	out := &Pin{PinID: "a", Direction: DirOutput, Kind: KindData, ValueType: TypeNumber}
	in := &Pin{PinID: "b", Direction: DirInput, Kind: KindData, ValueType: TypeNumber, MultiLinks: true}
	resp := CanConnect(out, in)
	if resp.Code == ResponseDisallow {
		t.Fatalf("expected allow number->number, got disallow: %s", resp.Message)
	}
}

func TestCanConnect_BooleanToBoolean_Allow(t *testing.T) {
	out := &Pin{PinID: "a", Direction: DirOutput, Kind: KindData, ValueType: TypeBoolean}
	in := &Pin{PinID: "b", Direction: DirInput, Kind: KindData, ValueType: TypeBoolean, MultiLinks: true}
	resp := CanConnect(out, in)
	if resp.Code == ResponseDisallow {
		t.Fatalf("expected allow bool->bool, got disallow: %s", resp.Message)
	}
}

func TestCanConnect_StringToNumber_Disallow(t *testing.T) {
	out := &Pin{PinID: "a", Direction: DirOutput, Kind: KindData, ValueType: TypeString}
	in := &Pin{PinID: "b", Direction: DirInput, Kind: KindData, ValueType: TypeNumber}
	resp := CanConnect(out, in)
	if resp.Code != ResponseDisallow {
		t.Fatalf("expected disallow string->number, got %s", resp.Code)
	}
}

func TestCanConnect_NumberToString_Disallow(t *testing.T) {
	out := &Pin{PinID: "a", Direction: DirOutput, Kind: KindData, ValueType: TypeNumber}
	in := &Pin{PinID: "b", Direction: DirInput, Kind: KindData, ValueType: TypeString}
	resp := CanConnect(out, in)
	if resp.Code != ResponseDisallow {
		t.Fatalf("expected disallow number->string, got %s", resp.Code)
	}
}

func TestCanConnect_BooleanToString_Disallow(t *testing.T) {
	out := &Pin{PinID: "a", Direction: DirOutput, Kind: KindData, ValueType: TypeBoolean}
	in := &Pin{PinID: "b", Direction: DirInput, Kind: KindData, ValueType: TypeString}
	resp := CanConnect(out, in)
	if resp.Code != ResponseDisallow {
		t.Fatalf("expected disallow bool->string, got %s", resp.Code)
	}
}

func TestCanConnect_StringToJSON_Allow(t *testing.T) {
	out := &Pin{PinID: "a", Direction: DirOutput, Kind: KindData, ValueType: TypeString}
	in := &Pin{PinID: "b", Direction: DirInput, Kind: KindData, ValueType: TypeJSON, MultiLinks: true}
	resp := CanConnect(out, in)
	if resp.Code == ResponseDisallow {
		t.Fatalf("expected allow string->json, got disallow: %s", resp.Message)
	}
}

func TestCanConnect_NumberToJSON_Allow(t *testing.T) {
	out := &Pin{PinID: "a", Direction: DirOutput, Kind: KindData, ValueType: TypeNumber}
	in := &Pin{PinID: "b", Direction: DirInput, Kind: KindData, ValueType: TypeJSON, MultiLinks: true}
	resp := CanConnect(out, in)
	if resp.Code == ResponseDisallow {
		t.Fatalf("expected allow number->json, got disallow: %s", resp.Message)
	}
}

func TestCanConnect_JSONToString_Disallow(t *testing.T) {
	out := &Pin{PinID: "a", Direction: DirOutput, Kind: KindData, ValueType: TypeJSON}
	in := &Pin{PinID: "b", Direction: DirInput, Kind: KindData, ValueType: TypeString}
	resp := CanConnect(out, in)
	if resp.Code != ResponseDisallow {
		t.Fatalf("expected disallow json->string, got %s", resp.Code)
	}
}

// --- Container type ---

func TestCanConnect_ArrayToNone_Disallow(t *testing.T) {
	out := &Pin{PinID: "a", Direction: DirOutput, Kind: KindData, ValueType: TypeString, ContainerType: ContainerArray}
	in := &Pin{PinID: "b", Direction: DirInput, Kind: KindData, ValueType: TypeString, ContainerType: ContainerNone}
	resp := CanConnect(out, in)
	if resp.Code != ResponseDisallow {
		t.Fatalf("expected disallow array->none, got %s", resp.Code)
	}
}

func TestCanConnect_ArrayToArray_Allow(t *testing.T) {
	out := &Pin{PinID: "a", Direction: DirOutput, Kind: KindData, ValueType: TypeString, ContainerType: ContainerArray}
	in := &Pin{PinID: "b", Direction: DirInput, Kind: KindData, ValueType: TypeString, ContainerType: ContainerArray, MultiLinks: true}
	resp := CanConnect(out, in)
	if resp.Code == ResponseDisallow {
		t.Fatalf("expected allow array->array, got disallow: %s", resp.Message)
	}
}

// --- Data input single-link ---

func TestCanConnect_DataInput_SingleLink_BreakOthers(t *testing.T) {
	out := &Pin{PinID: "a", Direction: DirOutput, Kind: KindData, ValueType: TypeString}
	in := &Pin{PinID: "b", Direction: DirInput, Kind: KindData, ValueType: TypeString, MultiLinks: false}
	resp := CanConnect(out, in)
	if resp.Code != ResponseBreakOthersB {
		t.Fatalf("expected BREAK_OTHERS_B for single-link data input, got %s", resp.Code)
	}
}

// --- ValidateGraph tests ---

func TestValidateGraph_EmptyGraph(t *testing.T) {
	errs := ValidateGraph(nil, nil)
	if len(errs) != 0 {
		t.Fatalf("expected no errors for empty graph, got %d", len(errs))
	}
}

func TestValidateGraph_ValidDisconnectedNodes(t *testing.T) {
	nodes := []GraphNode{
		{NodeID: "n1", TypeID: "text"},
		{NodeID: "n2", TypeID: "text"},
		{NodeID: "c1", TypeID: "comment"},
	}
	errs := ValidateGraph(nodes, nil)
	if len(errs) != 0 {
		t.Fatalf("expected no errors, got %d: %v", len(errs), errs)
	}
}

func TestValidateGraph_SelfConnection(t *testing.T) {
	nodes := []GraphNode{{NodeID: "n1", TypeID: "text"}}
	conns := []Connection{{SourceNodeID: "n1", SourcePinID: "exec_out", TargetNodeID: "n1", TargetPinID: "exec_out"}}
	errs := ValidateGraph(nodes, conns)
	found := false
	for _, e := range errs {
		if e.Code == "SELF_CONNECTION" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected SELF_CONNECTION error, got %v", errs)
	}
}

func TestValidateGraph_CommentConnection(t *testing.T) {
	nodes := []GraphNode{
		{NodeID: "n1", TypeID: "text"},
		{NodeID: "c1", TypeID: "comment"},
	}
	conns := []Connection{{SourceNodeID: "n1", SourcePinID: "exec_out", TargetNodeID: "c1", TargetPinID: "x"}}
	errs := ValidateGraph(nodes, conns)
	found := false
	for _, e := range errs {
		if e.Code == "COMMENT_CONNECTION" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected COMMENT_CONNECTION error, got %v", errs)
	}
}

func TestValidateGraph_UnknownNodeType(t *testing.T) {
	nodes := []GraphNode{{NodeID: "n1", TypeID: "nonexistent"}}
	errs := ValidateGraph(nodes, nil)
	found := false
	for _, e := range errs {
		if e.Code == "UNKNOWN_NODE_TYPE" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected UNKNOWN_NODE_TYPE error, got %v", errs)
	}
}

func TestValidateGraph_UnknownPin(t *testing.T) {
	nodes := []GraphNode{
		{NodeID: "n1", TypeID: "text"},
		{NodeID: "n2", TypeID: "text"},
	}
	conns := []Connection{{SourceNodeID: "n1", SourcePinID: "fake_pin", TargetNodeID: "n2", TargetPinID: "text"}}
	errs := ValidateGraph(nodes, conns)
	found := false
	for _, e := range errs {
		if e.Code == "UNKNOWN_PIN" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected UNKNOWN_PIN error, got %v", errs)
	}
}

func TestValidateGraph_ExecCycle(t *testing.T) {
	// Register a helper node with both exec in and exec out for cycle testing
	Register(NodeType{
		TypeID: "_test_passthrough", Version: 1, DisplayName: "Test", Category: CategoryFlow,
		Inputs:  []Pin{{PinID: "exec_in", Label: "In", Direction: DirInput, Kind: KindExec}},
		Outputs: []Pin{{PinID: "exec_out", Label: "Out", Direction: DirOutput, Kind: KindExec}},
	})
	defer func() {
		registry.mu.Lock()
		delete(registry.types, "_test_passthrough")
		registry.mu.Unlock()
	}()

	nodes := []GraphNode{
		{NodeID: "a", TypeID: "_test_passthrough"},
		{NodeID: "b", TypeID: "_test_passthrough"},
	}
	conns := []Connection{
		{SourceNodeID: "a", SourcePinID: "exec_out", TargetNodeID: "b", TargetPinID: "exec_in"},
		{SourceNodeID: "b", SourcePinID: "exec_out", TargetNodeID: "a", TargetPinID: "exec_in"},
	}
	errs := ValidateGraph(nodes, conns)
	found := false
	for _, e := range errs {
		if e.Code == "EXEC_CYCLE" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected EXEC_CYCLE error, got %v", errs)
	}
}

func TestValidateGraph_ValidLinearChain(t *testing.T) {
	Register(NodeType{
		TypeID: "_test_mid", Version: 1, DisplayName: "Mid", Category: CategoryFlow,
		Inputs:  []Pin{{PinID: "exec_in", Label: "In", Direction: DirInput, Kind: KindExec}},
		Outputs: []Pin{{PinID: "exec_out", Label: "Out", Direction: DirOutput, Kind: KindExec}},
	})
	defer func() {
		registry.mu.Lock()
		delete(registry.types, "_test_mid")
		registry.mu.Unlock()
	}()

	// text -> mid -> mid (valid linear chain, no cycle)
	nodes := []GraphNode{
		{NodeID: "start", TypeID: "text"},
		{NodeID: "m1", TypeID: "_test_mid"},
		{NodeID: "m2", TypeID: "_test_mid"},
	}
	conns := []Connection{
		{SourceNodeID: "start", SourcePinID: "exec_out", TargetNodeID: "m1", TargetPinID: "exec_in"},
		{SourceNodeID: "m1", SourcePinID: "exec_out", TargetNodeID: "m2", TargetPinID: "exec_in"},
	}
	errs := ValidateGraph(nodes, conns)
	if len(errs) != 0 {
		t.Fatalf("expected no errors for valid linear chain, got %d: %v", len(errs), errs)
	}
}

// --- isTypeCompatible tests ---

func TestTypeCompatibility(t *testing.T) {
	tests := []struct {
		output DataType
		input  DataType
		expect bool
	}{
		{TypeString, TypeString, true},
		{TypeNumber, TypeNumber, true},
		{TypeBoolean, TypeBoolean, true},
		{TypeJSON, TypeJSON, true},
		{TypeString, TypeJSON, true},  // json accepts everything
		{TypeNumber, TypeJSON, true},  // json accepts everything
		{TypeBoolean, TypeJSON, true}, // json accepts everything
		{TypeString, TypeNumber, false},
		{TypeNumber, TypeString, false},
		{TypeBoolean, TypeString, false},
		{TypeJSON, TypeString, false}, // json output cannot flow into string input
		{TypeJSON, TypeNumber, false},
		{TypeJSON, TypeBoolean, false},
		{TypeNumber, TypeBoolean, false},
		{TypeBoolean, TypeNumber, false},
	}
	for _, tt := range tests {
		got := isTypeCompatible(tt.output, tt.input)
		if got != tt.expect {
			t.Errorf("isTypeCompatible(%s, %s) = %v, want %v", tt.output, tt.input, got, tt.expect)
		}
	}
}

// --- Registry tests ---

func TestRegistryContainsTextAndComment(t *testing.T) {
	text := Get("text")
	if text == nil {
		t.Fatal("text node type not registered")
	}
	if text.Category != CategoryData {
		t.Errorf("text category = %s, want data", text.Category)
	}
	if len(text.Inputs) != 0 {
		t.Errorf("text should have 0 inputs, got %d", len(text.Inputs))
	}
	if len(text.Outputs) != 2 {
		t.Errorf("text should have 2 outputs, got %d", len(text.Outputs))
	}

	comment := Get("comment")
	if comment == nil {
		t.Fatal("comment node type not registered")
	}
	if !comment.IsComment() {
		t.Error("comment node should be identified as comment")
	}
	if len(comment.Inputs) != 0 || len(comment.Outputs) != 0 {
		t.Error("comment node should have no pins")
	}
}

func TestRegistryAll(t *testing.T) {
	all := All()
	if len(all) < 2 {
		t.Fatalf("expected at least 2 node types, got %d", len(all))
	}
}

func TestNodeTypeFindPin(t *testing.T) {
	text := Get("text")
	if text == nil {
		t.Fatal("text not found")
	}
	execOut := text.FindPin("exec_out")
	if execOut == nil {
		t.Fatal("exec_out pin not found")
	}
	if !execOut.IsExec() {
		t.Error("exec_out should be exec kind")
	}
	if execOut.Direction != DirOutput {
		t.Error("exec_out should be output direction")
	}

	textPin := text.FindPin("text")
	if textPin == nil {
		t.Fatal("text pin not found")
	}
	if !textPin.IsData() {
		t.Error("text pin should be data kind")
	}
	if textPin.ValueType != TypeString {
		t.Errorf("text pin valueType = %s, want string", textPin.ValueType)
	}

	unknown := text.FindPin("nonexistent")
	if unknown != nil {
		t.Error("should return nil for unknown pin")
	}
}
