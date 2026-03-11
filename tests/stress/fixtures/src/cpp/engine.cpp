/**
 * engine.cpp — secondary C++ fixture (implements engine.hpp).
 */
#include "engine.hpp"
#include <algorithm>

namespace stress {

Task::Task(std::string id, std::string name)
    : id_(std::move(id)), name_(std::move(name)) {}

const std::string& Task::getId() const { return id_; }
const std::string& Task::getName() const { return name_; }

Engine::Engine(int maxWorkers)
    : maxWorkers_(maxWorkers), running_(false), completedCount_(0) {}

Engine::~Engine() { stop(); }

void Engine::addTask(std::unique_ptr<Task> task) {
    tasks_.push_back(std::move(task));
}

void Engine::run() {
    running_ = true;
    for (auto& task : tasks_) {
        if (!running_) break;
        auto result = task->execute();
        results_[task->getId()] = result;
        if (result.isOk()) {
            completedCount_++;
        }
    }
    running_ = false;
}

void Engine::stop() {
    running_ = false;
}

int Engine::getCompletedCount() const { return completedCount_; }

int Engine::getPendingCount() const {
    return static_cast<int>(tasks_.size()) - completedCount_;
}

bool Engine::isRunning() const { return running_; }

Engine createDefaultEngine() {
    return Engine(4);
}

} // namespace stress
