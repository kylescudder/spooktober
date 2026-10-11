import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  cacheMaxMemorySize: 0,
  serverExternalPackages: ["pg"],
  outputFileTracingIncludes: { "/*": ["./src/migrations/*.sql"] },
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "same-origin" },
      { key: "X-Frame-Options", value: "DENY" },
    ] }];
  },
};

export default config;
