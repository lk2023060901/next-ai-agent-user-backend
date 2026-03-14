package handler

import (
	"net/http"
	"path/filepath"
	"strings"

	"go.uber.org/zap"

	"github.com/go-chi/chi/v5"
	"github.com/nextai-agent/gateway/internal/logger"
	"github.com/nextai-agent/gateway/internal/model"
	"github.com/nextai-agent/gateway/internal/store"
)

var kbLog = logger.Named("knowledge")

type KnowledgeHandler struct {
	kb *store.KnowledgeStore
}

func NewKnowledgeHandler(kb *store.KnowledgeStore) *KnowledgeHandler {
	return &KnowledgeHandler{kb: kb}
}

func (h *KnowledgeHandler) Mount(r chi.Router) {
	r.Get("/workspaces/{wsId}/knowledge-bases", h.List)
	r.Post("/workspaces/{wsId}/knowledge-bases", h.Create)
	r.Patch("/knowledge-bases/{kbId}", h.Update)
	r.Delete("/knowledge-bases/{kbId}", h.Delete)
	r.Get("/knowledge-bases/{kbId}/documents", h.ListDocuments)
	r.Post("/knowledge-bases/{kbId}/documents", h.UploadDocument)
	r.Delete("/knowledge-bases/{kbId}/documents/{docId}", h.DeleteDocument)
}

func (h *KnowledgeHandler) List(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	kbs, err := h.kb.List(r.Context(), wsID)
	if err != nil {
		kbLog.Error("list knowledge bases failed", zap.String("workspaceId", wsID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取知识库列表失败")
		return
	}
	if kbs == nil {
		kbs = []model.KnowledgeBase{}
	}
	kbLog.Debug("list knowledge bases", zap.String("workspaceId", wsID), zap.Int("count", len(kbs)))
	writeData(w, kbs)
}

func (h *KnowledgeHandler) Create(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	var body struct {
		Name                   string   `json:"name"`
		EmbeddingModel         string   `json:"embeddingModel"`
		ChunkSize              int      `json:"chunkSize"`
		ChunkOverlap           int      `json:"chunkOverlap"`
		RequestedDocumentChunks int     `json:"requestedDocumentChunks"`
		DocumentProcessing     *string  `json:"documentProcessing"`
		RerankerModel          *string  `json:"rerankerModel"`
		MatchingThreshold      *float64 `json:"matchingThreshold"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	if body.Name == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "name is required")
		return
	}
	if body.ChunkSize <= 0 {
		body.ChunkSize = 512
	}
	if body.ChunkOverlap <= 0 {
		body.ChunkOverlap = 50
	}
	if body.RequestedDocumentChunks <= 0 {
		body.RequestedDocumentChunks = 5
	}

	kb := &model.KnowledgeBase{
		WorkspaceID: wsID, Name: body.Name, EmbeddingModel: body.EmbeddingModel,
		ChunkSize: body.ChunkSize, ChunkOverlap: body.ChunkOverlap,
		RequestedDocumentChunks: body.RequestedDocumentChunks,
		DocumentProcessing: body.DocumentProcessing, RerankerModel: body.RerankerModel,
		MatchingThreshold: body.MatchingThreshold,
	}
	created, err := h.kb.Create(r.Context(), kb)
	if err != nil {
		kbLog.Error("create knowledge base failed", zap.String("workspaceId", wsID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "创建知识库失败")
		return
	}
	kbLog.Debug("create knowledge base", zap.String("kbId", created.ID), zap.String("name", created.Name))
	writeJSON(w, http.StatusCreated, apiResponse{Data: created})
}

func (h *KnowledgeHandler) Update(w http.ResponseWriter, r *http.Request) {
	kbID := chi.URLParam(r, "kbId")
	var body map[string]interface{}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	fieldMap := map[string]string{
		"name": "name", "embeddingModel": "embedding_model", "chunkSize": "chunk_size",
		"chunkOverlap": "chunk_overlap", "requestedDocumentChunks": "requested_document_chunks",
		"documentProcessing": "document_processing", "rerankerModel": "reranker_model",
		"matchingThreshold": "matching_threshold",
	}
	dbFields := make(map[string]interface{})
	for jk, dk := range fieldMap {
		if v, ok := body[jk]; ok {
			dbFields[dk] = v
		}
	}
	if len(dbFields) == 0 {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "no fields to update")
		return
	}
	kb, err := h.kb.Update(r.Context(), kbID, dbFields)
	if err != nil {
		kbLog.Error("update knowledge base failed", zap.String("kbId", kbID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "更新知识库失败")
		return
	}
	kbLog.Debug("update knowledge base", zap.String("kbId", kbID))
	writeData(w, kb)
}

func (h *KnowledgeHandler) Delete(w http.ResponseWriter, r *http.Request) {
	kbID := chi.URLParam(r, "kbId")
	if err := h.kb.Delete(r.Context(), kbID); err != nil {
		kbLog.Error("delete knowledge base failed", zap.String("kbId", kbID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "删除知识库失败")
		return
	}
	kbLog.Debug("delete knowledge base", zap.String("kbId", kbID))
	w.WriteHeader(http.StatusNoContent)
}

func (h *KnowledgeHandler) ListDocuments(w http.ResponseWriter, r *http.Request) {
	kbID := chi.URLParam(r, "kbId")
	docs, err := h.kb.ListDocuments(r.Context(), kbID)
	if err != nil {
		kbLog.Error("list documents failed", zap.String("kbId", kbID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取文档列表失败")
		return
	}
	if docs == nil {
		docs = []model.KbDocument{}
	}
	kbLog.Debug("list documents", zap.String("kbId", kbID), zap.Int("count", len(docs)))
	writeData(w, docs)
}

func (h *KnowledgeHandler) UploadDocument(w http.ResponseWriter, r *http.Request) {
	kbID := chi.URLParam(r, "kbId")
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid multipart form")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "file is required")
		return
	}
	defer file.Close()

	ext := strings.TrimPrefix(filepath.Ext(header.Filename), ".")
	storagePath := "uploads/" + kbID + "/" + header.Filename

	doc, err := h.kb.CreateDocument(r.Context(), kbID, header.Filename, ext, header.Size, storagePath)
	if err != nil {
		kbLog.Error("upload document failed", zap.String("kbId", kbID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "上传文档失败")
		return
	}
	kbLog.Debug("upload document", zap.String("kbId", kbID), zap.String("docId", doc.ID), zap.String("name", doc.Name))
	writeJSON(w, http.StatusCreated, apiResponse{Data: doc})
}

func (h *KnowledgeHandler) DeleteDocument(w http.ResponseWriter, r *http.Request) {
	kbID := chi.URLParam(r, "kbId")
	docID := chi.URLParam(r, "docId")
	if err := h.kb.DeleteDocument(r.Context(), kbID, docID); err != nil {
		kbLog.Error("delete document failed", zap.String("kbId", kbID), zap.String("docId", docID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "删除文档失败")
		return
	}
	kbLog.Debug("delete document", zap.String("kbId", kbID), zap.String("docId", docID))
	w.WriteHeader(http.StatusNoContent)
}
