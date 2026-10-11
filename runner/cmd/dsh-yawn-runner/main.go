package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/zhming0/dsh-yawn/runner/credentials"
	"github.com/zhming0/dsh-yawn/runner/gen/dsh/yawn/v1/yawnv1connect"
	"github.com/zhming0/dsh-yawn/runner/service"
	"github.com/zhming0/dsh-yawn/runner/telemetry"
	"github.com/zhming0/dsh-yawn/runner/tunnel"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
func main() {
	socket := getenv("CREDENTIAL_SOCKET", "/run/dsh/credentials.sock")
	if len(os.Args) > 1 && os.Args[1] == "git-credential" {
		action := ""
		if len(os.Args) > 2 {
			action = os.Args[2]
		}
		if err := credentials.Helper(socket, action, os.Stdin, os.Stdout); err != nil {
			log.Fatal(err)
		}
		return
	}
	if err := serve(socket); err != nil {
		log.Fatal(err)
	}
}
func registrationToken() (string, error) {
	if token := os.Getenv("DSH_YAWN_REGISTRATION_TOKEN"); token != "" {
		return token, nil
	}
	if file := os.Getenv("DSH_YAWN_REGISTRATION_TOKEN_FILE"); file != "" {
		raw, err := os.ReadFile(file)
		if err != nil {
			return "", err
		}
		token := strings.TrimSpace(string(raw))
		if token != "" {
			return token, nil
		}
	}
	return "", errors.New("DSH_YAWN_REGISTRATION_TOKEN or DSH_YAWN_REGISTRATION_TOKEN_FILE is required")
}

// ensureHome creates the directory HOME names. The image ships one, but a
// Kubernetes sandbox mounts its workspace volume over /workspace and hides
// that copy, so the runner makes it before any command can need it.
func ensureHome() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	return os.MkdirAll(home, 0o755)
}

func serve(socket string) error {
	if err := ensureHome(); err != nil {
		return fmt.Errorf("create home directory: %w", err)
	}
	sandboxID := os.Getenv("DSH_YAWN_SANDBOX_ID")
	if sandboxID == "" {
		return errors.New("DSH_YAWN_SANDBOX_ID is required")
	}
	controlPlaneURL := os.Getenv("DSH_YAWN_CONTROL_PLANE_URL")
	if controlPlaneURL == "" {
		return errors.New("DSH_YAWN_CONTROL_PLANE_URL is required")
	}
	token, err := registrationToken()
	if err != nil {
		return err
	}
	stopTelemetry, err := telemetry.Start(context.Background())
	if err != nil {
		return err
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := stopTelemetry(ctx); err != nil {
			log.Printf("stopping telemetry: %v", err)
		}
	}()
	runnerService := service.New(sandboxID)
	listener, err := credentials.Serve(socket, runnerService)
	if err != nil {
		return err
	}
	defer func() { _ = listener.Close() }()
	runnerPath, runnerHandler := yawnv1connect.NewRunnerServiceHandler(runnerService)
	terminalPath, terminalHandler := yawnv1connect.NewTerminalServiceHandler(runnerService.TerminalHandler())
	ptcPath, ptcHandler := yawnv1connect.NewPtcServiceHandler(runnerService.PtcHandler())
	mux := http.NewServeMux()
	mux.Handle(runnerPath, runnerHandler)
	mux.Handle(terminalPath, terminalHandler)
	mux.Handle(ptcPath, ptcHandler)
	instrumented := otelhttp.NewHandler(mux, "dsh-yawn-runner")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// RPCs are served only over the host tunnel. This listener exists for the
	// kubelet probes and exposes nothing but liveness.
	health := http.NewServeMux()
	health.HandleFunc("GET /health", func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("content-type", "text/plain; charset=utf-8")
		_, _ = response.Write([]byte("ok\n"))
	})
	healthServer := &http.Server{Addr: getenv("ADDR", ":8080"), Handler: health, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = healthServer.Shutdown(shutdown)
	}()
	go func() {
		if err := healthServer.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			log.Printf("health listener: %v", err)
		}
	}()

	log.Printf("dsh-yawn-runner %s dialing %s", sandboxID, controlPlaneURL)
	return tunnel.Run(ctx, tunnel.Config{
		HostURL:   controlPlaneURL,
		SandboxID: sandboxID,
		Token:     token,
		Handler:   instrumented,
		Logf:      log.Printf,
	})
}
