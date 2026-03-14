package workflow

// ExtractGraph converts a workflow definition into validation graph primitives.
func ExtractGraph(def Definition) ([]GraphNode, []Connection) {
	def = NormalizeDefinition(def)

	nodes := make([]GraphNode, 0, len(def.Nodes))
	for _, node := range def.Nodes {
		if node.ID == "" || node.TypeID == "" {
			continue
		}
		nodes = append(nodes, GraphNode{
			NodeID: node.ID,
			TypeID: node.TypeID,
		})
	}

	connections := make([]Connection, 0, len(def.Connections))
	for _, conn := range def.Connections {
		if conn.SourceNodeID == "" || conn.TargetNodeID == "" {
			continue
		}
		connections = append(connections, Connection{
			SourceNodeID: conn.SourceNodeID,
			SourcePinID:  conn.SourcePinID,
			TargetNodeID: conn.TargetNodeID,
			TargetPinID:  conn.TargetPinID,
		})
	}

	return nodes, connections
}
