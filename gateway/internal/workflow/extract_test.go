package workflow

import (
	"testing"
)

func TestExtractGraph_WithNodesAndConnections(t *testing.T) {
	data := Definition{
		Nodes: []DefinitionNode{
			{ID: "n1", TypeID: "text"},
			{ID: "n2", TypeID: "text"},
		},
		Connections: []DefinitionConnection{
			{
				SourceNodeID: "n1", SourcePinID: "exec_out",
				TargetNodeID: "n2", TargetPinID: "exec_in",
			},
		},
	}

	nodes, conns := ExtractGraph(data)
	if len(nodes) != 2 {
		t.Fatalf("expected 2 nodes, got %d", len(nodes))
	}
	if nodes[0].NodeID != "n1" || nodes[0].TypeID != "text" {
		t.Errorf("node 0 = %+v, want n1/text", nodes[0])
	}
	if nodes[1].NodeID != "n2" || nodes[1].TypeID != "text" {
		t.Errorf("node 1 = %+v, want n2/text", nodes[1])
	}
	if len(conns) != 1 {
		t.Fatalf("expected 1 connection, got %d", len(conns))
	}
	if conns[0].SourceNodeID != "n1" || conns[0].SourcePinID != "exec_out" {
		t.Errorf("conn source = %s/%s, want n1/exec_out", conns[0].SourceNodeID, conns[0].SourcePinID)
	}
	if conns[0].TargetNodeID != "n2" || conns[0].TargetPinID != "exec_in" {
		t.Errorf("conn target = %s/%s, want n2/exec_in", conns[0].TargetNodeID, conns[0].TargetPinID)
	}
}

func TestExtractGraph_WithDefinitionDefaults(t *testing.T) {
	data := Definition{
		Nodes: []DefinitionNode{
			{ID: "a", TypeID: "text"},
			{ID: "b", TypeID: "comment"},
		},
		Connections: []DefinitionConnection{
			{
				SourceNodeID: "a", SourcePinID: "text",
				TargetNodeID: "b", TargetPinID: "x",
			},
		},
	}

	nodes, conns := ExtractGraph(data)
	if len(nodes) != 2 {
		t.Fatalf("expected 2 nodes, got %d", len(nodes))
	}
	if len(conns) != 1 {
		t.Fatalf("expected 1 connection, got %d", len(conns))
	}
}

func TestExtractGraph_EmptyData(t *testing.T) {
	nodes, conns := ExtractGraph(Definition{})
	if len(nodes) != 0 {
		t.Fatalf("expected 0 nodes, got %d", len(nodes))
	}
	if len(conns) != 0 {
		t.Fatalf("expected 0 connections, got %d", len(conns))
	}
}

func TestExtractGraph_NilData(t *testing.T) {
	nodes, conns := ExtractGraph(Definition{})
	if nodes == nil || conns == nil {
		t.Fatalf("expected normalized empty slices, got nodes=%v conns=%v", nodes, conns)
	}
}

func TestExtractGraph_SkipsInvalidNodes(t *testing.T) {
	data := Definition{
		Nodes: []DefinitionNode{
			{ID: "n1", TypeID: "text"},
			{ID: "", TypeID: "text"},
			{ID: "n3", TypeID: ""},
			{ID: "n4", TypeID: "comment"},
		},
	}
	nodes, _ := ExtractGraph(data)
	if len(nodes) != 2 {
		t.Fatalf("expected 2 valid nodes (n1, n4), got %d", len(nodes))
	}
}

func TestExtractGraph_SkipsInvalidConnections(t *testing.T) {
	data := Definition{
		Nodes: []DefinitionNode{
			{ID: "n1", TypeID: "text"},
		},
		Connections: []DefinitionConnection{
			{SourceNodeID: "n1", SourcePinID: "exec_out", TargetNodeID: "n2", TargetPinID: "exec_in"},
			{SourceNodeID: "", SourcePinID: "x", TargetNodeID: "n2", TargetPinID: "y"},
			{SourceNodeID: "n1", SourcePinID: "x", TargetNodeID: "", TargetPinID: "y"},
		},
	}
	_, conns := ExtractGraph(data)
	if len(conns) != 1 {
		t.Fatalf("expected 1 valid connection, got %d", len(conns))
	}
}

// Integration: ExtractGraph + ValidateGraph

func TestExtractAndValidate_ValidGraph(t *testing.T) {
	data := Definition{
		Nodes: []DefinitionNode{
			{ID: "n1", TypeID: "text"},
			{ID: "c1", TypeID: "comment"},
		},
		Connections: []DefinitionConnection{},
	}
	nodes, conns := ExtractGraph(data)
	errs := ValidateGraph(nodes, conns)
	if len(errs) != 0 {
		t.Fatalf("expected no errors, got %v", errs)
	}
}

func TestExtractAndValidate_CycleDetected(t *testing.T) {
	Register(NodeType{
		TypeID: "_test_node_ext", Version: 1, DisplayName: "Test", Category: CategoryFlow,
		Inputs:  []Pin{{PinID: "exec_in", Label: "In", Direction: DirInput, Kind: KindExec}},
		Outputs: []Pin{{PinID: "exec_out", Label: "Out", Direction: DirOutput, Kind: KindExec}},
	})
	defer func() {
		registry.mu.Lock()
		delete(registry.types, "_test_node_ext")
		registry.mu.Unlock()
	}()

	data := Definition{
		Nodes: []DefinitionNode{
			{ID: "a", TypeID: "_test_node_ext"},
			{ID: "b", TypeID: "_test_node_ext"},
		},
		Connections: []DefinitionConnection{
			{SourceNodeID: "a", SourcePinID: "exec_out", TargetNodeID: "b", TargetPinID: "exec_in"},
			{SourceNodeID: "b", SourcePinID: "exec_out", TargetNodeID: "a", TargetPinID: "exec_in"},
		},
	}
	nodes, conns := ExtractGraph(data)
	errs := ValidateGraph(nodes, conns)
	found := false
	for _, e := range errs {
		if e.Code == "EXEC_CYCLE" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected EXEC_CYCLE, got %v", errs)
	}
}

func TestExtractAndValidate_CommentConnectionRejected(t *testing.T) {
	data := Definition{
		Nodes: []DefinitionNode{
			{ID: "n1", TypeID: "text"},
			{ID: "c1", TypeID: "comment"},
		},
		Connections: []DefinitionConnection{
			{SourceNodeID: "n1", SourcePinID: "exec_out", TargetNodeID: "c1", TargetPinID: "anything"},
		},
	}
	nodes, conns := ExtractGraph(data)
	errs := ValidateGraph(nodes, conns)
	found := false
	for _, e := range errs {
		if e.Code == "COMMENT_CONNECTION" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected COMMENT_CONNECTION, got %v", errs)
	}
}
