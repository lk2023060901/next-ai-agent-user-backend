package handler

import (
	"testing"
	"time"

	"github.com/nextai-agent/gateway/internal/model"
)

func TestMonitoringEventSummaryAndCurrentStep(t *testing.T) {
	eventType := "tool.called"
	rawPayload := []byte(`{"toolName":"issue.fetchContext"}`)
	title := monitoringEventTitle(eventType)
	if title == nil || *title != "Tool called" {
		t.Fatalf("expected tool title, got %#v", title)
	}
	summary := monitoringEventSummary(&eventType, rawPayload, "running", nil, nil)
	if summary == nil || *summary != "Calling issue.fetchContext" {
		t.Fatalf("expected tool summary, got %#v", summary)
	}

	currentStep := monitoringCurrentStep("running", &eventType, summary)
	if currentStep == nil || *currentStep != "Calling issue.fetchContext" {
		t.Fatalf("expected current step from summary, got %#v", currentStep)
	}

	completedType := "run.completed"
	resultText := optionalString("Posted final issue update.")
	completedSummary := monitoringEventSummary(&completedType, nil, "completed", nil, resultText)
	if completedSummary == nil || *completedSummary != "Posted final issue update." {
		t.Fatalf("expected completed summary from result text, got %#v", completedSummary)
	}

	if step := monitoringCurrentStep("completed", &completedType, completedSummary); step != nil {
		t.Fatalf("expected no current step for completed run, got %#v", step)
	}
}

func TestIssueRunTimelineHelpers(t *testing.T) {
	startedAt := time.Date(2026, 3, 13, 10, 0, 0, 0, time.UTC)
	finishedAt := time.Date(2026, 3, 13, 10, 5, 0, 0, time.UTC)
	run := model.IssueRun{
		ID:               "run-1",
		AgentID:          "agent-1",
		ExecutionMode:    "local",
		ExecutorName:     optionalString("LiuKai MacBook"),
		ExecutorPlatform: optionalString("macOS"),
		Status:           "completed",
		ResultText:       optionalString("Investigated the issue and posted a status update."),
		StartedAt:        &startedAt,
		FinishedAt:       &finishedAt,
		CreatedAt:        startedAt.Add(-time.Minute),
	}

	if title := issueRunTimelineTitle(run); title != "Run completed" {
		t.Fatalf("unexpected timeline title: %s", title)
	}

	description := issueRunTimelineDescription(run, "Backend Fixer")
	if description != "Investigated the issue and posted a status update." {
		t.Fatalf("unexpected timeline description: %s", description)
	}

	if at := issueRunTimelineAt(run); !at.Equal(finishedAt) {
		t.Fatalf("expected finishedAt to drive timeline time, got %s", at)
	}

	running := model.IssueRun{
		AgentID:          "agent-2",
		ExecutionMode:    "cloud",
		ExecutorName:     optionalString("Default Cloud Runner"),
		ExecutorPlatform: optionalString("linux"),
		Status:           "running",
		TriggerDetail:    optionalString("Investigating the latest auth timeout."),
		CreatedAt:        startedAt,
	}
	description = issueRunTimelineDescription(running, "Ops Agent")
	expected := "Ops Agent started working in cloud on Default Cloud Runner (linux). Investigating the latest auth timeout."
	if description != expected {
		t.Fatalf("unexpected running description: %s", description)
	}
}
