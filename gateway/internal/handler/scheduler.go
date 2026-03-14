package handler

import (
	"net/http"

	"go.uber.org/zap"

	sq "github.com/Masterminds/squirrel"
	"github.com/go-chi/chi/v5"
	"github.com/nextai-agent/gateway/internal/logger"
	"github.com/nextai-agent/gateway/internal/model"
	"github.com/nextai-agent/gateway/internal/store"
)

var schedLog = logger.Named("scheduler")

type SchedulerHandler struct {
	db *store.DB
}

func NewSchedulerHandler(db *store.DB) *SchedulerHandler {
	return &SchedulerHandler{db: db}
}

func (h *SchedulerHandler) Mount(r chi.Router) {
	r.Get("/workspaces/{wsId}/scheduler/tasks", h.List)
	r.Post("/workspaces/{wsId}/scheduler/tasks", h.Create)
	r.Patch("/workspaces/{wsId}/scheduler/tasks/{taskId}", h.Update)
	r.Delete("/workspaces/{wsId}/scheduler/tasks/{taskId}", h.Delete)
	r.Get("/workspaces/{wsId}/scheduler/tasks/{taskId}/executions", h.Executions)
	r.Post("/workspaces/{wsId}/scheduler/tasks/{taskId}/run", h.RunNow)
}

var taskCols = []string{
	"id", "workspace_id", "name", "description", "instruction", "cron_expression", "cron_description",
	"schedule_type", "target_agent_id", "target_agent_name", "enabled", "status",
	"last_run_at", "next_run_at", "run_count", "created_at", "updated_at",
}

func (h *SchedulerHandler) List(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	rows, err := h.db.Query(r.Context(),
		store.Select(taskCols...).From("scheduled_tasks").Where("workspace_id = ?", wsID).OrderBy("created_at"))
	if err != nil {
		schedLog.Error("list tasks failed", zap.String("wsId", wsID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取任务列表失败")
		return
	}
	defer rows.Close()

	var tasks []model.ScheduledTask
	for rows.Next() {
		var t model.ScheduledTask
		rows.Scan(&t.ID, &t.WorkspaceID, &t.Name, &t.Description, &t.Instruction,
			&t.CronExpression, &t.CronDescription, &t.ScheduleType,
			&t.TargetAgentID, &t.TargetAgentName, &t.Enabled, &t.Status,
			&t.LastRunAt, &t.NextRunAt, &t.RunCount, &t.CreatedAt, &t.UpdatedAt)
		tasks = append(tasks, t)
	}
	if tasks == nil {
		tasks = []model.ScheduledTask{}
	}
	schedLog.Debug("list tasks", zap.String("wsId", wsID), zap.Int("count", len(tasks)))
	writeData(w, tasks)
}

func (h *SchedulerHandler) Create(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "wsId")
	var body struct {
		Name            string  `json:"name"`
		Description     *string `json:"description"`
		Instruction     string  `json:"instruction"`
		CronExpression  string  `json:"cronExpression"`
		CronDescription string  `json:"cronDescription"`
		ScheduleType    *string `json:"scheduleType"`
		TargetAgentID   *string `json:"targetAgentId"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	if body.Name == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "name is required")
		return
	}

	t := &model.ScheduledTask{}
	err := h.db.QueryRow(r.Context(),
		store.Insert("scheduled_tasks").
			Columns("workspace_id", "name", "description", "instruction", "cron_expression", "cron_description", "schedule_type", "target_agent_id").
			Values(wsID, body.Name, body.Description, body.Instruction, body.CronExpression, body.CronDescription, body.ScheduleType, body.TargetAgentID).
			Suffix("RETURNING "+store.JoinCols(taskCols)),
	).Scan(&t.ID, &t.WorkspaceID, &t.Name, &t.Description, &t.Instruction,
		&t.CronExpression, &t.CronDescription, &t.ScheduleType,
		&t.TargetAgentID, &t.TargetAgentName, &t.Enabled, &t.Status,
		&t.LastRunAt, &t.NextRunAt, &t.RunCount, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		schedLog.Error("create task failed", zap.String("wsId", wsID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "创建任务失败")
		return
	}
	schedLog.Debug("create task", zap.String("taskId", t.ID))
	writeJSON(w, http.StatusCreated, apiResponse{Data: t})
}

func (h *SchedulerHandler) Update(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "taskId")
	var body map[string]interface{}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid request body")
		return
	}
	fieldMap := map[string]string{
		"name": "name", "description": "description", "instruction": "instruction",
		"cronExpression": "cron_expression", "cronDescription": "cron_description",
		"scheduleType": "schedule_type", "targetAgentId": "target_agent_id", "enabled": "enabled",
	}
	dbFields := make(map[string]interface{})
	for jk, dk := range fieldMap {
		if v, ok := body[jk]; ok {
			dbFields[dk] = v
		}
	}
	b := store.SetFields(store.Update("scheduled_tasks"), dbFields).
		Set("updated_at", sq.Expr("NOW()")).Where("id = ?", taskID).
		Suffix("RETURNING " + store.JoinCols(taskCols))

	t := &model.ScheduledTask{}
	err := h.db.QueryRow(r.Context(), b).Scan(&t.ID, &t.WorkspaceID, &t.Name, &t.Description, &t.Instruction,
		&t.CronExpression, &t.CronDescription, &t.ScheduleType,
		&t.TargetAgentID, &t.TargetAgentName, &t.Enabled, &t.Status,
		&t.LastRunAt, &t.NextRunAt, &t.RunCount, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		schedLog.Error("update task failed", zap.String("taskId", taskID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "更新任务失败")
		return
	}
	schedLog.Debug("update task", zap.String("taskId", taskID))
	writeData(w, t)
}

func (h *SchedulerHandler) Delete(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "taskId")
	_ = h.db.Exec(r.Context(), store.Delete("scheduled_tasks").Where("id = ?", taskID))
	schedLog.Debug("delete task", zap.String("taskId", taskID))
	w.WriteHeader(http.StatusNoContent)
}

func (h *SchedulerHandler) Executions(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "taskId")
	rows, err := h.db.Query(r.Context(),
		store.Select("id", "task_id", "task_name", "status", "started_at", "completed_at", "duration_ms", "log_summary").
			From("task_executions").Where("task_id = ?", taskID).OrderBy("started_at DESC").Limit(50))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "获取执行历史失败")
		return
	}
	defer rows.Close()

	var execs []model.TaskExecution
	for rows.Next() {
		var e model.TaskExecution
		rows.Scan(&e.ID, &e.TaskID, &e.TaskName, &e.Status, &e.StartedAt, &e.CompletedAt, &e.DurationMs, &e.LogSummary)
		execs = append(execs, e)
	}
	if execs == nil {
		execs = []model.TaskExecution{}
	}
	schedLog.Debug("list executions", zap.String("taskId", taskID), zap.Int("count", len(execs)))
	writeData(w, execs)
}

func (h *SchedulerHandler) RunNow(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "taskId")
	schedLog.Debug("run now", zap.String("taskId", taskID))
	writeData(w, map[string]interface{}{"message": "任务已触发"})
}
