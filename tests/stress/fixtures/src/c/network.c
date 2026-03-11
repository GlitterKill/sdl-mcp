/**
 * network.c — secondary C fixture (implements network.h).
 */
#include "network.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

ConnectionPool* pool_create(const NetworkConfig* config) {
    ConnectionPool* pool = (ConnectionPool*)calloc(1, sizeof(ConnectionPool));
    if (!pool) return NULL;
    pool->config = *config;
    pool->active_count = 0;
    for (int i = 0; i < MAX_CONNECTIONS; i++) {
        pool->connections[i].state = CONN_IDLE;
        pool->connections[i].fd = -1;
    }
    return pool;
}

void pool_destroy(ConnectionPool* pool) {
    if (!pool) return;
    for (int i = 0; i < MAX_CONNECTIONS; i++) {
        if (pool->connections[i].state != CONN_IDLE) {
            conn_close(&pool->connections[i]);
        }
    }
    free(pool);
}

Connection* pool_acquire(ConnectionPool* pool) {
    if (!pool) return NULL;
    for (int i = 0; i < MAX_CONNECTIONS; i++) {
        if (pool->connections[i].state == CONN_IDLE) {
            pool->connections[i].state = CONN_CONNECTING;
            pool->active_count++;
            return &pool->connections[i];
        }
    }
    return NULL;
}

void pool_release(ConnectionPool* pool, Connection* conn) {
    if (!pool || !conn) return;
    conn->state = CONN_IDLE;
    conn->buffer_len = 0;
    memset(conn->buffer, 0, BUFFER_SIZE);
    pool->active_count--;
}

int pool_active_count(const ConnectionPool* pool) {
    return pool ? pool->active_count : 0;
}

int conn_send(Connection* conn, const void* data, size_t len) {
    if (!conn || conn->state != CONN_ESTABLISHED) return -1;
    /* Simulated send */
    return (int)len;
}

int conn_recv(Connection* conn, void* buf, size_t max_len) {
    if (!conn || conn->state != CONN_ESTABLISHED) return -1;
    size_t to_copy = conn->buffer_len < max_len ? conn->buffer_len : max_len;
    memcpy(buf, conn->buffer, to_copy);
    return (int)to_copy;
}

void conn_close(Connection* conn) {
    if (!conn) return;
    conn->state = CONN_CLOSED;
    conn->fd = -1;
    conn->buffer_len = 0;
}
