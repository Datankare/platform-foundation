import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ADR-055 D1: the container image runs Next.js's standalone server (.next/standalone/server.js
  // with only the node_modules it traces). Vercel builds the same commit its own way and ignores
  // this. Tracing is rooted at this project, so the server sits at the top of the output even
  // when a lockfile exists in a directory above the checkout.
  output: "standalone",
  outputFileTracingRoot: __dirname,
  // OWASP A05: Security misconfiguration — HTTP security headers
  // See ADR-011 for rationale and tightening schedule
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(self), geolocation=(), payment=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            // Deprecated — CSP replaces this. Set to 0 per OWASP guidance.
            key: "X-XSS-Protection",
            value: "0",
          },
          {
            // Isolate browsing context — prevent cross-origin window access
            key: "Cross-Origin-Opener-Policy",
            value: "same-origin",
          },
          {
            // Prevent cross-origin resource theft
            key: "Cross-Origin-Resource-Policy",
            value: "same-origin",
          },
          {
            // Content Security Policy — generic baseline
            // Projects inheriting this template should tighten connect-src
            // to only the external domains they actually use
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "media-src 'self' blob:",
              "connect-src 'self' https://cognito-idp.us-east-1.amazonaws.com",
              "font-src 'self'",
              "frame-ancestors 'none'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
