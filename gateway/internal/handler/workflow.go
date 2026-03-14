package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"go.uber.org/zap"

	"github.com/go-chi/chi/v5"
	"github.com/nextai-agent/gateway/internal/logger"
	"github.com/nextai-agent/gateway/internal/model"
	"github.com/nextai-agent/gateway/internal/store"
	workflowdef "github.com/nextai-agent/gateway/internal/workflow"
)

var wfLog = logger.Named("workflow")

type WorkflowHandler struct {
	workflows *store.WorkflowStore
}

func NewWorkflowHandler(workflows *store.WorkflowStore) *WorkflowHandler {
	return &WorkflowHandler{workflows: workflows}
}

func (h *WorkflowHandler) Mount(r chi.Router) {
	r.Get("/workspaces/{wsId}/workflows", h.List)
	r.Post("/workspaces/{wsId}/workflows", h.Create)
	r.Get("/workflows/{workflowId}", h.Get)
	r.Patch("/workflows/{workflowId}", h.Update)
	r.Delete("/workflows/{workflowId}", h.Delete)
	r.Get("/workflows/{workflowId}/document", h.GetDocument)
	r.Put("/workflows/{workflowId}/document", h.SaveDocument)
	r.Post("/workflows/{workflowId}/validate", h.Validate)
	r.Get("/workflow/node-types", h.NodeTypes)
}

