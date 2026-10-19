package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"connectrpc.com/connect"
	v1 "github.com/zhming0/dsh-yawn/runner/gen/dsh/yawn/v1"
	"github.com/zhming0/dsh-yawn/runner/gen/dsh/yawn/v1/yawnv1connect"
)

func TestExecEmptyStdinMeansIgnore(t *testing.T) {
	client := newExecClient(t)

	exitCode := func(stdin []byte) int {
		stream, err := client.Exec(context.Background(), connect.NewRequest(&v1.ExecRequest{
			Argv:  []string{"/bin/bash", "-c", "test -p /dev/stdin"},
			Cwd:   t.TempDir(),
			Stdin: stdin,
		}))
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = stream.Close() }()
		for stream.Receive() {
			if exited := stream.Msg().GetExited(); exited != nil {
				return int(exited.GetExitCode())
			}
		}
		t.Fatal("exec stream ended without an exit status")
		return -1
	}

	// Delivered bytes arrive over a pipe.
	if code := exitCode([]byte("data")); code != 0 {
		t.Fatalf("non-empty stdin: child saw a non-pipe stdin, exit = %d", code)
	}
	// Empty stdin is ignore: the child reads the null device, not an empty
	// pipe, so workdir-fallback tools like ripgrep behave.
	if code := exitCode(nil); code != 1 {
		t.Fatalf("empty stdin: child saw a pipe stdin, exit = %d", code)
	}
}

