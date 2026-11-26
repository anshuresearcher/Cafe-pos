import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    agentFeedback: true,
    // Next 16.4's CLI parser is incompatible with the current TypeScript CLI
    // output in this environment; use the compiler API for type checking.
    useTypeScriptCli: false,
  },
  async rewrites() {
    return [
      { source: "/public-menu/:token/push-config", destination: "/api/public-menu/:token/push-config" },
      { source: "/public-menu/:token/analytics", destination: "/api/public-menu/:token/analytics" },
      { source: "/public-menu/:token/session", destination: "/api/public-menu/:token/session" },
      { source: "/public-menu/:path*", destination: "/api/public-menu/:path*" },
    ];
  },
};

export default nextConfig;
