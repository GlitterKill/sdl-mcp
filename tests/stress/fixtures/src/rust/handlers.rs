/// handlers.rs — secondary Rust fixture (uses types from lib.rs).
/// Defines handler functions that operate on the UserStore.

use crate::{User, UserStore, Repository, Status, create_user};

pub struct ApiResponse<T> {
    pub data: Option<T>,
    pub status_code: u16,
    pub message: String,
}

impl<T> ApiResponse<T> {
    pub fn ok(data: T) -> Self {
        Self { data: Some(data), status_code: 200, message: "OK".to_string() }
    }

    pub fn not_found(msg: &str) -> Self {
        Self { data: None, status_code: 404, message: msg.to_string() }
    }

    pub fn created(data: T) -> Self {
        Self { data: Some(data), status_code: 201, message: "Created".to_string() }
    }
}

pub fn handle_get_user(store: &UserStore, id: &str) -> ApiResponse<User> {
    match store.find_by_id(id) {
        Some(user) => ApiResponse::ok(user.clone()),
        None => ApiResponse::not_found(&format!("User {} not found", id)),
    }
}

pub fn handle_create_user(
    store: &mut UserStore,
    id: &str,
    name: &str,
    email: &str,
) -> ApiResponse<User> {
    let user = create_user(id, name, email);
    match store.save(user.clone()) {
        Ok(()) => ApiResponse::created(user),
        Err(e) => ApiResponse { data: None, status_code: 500, message: e },
    }
}

pub fn handle_delete_user(store: &mut UserStore, id: &str) -> ApiResponse<()> {
    match store.delete(id) {
        Ok(()) => ApiResponse::ok(()),
        Err(e) => ApiResponse::not_found(&e),
    }
}

pub fn handle_list_active(store: &UserStore) -> ApiResponse<Vec<User>> {
    let users: Vec<User> = store.find_by_status(&Status::Active)
        .into_iter()
        .cloned()
        .collect();
    ApiResponse::ok(users)
}

pub fn handle_user_count(store: &UserStore) -> ApiResponse<usize> {
    ApiResponse::ok(store.count())
}
