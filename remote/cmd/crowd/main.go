package main

import (
	"log"

	"github.com/crow-harness/remote/internal/server"
)

func main() {
	if err := server.Run(); err != nil {
		log.Fatal(err)
	}
}
