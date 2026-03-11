/**
 * UseCases — secondary Kotlin fixture (uses Repository types).
 * Defines use case classes that delegate to the repository.
 */
package com.example.stress

class GetItemUseCase(private val repository: ItemRepository) {
    fun execute(id: String): RepositoryResult<Item> {
        val item = repository.findById(id)
            ?: return RepositoryResult.Error("Item not found: $id")
        return RepositoryResult.Success(item)
    }
}

class CreateItemUseCase(private val repository: ItemRepository) {
    fun execute(name: String, price: Double, category: String): RepositoryResult<Item> {
        if (price < 0) return RepositoryResult.Error("Price must be non-negative")
        val id = "item-${System.currentTimeMillis()}"
        val item = Item(id = id, name = name, price = price, category = category)
        return RepositoryResult.Success(repository.save(item))
    }
}

class ListItemsByCategoryUseCase(private val repository: InMemoryItemRepository) {
    fun execute(category: String): RepositoryResult<List<Item>> {
        val items = repository.findByCategory(category)
        return RepositoryResult.Success(items)
    }
}

class DeactivateItemUseCase(private val repository: ItemRepository) {
    fun execute(id: String): RepositoryResult<Item> {
        val existing = repository.findById(id)
            ?: return RepositoryResult.Error("Item not found: $id")
        val deactivated = existing.copy(active = false)
        return RepositoryResult.Success(repository.save(deactivated))
    }
}

class GetInventorySummaryUseCase(private val repository: InMemoryItemRepository) {
    fun execute(): Map<String, Any> {
        val all = repository.findAll()
        val active = repository.findActive()
        return mapOf(
            "total" to all.size,
            "active" to active.size,
            "inactive" to (all.size - active.size),
            "totalValue" to all.sumOf { it.price }
        )
    }
}
