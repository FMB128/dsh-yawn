// Package ptc runs one sandbox's PTC programs: a command with a byte channel
// to it, which dsh's PTC runtime speaks its own protocol over.
//
// It stands alone on purpose: the RPC lives in its own proto file, the runner's
// service package only wires this one up, and the control plane keeps its half
// in one folder, so deleting those and their handoffs removes the feature and
// leaves every other command alone.
package ptc

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"connectrpc.com/connect"
	v1 "github.com/zhming0/dsh-yawn/runner/gen/dsh/yawn/v1"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/metric"
)

// Options is what a PTC run needs from the runner that owns it.
type Options struct {
	// Environment resolves the environment for one command: the sandbox base,
	// the secrets the control plane pushed, then the request's own overrides.
	Environment func(extra map[string]string) []string
}

// Handler serves PtcService over the runner's tunnel.
type Handler struct {
	environment func(extra map[string]string) []string
}

// New returns the PTC handler for one sandbox.
func New(options Options) *Handler {
	return &Handler{environment: options.Environment}
}

// The launch marker and descriptor dsh's `openInheritedControlChannel()`
// consumes. Keep them equal to SUBPROCESS_CONTROL_ENV and SUBPROCESS_CONTROL_FD
// in @deepseek-ai/dsh-subprocess/control, and the socket type equal to what its
// `net.Socket` requires: a connected Unix socket, not a half-duplex pipe.
const (
	subprocessControlEnv = "DSH_SUBPROCESS_CONTROL"
	subprocessControlFD  = 7
	// Reads are frame-sized by the program's own protocol, so one chunk carries
	// several frames at once and the RPC framing stays out of the way.
	channelChunkSize = 32 << 10
	// How many events the sender may queue before the reader waits.
	channelEventBuffer = 16
	// How long the channel keeps draining after the command's output pipes
	// close. Frames written just before exit can still be in the socket buffer,
	// while a process the command left behind may hold the child's end open for
	// good, which is what the bound is for.
	channelDrainGrace = 500 * time.Millisecond
	// TERM-to-KILL grace when the call is cancelled.
	termGrace = 2 * time.Second
)

// runDuration is the same instrument the runner's own exec records, so a PTC
// run shows up in the sandbox's command-duration series instead of vanishing
// from it. Keep name, unit, and description equal to the one in service.go.
var runDuration metric.Float64Histogram

func init() {
	runDuration, _ = otel.Meter("dsh-yawn-runner").Float64Histogram(
		"dsh.sandbox.exec.duration",
		metric.WithUnit("s"),
		metric.WithDescription("Time spent running a command in the sandbox"),
	)
}

// invalidArgument reports a request the runner cannot start.
func invalidArgument(err error) error {
	return connect.NewError(connect.CodeInvalidArgument, err)
}

