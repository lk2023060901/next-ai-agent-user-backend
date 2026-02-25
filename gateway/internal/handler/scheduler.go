package handler

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/grpcclient"
	"github.com/liukai/next-ai-agent-user-backend/gateway/internal/middleware"
	commonpb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/common"
	schedulerpb "github.com/liukai/next-ai-agent-user-backend/gateway/internal/pb/scheduler"
)

type SchedulerHandler struct {
	clients *grpcclient.Clients
}

func NewSchedulerHandler(clients *grpcclient.Clients) *SchedulerHandler {
	return &SchedulerHandler{clients: clients}
}

func (h *SchedulerHandler) userCtx(r *http.Request) *commonpb.UserContext {
	u, _ := middleware.GetUser(r)
	return &commonpb.UserContext{UserId: u.UserID, Email: u.Email, Name: u.Name}
}

func (h *SchedulerHandler) ListTasks(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Scheduler.ListTasks(r.Context(), &schedulerpb.WorkspaceRequest{
		WorkspaceId: chi.URLParam(r, "wsId"), UserContext: h.userCtx(r),
	})
	if err != nil { writeGRPCError(w, err); return }
	writeData(w, http.StatusOK, resp.Tasks)
}

func (h *SchedulerHandler) CreateTask(w http.ResponseWriter, r *http.Request) {
	var body schedulerpb.CreateTaskRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body"); return
	}
	body.WorkspaceId = chi.URLParam(r, "wsId")
	body.UserContext = h.userCtx(r)
	resp, err := h.clients.Scheduler.CreateTask(r.Context(), &body)
	if err != nil { writeGRPCError(w, err); return }
	writeData(w, http.StatusCreated, resp)
}

func (h *SchedulerHandler) UpdateTask(w http.ResponseWriter, r *http.Request) {
	var body schedulerpb.UpdateTaskRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body"); return
	}
	body.TaskId = chi.URLParam(r, "taskId")
	body.UserContext = h.userCtx(r)
	resp, err := h.clients.Scheduler.UpdateTask(r.Context(), &body)
	if err != nil { writeGRPCError(w, err); return }
	writeData(w, http.StatusOK, resp)
}

func (h *SchedulerHandler) DeleteTask(w http.ResponseWriter, r *http.Request) {
	_, err := h.clients.Scheduler.DeleteTask(r.Context(), &schedulerpb.TaskRequest{
		TaskId: chi.URLParam(r, "taskId"), UserContext: h.userCtx(r),
	})
	if err != nil { writeGRPCError(w, err); return }
	w.WriteHeader(http.StatusNoContent)
}

func (h *SchedulerHandler) RunTask(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Scheduler.RunTask(r.Context(), &schedulerpb.TaskRequest{
		TaskId: chi.URLParam(r, "taskId"), UserContext: h.userCtx(r),
	})
	if err != nil { writeGRPCError(w, err); return }
	writeData(w, http.StatusOK, resp)
}

func (h *SchedulerHandler) ListExecutions(w http.ResponseWriter, r *http.Request) {
	resp, err := h.clients.Scheduler.ListExecutions(r.Context(), &schedulerpb.ListExecutionsRequest{
		TaskId: chi.URLParam(r, "taskId"), UserContext: h.userCtx(r),
	})
	if err != nil { writeGRPCError(w, err); return }
	writeData(w, http.StatusOK, resp.Executions)
}
