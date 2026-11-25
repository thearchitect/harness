package lib

// Hello is used from svc, a module of the repository's go.work; lib itself is not in go.work.
func Hello() string {
	return "hello"
}
