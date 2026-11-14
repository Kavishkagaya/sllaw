"use client";

import { useEffect } from "react";

// The landing's motion (landing-motion): CSS does the moving (globals.css, "landing motion"), keyed on
// html[data-motion]; this only sets that flag and marks each [data-reveal] block [data-shown] the first time it
// scrolls into view. Off when the visitor asked for reduced motion, and without JS: then the page is still and whole.
const ON = "(prefers-reduced-motion: no-preference)";

/** Runs before first paint on a full load, so revealed blocks never flash in and out. */
export const MOTION_FLAG = `matchMedia(${JSON.stringify(ON)}).matches&&document.documentElement.setAttribute("data-motion","")`;

export function LandingMotion() {
  useEffect(() => {
    const root = document.documentElement;
    if (!matchMedia(ON).matches) return;
    root.setAttribute("data-motion", "");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.setAttribute("data-shown", "");
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    for (const el of document.querySelectorAll("[data-reveal]")) io.observe(el);
    return () => {
      io.disconnect();
      root.removeAttribute("data-motion");
    };
  }, []);
  return null;
}
