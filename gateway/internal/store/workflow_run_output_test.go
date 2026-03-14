package store

import "testing"

func TestNormalizeWorkflowRunOutputText(t *testing.T) {
	output := NormalizeWorkflowRunOutput("run_1", "node_1", "text", "hello")
	if output.Kind != "text" {
		t.Fatalf("expected text kind, got %s", output.Kind)
	}
	if output.Value != "hello" {
		t.Fatalf("expected raw value to be preserved, got %#v", output.Value)
	}
}

func TestNormalizeWorkflowRunOutputMedia(t *testing.T) {
	output := NormalizeWorkflowRunOutput("run_1", "node_1", "audio", map[string]interface{}{
		"type":        "audio",
		"url":         "https://example.com/audio.mp3",
		"mimeType":    "audio/mpeg",
		"storagePath": "outputs/run_1/audio.mp3",
		"fileName":    "audio.mp3",
		"sizeBytes":   float64(1024),
	})

	if output.Kind != "audio" {
		t.Fatalf("expected audio kind, got %s", output.Kind)
	}
	if output.MediaURL == nil || *output.MediaURL != "https://example.com/audio.mp3" {
		t.Fatalf("expected media url, got %#v", output.MediaURL)
	}
	if output.StoragePath == nil || *output.StoragePath != "outputs/run_1/audio.mp3" {
		t.Fatalf("expected storage path, got %#v", output.StoragePath)
	}
	if output.FileName == nil || *output.FileName != "audio.mp3" {
		t.Fatalf("expected file name, got %#v", output.FileName)
	}
	if output.SizeBytes == nil || *output.SizeBytes != 1024 {
		t.Fatalf("expected size bytes, got %#v", output.SizeBytes)
	}
}
