/**
 * Service — secondary Java fixture (uses Repository types).
 * Defines a service layer that delegates to the repository.
 */
package com.example.stress;

import java.util.*;

class UserNotFoundException extends RuntimeException {
    public UserNotFoundException(String userId) {
        super("User not found: " + userId);
    }
}

class UserService {
    private final UserRepository repository;

    public UserService(UserRepository repository) {
        this.repository = repository;
    }

    public UserEntity getUser(String id) {
        return repository.findById(id)
            .orElseThrow(() -> new UserNotFoundException(id));
    }

    public UserEntity createUser(String name, String email) {
        String id = UUID.randomUUID().toString();
        UserEntity user = new UserEntity(id, name, email);
        return repository.save(user);
    }

    public void deactivateUser(String id) {
        UserEntity user = getUser(id);
        user.setStatus(EntityStatus.INACTIVE);
        repository.save(user);
    }

    public List<UserEntity> getActiveUsers() {
        return repository.findByStatus(EntityStatus.ACTIVE);
    }

    public long getUserCount() {
        return repository.count();
    }

    public void deleteUser(String id) {
        getUser(id); // verify exists
        repository.deleteById(id);
    }
}
