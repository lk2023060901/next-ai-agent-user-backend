package handler

import (
	"testing"

	"github.com/nextai-agent/gateway/internal/model"
)

func TestHydrateIssueRunEvent(t *testing.T) {
	run := &model.IssueRun{
		Status:     "running",
		ResultText: optionalString("Final answer posted."),
	}
	event := model.IssueRunEvent{
		EventType: "tool.called",
		Payload: map[string]interface{}{
			"toolName": "issue.fetchContext",
		},
	}

	hydrateIssueRunEvent(&event, run)

	if event.Title == nil || *event.Title != "Tool called" {
		t.Fatalf("expected event title to be hydrated, got %#v", event.Title)
	}
	if event.Summary == nil || *event.Summary != "Calling issue.fetchContext" {
		t.Fatalf("expected event summary to be hydrated, got %#v", event.Summary)
	}
}

func TestApprovalStatusValue(t *testing.T) {
	cases := []string{"pending", "approved", "rejected", "cancelled"}
	for _, value := range cases {
		status, err := approvalStatusValue(value)
		if err != nil {
			t.Fatalf("expected %s to be accepted: %v", value, err)
		}
		if status != value {
			t.Fatalf("expected %s, got %s", value, status)
		}
	}

	if _, err := approvalStatusValue("invalid"); err == nil {
		t.Fatal("expected invalid approval status to fail")
	}
}
