/**
 * Repository — primary Kotlin fixture.
 * Defines data classes, interfaces, and class implementations.
 */
package com.example.stress

data class Item(
    val id: String,
    val name: String,
    val price: Double,
    val category: String,
    val active: Boolean = true
)

interface ItemRepository {
    fun findById(id: String): Item?
    fun findAll(): List<Item>
    fun save(item: Item): Item
    fun deleteById(id: String): Boolean
    fun count(): Int
}

class InMemoryItemRepository : ItemRepository {
    private val store = mutableMapOf<String, Item>()

    override fun findById(id: String): Item? = store[id]

    override fun findAll(): List<Item> = store.values.toList()

    override fun save(item: Item): Item {
        store[item.id] = item
        return item
    }

    override fun deleteById(id: String): Boolean = store.remove(id) != null

    override fun count(): Int = store.size

    fun findByCategory(category: String): List<Item> =
        store.values.filter { it.category == category }

    fun findActive(): List<Item> =
        store.values.filter { it.active }
}

sealed class RepositoryResult<out T> {
    data class Success<T>(val data: T) : RepositoryResult<T>()
    data class Error(val message: String) : RepositoryResult<Nothing>()
}
