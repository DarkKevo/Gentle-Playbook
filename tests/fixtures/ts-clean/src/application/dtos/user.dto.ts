import { z } from 'zod';

export const CreateUserDto = z.object({
  email: z.string().email(),
  name: z.string().min(1).trim(),
});

export type CreateUserDto = z.infer<typeof CreateUserDto>;
