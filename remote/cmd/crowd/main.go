package main

import (
	"log"
	"os"

	"github.com/crow-harness/remote/internal/server"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "hook-notify" {
		_ = server.RunHookNotify(os.Args[2:])
		return
	}
	if err := server.Run(); err != nil {
		log.Fatal(err)
	}
}
