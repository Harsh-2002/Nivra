import { z } from "./zod";

export const bookmarkReadStateBatchSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            revision: z.number().int().positive(),
            read: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
