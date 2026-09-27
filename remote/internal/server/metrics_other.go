//go:build !linux

package server

import "errors"

func rootDiskUsage() (used, total uint64, err error) {
	return 0, 0, errors.New("host metrics require Linux")
}
