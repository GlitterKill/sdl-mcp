<?php
/**
 * Router — primary PHP fixture.
 * Defines router class, interface, and helper functions.
 */

namespace StressFixture;

interface RouteHandler
{
    public function handle(array $request): array;
    public function getMethod(): string;
}

interface Middleware
{
    public function process(array $request, callable $next): array;
}

class Route
{
    public string $method;
    public string $path;
    public RouteHandler $handler;

    public function __construct(string $method, string $path, RouteHandler $handler)
    {
        $this->method = $method;
        $this->path = $path;
        $this->handler = $handler;
    }

    public function matches(string $method, string $path): bool
    {
        return $this->method === $method && $this->path === $path;
    }
}

class Router
{
    /** @var Route[] */
    private array $routes = [];
    /** @var Middleware[] */
    private array $middlewares = [];

    public function addRoute(string $method, string $path, RouteHandler $handler): void
    {
        $this->routes[] = new Route($method, $path, $handler);
    }

    public function addMiddleware(Middleware $middleware): void
    {
        $this->middlewares[] = $middleware;
    }

    public function dispatch(string $method, string $path, array $request = []): array
    {
        foreach ($this->routes as $route) {
            if ($route->matches($method, $path)) {
                $handler = function (array $req) use ($route): array {
                    return $route->handler->handle($req);
                };

                $pipeline = $handler;
                foreach (array_reverse($this->middlewares) as $mw) {
                    $next = $pipeline;
                    $pipeline = function (array $req) use ($mw, $next): array {
                        return $mw->process($req, $next);
                    };
                }
                return $pipeline($request);
            }
        }
        return ['status' => 404, 'body' => 'Not found'];
    }

    public function getRouteCount(): int
    {
        return count($this->routes);
    }
}

function jsonResponse(int $status, $data): array
{
    return ['status' => $status, 'body' => json_encode($data), 'content_type' => 'application/json'];
}
