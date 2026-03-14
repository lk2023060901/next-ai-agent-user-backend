package handler

import (
	"encoding/json"

	"github.com/nextai-agent/gateway/internal/model"
)

func hydrateIssueRunEvents(events []model.IssueRunEvent, run *model.IssueRun) []model.IssueRunEvent {
	for i := range events {
		hydrateIssueRunEvent(&events[i], run)
	}
	return events
}

func hydrateIssueRunEvent(event *model.IssueRunEvent, run *model.IssueRun) {
	if event == nil {
		return
	}
	rawPayload, _ := json.Marshal(event.Payload)
	status := ""
	var errorMessage *string
	var resultText *string
	if run != nil {
		status = run.Status
		errorMessage = run.ErrorMessage
		resultText = run.ResultText
	}
	event.Title = monitoringEventTitle(event.EventType)
	event.Summary = monitoringEventSummary(monitoringStringPtr(event.EventType), rawPayload, status, errorMessage, resultText)
}
