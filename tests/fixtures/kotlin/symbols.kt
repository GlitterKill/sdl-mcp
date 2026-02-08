package com.example.kotlin

import java.util.*
import kotlin.collections.*

data class User(val id: Int, val name: String, val email: String?)

open class Animal(val name: String) {
    open fun makeSound(): String = "Unknown sound"

    fun eat(): Unit {
        println("Eating")
    }
}

class Dog(name: String, private val breed: String) : Animal(name) {
    override fun makeSound(): String = "Bark"
}

interface Repository<T> {
    fun findById(id: String): T?
    fun findAll(): List<T>
    fun save(entity: T): T
}

class UserRepository : Repository<User> {
    private val users = mutableListOf<User>()

    override fun findById(id: String): User? {
        return users.find { it.id.toString() == id }
    }

    override fun findAll(): List<User> {
        return users.toList()
    }

    override fun save(entity: User): User {
        users.add(entity)
        return entity
    }
}

object DatabaseConnection {
    private var connectionCount = 0

    fun connect(): String {
        connectionCount++
        return "Connected #$connectionCount"
    }

    fun disconnect(): String {
        return "Disconnected"
    }
}

class UserService(private val repository: Repository<User>) {
    private val cache = mutableMapOf<String, User>()

    fun getUser(id: String): User? {
        val cached = cache[id]
        if (cached != null) {
            return cached
        }
        val user = repository.findById(id)
        if (user != null) {
            cache[id] = user
        }
        return user
    }

    fun getAllUsers(): List<User> {
        return repository.findAll()
    }

    fun createUser(name: String, email: String): User {
        val id = (repository.findAll().size + 1)
        val user = User(id, name, email)
        return repository.save(user)
    }

    fun <T> transformUser(id: String, transformer: (User) -> T): T? {
        val user = repository.findById(id)
        return user?.let { transformer(it) }
    }
}

enum class Status {
    PENDING,
    ACTIVE,
    INACTIVE,
    ARCHIVED
}

data class Task(
    val id: Int,
    val title: String,
    val status: Status = Status.PENDING,
    val createdAt: Long = System.currentTimeMillis()
) {
    companion object {
        const val MAX_TITLE_LENGTH = 100

        fun create(id: Int, title: String): Task {
            if (title.length > MAX_TITLE_LENGTH) {
                throw IllegalArgumentException("Title too long")
            }
            return Task(id, title)
        }
    }

    fun withStatus(newStatus: Status): Task {
        return copy(status = newStatus)
    }

    fun isActive(): Boolean {
        return status == Status.ACTIVE
    }
}

class TaskManager {
    private val tasks = mutableListOf<Task>()

    constructor() {
        println("TaskManager initialized")
    }

    constructor(initialTasks: List<Task>) {
        tasks.addAll(initialTasks)
    }

    fun addTask(task: Task): Task {
        tasks.add(task)
        return task
    }

    fun findTask(id: Int): Task? {
        return tasks.find { it.id == id }
    }

    fun listTasks(): List<Task> {
        return tasks.toList()
    }
}

interface Logger {
    fun log(message: String)
    fun logError(message: String, error: Throwable? = null)
}

class ConsoleLogger : Logger {
    override fun log(message: String) {
        println("[LOG] $message")
    }

    override fun logError(message: String, error: Throwable?) {
        println("[ERROR] $message")
        error?.printStackTrace()
    }
}
