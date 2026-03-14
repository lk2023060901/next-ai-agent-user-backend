package model

import "time"

type KnowledgeBase struct {
	ID                     string   `json:"id"`
	WorkspaceID            string   `json:"workspaceId"`
	Name                   string   `json:"name"`
	DocumentCount          int      `json:"documentCount"`
	EmbeddingModel         string   `json:"embeddingModel"`
	ChunkSize              int      `json:"chunkSize"`
	ChunkOverlap           int      `json:"chunkOverlap"`
	RequestedDocumentChunks int     `json:"requestedDocumentChunks"`
	DocumentProcessing     *string  `json:"documentProcessing,omitempty"`
	RerankerModel          *string  `json:"rerankerModel,omitempty"`
	MatchingThreshold      *float64 `json:"matchingThreshold,omitempty"`
	CreatedAt              time.Time `json:"createdAt"`
	UpdatedAt              time.Time `json:"updatedAt"`
}

type KbDocument struct {
	ID          string     `json:"id"`
	KbID        string     `json:"kbId"`
	Name        string     `json:"name"`
	FileType    string     `json:"fileType"`
	FileSize    int64      `json:"fileSize"`
	Status      string     `json:"status"`
	ChunkCount  *int       `json:"chunkCount,omitempty"`
	UploadedAt  time.Time  `json:"uploadedAt"`
	ProcessedAt *time.Time `json:"processedAt,omitempty"`
}
