package service

import "github.com/zhming0/dsh-yawn/runner/ptc"

// PtcHandler serves this sandbox's PTC runs over the same tunnel as the rest of
// the runner's RPCs.
//
// The feature itself lives in runner/ptc; this and the registration in main are
// the whole of its footprint in this package.
func (s *Service) PtcHandler() *ptc.Handler {
	return ptc.New(ptc.Options{Environment: s.environment})
}
