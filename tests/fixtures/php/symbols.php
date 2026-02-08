<?php
namespace App\Models;

use Illuminate\Database\Eloquent\Model;

interface RepositoryInterface {
    public function find(int $id): ?object;
    public function findAll(): array;
    protected function buildQuery(): object;
}

trait Loggable {
    public function log(string $message): void {
        echo $message;
    }

    private function logError(string $error): void {
        error_log($error);
    }
}

class User extends BaseModel implements RepositoryInterface {
    use Loggable;

    public const MAX_ATTEMPTS = 3;
    private const SECRET_KEY = "secret";

    private string $name;
    protected int $age;
    public array $roles;

    public function __construct(string $name, int $age = 0) {
        $this->name = $name;
        $this->age = $age;
    }

    public function getName(): string {
        return $this->name;
    }

    public function setName(string $name): void {
        $this->name = $name;
    }

    public function getAge(): int {
        return $this->age;
    }

    public function find(int $id): ?object {
        return $this->buildQuery()->find($id);
    }

    public function findAll(): array {
        return [];
    }

    protected function buildQuery(): object {
        return new QueryBuilder();
    }

    private function validate(): bool {
        return !empty($this->name);
    }
}

class BaseController {
    public function render(string $view, array $data = []): void {
        include $view;
    }

    public function redirect(string $url): void {
        header("Location: " . $url);
    }
}

function createUser(string $name): User {
    return new User($name);
}

function sendEmail(string $to, string $subject, string $body): bool {
    return mail($to, $subject, $body);
}

function _privateHelper(): void {
    echo "Helper function";
}

define('APP_VERSION', '1.0.0');
define('DEBUG_MODE', true);

abstract class Service {
    abstract public function execute(): void;

    public function validate(): bool {
        return true;
    }
}

final class CacheService extends Service {
    public function execute(): void {
        echo "Caching...";
    }
}
