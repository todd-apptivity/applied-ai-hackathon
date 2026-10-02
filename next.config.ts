import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // sqlite-vec loads a native extension from its own package directory, so it
  // must be required at runtime rather than bundled. (better-sqlite3 is on
  // Next's built-in external list already.)
  serverExternalPackages: ["sqlite-vec"],
};

export default nextConfig;
