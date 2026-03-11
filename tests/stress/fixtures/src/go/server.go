// Package main — primary Go fixture.
// Defines structs, interfaces, and exported functions for an HTTP server.
package main

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// ServerConfig holds the configuration for the HTTP server.
type ServerConfig struct {
	Port         int           `json:"port"`
	ReadTimeout  time.Duration `json:"readTimeout"`
	WriteTimeout time.Duration `json:"writeTimeout"`
	MaxConns     int           `json:"maxConns"`
}

// RequestHandler defines the interface for handling HTTP requests.
type RequestHandler interface {
	HandleRequest(w http.ResponseWriter, r *http.Request)
	GetName() string
}

// HealthChecker provides health check capabilities.
type HealthChecker interface {
	IsHealthy() bool
	GetStatus() map[string]interface{}
}

// Server is the main HTTP server implementation.
type Server struct {
	config   ServerConfig
	handlers map[string]RequestHandler
	mu       sync.RWMutex
	started  bool
}

// NewServer creates a new Server with the given configuration.
func NewServer(config ServerConfig) *Server {
	return &Server{
		config:   config,
		handlers: make(map[string]RequestHandler),
	}
}

// RegisterHandler adds a request handler for the given path.
func (s *Server) RegisterHandler(path string, handler RequestHandler) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.handlers[path] = handler
}

// Start begins listening for HTTP requests.
func (s *Server) Start() error {
	s.mu.Lock()
	s.started = true
	s.mu.Unlock()
	return nil
}

// Stop gracefully shuts down the server.
func (s *Server) Stop() error {
	s.mu.Lock()
	s.started = false
	s.mu.Unlock()
	return nil
}

// IsRunning returns whether the server is currently running.
func (s *Server) IsRunning() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.started
}

// JSONResponse writes a JSON response with the given status code.
func JSONResponse(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

// DefaultConfig returns the default server configuration.
func DefaultConfig() ServerConfig {
	return ServerConfig{
		Port:         8080,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		MaxConns:     100,
	}
}
