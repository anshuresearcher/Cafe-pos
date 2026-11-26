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
      { source: "/public-menu/:token", destination: "/api/public-menu/:token" },
      { source: "/public-menu/:token/customers", destination: "/api/public-menu/:token/customers" },
      { source: "/public-menu/:token/otp/send", destination: "/api/public-menu/:token/otp/send" },
      { source: "/public-menu/:token/otp/verify", destination: "/api/public-menu/:token/otp/verify" },
      { source: "/public-menu/:token/orders/statuses", destination: "/api/public-menu/:token/orders/statuses" },
      { source: "/public-menu/:token/orders/:orderId", destination: "/api/public-menu/:token/orders/:orderId" },
      { source: "/public-menu/:token/analytics", destination: "/api/public-menu/:token/analytics" },
      { source: "/public-menu/:token/session", destination: "/api/public-menu/:token/session" },
      { source: "/public-menu/:token/service-requests", destination: "/api/public-menu/:token/service-requests" },
      { source: "/public-menu/:token/push-subscriptions", destination: "/api/public-menu/:token/push-subscriptions" },
      { source: "/public-menu/:path*", destination: "/api/public-menu/:path*" },
    ];
  },
};

export default nextConfig;
