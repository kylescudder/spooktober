export interface Film {
  id: string;
  title: string;
  position: number;
  watched: boolean;
  watchedAt: string | null;
  updatedAt: string;
}
