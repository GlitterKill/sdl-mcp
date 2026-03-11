/**
 * Models — secondary TypeScript fixture (imports from api-service).
 */

import type { UserProfile, UserRole, ApiResponse } from "./api-service.js";

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface AuditLogEntry {
  id: string;
  userId: string;
  action: string;
  resource: string;
  timestamp: Date;
  metadata: Record<string, unknown>;
}

export type UserSortField = "name" | "email" | "createdAt";

export interface UserFilter {
  role?: UserRole;
  search?: string;
  sortBy?: UserSortField;
  sortOrder?: "asc" | "desc";
}

export class UserRepository {
  private users: Map<string, UserProfile> = new Map();

  add(user: UserProfile): void {
    this.users.set(user.id, user);
  }

  findById(id: string): UserProfile | undefined {
    return this.users.get(id);
  }

  findAll(filter?: UserFilter): UserProfile[] {
    let results = Array.from(this.users.values());
    if (filter?.role) {
      results = results.filter((u) => u.role === filter.role);
    }
    if (filter?.search) {
      const search = filter.search.toLowerCase();
      results = results.filter(
        (u) =>
          u.name.toLowerCase().includes(search) ||
          u.email.toLowerCase().includes(search),
      );
    }
    return results;
  }

  count(): number {
    return this.users.size;
  }
}

export function toApiResponse<T>(
  data: T,
  status: number = 200,
): ApiResponse<T> {
  return { data, status, message: "OK", timestamp: new Date() };
}

export function toPaginatedResult<T>(
  items: T[],
  total: number,
  page: number,
  pageSize: number,
): PaginatedResult<T> {
  return { items, total, page, pageSize, hasMore: page * pageSize < total };
}
