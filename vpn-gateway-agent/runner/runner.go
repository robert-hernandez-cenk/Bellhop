// Package runner wraps external command execution behind an interface so
// wireguard/netctl can be unit-tested without actually shelling out to
// wg-quick/iptables -- mirrors this repo's TypeScript side injecting a
// FakeSSHClient instead of mocking a PATH binary.
package runner

import (
	"bytes"
	"os/exec"
)

type Runner interface {
	Run(name string, args ...string) (stdout string, stderr string, err error)
}

type ExecRunner struct{}

func (ExecRunner) Run(name string, args ...string) (string, string, error) {
	cmd := exec.Command(name, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return stdout.String(), stderr.String(), err
}
