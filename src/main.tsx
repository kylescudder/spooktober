import React from "react";
import { createRoot } from "react-dom/client";
import { FilmList } from "./film-list";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<FilmList initialFilms={null} />);
