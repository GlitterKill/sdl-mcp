/**
 * API Service — primary TypeScript fixture.
 * Defines classes, interfaces, enums, and exported functions for indexing.
 */

export enum UserRole {
  Admin = "admin",
  Editor = "editor",
  Viewer = "viewer",
}

export interface ApiResponse<T> {
  data: T;
  status: number;
  message: string;
  timestamp: Date;
}

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  createdAt: Date;
}

export interface ApiServiceConfig {
  baseUrl: string;
  timeout: number;
  retries: number;
  apiKey: string;
}

export class ApiService {
  private config: ApiServiceConfig;
  private requestCount: number = 0;

  constructor(config: ApiServiceConfig) {
    this.config = config;
  }

  async fetchUser(userId: string): Promise<ApiResponse<UserProfile>> {
    this.requestCount++;
    return {
      data: {
        id: userId,
        name: "Test User",
        email: "test@example.com",
        role: UserRole.Viewer,
        createdAt: new Date(),
      },
      status: 200,
      message: "OK",
      timestamp: new Date(),
    };
  }

  async createUser(
    profile: Omit<UserProfile, "id" | "createdAt">,
  ): Promise<ApiResponse<UserProfile>> {
    this.requestCount++;
    return {
      data: { ...profile, id: crypto.randomUUID(), createdAt: new Date() },
      status: 201,
      message: "Created",
      timestamp: new Date(),
    };
  }

  async deleteUser(userId: string): Promise<ApiResponse<null>> {
    this.requestCount++;
    return {
      data: null,
      status: 204,
      message: "Deleted",
      timestamp: new Date(),
    };
  }

  async listUsers(
    page: number,
    pageSize: number,
  ): Promise<ApiResponse<UserProfile[]>> {
    this.requestCount++;
    return { data: [], status: 200, message: "OK", timestamp: new Date() };
  }

  getRequestCount(): number {
    return this.requestCount;
  }

  getBaseUrl(): string {
    return this.config.baseUrl;
  }
}

export function createDefaultConfig(): ApiServiceConfig {
  return {
    baseUrl: "https://api.example.com",
    timeout: 5000,
    retries: 3,
    apiKey: "test-key",
  };
}

export function isAdmin(profile: UserProfile): boolean {
  return profile.role === UserRole.Admin;
}
