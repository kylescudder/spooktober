import type { z } from "zod";
import type { filmSchema } from "./validation";

export type Film = z.infer<typeof filmSchema>;
export type ImportedFilm = Film & { year?: number };
export type AnnualFilm = Film & { year: number };
