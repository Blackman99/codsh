import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const snapshotRoot = dirname(fileURLToPath(import.meta.url));
const sourceRoot = process.env.MALL_SOURCE_ROOT;
if (!sourceRoot) {
  throw new Error("MALL_SOURCE_ROOT must point at the International Mall project");
}

const requireFromSource = createRequire(join(sourceRoot, "package.json"));
const reactPlugin = requireFromSource("@vitejs/plugin-react");
const react = typeof reactPlugin === "function" ? reactPlugin : reactPlugin.default;

export default {
  root: snapshotRoot,
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(snapshotRoot, "src"),
      "next/link": resolve(snapshotRoot, "src/shims/next-link.tsx"),
      "next/navigation": resolve(snapshotRoot, "src/shims/next-navigation.ts"),
    },
  },
};