// Run starts one program's process with a channel at fd 7: the first request
// starts the command, later requests are written to that channel, and bytes the
// program writes back arrive as `control` events. Output, exit facts,
// environment, and termination match an ordinary command.
//
// The runner owns the child's end: a caller on the dsh host can ask for the
// channel dsh's subprocess interface describes, but it cannot create a
// descriptor in the sandbox for the child to inherit.
func (h *Handler) Run(ctx context.Context, stream *connect.BidiStream[v1.RunRequest, v1.RunResponse]) error {
	first, err := stream.Receive()
	if err != nil {
		return err
	}
	start := first.GetStart()
	if start == nil {
		return invalidArgument(errors.New("the first message must start a command"))
	}
	if len(start.GetArgv()) == 0 {
		return invalidArgument(errors.New("argv is required"))
	}
	// The provider owns the launch marker, so a request that sets it is refused
	// rather than silently overridden; a pushed secret of the same name is
	// filtered below.
	for name := range start.GetEnv() {
		if strings.EqualFold(name, subprocessControlEnv) {
			return invalidArgument(fmt.Errorf("%s is reserved for the runner's control channel", subprocessControlEnv))
		}
	}

	execCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	startedAt := time.Now()
	defer func() {
		runDuration.Record(ctx, time.Since(startedAt).Seconds())
	}()

	pair, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		return connect.NewError(connect.CodeInternal, err)
	}
	childFile := os.NewFile(uintptr(pair[1]), "dsh-control-child")
	parentFile := os.NewFile(uintptr(pair[0]), "dsh-control-parent")
	control, err := net.FileConn(parentFile)
	_ = parentFile.Close()
	if err != nil {
		_ = childFile.Close()
		return connect.NewError(connect.CodeInternal, err)
	}
	defer func() { _ = control.Close() }()

	cmd := exec.Command(start.GetArgv()[0], start.GetArgv()[1:]...)
	cmd.Dir = start.GetCwd()
	cmd.Env = h.environmentWithChannel(start.GetEnv())
	if len(start.GetStdin()) > 0 {
		cmd.Stdin = bytes.NewReader(start.GetStdin())
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	inheritance, err := channelInheritance(childFile)
	if err != nil {
		_ = childFile.Close()
		return connect.NewError(connect.CodeInternal, err)
	}
	cmd.ExtraFiles = inheritance
	chunks := make(chan execChunk, channelEventBuffer)
	cmd.Stdout = execChunkWriter{chunks: chunks, ctx: execCtx}
	cmd.Stderr = execChunkWriter{chunks: chunks, ctx: execCtx, stderr: true}
	cmd.WaitDelay = channelDrainGrace
	if err := cmd.Start(); err != nil {
		closeFiles(cmd.ExtraFiles)
		return invalidArgument(err)
	}
	// The parent must not hold the child's end open, or the socket never
	// reports the child's exit and the channel reader never sees EOF.
	closeFiles(cmd.ExtraFiles)

	var commandError error
	waitDone := make(chan struct{})
	go func() {
		commandError = cmd.Wait()
		close(chunks)
		close(waitDone)
	}()
	go func() {
		select {
		case <-execCtx.Done():
			terminateProcessGroup(cmd.Process.Pid, waitDone)
		case <-waitDone:
		}
	}()

	if err := stream.Send(&v1.RunResponse{Event: &v1.RunResponse_Started{Started: &v1.RunStarted{Pid: int64(cmd.Process.Pid)}}}); err != nil {
		cancel()
		<-waitDone
		return err
	}

	// Program to client: reads end when the program's end of the socket closes
	// or this handler returns and closes the socket underneath them.
	channelChunks := make(chan []byte, channelEventBuffer)
	go func() {
		defer close(channelChunks)
		buffer := make([]byte, channelChunkSize)
		for {
			count, err := control.Read(buffer)
			if count > 0 {
				chunk := append([]byte(nil), buffer[:count]...)
				select {
				case channelChunks <- chunk:
				case <-execCtx.Done():
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()

	// Client to program: the request half ending means the caller closed its
	// endpoint, which is a half-close of the channel, not a termination. Ending
	// the process stays the caller's explicit cancel.
	protocolError := make(chan error, 1)
	go func() {
		for {
			message, err := stream.Receive()
			if err != nil {
				if unix, ok := control.(*net.UnixConn); ok {
					_ = unix.CloseWrite()
				}
				return
			}
			if message.GetStart() != nil {
				protocolError <- invalidArgument(errors.New("a PTC run starts once"))
				return
			}
			data := message.GetControl()
			if len(data) == 0 {
				continue
			}
			if _, err := control.Write(data); err != nil {
				return
			}
		}
	}()

	var drain <-chan time.Time
	channelOpen := true
	for chunks != nil || channelOpen {
		select {
		case chunk, ok := <-chunks:
			if !ok {
				chunks = nil
				if channelOpen && drain == nil {
					drain = time.After(channelDrainGrace)
				}
				continue
			}
			var sendError error
			if chunk.stderr {
				sendError = stream.Send(&v1.RunResponse{Event: &v1.RunResponse_Stderr{Stderr: chunk.data}})
			} else {
				sendError = stream.Send(&v1.RunResponse{Event: &v1.RunResponse_Stdout{Stdout: chunk.data}})
			}
			if sendError != nil {
				cancel()
				<-waitDone
				return sendError
			}
		case data, ok := <-channelChunks:
			if !ok {
				channelOpen = false
				continue
			}
			if err := stream.Send(&v1.RunResponse{Event: &v1.RunResponse_Control{Control: data}}); err != nil {
				cancel()
				<-waitDone
				return err
			}
		case <-drain:
			// The bound closed the channel, but whatever the reader already handed
			// over still belongs to the caller.
			if err := sendBuffered(stream, channelChunks); err != nil {
				cancel()
				<-waitDone
				return err
			}
			channelOpen = false
		case err := <-protocolError:
			cancel()
			<-waitDone
			return err
		}
	}

	<-waitDone
	if ctx.Err() != nil {
		return ctx.Err()
	}
	exit := &v1.RunExited{}
	if commandError != nil {
		if exitError, ok := commandError.(*exec.ExitError); ok {
			exit.ExitCode = int32(exitError.ExitCode())
			if waitStatus, ok := exitError.Sys().(syscall.WaitStatus); ok && waitStatus.Signaled() {
				exit.Signal = waitStatus.Signal().String()
			}
		} else if !errors.Is(commandError, exec.ErrWaitDelay) {
			// ErrWaitDelay is not a failure of the command itself: it exited,
			// and only a process it left behind held a pipe open past the
			// grace, so the recorded exit status stands.
			return connect.NewError(connect.CodeInternal, commandError)
		}
	}
	return stream.Send(&v1.RunResponse{Event: &v1.RunResponse_Exited{Exited: exit}})
}

// environmentWithChannel is the command environment with the launch marker
// forced, so neither a pushed secret nor the request can replace it.
func (h *Handler) environmentWithChannel(extra map[string]string) []string {
	result := make([]string, 0, len(extra)+1)
	for _, entry := range h.environment(extra) {
		if !strings.HasPrefix(entry, subprocessControlEnv+"=") {
			result = append(result, entry)
		}
	}
	return append(result, subprocessControlEnv+"=pipe")
}

// sendBuffered forwards the control chunks the reader has already handed over,
// and stops at the first gap: the bound is a bound, not a wait.
func sendBuffered(stream *connect.BidiStream[v1.RunRequest, v1.RunResponse], chunks <-chan []byte) error {
	for {
		select {
		case data, ok := <-chunks:
			if !ok {
				return nil
			}
			if err := stream.Send(&v1.RunResponse{Event: &v1.RunResponse_Control{Control: data}}); err != nil {
				return err
			}
		default:
			return nil
		}
	}
}

// channelInheritance lays the child's socket out at fd 7. ExtraFiles entry i
// becomes file descriptor 3+i, so the descriptors below 7 take the null device
// and the reserved number lands where `openInheritedControlChannel()` looks for
// it.
func channelInheritance(child *os.File) ([]*os.File, error) {
	// One entry per descriptor from 3 through subprocessControlFD.
	files := make([]*os.File, subprocessControlFD-3+1)
	for index := range files[:len(files)-1] {
		null, err := os.Open(os.DevNull)
		if err != nil {
			closeFiles(files)
			return nil, err
		}
		files[index] = null
	}
	files[len(files)-1] = child
	return files, nil
}

func closeFiles(files []*os.File) {
	for _, file := range files {
		if file != nil {
			_ = file.Close()
		}
	}
}

// execChunk is one piece of a command's output, tagged with the stream it came
// from.
type execChunk struct {
	data   []byte
	stderr bool
}

// execChunkWriter publishes one of a command's output pipes as events on the
// run stream. os/exec starts a copying goroutine for a writer like this
// one and Wait drains it before closing the pipe, so no output is dropped;
// blocking here applies backpressure, and a canceled context unblocks the
// writer so the command can be reaped.
type execChunkWriter struct {
	chunks chan<- execChunk
	ctx    context.Context
	stderr bool
}

func (w execChunkWriter) Write(data []byte) (int, error) {
	// io.Copy reuses its buffer, so the chunk owns its bytes.
	select {
	case w.chunks <- execChunk{data: append([]byte(nil), data...), stderr: w.stderr}:
		return len(data), nil
	case <-w.ctx.Done():
		return 0, w.ctx.Err()
	}
}

// terminateProcessGroup ends the command's process group, escalating from TERM
// to KILL when the group does not exit inside the grace.
func terminateProcessGroup(pid int, done <-chan struct{}) {
	select {
	case <-done:
		return
	default:
	}
	_ = syscall.Kill(-pid, syscall.SIGTERM)
	timer := time.NewTimer(termGrace)
	defer timer.Stop()
	select {
	case <-done:
		return
	case <-timer.C:
		_ = syscall.Kill(-pid, syscall.SIGKILL)
		<-done
	}
}
