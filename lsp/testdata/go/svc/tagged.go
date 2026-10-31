//go:build integration

package main

import "example.com/lib"

func tagged() string {
	return lib.Hello()
}
