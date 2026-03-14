package store

import (
	"context"
	"fmt"

	sq "github.com/Masterminds/squirrel"
	"github.com/jackc/pgx/v5"
	"github.com/nextai-agent/gateway/internal/model"
)

type KnowledgeStore struct {
	db *DB
}

func NewKnowledgeStore(db *DB) *KnowledgeStore {
	return &KnowledgeStore{db: db}
}

var kbCols = []string{
	"id", "workspace_id", "name", "document_count", "embedding_model",
	"chunk_size", "chunk_overlap", "requested_document_chunks",
	"document_processing", "reranker_model", "matching_threshold",
	"created_at", "updated_at",
}

func (s *KnowledgeStore) List(ctx context.Context, workspaceID string) ([]model.KnowledgeBase, error) {
	rows, err := s.db.Query(ctx,
		Select(kbCols...).From("knowledge_bases").
			Where("workspace_id = ?", workspaceID).OrderBy("created_at"),
	)
	if err != nil {
		return nil, fmt.Errorf("list knowledge bases: %w", err)
	}
	defer rows.Close()
	return scanKBs(rows)
}

func (s *KnowledgeStore) Create(ctx context.Context, kb *model.KnowledgeBase) (*model.KnowledgeBase, error) {
	err := s.db.QueryRow(ctx,
		Insert("knowledge_bases").
			Columns("workspace_id", "name", "embedding_model", "chunk_size", "chunk_overlap",
				"requested_document_chunks", "document_processing", "reranker_model", "matching_threshold").
			Values(kb.WorkspaceID, kb.Name, kb.EmbeddingModel, kb.ChunkSize, kb.ChunkOverlap,
				kb.RequestedDocumentChunks, kb.DocumentProcessing, kb.RerankerModel, kb.MatchingThreshold).
			Suffix("RETURNING "+JoinCols(kbCols)),
	).Scan(&kb.ID, &kb.WorkspaceID, &kb.Name, &kb.DocumentCount, &kb.EmbeddingModel,
		&kb.ChunkSize, &kb.ChunkOverlap, &kb.RequestedDocumentChunks,
		&kb.DocumentProcessing, &kb.RerankerModel, &kb.MatchingThreshold,
		&kb.CreatedAt, &kb.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("create knowledge base: %w", err)
	}
	return kb, nil
}

func (s *KnowledgeStore) Update(ctx context.Context, id string, fields map[string]interface{}) (*model.KnowledgeBase, error) {
	b := SetFields(Update("knowledge_bases"), fields).
		Set("updated_at", sq.Expr("NOW()")).
		Where("id = ?", id).
		Suffix("RETURNING " + JoinCols(kbCols))
	kb := &model.KnowledgeBase{}
	err := s.db.QueryRow(ctx, b).Scan(&kb.ID, &kb.WorkspaceID, &kb.Name, &kb.DocumentCount, &kb.EmbeddingModel,
		&kb.ChunkSize, &kb.ChunkOverlap, &kb.RequestedDocumentChunks,
		&kb.DocumentProcessing, &kb.RerankerModel, &kb.MatchingThreshold,
		&kb.CreatedAt, &kb.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("update knowledge base: %w", err)
	}
	return kb, nil
}

func (s *KnowledgeStore) Delete(ctx context.Context, id string) error {
	return s.db.Exec(ctx, Delete("knowledge_bases").Where("id = ?", id))
}

// Documents

var docCols = []string{"id", "kb_id", "name", "file_type", "file_size", "status", "chunk_count", "uploaded_at", "processed_at"}

func (s *KnowledgeStore) ListDocuments(ctx context.Context, kbID string) ([]model.KbDocument, error) {
	rows, err := s.db.Query(ctx,
		Select(docCols...).From("kb_documents").Where("kb_id = ?", kbID).OrderBy("uploaded_at DESC"),
	)
	if err != nil {
		return nil, fmt.Errorf("list documents: %w", err)
	}
	defer rows.Close()
	var docs []model.KbDocument
	for rows.Next() {
		var d model.KbDocument
		if err := rows.Scan(&d.ID, &d.KbID, &d.Name, &d.FileType, &d.FileSize, &d.Status, &d.ChunkCount, &d.UploadedAt, &d.ProcessedAt); err != nil {
			return nil, fmt.Errorf("scan document: %w", err)
		}
		docs = append(docs, d)
	}
	return docs, nil
}

func (s *KnowledgeStore) CreateDocument(ctx context.Context, kbID, name, fileType string, fileSize int64, storagePath string) (*model.KbDocument, error) {
	d := &model.KbDocument{}
	err := s.db.QueryRow(ctx,
		Insert("kb_documents").
			Columns("kb_id", "name", "file_type", "file_size", "storage_path", "status").
			Values(kbID, name, fileType, fileSize, storagePath, "pending").
			Suffix("RETURNING "+JoinCols(docCols)),
	).Scan(&d.ID, &d.KbID, &d.Name, &d.FileType, &d.FileSize, &d.Status, &d.ChunkCount, &d.UploadedAt, &d.ProcessedAt)
	if err != nil {
		return nil, fmt.Errorf("create document: %w", err)
	}
	// Increment document count
	_ = s.db.Exec(ctx, Update("knowledge_bases").
		Set("document_count", sq.Expr("document_count + 1")).
		Set("updated_at", sq.Expr("NOW()")).
		Where("id = ?", kbID))
	return d, nil
}

func (s *KnowledgeStore) DeleteDocument(ctx context.Context, kbID, docID string) error {
	err := s.db.Exec(ctx, Delete("kb_documents").Where("id = ? AND kb_id = ?", docID, kbID))
	if err != nil {
		return err
	}
	_ = s.db.Exec(ctx, Update("knowledge_bases").
		Set("document_count", sq.Expr("GREATEST(document_count - 1, 0)")).
		Set("updated_at", sq.Expr("NOW()")).
		Where("id = ?", kbID))
	return nil
}

func scanKBs(rows pgx.Rows) ([]model.KnowledgeBase, error) {
	var kbs []model.KnowledgeBase
	for rows.Next() {
		var kb model.KnowledgeBase
		if err := rows.Scan(&kb.ID, &kb.WorkspaceID, &kb.Name, &kb.DocumentCount, &kb.EmbeddingModel,
			&kb.ChunkSize, &kb.ChunkOverlap, &kb.RequestedDocumentChunks,
			&kb.DocumentProcessing, &kb.RerankerModel, &kb.MatchingThreshold,
			&kb.CreatedAt, &kb.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan knowledge base: %w", err)
		}
		kbs = append(kbs, kb)
	}
	return kbs, nil
}
