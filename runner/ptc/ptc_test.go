package ptc

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	v1 "github.com/zhming0/dsh-yawn/runner/gen/dsh/yawn/v1"
	"github.com/zhming0/dsh-yawn/runner/gen/dsh/yawn/v1/yawnv1connect"
)

// newPtcClient serves one handler over a real HTTP/2 connection, the way the
// tunnel does, so the tests exercise the stream contract itself.
func newPtcClient(t *testing.T) yawnv1connect.PtcServiceClient {
	t.Helper()
	s := New(Options{Environment: func(extra map[string]string) []string {
		environment := []string{"PATH=/usr/local/bin:/usr/bin:/bin"}
		for name, value := range extra {
			environment = append(environment, name+"="+value)
		}
		return environment
	}})
	mux := http.NewServeMux()
	mux.Handle(yawnv1connect.NewPtcServiceHandler(s))
	server := httptest.NewUnstartedServer(mux)
	server.EnableHTTP2 = true
	server.StartTLS()
	t.Cleanup(server.Close)
	return yawnv1connect.NewPtcServiceClient(server.Client(), server.URL)
}

// startRun opens one PTC run and sends its start message. The caller receives
// an open stream it can send channel bytes on.
func startRun(t *testing.T, argv []string, env map[string]string) *connect.BidiStreamForClient[v1.RunRequest, v1.RunResponse] {
	t.Helper()
	stream := newPtcClient(t).Run(context.Background())
	if err := stream.Send(&v1.RunRequest{Message: &v1.RunRequest_Start{Start: &v1.RunStart{
		Argv: argv,
		Cwd:  t.TempDir(),
		Env:  env,
	}}}); err != nil {
		t.Fatal(err)
	}
	return stream
}

// runResult is everything one PTC run reported.
type runResult struct {
	control  string
	stdout   string
	stderr   string
	exitCode int32
	exited   bool
}

// collectRun drains one PTC run to its exit status.
func collectRun(t *testing.T, stream *connect.BidiStreamForClient[v1.RunRequest, v1.RunResponse]) runResult {
	t.Helper()
	var result runResult
	for {
		message, err := stream.Receive()
		if errors.Is(err, io.EOF) {
			return result
		}
		if err != nil {
			t.Fatal(err)
		}
		if chunk := message.GetControl(); chunk != nil {
			result.control += string(chunk)
		}
		if chunk := message.GetStdout(); chunk != nil {
			result.stdout += string(chunk)
		}
		if chunk := message.GetStderr(); chunk != nil {
			result.stderr += string(chunk)
		}
		if status := message.GetExited(); status != nil {
			result.exited = true
			result.exitCode = status.GetExitCode()
		}
	}
}

// The channel is a real descriptor the child can read and write, and the
// handler supplies the launch marker dsh's helper consumes. The child here is a
// shell so the test needs nothing from the runner image.
func TestRunCarriesBothDirections(t *testing.T) {
	stream := startRun(t, []string{"/bin/bash", "-c",
		`IFS= read -r line <&7 && printf 'reply:%s' "$line" >&7; printf 'marker:%s' "$DSH_SUBPROCESS_CONTROL"`,
	}, nil)
	if err := stream.Send(&v1.RunRequest{Message: &v1.RunRequest_Control{Control: []byte("ping\n")}}); err != nil {
		t.Fatal(err)
	}

	result := collectRun(t, stream)
	if !result.exited {
		t.Fatal("PTC run stream ended without an exit status")
	}
	if result.exitCode != 0 {
		t.Fatalf("exit code = %d, want 0 (stderr %q)", result.exitCode, result.stderr)
	}
	if result.control != "reply:ping" {
		t.Fatalf("control = %q, want %q (stderr %q)", result.control, "reply:ping", result.stderr)
	}
	if result.stdout != "marker:pipe" {
		t.Fatalf("stdout = %q, want %q (stderr %q)", result.stdout, "marker:pipe", result.stderr)
	}
}

// Ending the request half is a half-close: the child reads end-of-file on fd 7
// while the run keeps reporting its output and exit status.
func TestRunHalfCloseReachesTheChild(t *testing.T) {
	stream := startRun(t, []string{"/bin/bash", "-c",
		`if IFS= read -r line <&7; then printf 'data:%s' "$line"; else printf 'eof'; fi`,
	}, nil)
	if err := stream.CloseRequest(); err != nil {
		t.Fatal(err)
	}

	result := collectRun(t, stream)
	if !result.exited {
		t.Fatal("PTC run stream ended without an exit status")
	}
	if result.exitCode != 0 {
		t.Fatalf("exit code = %d, want 0 (stderr %q)", result.exitCode, result.stderr)
	}
	if result.stdout != "eof" {
		t.Fatalf("stdout = %q, want %q (stderr %q)", result.stdout, "eof", result.stderr)
	}
}

// A process the command left behind can hold the child's fd 7 open for good, so
// the run is bounded rather than waiting for it — and what the command wrote
// before exiting still reaches the caller.
func TestRunDrainsTheChannelAfterTheChildExits(t *testing.T) {
	stream := startRun(t, []string{"/bin/bash", "-c",
		`sh -c 'sleep 30' & printf 'last' >&7; printf done`,
	}, nil)

	started := time.Now()
	result := collectRun(t, stream)
	if !result.exited {
		t.Fatal("PTC run stream ended without an exit status")
	}
	if result.control != "last" {
		t.Fatalf("control = %q, want %q (stderr %q)", result.control, "last", result.stderr)
	}
	if result.stdout != "done" {
		t.Fatalf("stdout = %q, want %q (stderr %q)", result.stdout, "done", result.stderr)
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("the run waited %s for a process it left behind", elapsed)
	}
}

// The descriptor belongs to the runner, so a request that names the marker is
// refused instead of choosing what the child inherits.
func TestRunRefusesTheControlMarker(t *testing.T) {
	stream := startRun(t, []string{"/bin/bash", "-c", "true"}, map[string]string{
		subprocessControlEnv: "pipe",
	})
	var err error
	for err == nil {
		_, err = stream.Receive()
	}
	if code := connect.CodeOf(err); code != connect.CodeInvalidArgument {
		t.Fatalf("code = %v, want %v (%v)", code, connect.CodeInvalidArgument, err)
	}
}

// A pushed secret of the marker's name cannot replace it either: the handler
// builds the child's environment last and forces its own value.
func TestEnvironmentWithChannelForcesTheMarker(t *testing.T) {
	handler := New(Options{Environment: func(map[string]string) []string {
		return []string{
			"PATH=/usr/bin",
			subprocessControlEnv + "=spoofed",
		}
	}})

	environment := handler.environmentWithChannel(nil)
	matches := 0
	for _, entry := range environment {
		if strings.HasPrefix(entry, subprocessControlEnv+"=") {
			matches++
		}
	}
	if matches != 1 {
		t.Fatalf("environment carries %d control markers, want 1: %v", matches, environment)
	}
	if !slices.Contains(environment, subprocessControlEnv+"=pipe") {
		t.Fatalf("environment does not force the marker: %v", environment)
	}
}
