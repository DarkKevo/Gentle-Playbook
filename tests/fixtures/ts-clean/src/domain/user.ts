export interface User {
  id: string;
  email: string;
  name: string;
}

export interface UserRepository {
  findById(id: string): Promise<User | null>;
}
