import { defineConfig } from "vite";

export default defineConfig({
  // Documents and questions are read from ../../corpus at build time.
  server: { port: 5173, fs: { allow: ["../.."] } },
});
