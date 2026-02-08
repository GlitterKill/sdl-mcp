<?php
namespace App\Services;

class UserService {
    private $userRepository;
    private $logger;

    public function __construct($repository, $logger) {
        $this->userRepository = $repository;
        $this->logger = $logger;
    }

    // Simple function call
    public function createUser(string $name): User {
        return $this->userRepository->create($name);
    }

    // Method call with receiver
    public function updateUser(int $id, array $data): bool {
        return $this->userRepository->update($id, $data);
    }

    // Static method call
    public function validateUser(array $data): bool {
        return Validator::validate($data);
    }

    // Dynamic function call
    public function executeCallback(callable $callback, array $args) {
        $callback($args);
    }

    // Dynamic method call
    public function callDynamicMethod(object $obj, string $method, array $args) {
        $obj->$method(...$args);
    }

    // Chained method calls
    public function getUserById(int $id): ?User {
        return $this->userRepository
            ->with('roles')
            ->find($id);
    }

    // Self method call
    private function logAction(string $action): void {
        $this->logger->log($action);
    }

    // Static method with namespace
    public function getConfig(): array {
        return \App\Config::get('database');
    }

    // Nested calls
    public function processUser(int $id): array {
        $user = $this->getUserById($id);
        return $this->transformUser($user);
    }

    // Multiple dynamic calls
    public function batchProcess(array $users, string $method) {
        foreach ($users as $user) {
            $user->$method();
        }
    }
}

// Free functions
function sendEmail(string $to, string $subject, string $body): bool {
    return mail($to, $subject, $body);
}

function logMessage(string $message): void {
    error_log($message);
}

// Dynamic function call pattern
function executeCommand(string $command, array $args) {
    $fn = 'run_' . $command;
    $fn($args);
}

class Database {
    public static function connect(): self {
        return new self();
    }

    public function query(string $sql): array {
        return [];
    }
}

class Cache {
    public static function get(string $key): mixed {
        return null;
    }

    public static function set(string $key, mixed $value): void {
    }
}

// Static class usage
class UserController {
    public function index(): array {
        $data = Cache::get('users');
        if (!$data) {
            $data = Database::connect()->query('SELECT * FROM users');
            Cache::set('users', $data);
        }
        return $data;
    }
}

// Variable holding function name
class Dispatcher {
    public function dispatch(string $action): void {
        $handler = $this->getHandler($action);
        $handler();
    }

    private function getHandler(string $action): callable {
        return [$this, 'handle' . ucfirst($action)];
    }

    private function handleCreate(): void {
        echo "Creating...";
    }

    private function handleUpdate(): void {
        echo "Updating...";
    }
}
