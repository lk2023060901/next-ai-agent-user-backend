package handler

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/grpcclient"
	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/middleware"
	commonpb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/common"
	toolspb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/tools"
)

type ToolsHandler struct {
	clients *grpcclient.Clients
}

func NewToolsHandler(clients *grpcclient.Clients) *ToolsHandler {
	return &ToolsHandler{clients: clients}
}

func (h *ToolsHandler) userCtx(r *http.Request) *commonpb.UserContext {
	u, _ := middleware.GetUser(r)
	return &commonpb.UserContext{UserId: u.UserID, Email: u.Email, Name: u.Name}
}

func (h *ToolsHandler) ListTools(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Tools.ListTools(r.Context(), &toolspb.ListToolsRequest{
		WorkspaceId: chi.URLParam(r, "wsId"),
		Category:    r.URL.Query().Get("category"),
		UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, resp.Tools)
}

func (h *ToolsHandler) ListToolAuthorizations(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Tools.ListToolAuthorizations(r.Context(), &toolspb.WorkspaceRequest{
		WorkspaceId: chi.URLParam(r, "wsId"),
		UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, resp.Authorizations)
}

func (h *ToolsHandler) UpsertToolAuthorization(w http.ResponseWriter, r *http.Request) {
	var body toolspb.UpsertToolAuthRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	body.WorkspaceId = chi.URLParam(r, "wsId")
	body.UserContext = h.userCtx(r)
	resp, err := h.clients.Tools.UpsertToolAuthorization(r.Context(), &body)
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, resp)
}

func (h *ToolsHandler) ListKnowledgeBases(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Tools.ListKnowledgeBases(r.Context(), &toolspb.WorkspaceRequest{
		WorkspaceId: chi.URLParam(r, "wsId"),
		UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}

	items := make([]map[string]any, 0, len(resp.KnowledgeBases))
	for _, kb := range resp.KnowledgeBases {
		items = append(items, mapKnowledgeBase(kb))
	}
	writeData(w, http.StatusOK, items)
}

func (h *ToolsHandler) CreateKnowledgeBase(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name                    string   `json:"name"`
		EmbeddingModel          string   `json:"embeddingModel"`
		ChunkSize               int32    `json:"chunkSize"`
		ChunkOverlap            int32    `json:"chunkOverlap"`
		RequestedDocumentChunks int32    `json:"requestedDocumentChunks"`
		DocumentProcessing      string   `json:"documentProcessing"`
		RerankerModel           string   `json:"rerankerModel"`
		MatchingThreshold       *float64 `json:"matchingThreshold"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	req := &toolspb.CreateKnowledgeBaseRequest{
		WorkspaceId:             chi.URLParam(r, "wsId"),
		Name:                    body.Name,
		EmbeddingModel:          body.EmbeddingModel,
		ChunkSize:               body.ChunkSize,
		ChunkOverlap:            body.ChunkOverlap,
		RequestedDocumentChunks: body.RequestedDocumentChunks,
		DocumentProcessing:      body.DocumentProcessing,
		RerankerModel:           body.RerankerModel,
		MatchingThreshold:       -1,
		UserContext:             h.userCtx(r),
	}
	if body.MatchingThreshold != nil {
		req.MatchingThreshold = *body.MatchingThreshold
	}

	resp, err := h.clients.Tools.CreateKnowledgeBase(r.Context(), req)
	if err != nil {
		log.Printf("tools.create_knowledge_base failed: ws=%s name=%q embedding=%q err=%v",
			chi.URLParam(r, "wsId"), body.Name, body.EmbeddingModel, err)
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusCreated, mapKnowledgeBase(resp))
}

func (h *ToolsHandler) UpdateKnowledgeBase(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name                    *string  `json:"name"`
		EmbeddingModel          *string  `json:"embeddingModel"`
		ChunkSize               *int32   `json:"chunkSize"`
		ChunkOverlap            *int32   `json:"chunkOverlap"`
		RequestedDocumentChunks *int32   `json:"requestedDocumentChunks"`
		DocumentProcessing      *string  `json:"documentProcessing"`
		RerankerModel           *string  `json:"rerankerModel"`
		MatchingThreshold       *float64 `json:"matchingThreshold"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	req := &toolspb.UpdateKnowledgeBaseRequest{
		Id:                chi.URLParam(r, "kbId"),
		ChunkSize:         -1,
		ChunkOverlap:      -1,
		MatchingThreshold: -1,
		UserContext:       h.userCtx(r),
	}
	if body.Name != nil {
		req.Name = *body.Name
	}
	if body.EmbeddingModel != nil {
		req.EmbeddingModel = *body.EmbeddingModel
	}
	if body.ChunkSize != nil {
		req.ChunkSize = *body.ChunkSize
	}
	if body.ChunkOverlap != nil {
		req.ChunkOverlap = *body.ChunkOverlap
	}
	if body.RequestedDocumentChunks != nil {
		req.RequestedDocumentChunks = *body.RequestedDocumentChunks
	}
	if body.DocumentProcessing != nil {
		req.DocumentProcessing = *body.DocumentProcessing
	}
	if body.RerankerModel != nil {
		req.RerankerModel = *body.RerankerModel
	}
	if body.MatchingThreshold != nil {
		req.MatchingThreshold = *body.MatchingThreshold
	}

	resp, err := h.clients.Tools.UpdateKnowledgeBase(r.Context(), req)
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, mapKnowledgeBase(resp))
}

func (h *ToolsHandler) DeleteKnowledgeBase(w http.ResponseWriter, r *http.Request) {
	_, err := h.clients.Tools.DeleteKnowledgeBase(r.Context(), &toolspb.DeleteKnowledgeBaseRequest{
		Id:          chi.URLParam(r, "kbId"),
		UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, nil)
}

func (h *ToolsHandler) ListKnowledgeBaseDocuments(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Tools.ListKnowledgeBaseDocuments(r.Context(), &toolspb.GetKnowledgeBaseRequest{
		Id:          chi.URLParam(r, "kbId"),
		UserContext: h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}

	items := make([]map[string]any, 0, len(resp.Documents))
	for _, doc := range resp.Documents {
		items = append(items, mapKnowledgeBaseDocument(doc))
	}
	writeData(w, http.StatusOK, items)
}

func (h *ToolsHandler) CreateKnowledgeBaseDocument(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeError(w, http.StatusBadRequest, "invalid multipart form data")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "file is required")
		return
	}
	defer file.Close()

	fileName := strings.TrimSpace(header.Filename)
	fileType := strings.TrimPrefix(strings.ToLower(filepath.Ext(fileName)), ".")
	if fileType == "" {
		fileType = "txt"
	}
	filePath, writtenSize, err := saveKnowledgeBaseUpload(file, fileName, chi.URLParam(r, "kbId"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save upload file")
		return
	}
	size := header.Size
	if size <= 0 {
		size = writtenSize
	}

	resp, err := h.clients.Tools.CreateKnowledgeBaseDocument(r.Context(), &toolspb.CreateKnowledgeBaseDocumentRequest{
		KnowledgeBaseId: chi.URLParam(r, "kbId"),
		Name:            fileName,
		Type:            fileType,
		Size:            size,
		FilePath:        filePath,
		UserContext:     h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusCreated, mapKnowledgeBaseDocument(resp))
}

var unsafeUploadName = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

func sanitizeUploadFileName(name string) string {
	base := strings.TrimSpace(filepath.Base(name))
	if base == "" {
		base = "upload.txt"
	}
	clean := unsafeUploadName.ReplaceAllString(base, "_")
	clean = strings.Trim(clean, "._")
	if clean == "" {
		clean = "upload.txt"
	}
	return clean
}

func saveKnowledgeBaseUpload(src io.Reader, originalName string, kbID string) (string, int64, error) {
	rootDir, err := filepath.Abs(filepath.Join("..", "data", "kb-uploads", kbID))
	if err != nil {
		return "", 0, err
	}
	if err := os.MkdirAll(rootDir, 0o755); err != nil {
		return "", 0, err
	}

	safeName := sanitizeUploadFileName(originalName)
	targetName := fmt.Sprintf("%d-%s-%s", time.Now().UnixMilli(), uuid.NewString(), safeName)
	targetPath := filepath.Join(rootDir, targetName)

	dst, err := os.Create(targetPath)
	if err != nil {
		return "", 0, err
	}
	defer dst.Close()

	written, err := io.Copy(dst, src)
	if err != nil {
		return "", 0, err
	}
	return targetPath, written, nil
}

func (h *ToolsHandler) DeleteKnowledgeBaseDocument(w http.ResponseWriter, r *http.Request) {
	_, err := h.clients.Tools.DeleteKnowledgeBaseDocument(r.Context(), &toolspb.DeleteKnowledgeBaseDocumentRequest{
		KnowledgeBaseId: chi.URLParam(r, "kbId"),
		DocumentId:      chi.URLParam(r, "docId"),
		UserContext:     h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeData(w, http.StatusOK, nil)
}

func (h *ToolsHandler) SearchKnowledgeBase(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Query string `json:"query"`
		TopK  int32  `json:"topK"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.TopK < 0 {
		body.TopK = 0
	}

	resp, err := h.clients.Tools.SearchKnowledgeBase(r.Context(), &toolspb.SearchKnowledgeBaseRequest{
		KnowledgeBaseId: chi.URLParam(r, "kbId"),
		Query:           body.Query,
		TopK:            body.TopK,
		UserContext:     h.userCtx(r),
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}

	items := make([]map[string]any, 0, len(resp.Results))
	for _, item := range resp.Results {
		items = append(items, map[string]any{
			"id":           item.Id,
			"documentId":   item.DocumentId,
			"documentName": item.DocumentName,
			"content":      item.Content,
			"score":        item.Score,
			"chunkIndex":   item.ChunkIndex,
		})
	}
	writeData(w, http.StatusOK, items)
}

func mapKnowledgeBase(kb *toolspb.KnowledgeBase) map[string]any {
	out := map[string]any{
		"id":                      kb.Id,
		"workspaceId":             kb.WorkspaceId,
		"name":                    kb.Name,
		"embeddingModel":          kb.EmbeddingModel,
		"documentCount":           kb.DocumentCount,
		"createdAt":               kb.CreatedAt,
		"updatedAt":               kb.UpdatedAt,
		"chunkSize":               kb.ChunkSize,
		"chunkOverlap":            kb.ChunkOverlap,
		"requestedDocumentChunks": kb.RequestedDocumentChunks,
		"documentProcessing":      kb.DocumentProcessing,
		"rerankerModel":           kb.RerankerModel,
	}
	// Proto3 scalar defaults make "unset" and 0 indistinguishable on wire.
	// Keep 0 as "not set" for UI compatibility.
	if kb.MatchingThreshold > 0 {
		out["matchingThreshold"] = kb.MatchingThreshold
	}
	return out
}

func mapKnowledgeBaseDocument(doc *toolspb.KnowledgeBaseDocument) map[string]any {
	return map[string]any{
		"id":          doc.Id,
		"kbId":        doc.KnowledgeBaseId,
		"name":        doc.Name,
		"fileType":    doc.Type,
		"fileSize":    doc.Size,
		"status":      doc.Status,
		"chunkCount":  doc.ChunkCount,
		"uploadedAt":  doc.CreatedAt,
		"processedAt": doc.ProcessedAt,
	}
}
