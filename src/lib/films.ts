import type { z } from "zod";
import type { filmSchema } from "./validation";

export type Film = z.infer<typeof filmSchema>;