func (h *WorkflowHandler) List(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	workflows, err := h.workflows.List(r.Context(), wsID)
	if err != nil {
		wfLog.Error("list workflows failed", zap.String("wsId", wsID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取工作流列表失败")
		return
	}
	if workflows == nil {
		workflows = []model.Workflow{}
	}
	writeData(w, workflows)
}

func (h *WorkflowHandler) Create(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	var body struct {
		Name        string  `json:"name"`
		Description *string `json:"description"`
		Status      *string `json:"status"`
		Document    *struct {
			Definition workflowdef.Definition `json:"definition"`
			Layout     workflowdef.Layout     `json:"layout"`
		} `json:"document"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	if strings.TrimSpace(body.Name) == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "name is required")
		return
	}

	definition := workflowdef.DefaultDefinition()
	layout := workflowdef.DefaultLayout()
	if body.Document != nil {
		definition = workflowdef.NormalizeDefinition(body.Document.Definition)
		layout = workflowdef.NormalizeLayout(body.Document.Layout)
	}

	nodes, conns := workflowdef.ExtractGraph(definition)
	issues := workflowdef.ValidateGraph(nodes, conns)
	if len(issues) > 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]interface{}{
			"code":    "VALIDATION_FAILED",
			"message": "workflow definition is invalid",
			"details": map[string]interface{}{"issues": issues},
		})
		return
	}

	input := store.CreateWorkflowInput{
		WorkspaceID: wsID,
		Name:        strings.TrimSpace(body.Name),
		Description: body.Description,
		Definition:  definition,
		Layout:      layout,
	}
	if body.Status != nil {
		input.Status = *body.Status
	}

	created, err := h.workflows.Create(r.Context(), input)
	if err != nil {
		switch {
		case errors.Is(err, store.ErrWorkflowNameTaken):
			writeJSON(w, http.StatusConflict, map[string]interface{}{
				"code":    "ALREADY_EXISTS",
				"message": "工作流名称已存在",
			})
		default:
			wfLog.Error("create workflow failed", zap.String("wsId", wsID), zap.Error(err))
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "创建工作流失败")
		}
		return
	}

	writeJSON(w, http.StatusCreated, apiResponse{Data: created})
}

func (h *WorkflowHandler) Get(w http.ResponseWriter, r *http.Request) {
	workflowID := chi.URLParam(r, "workflowId")
	workflow, err := h.workflows.GetByID(r.Context(), workflowID)
	if err != nil {
		wfLog.Error("get workflow failed", zap.String("workflowId", workflowID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取工作流失败")
		return
	}
	if workflow == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "工作流不存在")
		return
	}
	writeData(w, workflow)
}

func (h *WorkflowHandler) Update(w http.ResponseWriter, r *http.Request) {
	workflowID := chi.URLParam(r, "workflowId")
	var raw map[string]json.RawMessage
	if err := decodeBody(r, &raw); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}

	var input store.UpdateWorkflowInput
	if v, ok := raw["name"]; ok {
		var name string
		if err := json.Unmarshal(v, &name); err != nil {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid name")
			return
		}
		trimmed := strings.TrimSpace(name)
		input.Name = &trimmed
	}
	if v, ok := raw["description"]; ok {
		input.DescriptionSet = true
		if string(v) != "null" {
			var description string
			if err := json.Unmarshal(v, &description); err != nil {
				writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid description")
				return
			}
			input.Description = &description
		}
	}
	if v, ok := raw["status"]; ok {
		var status string
		if err := json.Unmarshal(v, &status); err != nil {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid status")
			return
		}
		input.Status = &status
	}
	if v, ok := raw["expectedRevision"]; ok {
		var revision int
		if err := json.Unmarshal(v, &revision); err != nil {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid expectedRevision")
			return
		}
		input.ExpectedRevision = &revision
	}

	updated, err := h.workflows.Update(r.Context(), workflowID, input)
	if err != nil {
		switch e := err.(type) {
		case *store.RevisionConflictError:
			writeJSON(w, http.StatusConflict, map[string]interface{}{
				"code":    "REVISION_CONFLICT",
				"message": "workflow revision mismatch",
				"details": map[string]interface{}{"currentRevision": e.CurrentRevision},
			})
		default:
			switch {
			case errors.Is(err, store.ErrWorkflowNotFound):
				writeError(w, http.StatusNotFound, "NOT_FOUND", "工作流不存在")
			case errors.Is(err, store.ErrWorkflowNameTaken):
				writeJSON(w, http.StatusConflict, map[string]interface{}{
					"code":    "ALREADY_EXISTS",
					"message": "工作流名称已存在",
				})
			default:
				wfLog.Error("update workflow failed", zap.String("workflowId", workflowID), zap.Error(err))
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "更新工作流失败")
			}
		}
		return
	}

	writeData(w, updated)
}

func (h *WorkflowHandler) Delete(w http.ResponseWriter, r *http.Request) {
	workflowID := chi.URLParam(r, "workflowId")
	if err := h.workflows.Delete(r.Context(), workflowID); err != nil {
		switch {
		case errors.Is(err, store.ErrWorkflowNotFound):
			writeError(w, http.StatusNotFound, "NOT_FOUND", "工作流不存在")
		default:
			wfLog.Error("delete workflow failed", zap.String("workflowId", workflowID), zap.Error(err))
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "删除工作流失败")
		}
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *WorkflowHandler) GetDocument(w http.ResponseWriter, r *http.Request) {
	workflowID := chi.URLParam(r, "workflowId")
	var revision *int
	if raw := strings.TrimSpace(r.URL.Query().Get("revision")); raw != "" {
		var parsed int
		if _, err := fmt.Sscanf(raw, "%d", &parsed); err != nil {
			writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid revision")
			return
		}
		revision = &parsed
	}

	doc, err := h.workflows.GetDocument(r.Context(), workflowID, revision)
	if err != nil {
		switch {
		case errors.Is(err, store.ErrWorkflowNotFound):
			writeError(w, http.StatusNotFound, "NOT_FOUND", "工作流不存在")
		default:
			wfLog.Error("get workflow document failed", zap.String("workflowId", workflowID), zap.Error(err))
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取工作流文档失败")
		}
		return
	}
	writeData(w, doc)
}

func (h *WorkflowHandler) SaveDocument(w http.ResponseWriter, r *http.Request) {
	workflowID := chi.URLParam(r, "workflowId")
	var body struct {
		ExpectedRevision int                    `json:"expectedRevision"`
		Definition       workflowdef.Definition `json:"definition"`
		Layout           workflowdef.Layout     `json:"layout"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}

	definition := workflowdef.NormalizeDefinition(body.Definition)
	layout := workflowdef.NormalizeLayout(body.Layout)
	nodes, conns := workflowdef.ExtractGraph(definition)
	issues := workflowdef.ValidateGraph(nodes, conns)
	if len(issues) > 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]interface{}{
			"code":    "VALIDATION_FAILED",
			"message": "workflow definition is invalid",
			"details": map[string]interface{}{"issues": issues},
		})
		return
	}

	doc, err := h.workflows.SaveDocument(r.Context(), workflowID, body.ExpectedRevision, definition, layout)
	if err != nil {
		switch e := err.(type) {
		case *store.RevisionConflictError:
			writeJSON(w, http.StatusConflict, map[string]interface{}{
				"code":    "REVISION_CONFLICT",
				"message": "workflow revision mismatch",
				"details": map[string]interface{}{"currentRevision": e.CurrentRevision},
			})
		default:
			switch {
			case errors.Is(err, store.ErrWorkflowNotFound):
				writeError(w, http.StatusNotFound, "NOT_FOUND", "工作流不存在")
			default:
				wfLog.Error("save workflow document failed", zap.String("workflowId", workflowID), zap.Error(err))
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "保存工作流文档失败")
			}
		}
		return
	}

	writeData(w, doc)
}

func (h *WorkflowHandler) Validate(w http.ResponseWriter, r *http.Request) {
	workflowID := chi.URLParam(r, "workflowId")
	var body struct {
		Definition *workflowdef.Definition `json:"definition"`
	}
	if err := decodeBody(r, &body); err != nil && err != io.EOF {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}

	var definition workflowdef.Definition
	if body.Definition != nil {
		definition = workflowdef.NormalizeDefinition(*body.Definition)
	} else {
		doc, err := h.workflows.GetDocument(r.Context(), workflowID, nil)
		if err != nil {
			switch {
			case errors.Is(err, store.ErrWorkflowNotFound):
				writeError(w, http.StatusNotFound, "NOT_FOUND", "工作流不存在")
			default:
				wfLog.Error("load workflow document for validate failed", zap.String("workflowId", workflowID), zap.Error(err))
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "读取工作流文档失败")
			}
			return
		}
		definition = doc.Definition
	}

	nodes, conns := workflowdef.ExtractGraph(definition)
	issues := workflowdef.ValidateGraph(nodes, conns)
	writeData(w, map[string]interface{}{
		"valid":  len(issues) == 0,
		"issues": issues,
	})
}

func (h *WorkflowHandler) NodeTypes(w http.ResponseWriter, _ *http.Request) {
	writeData(w, workflowdef.All())
}
