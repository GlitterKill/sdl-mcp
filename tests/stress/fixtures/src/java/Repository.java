/**
 * Repository — primary Java fixture.
 * Defines classes, interfaces, enums, and records for data access.
 */
package com.example.stress;

import java.util.*;
import java.time.Instant;

public interface CrudRepository<T, ID> {
    Optional<T> findById(ID id);
    List<T> findAll();
    T save(T entity);
    void deleteById(ID id);
    long count();
}

enum EntityStatus {
    ACTIVE,
    INACTIVE,
    ARCHIVED,
    DELETED
}

record EntityMetadata(String createdBy, Instant createdAt, String updatedBy, Instant updatedAt) {
    static EntityMetadata create(String user) {
        Instant now = Instant.now();
        return new EntityMetadata(user, now, user, now);
    }
}

class UserEntity {
    private String id;
    private String name;
    private String email;
    private EntityStatus status;
    private EntityMetadata metadata;

    public UserEntity(String id, String name, String email) {
        this.id = id;
        this.name = name;
        this.email = email;
        this.status = EntityStatus.ACTIVE;
        this.metadata = EntityMetadata.create("system");
    }

    public String getId() { return id; }
    public String getName() { return name; }
    public String getEmail() { return email; }
    public EntityStatus getStatus() { return status; }
    public EntityMetadata getMetadata() { return metadata; }
    public void setStatus(EntityStatus status) { this.status = status; }
}

class UserRepository implements CrudRepository<UserEntity, String> {
    private final Map<String, UserEntity> store = new HashMap<>();

    @Override
    public Optional<UserEntity> findById(String id) {
        return Optional.ofNullable(store.get(id));
    }

    @Override
    public List<UserEntity> findAll() {
        return new ArrayList<>(store.values());
    }

    @Override
    public UserEntity save(UserEntity entity) {
        store.put(entity.getId(), entity);
        return entity;
    }

    @Override
    public void deleteById(String id) {
        store.remove(id);
    }

    @Override
    public long count() {
        return store.size();
    }

    public List<UserEntity> findByStatus(EntityStatus status) {
        return store.values().stream()
            .filter(e -> e.getStatus() == status)
            .toList();
    }
}
