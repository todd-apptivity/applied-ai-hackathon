import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Clio redirect URI uses 127.0.0.1, so the app is often opened on that
  // host. Without this the dev server refuses it the scripts that make client
  // components work, and anything interactive silently stays inert.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
