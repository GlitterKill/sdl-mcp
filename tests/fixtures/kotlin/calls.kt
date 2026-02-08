package com.example.kotlin

import java.util.*

class CallExamples {
    private var field: String = "default"

    constructor() {
        println("Default constructor")
    }

    constructor(field: String) {
        this.field = field
    }

    // Simple function calls
    fun simpleCalls() {
        val result = processInput("test")
        println(result)
    }

    // Method calls on objects
    fun methodCalls() {
        val list = mutableListOf<String>()
        list.add("test")
        list.clear()
        list.size
    }

    // Chained method calls
    fun chainedCalls() {
        val result = "hello"
            .toUpperCase()
            .trim()
            .substring(0, 1)
    }

    // Static calls (companion object)
    fun staticCalls() {
        val user = Task.Companion.create(1, "title")
        val max = Task.MAX_TITLE_LENGTH
    }

    // Constructor calls
    fun constructorCalls() {
        val user = User(1, "Alice")
        val task = Task(1, "Task 1")
        val task2 = Task.create(2, "Task 2")
    }

    // Extension function calls
    fun extensionCalls() {
        val text = "hello"
        val result = text.capitalizeExtension()
        val numbers = listOf(1, 2, 3)
        val doubled = numbers.map { it * 2 }
    }

    // Calls with this
    fun thisCalls() {
        this.field = "updated"
        this.simpleCalls()
    }

    // Nested calls
    fun nestedCalls() {
        val result = processInput(uppercaseInput("test"))
    }

    private fun processInput(input: String): String {
        return input
    }

    private fun uppercaseInput(input: String): String {
        return input.toUpperCase()
    }
}

// Extension function
fun String.capitalizeExtension(): String {
    return this.capitalize()
}

data class User(val id: Int, val name: String)

data class Task(
    val id: Int,
    val title: String,
    val status: String = "pending"
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
}

class Service {
    fun <T> transform(value: T, transformer: (T) -> T): T {
        return transformer(value)
    }

    fun useTransform() {
        val result = transform("hello") { it.toUpperCase() }
        val numbers = listOf(1, 2, 3)
        val mapped = transform(numbers) { it.map { it * 2 } }
    }
}
