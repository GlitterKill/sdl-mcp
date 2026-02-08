import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PhpAdapter } from "../../dist/indexer/adapter/php.js";
describe("PHP Adapter", () => {
    const adapter = new PhpAdapter();
    describe("ML-C2.1: Symbol Extraction", () => {
        it("should extract class declarations", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/php/symbols.php"), "utf-8");
            const tree = adapter.parse(content, "test.php");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.php");
            const userClass = symbols.find((s) => s.name === "App\\Models\\User");
            assert.ok(userClass, "Should extract User class");
            assert.strictEqual(userClass?.kind, "class");
            assert.strictEqual(userClass?.exported, true);
            assert.strictEqual(userClass?.visibility, "public");
        });
        it("should extract interface declarations", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/php/symbols.php"), "utf-8");
            const tree = adapter.parse(content, "test.php");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.php");
            const repositoryInterface = symbols.find((s) => s.name === "App\\Models\\RepositoryInterface");
            assert.ok(repositoryInterface, "Should extract RepositoryInterface");
            assert.strictEqual(repositoryInterface?.kind, "interface");
            assert.strictEqual(repositoryInterface?.exported, true);
        });
        it("should extract trait declarations as class", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/php/symbols.php"), "utf-8");
            const tree = adapter.parse(content, "test.php");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.php");
            const loggableTrait = symbols.find((s) => s.name === "App\\Models\\Loggable");
            assert.ok(loggableTrait, "Should extract Loggable trait");
            assert.strictEqual(loggableTrait?.kind, "class");
            assert.strictEqual(loggableTrait?.exported, true);
        });
        it("should extract method declarations with visibility", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/php/symbols.php"), "utf-8");
            const tree = adapter.parse(content, "test.php");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.php");
            const getNameMethod = symbols.find((s) => s.name === "getName");
            assert.ok(getNameMethod, "Should extract getName method");
            assert.strictEqual(getNameMethod?.kind, "method");
            assert.strictEqual(getNameMethod?.exported, true);
            assert.strictEqual(getNameMethod?.visibility, "public");
            const validateMethod = symbols.find((s) => s.name === "validate");
            assert.ok(validateMethod, "Should extract validate method");
            assert.strictEqual(validateMethod?.kind, "method");
            assert.strictEqual(validateMethod?.exported, false);
            assert.strictEqual(validateMethod?.visibility, "private");
        });
        it("should extract method return types", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/php/symbols.php"), "utf-8");
            const tree = adapter.parse(content, "test.php");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.php");
            const findMethod = symbols.find((s) => s.name === "find");
            assert.ok(findMethod, "Should extract find method");
            assert.ok(findMethod?.signature);
            assert.strictEqual(findMethod?.signature?.params.length, 0);
            assert.strictEqual(findMethod?.signature?.returns, "?object");
        });
        it("should extract function declarations with namespace", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/php/symbols.php"), "utf-8");
            const tree = adapter.parse(content, "test.php");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.php");
            const createUserFunc = symbols.find((s) => s.name === "App\\Models\\createUser");
            assert.ok(createUserFunc, "Should extract createUser function");
            assert.strictEqual(createUserFunc?.kind, "function");
            assert.strictEqual(createUserFunc?.exported, true);
        });
        it("should mark private functions starting with underscore", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/php/symbols.php"), "utf-8");
            const tree = adapter.parse(content, "test.php");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.php");
            const privateHelper = symbols.find((s) => s.name === "App\\Models\\_privateHelper");
            assert.ok(privateHelper, "Should extract _privateHelper function");
            assert.strictEqual(privateHelper?.exported, false);
            assert.strictEqual(privateHelper?.visibility, "private");
        });
        it("should extract property declarations with visibility", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/php/symbols.php"), "utf-8");
            const tree = adapter.parse(content, "test.php");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.php");
            const nameProp = symbols.find((s) => s.name === "name");
            assert.ok(nameProp, "Should extract name property");
            assert.strictEqual(nameProp?.kind, "variable");
            assert.strictEqual(nameProp?.visibility, "private");
            const rolesProp = symbols.find((s) => s.name === "roles");
            assert.ok(rolesProp, "Should extract roles property");
            assert.strictEqual(rolesProp?.visibility, "public");
        });
        it("should extract const declarations", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/php/symbols.php"), "utf-8");
            const tree = adapter.parse(content, "test.php");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.php");
            const maxAttempts = symbols.find((s) => s.name === "MAX_ATTEMPTS");
            assert.ok(maxAttempts, "Should extract MAX_ATTEMPTS const");
            assert.strictEqual(maxAttempts?.kind, "variable");
            assert.strictEqual(maxAttempts?.exported, true);
            const secretKey = symbols.find((s) => s.name === "SECRET_KEY");
            assert.ok(secretKey, "Should extract SECRET_KEY const");
            assert.strictEqual(secretKey?.visibility, "private");
        });
        it("should extract abstract and final class declarations", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/php/symbols.php"), "utf-8");
            const tree = adapter.parse(content, "test.php");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.php");
            const serviceClass = symbols.find((s) => s.name === "App\\Models\\Service");
            assert.ok(serviceClass, "Should extract abstract Service class");
            assert.strictEqual(serviceClass?.kind, "class");
            const cacheServiceClass = symbols.find((s) => s.name === "App\\Models\\CacheService");
            assert.ok(cacheServiceClass, "Should extract final CacheService class");
            assert.strictEqual(cacheServiceClass?.kind, "class");
        });
    });
    describe("ML-C2.2: Import Extraction", () => {
        it("should extract namespace use declarations", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/php/imports.php"), "utf-8");
            const tree = adapter.parse(content, "test.php");
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, "test.php");
            const illuminateImport = imports.find((imp) => imp.specifier === "Illuminate\\Http\\Request");
            assert.ok(illuminateImport, "Should find Illuminate import");
            assert.strictEqual(illuminateImport?.isRelative, false);
            assert.strictEqual(illuminateImport?.isExternal, true);
        });
        it("should extract use statements with aliases", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/php/imports.php"), "utf-8");
            const tree = adapter.parse(content, "test.php");
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, "test.php");
            const userRepoAlias = imports.find((imp) => imp.specifier === "App\\Repositories\\UserRepository");
            assert.ok(userRepoAlias, "Should find UserRepository import");
            assert.strictEqual(userRepoAlias?.imports[0], "UserRepo");
            const strAlias = imports.find((imp) => imp.specifier === "App\\Utils\\StringHelper");
            assert.ok(strAlias, "Should find StringHelper import");
            assert.strictEqual(strAlias?.imports[0], "Str");
        });
        it("should extract require statements", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/php/imports.php"), "utf-8");
            const tree = adapter.parse(content, "test.php");
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, "test.php");
            const vendorRequire = imports.find((imp) => imp.specifier === "vendor/autoload.php");
            assert.ok(vendorRequire, "Should find vendor require");
            assert.strictEqual(vendorRequire?.isRelative, false);
            assert.strictEqual(vendorRequire?.isExternal, true);
        });
        it("should identify relative paths in require/include", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/php/imports.php"), "utf-8");
            const tree = adapter.parse(content, "test.php");
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, "test.php");
            const currentDirRequire = imports.find((imp) => imp.specifier === "./config/app.php");
            assert.ok(currentDirRequire, "Should find ./config/app.php");
            assert.strictEqual(currentDirRequire?.isRelative, true);
            assert.strictEqual(currentDirRequire?.isExternal, false);
            const parentDirRequire = imports.find((imp) => imp.specifier === "../helpers/functions.php");
            assert.ok(parentDirRequire, "Should find ../helpers/functions.php");
            assert.strictEqual(parentDirRequire?.isRelative, true);
            assert.strictEqual(parentDirRequire?.isExternal, false);
        });
        it("should extract include statements", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/php/imports.php"), "utf-8");
            const tree = adapter.parse(content, "test.php");
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, "test.php");
            const headerInclude = imports.find((imp) => imp.specifier === "templates/header.php");
            assert.ok(headerInclude, "Should find header include");
            const navInclude = imports.find((imp) => imp.specifier === "./partials/nav.php");
            assert.ok(navInclude, "Should find nav include");
        });
        it("should handle absolute paths on Windows", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/php/imports.php"), "utf-8");
            const tree = adapter.parse(content, "test.php");
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, "test.php");
            const windowsPath1 = imports.find((imp) => imp.specifier.startsWith("C:/"));
            assert.ok(windowsPath1, "Should find Windows path");
            const windowsPath2 = imports.find((imp) => imp.specifier.startsWith("D:/"));
            assert.ok(windowsPath2, "Should find another Windows path");
        });
        it("should identify leading backslash as relative", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/php/imports.php"), "utf-8");
            const tree = adapter.parse(content, "test.php");
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, "test.php");
            const dateTime = imports.find((imp) => imp.specifier === "\\DateTime");
            assert.ok(dateTime, "Should find \\DateTime import");
            assert.strictEqual(dateTime?.isRelative, true);
            const exception = imports.find((imp) => imp.specifier === "\\Exception");
            assert.ok(exception, "Should find \\Exception import");
            assert.strictEqual(exception?.isRelative, true);
        });
    });
    describe("ML-C2.3: Call Extraction", () => {
        it("should extract static method calls", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/php/calls.php"), "utf-8");
            const tree = adapter.parse(content, "test.php");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.php");
            const calls = adapter.extractCalls(tree, content, "test.php", symbols);
            const validatorCall = calls.find((c) => c.calleeIdentifier.includes("Validator::"));
            assert.ok(validatorCall, "Should find Validator::validate call");
            assert.strictEqual(validatorCall?.callType, "function");
            const cacheGetCall = calls.find((c) => c.calleeIdentifier === "Cache::get");
            assert.ok(cacheGetCall, "Should find Cache::get call");
            const dbConnectCall = calls.find((c) => c.calleeIdentifier === "Database::connect");
            assert.ok(dbConnectCall, "Should find Database::connect call");
        });
        it("should extract function calls", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/php/calls.php"), "utf-8");
            const tree = adapter.parse(content, "test.php");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.php");
            const calls = adapter.extractCalls(tree, content, "test.php", symbols);
            const mailCall = calls.find((c) => c.calleeIdentifier === "mail");
            assert.ok(mailCall, "Should find mail function call");
            assert.strictEqual(mailCall?.callType, "function");
            const errorLogCall = calls.find((c) => c.calleeIdentifier === "error_log");
            assert.ok(errorLogCall, "Should find error_log call");
            assert.strictEqual(errorLogCall?.callType, "function");
            const ucfirstCall = calls.find((c) => c.calleeIdentifier === "ucfirst");
            assert.ok(ucfirstCall, "Should find ucfirst call");
        });
        it("should mark dynamic calls as unresolved", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/php/calls.php"), "utf-8");
            const tree = adapter.parse(content, "test.php");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.php");
            const calls = adapter.extractCalls(tree, content, "test.php", symbols);
            const dynamicCalls = calls.filter((c) => c.callType === "dynamic");
            assert.ok(dynamicCalls.length >= 3, "Should have at least 3 dynamic calls");
            const unresolvedCalls = calls.filter((c) => !c.isResolved);
            assert.ok(unresolvedCalls.length > 0, "Should have unresolved calls");
        });
        it("should extract qualified namespace static calls", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/php/calls.php"), "utf-8");
            const tree = adapter.parse(content, "test.php");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.php");
            const calls = adapter.extractCalls(tree, content, "test.php", symbols);
            const configCall = calls.find((c) => c.calleeIdentifier.includes("Config::"));
            assert.ok(configCall, "Should find \\App\\Config::get call");
            assert.strictEqual(configCall?.isResolved, false);
        });
        it("should extract multiple static calls in same function", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/php/calls.php"), "utf-8");
            const tree = adapter.parse(content, "calls.php");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "calls.php");
            const calls = adapter.extractCalls(tree, content, "calls.php", symbols);
            const indexCalls = calls.filter((c) => c.callerNodeId === "calls.php:index:24");
            assert.strictEqual(indexCalls.length, 3, "Should find 3 calls in index function");
            const cacheCalls = indexCalls.filter((c) => c.calleeIdentifier.includes("Cache::"));
            assert.strictEqual(cacheCalls.length, 2, "Should find 2 Cache calls");
        });
        it("should handle variable function name patterns", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/php/calls.php"), "utf-8");
            const tree = adapter.parse(content, "test.php");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.php");
            const calls = adapter.extractCalls(tree, content, "test.php", symbols);
            const dynamicCalls = calls.filter((c) => c.callType === "dynamic");
            assert.ok(dynamicCalls.length >= 3, "Should have at least 3 dynamic calls");
            const varCallNames = dynamicCalls.map((c) => c.calleeIdentifier);
            assert.ok(varCallNames.some((n) => n.includes("$callback")));
            assert.ok(varCallNames.some((n) => n.includes("$fn")));
            assert.ok(varCallNames.some((n) => n.includes("$handler")));
        });
    });
    describe("ML-C2.4: Golden Files", () => {
        it("should match expected symbols output", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/php/symbols.php"), "utf-8");
            const tree = adapter.parse(content, "test.php");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.php");
            assert.strictEqual(symbols.length, 32, "Should extract 32 symbols");
        });
        it("should match expected imports output", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/php/imports.php"), "utf-8");
            const tree = adapter.parse(content, "test.php");
            assert.ok(tree);
            const imports = adapter.extractImports(tree, content, "test.php");
            assert.strictEqual(imports.length, 27, "Should extract 27 imports");
        });
        it("should match expected calls output", () => {
            const content = readFileSync(join(process.cwd(), "tests/fixtures/php/calls.php"), "utf-8");
            const tree = adapter.parse(content, "test.php");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.php");
            const calls = adapter.extractCalls(tree, content, "test.php", symbols);
            assert.strictEqual(calls.length, 11, "Should extract 11 calls");
        });
    });
    describe("Integration", () => {
        it("should handle complete PHP file with all constructs", () => {
            const content = `<?php
namespace App\\Controllers;

use Illuminate\\Http\\Request;

class UserController {
    private $userService;

    public function __construct(UserService $service) {
        $this->userService = $service;
    }

    public function index(): array {
        return $this->userService->getAll();
    }

    public function show(int $id): array {
        return $this->userService->find($id);
    }

    public function store(Request $request): array {
        $data = $request->validate($request->all());
        return $this->userService->create($data);
    }

    private function logAction(string $action): void {
        Logger::info($action);
    }
}
      `;
            const tree = adapter.parse(content, "test.php");
            assert.ok(tree);
            const symbols = adapter.extractSymbols(tree, content, "test.php");
            const imports = adapter.extractImports(tree, content, "test.php");
            const calls = adapter.extractCalls(tree, content, "test.php", symbols);
            assert.ok(symbols.length > 0, "Should have symbols");
            assert.strictEqual(imports.length, 1, "Should have 1 import");
            assert.ok(calls.length >= 1, "Should have at least 1 call");
            const userControllerClass = symbols.find((s) => s.name === "App\\Controllers\\UserController");
            assert.ok(userControllerClass);
            assert.strictEqual(userControllerClass?.kind, "class");
            const indexMethod = symbols.find((s) => s.name === "index");
            assert.ok(indexMethod);
            assert.strictEqual(indexMethod?.kind, "method");
            assert.strictEqual(indexMethod?.visibility, "public");
            const logActionMethod = symbols.find((s) => s.name === "logAction");
            assert.ok(logActionMethod);
            assert.strictEqual(logActionMethod?.visibility, "private");
            const loggerCall = calls.find((c) => c.calleeIdentifier.includes("Logger::"));
            assert.ok(loggerCall);
        });
    });
});
//# sourceMappingURL=php-adapter.test.js.map