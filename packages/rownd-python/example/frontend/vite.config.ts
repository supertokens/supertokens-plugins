import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backendPort = Number(process.env.PORT || 3001);

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/example-bootstrap": `http://localhost:${backendPort}`,
    },
  },
});
