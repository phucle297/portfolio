import type { ImageMetadata } from "astro";
import project1 from "@/assets/images/project-1.webp";
import project2 from "@/assets/images/project-2.webp";
import project3 from "@/assets/images/project-3.webp";

export interface Project {
  title: string;
  summary: string;
  tags: readonly string[];
  image: ImageMetadata;
  imageAlt: string;
  href?: string;
}

/** TODO: replace these placeholders with real projects. */
export const projects: readonly Project[] = [
  {
    title: "Project One",
    summary:
      "A placeholder for a flagship project. Describe the problem, your role and the impact.",
    tags: ["TypeScript", "Astro", "WebGL"],
    image: project1,
    imageAlt: "Abstract blue and violet gradient with concentric rings",
  },
  {
    title: "Project Two",
    summary: "A placeholder for a second project. Keep it short and outcome-focused.",
    tags: ["Node.js", "PostgreSQL"],
    image: project2,
    imageAlt: "Abstract teal and blue gradient with concentric rings",
  },
  {
    title: "Project Three",
    summary: "A placeholder for a third project. Link to a case study or live demo.",
    tags: ["React", "Motion"],
    image: project3,
    imageAlt: "Abstract magenta and amber gradient with concentric rings",
  },
];
