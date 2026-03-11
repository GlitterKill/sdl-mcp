/// lib.rs — primary Rust fixture.
/// Defines structs, traits, enums, and implementations.

use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub enum Status {
    Active,
    Inactive,
    Suspended,
}

#[derive(Debug, Clone)]
pub struct User {
    pub id: String,
    pub name: String,
    pub email: String,
    pub status: Status,
}

pub trait Repository<T> {
    fn find_by_id(&self, id: &str) -> Option<&T>;
    fn find_all(&self) -> Vec<&T>;
    fn save(&mut self, entity: T) -> Result<(), String>;
    fn delete(&mut self, id: &str) -> Result<(), String>;
    fn count(&self) -> usize;
}

pub struct UserStore {
    users: HashMap<String, User>,
}

impl UserStore {
    pub fn new() -> Self {
        Self {
            users: HashMap::new(),
        }
    }

    pub fn find_by_status(&self, status: &Status) -> Vec<&User> {
        self.users.values().filter(|u| &u.status == status).collect()
    }
}

impl Repository<User> for UserStore {
    fn find_by_id(&self, id: &str) -> Option<&User> {
        self.users.get(id)
    }

    fn find_all(&self) -> Vec<&User> {
        self.users.values().collect()
    }

    fn save(&mut self, entity: User) -> Result<(), String> {
        self.users.insert(entity.id.clone(), entity);
        Ok(())
    }

    fn delete(&mut self, id: &str) -> Result<(), String> {
        self.users
            .remove(id)
            .map(|_| ())
            .ok_or_else(|| format!("User not found: {}", id))
    }

    fn count(&self) -> usize {
        self.users.len()
    }
}

pub fn create_user(id: &str, name: &str, email: &str) -> User {
    User {
        id: id.to_string(),
        name: name.to_string(),
        email: email.to_string(),
        status: Status::Active,
    }
}

impl Default for UserStore {
    fn default() -> Self {
        Self::new()
    }
}
