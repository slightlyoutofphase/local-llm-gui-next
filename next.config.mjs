const developmentBackendOrigin =
  process.env.LOCAL_LLM_GUI_BACKEND_ORIGIN ?? "http://127.0.0.1:4000";
const developmentFrontendOrigin =
  process.env.LOCAL_LLM_GUI_FRONTEND_ORIGIN ?? "http://127.0.0.1:3000";

const allowedDevOrigins = Array.from(
  new Set(
    [developmentFrontendOrigin, developmentBackendOrigin]
      .map((origin) => getHostname(origin))
      .filter((hostname) => hostname.length > 0),
  ),
);

/** @type {import("next").NextConfig} */
const nextConfig = {
  allowedDevOrigins,
  output: "export",
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  async rewrites() {
    if (process.env.NODE_ENV !== "development") {
      return [];
    }

    return [
      {
        source: "/api/:path*",
        destination: `${developmentBackendOrigin}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;

function getHostname(origin) {
  try {
    return new URL(origin).hostname;
  } catch {
    return "";
  }
}
