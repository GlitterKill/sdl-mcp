/**
 * engine.hpp — primary C++ fixture (header).
 * Defines classes and templates for a processing engine.
 */
#pragma once

#include <string>
#include <vector>
#include <memory>
#include <functional>
#include <unordered_map>

namespace stress {

template<typename T>
class Result {
public:
    static Result<T> ok(T value) { return Result<T>(std::move(value), true, ""); }
    static Result<T> error(const std::string& msg) { return Result<T>(T{}, false, msg); }

    bool isOk() const { return success_; }
    const T& value() const { return value_; }
    const std::string& errorMsg() const { return error_; }

private:
    Result(T val, bool ok, const std::string& err)
        : value_(std::move(val)), success_(ok), error_(err) {}
    T value_;
    bool success_;
    std::string error_;
};

class Task {
public:
    Task(std::string id, std::string name);
    virtual ~Task() = default;

    const std::string& getId() const;
    const std::string& getName() const;
    virtual Result<int> execute() = 0;

private:
    std::string id_;
    std::string name_;
};

class Engine {
public:
    Engine(int maxWorkers);
    ~Engine();

    void addTask(std::unique_ptr<Task> task);
    void run();
    void stop();

    int getCompletedCount() const;
    int getPendingCount() const;
    bool isRunning() const;

private:
    int maxWorkers_;
    bool running_;
    int completedCount_;
    std::vector<std::unique_ptr<Task>> tasks_;
    std::unordered_map<std::string, Result<int>> results_;
};

using TaskFactory = std::function<std::unique_ptr<Task>(const std::string&)>;

Engine createDefaultEngine();

} // namespace stress
