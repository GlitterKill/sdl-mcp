// Package main — secondary Go fixture (uses types from server.go).
// Defines middleware functions that operate on Server and RequestHandler.
package main

import (
	"log"
	"net/http"
	"time"
)

// LoggingMiddleware wraps a handler with request logging.
type LoggingMiddleware struct {
	next   RequestHandler
	logger *log.Logger
}

// NewLoggingMiddleware creates a new logging middleware.
func NewLoggingMiddleware(next RequestHandler, logger *log.Logger) *LoggingMiddleware {
	return &LoggingMiddleware{next: next, logger: logger}
}

// HandleRequest logs the request and delegates to the next handler.
func (m *LoggingMiddleware) HandleRequest(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	m.next.HandleRequest(w, r)
	m.logger.Printf("method=%s path=%s duration=%v", r.Method, r.URL.Path, time.Since(start))
}

// GetName returns the middleware name.
func (m *LoggingMiddleware) GetName() string {
	return "logging:" + m.next.GetName()
}

// RateLimiter limits the number of requests per second.
type RateLimiter struct {
	maxRPS  int
	current int
	resetAt time.Time
}

// NewRateLimiter creates a new rate limiter with the specified max requests per second.
func NewRateLimiter(maxRPS int) *RateLimiter {
	return &RateLimiter{
		maxRPS:  maxRPS,
		resetAt: time.Now().Add(time.Second),
	}
}

// Allow checks whether a request is allowed under the rate limit.
func (rl *RateLimiter) Allow() bool {
	now := time.Now()
	if now.After(rl.resetAt) {
		rl.current = 0
		rl.resetAt = now.Add(time.Second)
	}
	if rl.current >= rl.maxRPS {
		return false
	}
	rl.current++
	return true
}

// SetupMiddleware configures all middleware on the server.
func SetupMiddleware(server *Server, logger *log.Logger) {
	for path, handler := range server.handlers {
		wrapped := NewLoggingMiddleware(handler, logger)
		server.RegisterHandler(path, wrapped)
	}
}
