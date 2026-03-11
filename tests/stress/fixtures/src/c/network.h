/**
 * network.h — primary C fixture (header).
 * Defines structs and function prototypes for a network library.
 */
#ifndef NETWORK_H
#define NETWORK_H

#include <stdint.h>
#include <stddef.h>

#define MAX_CONNECTIONS 256
#define BUFFER_SIZE 4096
#define DEFAULT_PORT 8080

typedef enum {
    CONN_IDLE,
    CONN_CONNECTING,
    CONN_ESTABLISHED,
    CONN_CLOSING,
    CONN_CLOSED
} ConnectionState;

typedef struct {
    char host[256];
    uint16_t port;
    int timeout_ms;
    int max_retries;
} NetworkConfig;

typedef struct {
    int fd;
    ConnectionState state;
    char remote_addr[256];
    uint16_t remote_port;
    uint8_t buffer[BUFFER_SIZE];
    size_t buffer_len;
} Connection;

typedef struct {
    Connection connections[MAX_CONNECTIONS];
    int active_count;
    NetworkConfig config;
} ConnectionPool;

/* Lifecycle functions */
ConnectionPool* pool_create(const NetworkConfig* config);
void pool_destroy(ConnectionPool* pool);

/* Connection management */
Connection* pool_acquire(ConnectionPool* pool);
void pool_release(ConnectionPool* pool, Connection* conn);
int pool_active_count(const ConnectionPool* pool);

/* I/O operations */
int conn_send(Connection* conn, const void* data, size_t len);
int conn_recv(Connection* conn, void* buf, size_t max_len);
void conn_close(Connection* conn);

#endif /* NETWORK_H */
