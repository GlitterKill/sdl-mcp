<?php
/**
 * Middleware — secondary PHP fixture (uses Router types).
 */

namespace StressFixture;

class AuthMiddleware implements Middleware
{
    private string $apiKey;

    public function __construct(string $apiKey)
    {
        $this->apiKey = $apiKey;
    }

    public function process(array $request, callable $next): array
    {
        $token = $request['headers']['authorization'] ?? '';
        if ($token !== 'Bearer ' . $this->apiKey) {
            return jsonResponse(401, ['error' => 'Unauthorized']);
        }
        return $next($request);
    }
}

class LoggingMiddleware implements Middleware
{
    private array $logs = [];

    public function process(array $request, callable $next): array
    {
        $start = microtime(true);
        $response = $next($request);
        $duration = (microtime(true) - $start) * 1000;

        $this->logs[] = [
            'method' => $request['method'] ?? 'GET',
            'path' => $request['path'] ?? '/',
            'status' => $response['status'] ?? 200,
            'duration_ms' => round($duration, 2),
        ];

        return $response;
    }

    public function getLogs(): array
    {
        return $this->logs;
    }
}

class CorsMiddleware implements Middleware
{
    private array $allowedOrigins;

    public function __construct(array $allowedOrigins = ['*'])
    {
        $this->allowedOrigins = $allowedOrigins;
    }

    public function process(array $request, callable $next): array
    {
        $response = $next($request);
        $response['headers'] = $response['headers'] ?? [];
        $response['headers']['Access-Control-Allow-Origin'] = implode(', ', $this->allowedOrigins);
        $response['headers']['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE';
        return $response;
    }
}