func TestExecKeepsOutputWrittenAfterTheCommandExits(t *testing.T) {
	client := newExecClient(t)

	// The command exits at once but leaves a process behind that writes to the
	// stdout it inherited a moment later. Waiting for the command must not
	// close that pipe underneath the output.
	stream, err := client.Exec(context.Background(), connect.NewRequest(&v1.ExecRequest{
		Argv: []string{"/bin/sh", "-c", "sh -c 'sleep 0.1; printf late' & exit 0"},
		Cwd:  t.TempDir(),
	}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stream.Close() }()
	var stdout strings.Builder
	exited := false
	for stream.Receive() {
		if chunk := stream.Msg().GetStdout(); chunk != nil {
			stdout.Write(chunk)
		}
		if stream.Msg().GetExited() != nil {
			exited = true
		}
	}
	if err := stream.Err(); err != nil {
		t.Fatal(err)
	}
	if !exited {
		t.Fatal("exec stream ended without an exit status")
	}
	if got := stdout.String(); got != "late" {
		t.Fatalf("stdout = %q, want %q", got, "late")
	}
}

func TestExecKeepsFastOutput(t *testing.T) {
	client := newExecClient(t)
	directory := t.TempDir()
	small := filepath.Join(directory, "sentinel")
	if err := os.WriteFile(small, []byte("media"), 0644); err != nil {
		t.Fatal(err)
	}

	// A command that prints a few bytes and exits immediately leaves its
	// output in the pipe. Losing that read looks like a successful command
	// with no output, which is how the Docker smoke test read an empty
	// artifacts sentinel.
	for attempt := 0; attempt < 500; attempt++ {
		if got := execOutput(t, client, directory, []string{"cat", small}); got != "media" {
			t.Fatalf("attempt %d: stdout = %q, want %q", attempt, got, "media")
		}
	}

	// Output that outruns the reader is the same race with a longer tail: the
	// pipe holds 64KiB, so a fast large write can exit with that much unread.
	large := strings.Repeat("abcdefghij", 20000)
	big := filepath.Join(directory, "big")
	if err := os.WriteFile(big, []byte(large), 0644); err != nil {
		t.Fatal(err)
	}
	if got := execOutput(t, client, directory, []string{"cat", big}); got != large {
		t.Fatalf("large output read %d bytes, want %d", len(got), len(large))
	}
}

// execOutput runs one command to completion and returns the stdout it saw.
func execOutput(t *testing.T, client yawnv1connect.RunnerServiceClient, cwd string, argv []string) string {
	t.Helper()
	stream, err := client.Exec(context.Background(), connect.NewRequest(&v1.ExecRequest{
		Argv: argv,
		Cwd:  cwd,
	}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stream.Close() }()
	var stdout strings.Builder
	for stream.Receive() {
		if chunk := stream.Msg().GetStdout(); chunk != nil {
			stdout.Write(chunk)
		}
	}
	if err := stream.Err(); err != nil {
		t.Fatal(err)
	}
	return stdout.String()
}

func newExecClient(t *testing.T) yawnv1connect.RunnerServiceClient {
	t.Helper()
	s := New("box")
	mux := http.NewServeMux()
	mux.Handle(yawnv1connect.NewRunnerServiceHandler(s))
	server := httptest.NewUnstartedServer(mux)
	server.EnableHTTP2 = true
	server.StartTLS()
	t.Cleanup(server.Close)
	return yawnv1connect.NewRunnerServiceClient(server.Client(), server.URL)
}

func TestWriteGuardsAndEditAmbiguity(t *testing.T) {
	s := New("box")
	p := filepath.Join(t.TempDir(), "file")
	w, err := s.WriteFile(context.Background(), connect.NewRequest(&v1.WriteFileRequest{Path: p, Content: []byte("one one"), Guard: &v1.WriteFileRequest_CreateIfAbsent{CreateIfAbsent: true}}))
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.WriteFile(context.Background(), connect.NewRequest(&v1.WriteFileRequest{Path: p, Content: []byte("bad"), Guard: &v1.WriteFileRequest_CreateIfAbsent{CreateIfAbsent: true}}))
	if connect.CodeOf(err) != connect.CodeAlreadyExists {
		t.Fatalf("code = %v", connect.CodeOf(err))
	}
	_, err = s.EditFile(context.Background(), connect.NewRequest(&v1.EditFileRequest{Path: p, OldString: "one", NewString: "two", ExpectedVersion: w.Msg.Version}))
	if connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("ambiguous code = %v", connect.CodeOf(err))
	}
	_, err = s.EditFile(context.Background(), connect.NewRequest(&v1.EditFileRequest{Path: p, OldString: "", NewString: "two"}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("empty edit code = %v", connect.CodeOf(err))
	}
	e, err := s.EditFile(context.Background(), connect.NewRequest(&v1.EditFileRequest{Path: p, OldString: "one", NewString: "two", ReplaceAll: true, ExpectedVersion: w.Msg.Version}))
	if err != nil {
		t.Fatal(err)
	}
	if string(e.Msg.After) != "two two" {
		t.Fatalf("after = %q", e.Msg.After)
	}
	_, err = s.WriteFile(context.Background(), connect.NewRequest(&v1.WriteFileRequest{Path: p, Content: []byte("bad"), Guard: &v1.WriteFileRequest_ExpectedVersion{ExpectedVersion: w.Msg.Version}}))
	if connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("stale code = %v", connect.CodeOf(err))
	}
}

func TestReadFileRangeWindows(t *testing.T) {
	s := New("box")
	p := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(p, []byte("0123456789"), 0644); err != nil {
		t.Fatal(err)
	}
	read := func(offset, length int64) string {
		r, err := s.ReadFileRange(context.Background(), connect.NewRequest(&v1.ReadFileRangeRequest{Path: p, Offset: offset, Length: length}))
		if err != nil {
			t.Fatal(err)
		}
		return string(r.Msg.Content)
	}
	cases := []struct {
		offset, length int64
		want           string
	}{
		{0, 4, "0123"},
		{3, 4, "3456"},
		{7, 10, "789"}, // window crosses the end: shorter, not an error
		{10, 4, ""},    // offset at the end
		{12, 4, ""},    // offset past the end
		{2, 0, ""},
	}
	for _, c := range cases {
		if got := read(c.offset, c.length); got != c.want {
			t.Errorf("range(%d, %d) = %q, want %q", c.offset, c.length, got, c.want)
		}
	}
	_, err := s.ReadFileRange(context.Background(), connect.NewRequest(&v1.ReadFileRangeRequest{Path: p, Offset: -1, Length: 4}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("negative offset code = %v", connect.CodeOf(err))
	}
	_, err = s.ReadFileRange(context.Background(), connect.NewRequest(&v1.ReadFileRangeRequest{Path: p + ".missing", Offset: 0, Length: 4}))
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("missing file code = %v", connect.CodeOf(err))
	}
}

func TestSecretsReplaceAndSafeEnvironment(t *testing.T) {
	t.Setenv("PROVIDER_PRIVATE_TOKEN", "must-not-leak")
	s := New("box")
	_, _ = s.SetSecrets(context.Background(), connect.NewRequest(&v1.SetSecretsRequest{Secrets: map[string]string{"FIRST": "1"}}))
	_, _ = s.SetSecrets(context.Background(), connect.NewRequest(&v1.SetSecretsRequest{Secrets: map[string]string{"SECOND": "2"}}))
	env := s.environment(map[string]string{"SECOND": "override"})
	if envValue(env, "FIRST") != "" || envValue(env, "SECOND") != "override" || envValue(env, "PROVIDER_PRIVATE_TOKEN") != "" {
		t.Fatalf("unsafe environment: %v", env)
	}
}

func TestEnvironmentForwardsDockerHost(t *testing.T) {
	t.Setenv("DOCKER_HOST", "unix:///run/user/1000/docker.sock")
	t.Setenv("DOCKER_TLS_VERIFY", "1")
	env := New("box").environment(nil)
	if envValue(env, "DOCKER_HOST") != "unix:///run/user/1000/docker.sock" {
		t.Fatalf("DOCKER_HOST not forwarded: %v", env)
	}
	if envValue(env, "DOCKER_TLS_VERIFY") != "" {
		t.Fatalf("only DOCKER_HOST is on the allow-list: %v", env)
	}
}

func TestEnvironmentForwardsNpmPrefix(t *testing.T) {
	t.Setenv("NPM_CONFIG_PREFIX", "/workspace/home/.local")
	env := New("box").environment(nil)
	if envValue(env, "NPM_CONFIG_PREFIX") != "/workspace/home/.local" {
		t.Fatalf("NPM_CONFIG_PREFIX not forwarded: %v", env)
	}
}

func TestEnvironmentEnablesNodeProxyWithSandboxProxy(t *testing.T) {
	for _, name := range []string{"HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NODE_USE_ENV_PROXY"} {
		t.Setenv(name, "")
	}
	t.Setenv("HTTPS_PROXY", "http://proxy.example:3128")
	env := New("box").environment(nil)
	if got := envValue(env, "NODE_USE_ENV_PROXY"); got != "1" {
		t.Fatalf("NODE_USE_ENV_PROXY = %q, want 1", got)
	}
}

func TestEnvironmentRespectsExplicitNodeProxy(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://proxy.example:3128")
	t.Setenv("NODE_USE_ENV_PROXY", "0")
	env := New("box").environment(nil)
	if got := envValue(env, "NODE_USE_ENV_PROXY"); got != "0" {
		t.Fatalf("NODE_USE_ENV_PROXY = %q, want the explicit 0", got)
	}
}

func TestEnvironmentLeavesNodeProxyUnsetWithoutProxy(t *testing.T) {
	for _, name := range []string{"HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NODE_USE_ENV_PROXY"} {
		t.Setenv(name, "")
	}
	env := New("box").environment(nil)
	if got := envValue(env, "NODE_USE_ENV_PROXY"); got != "" {
		t.Fatalf("NODE_USE_ENV_PROXY = %q, want unset", got)
	}
}

func TestResolveMissingLeafThroughSymlink(t *testing.T) {
	d := t.TempDir()
	real := filepath.Join(d, "real")
	_ = os.Mkdir(real, 0755)
	link := filepath.Join(d, "link")
	_ = os.Symlink(real, link)
	display, canonical, err := resolve(filepath.Join(link, "missing"), "")
	if err != nil {
		t.Fatal(err)
	}
	if display != filepath.Join(link, "missing") || canonical != filepath.Join(real, "missing") {
		t.Fatalf("got %q %q", display, canonical)
	}
}

// newSetupService returns a service whose machine state and workspace volume
// are temporary, so a setup test never touches /var/lib/dsh-yawn or /workspace.
func newSetupService(t *testing.T) *Service {
	t.Helper()
	service := New("box")
	service.stateDir = t.TempDir()
	service.volumeRoot = t.TempDir()
	return service
}

// newSetupWorkspace returns a workspace that already holds the checkout, as a
// workspace volume has after a wake, plus a `.agents/setup` hook that records
// every run. The returned path counts the runs.
func newSetupWorkspace(t *testing.T) (string, string) {
	t.Helper()
	workspace := t.TempDir()
	hook := filepath.Join(workspace, ".agents", "setup")
	if err := os.MkdirAll(filepath.Dir(hook), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(hook, []byte("#!/bin/sh\nprintf 'x' >> .setup-count\n"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(workspace, ".git"), 0755); err != nil {
		t.Fatal(err)
	}
	return workspace, filepath.Join(workspace, ".setup-count")
}

// repositorySetup is the request a repository session sends. The checkout is
// already there, so the URL is never cloned; it only says the workspace holds
// a repository, whose `.agents/setup` hook then runs.
func repositorySetup(workspace string) *connect.Request[v1.SetupRequest] {
	return connect.NewRequest(&v1.SetupRequest{
		RepositoryUrl: "https://example.invalid/repository.git",
		Workspace:     workspace,
	})
}

// setupRuns counts the runs the test hook recorded.
func setupRuns(t *testing.T, countFile string) int {
	t.Helper()
	content, err := os.ReadFile(countFile)
	if os.IsNotExist(err) {
		return 0
	}
	if err != nil {
		t.Fatal(err)
	}
	return len(content)
}

func TestSetupRunsOnANewMachine(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	workspace, countFile := newSetupWorkspace(t)
	service := newSetupService(t)

	response, err := service.Setup(context.Background(), repositorySetup(workspace))
	if err != nil {
		t.Fatal(err)
	}
	if !response.Msg.Ran {
		t.Fatal("setup did not run on a new machine")
	}
	if _, err := os.Stat(service.markerPath()); err != nil {
		t.Fatalf("setup marker was not written: %v", err)
	}
	if _, err := os.Stat(filepath.Join(service.aptCacheDir(), "partial")); err != nil {
		t.Fatalf("apt cache directory was not created: %v", err)
	}
	if runs := setupRuns(t, countFile); runs != 1 {
		t.Fatalf("setup ran %d times on a new machine, want 1", runs)
	}
}

func TestSetupSkipsSetupOnTheSameMachine(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	workspace, countFile := newSetupWorkspace(t)
	service := newSetupService(t)

	if _, err := service.Setup(context.Background(), repositorySetup(workspace)); err != nil {
		t.Fatal(err)
	}
	second, err := service.Setup(context.Background(), repositorySetup(workspace))
	if err != nil {
		t.Fatal(err)
	}
	if second.Msg.Ran {
		t.Fatal("setup reported a run on a machine that already ran it")
	}
	if runs := setupRuns(t, countFile); runs != 1 {
		t.Fatalf("setup ran %d times on one machine, want 1", runs)
	}
}

func TestSetupIgnoresTheOldGitMarker(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	workspace, countFile := newSetupWorkspace(t)
	legacyMarker := filepath.Join(workspace, ".git", ".agents-setup-done")
	if err := os.WriteFile(legacyMarker, []byte("complete\n"), 0644); err != nil {
		t.Fatal(err)
	}
	service := newSetupService(t)

	response, err := service.Setup(context.Background(), repositorySetup(workspace))
	if err != nil {
		t.Fatal(err)
	}
	if !response.Msg.Ran {
		t.Fatal("the old .git marker suppressed setup on a new machine")
	}
	if runs := setupRuns(t, countFile); runs != 1 {
		t.Fatalf("setup ran %d times, want 1", runs)
	}
	if _, err := os.Stat(legacyMarker); !os.IsNotExist(err) {
		t.Fatalf("old .git marker was not removed: %v", err)
	}
}

func TestSetupNeverRunsAResumeHook(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	workspace, _ := newSetupWorkspace(t)
	if err := os.WriteFile(
		filepath.Join(workspace, ".agents", "resume"),
		[]byte("#!/bin/sh\nprintf resumed > .resumed\n"),
		0755,
	); err != nil {
		t.Fatal(err)
	}
	service := newSetupService(t)

	for range 2 {
		if _, err := service.Setup(context.Background(), repositorySetup(workspace)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(filepath.Join(workspace, ".resumed")); !os.IsNotExist(err) {
		t.Fatalf("a .agents/resume hook ran: %v", err)
	}
}

func TestFailedSetupIsNotRemembered(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	workspace := t.TempDir()
	if err := os.Mkdir(filepath.Join(workspace, ".git"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(workspace, ".agents"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(workspace, ".agents", "setup"),
		[]byte("#!/bin/sh\nprintf 'x' >> .setup-count\nexit 1\n"),
		0755,
	); err != nil {
		t.Fatal(err)
	}
	service := newSetupService(t)

	if _, err := service.Setup(context.Background(), repositorySetup(workspace)); err == nil {
		t.Fatal("a failing setup returned no error")
	}
	if _, err := os.Stat(service.markerPath()); !os.IsNotExist(err) {
		t.Fatalf("a failed setup wrote the marker: %v", err)
	}
	// The next start on the same machine tries again.
	if _, err := service.Setup(context.Background(), repositorySetup(workspace)); err == nil {
		t.Fatal("a second setup returned no error")
	}
	if runs := setupRuns(t, filepath.Join(workspace, ".setup-count")); runs != 2 {
		t.Fatalf("failed setup ran %d times, want 2", runs)
	}
}

func TestSetupRestoresGitCredentialHelperOnAMachineThatAlreadyRanSetup(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	service := newSetupService(t)
	if err := os.WriteFile(service.markerPath(), []byte("complete\n"), 0644); err != nil {
		t.Fatal(err)
	}

	response, err := service.Setup(context.Background(), connect.NewRequest(&v1.SetupRequest{Workspace: t.TempDir()}))
	if err != nil {
		t.Fatal(err)
	}
	if response.Msg.Ran {
		t.Fatal("setup ran on a machine that already ran it")
	}
	config, err := os.ReadFile(filepath.Join(home, ".gitconfig"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(config), "dsh-yawn-runner git-credential") {
		t.Fatalf("credential helper was not restored: %s", config)
	}
}

func TestSetupClonesBelowFilesystemRoot(t *testing.T) {
	home := t.TempDir()
	source := t.TempDir()
	filesystemRoot := t.TempDir()
	workspace := filepath.Join(filesystemRoot, "repository")
	t.Setenv("HOME", home)

	service := newSetupService(t)
	commands := [][]string{
		{"git", "init", "--initial-branch=main"},
		{"git", "add", "README.md"},
		{"git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"},
	}
	if err := os.WriteFile(filepath.Join(source, "README.md"), []byte("cloned\n"), 0644); err != nil {
		t.Fatal(err)
	}
	for _, command := range commands {
		if err := service.run(context.Background(), source, command...); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(filesystemRoot, "lost+found"), 0700); err != nil {
		t.Fatal(err)
	}

	response, err := service.Setup(context.Background(), connect.NewRequest(&v1.SetupRequest{
		RepositoryUrl: source,
		Workspace:     workspace,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if !response.Msg.Ran {
		t.Fatal("setup did not run")
	}
	content, err := os.ReadFile(filepath.Join(workspace, "README.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "cloned\n" {
		t.Fatalf("cloned content = %q", content)
	}
	if _, err := os.Stat(filepath.Join(workspace, "lost+found")); !os.IsNotExist(err) {
		t.Fatalf("lost+found entered the repository: %v", err)
	}
}

// A workspace without a repository is never cloned into and runs no setup
// hook: a fresh machine starts it empty, and a rebuilt one keeps what the
// session left there.
func TestSetupWithoutRepositoryKeepsTheWorkspace(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	workspace := filepath.Join(t.TempDir(), "repository")

	service := newSetupService(t)
	response, err := service.Setup(context.Background(), connect.NewRequest(&v1.SetupRequest{Workspace: workspace}))
	if err != nil {
		t.Fatal(err)
	}
	if !response.Msg.Ran {
		t.Fatal("setup did not run")
	}
	entries, err := os.ReadDir(workspace)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("fresh workspace has %d entries, want none", len(entries))
	}

	if err := os.WriteFile(filepath.Join(workspace, "notes.md"), []byte("kept\n"), 0644); err != nil {
		t.Fatal(err)
	}
	// A hook the session happened to write is not a repository's setup.
	hook := filepath.Join(workspace, ".agents", "setup")
	if err := os.MkdirAll(filepath.Dir(hook), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(hook, []byte("#!/bin/sh\nprintf ran > .hook-ran\n"), 0755); err != nil {
		t.Fatal(err)
	}
	rebuilt := newSetupService(t)
	if _, err := rebuilt.Setup(context.Background(), connect.NewRequest(&v1.SetupRequest{Workspace: workspace})); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(workspace, "notes.md")); err != nil {
		t.Fatalf("rebuilt machine lost the session's file: %v", err)
	}
	if _, err := os.Stat(filepath.Join(workspace, ".git")); !os.IsNotExist(err) {
		t.Fatalf("workspace without a repository got a .git: %v", err)
	}
	if _, err := os.Stat(filepath.Join(workspace, ".hook-ran")); !os.IsNotExist(err) {
		t.Fatalf("setup ran a hook in a workspace without a repository: %v", err)
	}
}
