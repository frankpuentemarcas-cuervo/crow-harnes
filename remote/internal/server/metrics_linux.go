//go:build linux

package server

import "syscall"

func rootDiskUsage() (used, total uint64, err error) {
	var stat syscall.Statfs_t
	if err = syscall.Statfs("/", &stat); err != nil {
		return 0, 0, err
	}
	total = stat.Blocks * uint64(stat.Bsize)
	used = (stat.Blocks - stat.Bavail) * uint64(stat.Bsize)
	return used, total, nil
}
